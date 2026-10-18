/* `npm run devnet:e2e` — the end-to-end validation with OUR OWN real Devnet transactions.
 * Needs the Devnet wallet to be funded (see `npm run devnet:wallet`) and DEVNET_DATABASE_URL/TEST_DATABASE_URL.
 *
 * Flow: create SPL test tokens (supply known, mint authority revoked) -> run the real engine on them ->
 * send real Burn / BurnChecked transactions (below, between and across level thresholds) -> for every burn
 * check: finalization on Devnet, exact raw amount, detection, PostgreSQL rows, REST, SSE, levels, mutations
 * only after finalization -> RPC outage, engine restarts, SSE reconnection -> supply reconciliation.
 *
 * Not executed here (and reported as such): burn by CPI (needs a deployed program; see README) and
 * Token-2022 when the program is absent from the cluster. */
import { parseBurns } from '../../src/chain/burn-parser.ts';
import { createPool, loadDbConfig } from '../../src/db/config.ts';
import { buildTransaction, ix, Keypair, loadOrCreateKeypair, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type Instruction } from './chain.ts';
import { Report } from './check.ts';
import { boot, newRun, projectJson, type Booted } from './harness.ts';
import { getJson, openSse, waitUntil } from './http.ts';
import { startCuttableProxy } from './proxy.ts';
import { assertDevnet, getBalance, latestBlockhash, rentExempt, rpc, sendAndFinalize, shortSig, sleep, type Sent } from './rpc.ts';
import { REQUIRED_LAMPORTS, WALLET_PATH } from './wallet.ts';

const UI = 1_000_000n; // 1 token = 10^6 raw (6 decimals)
const SUPPLY_UI = 1_000_000n;
const LEVELS = [{ id: 'l0', name: 'Dormant', threshold: '0' }, { id: 'l1', name: 'Awake', threshold: '10' }, { id: 'l2', name: 'Mutated', threshold: '50' }, { id: 'l3', name: 'Evolved', threshold: '200' }];

const r = new Report();
await assertDevnet();
const payer = loadOrCreateKeypair(WALLET_PATH).keypair;
const balance = await getBalance(payer.address);
r.fact('wallet (Devnet only, public address)', payer.address);
if (balance < REQUIRED_LAMPORTS) {
  console.log(`\nNot enough Devnet SOL (${Number(balance) / 1e9} SOL). Fund this PUBLIC address with at least ${Number(REQUIRED_LAMPORTS) / 1e9} SOL via https://faucet.solana.com :\n${payer.address}`);
  process.exit(2);
}

/* ------------------------------ helpers ------------------------------ */

const log: { label: string; project: string; signature: string; slot: number; amountRaw: string; path: string; kind: string }[] = [];

async function send(instructions: Instruction[], extra: Keypair[] = []): Promise<Sent> {
  return sendAndFinalize(buildTransaction(payer, extra, instructions, await latestBlockhash()));
}

interface Token {
  id: string;
  program: string;
  name: 'spl-token' | 'token-2022';
  mint: Keypair;
  account: Keypair;
  createSig: string;
}

async function createToken(id: string, program: string, name: Token['name']): Promise<Token> {
  const mint = Keypair.generate();
  const account = Keypair.generate();
  const sent = await send([
    ix.createAccount(payer.address, mint.address, await rentExempt(82), 82n, program),
    ix.initializeMint2(program, mint.address, 6, payer.address, null),
    ix.createAccount(payer.address, account.address, await rentExempt(165), 165n, program),
    ix.initializeAccount3(program, account.address, mint.address, payer.address),
    ix.mintTo(program, mint.address, account.address, payer.address, SUPPLY_UI * UI),
    ix.revokeAuthority(program, mint.address, payer.address, 0),
  ], [mint, account]);
  r.fact(`${id}: token created`, `mint ${mint.address}, creation tx ${sent.signature} (slot ${sent.slot})`);
  const supply = await rpc<any>('getTokenSupply', [mint.address, { commitment: 'finalized' }]);
  r.check(`${id}: on-chain supply is the known initial supply`, supply.value.amount === (SUPPLY_UI * UI).toString());
  const info = await rpc<any>('getAccountInfo', [mint.address, { encoding: 'base64', commitment: 'finalized' }]);
  const data = Buffer.from(info.value.data[0], 'base64');
  r.check(`${id}: mint authority revoked on-chain`, data.readUInt32LE(0) === 0 && info.value.owner === program);
  return { id, program, name, mint, account, createSig: sent.signature };
}

/** Independent view of a finalized burn straight from Devnet (our parser on the node's own response). */
async function onChainBurns(t: Token, signature: string) {
  const tx = await rpc<any>('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
  const parsed = parseBurns(tx, { mint: t.mint.address, expectedSignature: signature, tokenProgram: t.name, decimals: 6 });
  if (parsed.status !== 'ok') throw new Error(`cannot parse ${signature}: ${parsed.status}`);
  return { slot: tx.slot as number, burns: parsed.burns, tx };
}

async function burnOnce(t: Token, label: string, kind: 'burn' | 'burnChecked', amountUi: bigint): Promise<Sent & { amountRaw: bigint }> {
  const amountRaw = amountUi * UI;
  const i = kind === 'burn' ? ix.burn(t.program, t.account.address, t.mint.address, payer.address, amountRaw) : ix.burnChecked(t.program, t.account.address, t.mint.address, payer.address, amountRaw, 6);
  const sent = await send([i]);
  log.push({ label, project: t.id, signature: sent.signature, slot: sent.slot, amountRaw: amountRaw.toString(), path: '0', kind });
  r.fact(`${label}`, `${kind} ${amountUi} tokens (${amountRaw} raw) on ${t.id}: ${sent.signature} slot ${sent.slot} FINALIZED`);
  return { ...sent, amountRaw };
}

/* ----------------------------- environment ----------------------------- */

const run = await newRun();
const proxy = await startCuttableProxy();
const dbPool = createPool(loadDbConfig({ DATABASE_URL: run.databaseUrl, PG_POOL_MAX: '2' }));
let booted: Booted | null = null;
const api = async (path: string) => (await getJson(`${booted!.url}/api/v1/projects/${path}`));
const eventsOf = async (id: string) => (await api(`${id}/events?limit=500`)).json.data as any[];
const status = async (id: string) => (await api(`${id}/status`)).json;
const burnEvent = async (id: string, signature: string, path = '0') => (await eventsOf(id)).find((e) => e.type === 'burn' && e.burn.signature === signature && e.burn.instructionPath === path);
const mutations = async (id: string) => (await eventsOf(id)).filter((e) => e.type === 'mutation').map((e) => e.mutation.levelId);
/** Behaves like a browser EventSource: reconnects (also across engine restarts) with Last-Event-ID. */
function follow(urlOf: () => string | undefined, path: string) {
  const got: any[] = [];
  let last = 0;
  let stopped = false;
  let connections = 0;
  let duplicates = 0;
  const loop = (async () => {
    while (!stopped) {
      const base = urlOf();
      if (!base) { await sleep(200); continue; }
      try {
        const s = await openSse(`${base}${path}`, last);
        connections++;
        let seen = 0;
        const drain = () => {
          for (; seen < s.frames.length; seen++) {
            const f = s.frames[seen]!;
            if (!f.id) continue;
            if (Number(f.id) <= last) duplicates++;
            else { got.push(f.data); last = Number(f.id); }
          }
        };
        for (let ended = false; !ended && !stopped; ) {
          drain();
          ended = await Promise.race([s.ended.then(() => true), sleep(100).then(() => false)]);
        }
        drain();
        s.close();
      } catch { await sleep(300); }
    }
  })();
  return { got, stats: () => ({ connections, duplicates, last }), stop: async () => { stopped = true; await loop; } };
}

const sumRaw = (id: string) => log.filter((l) => l.project === id).reduce((a, l) => a + BigInt(l.amountRaw), 0n);

try {
  /* ------------------------- 1. tokens and engine ------------------------- */
  const tokens: Token[] = [await createToken('tok-a', TOKEN_PROGRAM, 'spl-token'), await createToken('tok-b', TOKEN_PROGRAM, 'spl-token')];
  const t22 = (await rpc<any>('getAccountInfo', [TOKEN_2022_PROGRAM, { encoding: 'base64' }])).value !== null;
  if (t22) tokens.push(await createToken('tok-c', TOKEN_2022_PROGRAM, 'token-2022'));
  else r.fact('Token-2022 scenario: NOT EXECUTED', 'the Token-2022 program does not exist on this Devnet');
  const [A, B] = tokens as [Token, Token];
  const C = t22 ? tokens[2] : undefined;

  const projects = tokens.map((t) => projectJson({ id: t.id, mint: t.mint.address, decimals: 6, tokenProgram: t.name, levels: LEVELS, initialSupply: SUPPLY_UI.toString() }));
  booted = await boot(run, { projects, rpcUrl: proxy.url, trackConfirmed: true, pollMs: 1500 });
  const follower = follow(() => booted?.url, '/api/v1/projects/tok-a/stream');
  const synced = async (id: string) => { const s = await status(id); return s?.data?.state === 'synced' && s.data.history.backfill !== 'pending'; };
  await waitUntil(async () => (await synced('tok-a')) && (await synced('tok-b')), 'engine watching the new tokens', 120_000);
  r.check('engine watches the new tokens: creation transactions seen, no burn yet, no mutation', (await eventsOf('tok-a')).length === 0 && (await status('tok-a')).totals.finalizedRaw === '0');

  /* ----------------- 2. burns below / across thresholds on A ----------------- */
  const a1 = await burnOnce(A, 'a1', 'burn', 3n); // total 3: no threshold
  const a2 = await burnOnce(A, 'a2', 'burnChecked', 4n); // total 7: no threshold
  await waitUntil(async () => !!(await burnEvent('tok-a', a2.signature)), 'a1/a2 detected', 90_000);
  r.check('burns below the first threshold: detected, no mutation', !!(await burnEvent('tok-a', a1.signature)) && (await mutations('tok-a')).length === 0);

  // a3 crosses l1. It must not produce a mutation before it is FINALIZED on Devnet.
  const a3Raw = 5n * UI;
  const a3Wire = buildTransaction(payer, [], [ix.burnChecked(A.program, A.account.address, A.mint.address, payer.address, a3Raw, 6)], await latestBlockhash());
  const a3Sig = await rpc<string>('sendTransaction', [Buffer.from(a3Wire).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  let violation = false;
  let sawNotFinalizedWindow = false;
  let windowSamples = 0;
  let sawPending = false;
  let a3Slot = 0;
  for (let i = 0; i < 400; i++) {
    const evs = await mutations('tok-a');
    const st = (await rpc<any>('getSignatureStatuses', [[a3Sig], { searchTransactionHistory: true }])).value[0];
    if (evs.includes('l1') && st?.confirmationStatus !== 'finalized') violation = true; // mutation visible although Devnet does not say finalized
    if (st && st.confirmationStatus !== 'finalized') {
      sawNotFinalizedWindow = true;
      windowSamples++;
      if (BigInt((await status('tok-a')).totals.pendingFinalizationRaw) > 0n) sawPending = true;
    }
    if (st?.err) throw new Error(`a3 failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'finalized') { a3Slot = st.slot; break; }
    await sleep(250);
  }
  if (!a3Slot) throw new Error('a3 was not finalized in time');
  log.push({ label: 'a3', project: 'tok-a', signature: a3Sig, slot: a3Slot, amountRaw: a3Raw.toString(), path: '0', kind: 'burnChecked' });
  r.fact('a3', `burnChecked 5 tokens (${a3Raw} raw) on tok-a CROSSING l1: ${a3Sig} slot ${a3Slot} FINALIZED`);
  r.check('no mutation was ever published while the crossing burn was not finalized on Devnet', !violation);
  r.fact('confirmed-but-not-finalized window observed', `${sawNotFinalizedWindow} (${windowSamples} samples; this Devnet finalizes in about 1 s, so the window is tiny); engine showed it as pendingFinalization: ${sawPending}`);
  await waitUntil(async () => (await mutations('tok-a')).includes('l1'), 'mutation l1 after finalization', 90_000);
  r.check('crossing burn: mutation l1 published exactly once, after finalization', (await mutations('tok-a')).filter((m) => m === 'l1').length === 1 && (await status('tok-a')).progression.level.id === 'l1');

  // a4: ONE transaction with two burn instructions (paths 0 and 1), crossing l2
  const a4 = await send([ix.burn(A.program, A.account.address, A.mint.address, payer.address, 20n * UI), ix.burnChecked(A.program, A.account.address, A.mint.address, payer.address, 30n * UI, 6)]);
  log.push({ label: 'a4.0', project: 'tok-a', signature: a4.signature, slot: a4.slot, amountRaw: (20n * UI).toString(), path: '0', kind: 'burn' }, { label: 'a4.1', project: 'tok-a', signature: a4.signature, slot: a4.slot, amountRaw: (30n * UI).toString(), path: '1', kind: 'burnChecked' });
  r.fact('a4', `ONE tx, Burn 20 + BurnChecked 30 tokens on tok-a, crossing l2: ${a4.signature} slot ${a4.slot} FINALIZED`);
  await waitUntil(async () => !!(await burnEvent('tok-a', a4.signature, '1')), 'a4 detected', 90_000);
  r.check('one transaction with two burns: both instructions counted separately with their real positions', !!(await burnEvent('tok-a', a4.signature, '0')) && !!(await burnEvent('tok-a', a4.signature, '1')));
  await waitUntil(async () => (await mutations('tok-a')).includes('l2'), 'mutation l2', 60_000);

  /* -------- 3. restart of the engine (state must come from PostgreSQL) -------- */
  const idsBefore = (await eventsOf('tok-a')).map((e) => e.id);
  await booted.stop();
  booted = await boot(run, { projects, rpcUrl: proxy.url, trackConfirmed: true, pollMs: 1500 });
  r.check('restart: cursors reloaded (resumed logged)', booted.lines.filter((l) => l.event === 'resumed').length >= 2);
  await waitUntil(async () => (await synced('tok-a')) && (await synced('tok-b')), 'resynced after restart', 120_000);
  await sleep(5000);
  r.check('restart: no event lost, none duplicated, same ids', JSON.stringify((await eventsOf('tok-a')).map((e) => e.id)) === JSON.stringify(idsBefore) && (await status('tok-a')).totals.finalizedRaw === sumRaw('tok-a').toString());

  /* ---------- 4. burn while the engine is DOWN: caught up after restart ---------- */
  await booted.stop();
  const b1 = await burnOnce(B, 'b1', 'burnChecked', 300n); // from 0: crosses l1, l2 and l3 in ONE burn
  booted = await boot(run, { projects, rpcUrl: proxy.url, trackConfirmed: true, pollMs: 1500 });
  await waitUntil(async () => !!(await burnEvent('tok-b', b1.signature)), 'b1 caught up after downtime', 120_000);
  await waitUntil(async () => (await mutations('tok-b')).length === 3, 'three mutations', 60_000);
  r.check('burn made while the engine was stopped is found after restart (no hole)', !!(await burnEvent('tok-b', b1.signature)));
  r.check('one burn crossing three thresholds: l1, l2, l3 each published once, in order', JSON.stringify(await mutations('tok-b')) === JSON.stringify(['l1', 'l2', 'l3']));
  r.check('isolation: tok-a untouched by tok-b activity', (await status('tok-a')).totals.finalizedRaw === sumRaw('tok-a').toString() && (await eventsOf('tok-a')).every((e) => e.type !== 'burn' || e.burn.signature !== b1.signature));

  /* ------------------------ 5. RPC outage and recovery ------------------------ */
  proxy.cut(true);
  const a5 = await burnOnce(A, 'a5', 'burn', 150n); // sent straight to Devnet while the engine's RPC is cut; crosses l3
  await waitUntil(async () => (await status('tok-a')).data.reasons.includes('sync_failing'), 'outage reported', 60_000);
  const during = await status('tok-a');
  r.check('RPC outage: project explicitly incomplete (sync_failing), API still serving', during.data.state === 'incomplete' && (await getJson(`${booted.url}/health/ready`)).status === 200);
  r.check('RPC outage: the burn is not (yet) counted', !(await burnEvent('tok-a', a5.signature)));
  proxy.cut(false);
  await waitUntil(async () => !!(await burnEvent('tok-a', a5.signature)), 'a5 after recovery', 120_000);
  await waitUntil(async () => (await mutations('tok-a')).includes('l3'), 'mutation l3', 60_000);
  r.check('RPC recovery: the missed burn is counted exactly once and l3 published once', (await mutations('tok-a')).filter((m) => m === 'l3').length === 1 && (await eventsOf('tok-a')).filter((e) => e.type === 'burn' && e.burn.signature === a5.signature).length === 1);

  /* ---------------------------- 6. Token-2022 (if any) ---------------------------- */
  if (C) {
    const c1 = await burnOnce(C, 'c1', 'burn', 2n);
    const c2 = await burnOnce(C, 'c2', 'burnChecked', 11n);
    await waitUntil(async () => !!(await burnEvent('tok-c', c2.signature)), 'token-2022 detected', 90_000);
    r.check('Token-2022: Burn and BurnChecked detected, level l1 reached', !!(await burnEvent('tok-c', c1.signature)) && (await mutations('tok-c')).includes('l1'));
  }

  /* ------------- 6b. a burn that FAILS on-chain must never be counted ------------- */
  const beforeFail = (await status('tok-a')).totals.finalizedRaw;
  const badWire = buildTransaction(payer, [], [ix.burnChecked(A.program, A.account.address, A.mint.address, payer.address, 1n * UI, 5)], await latestBlockhash()); // wrong decimals -> runtime error
  const badSig = await rpc<string>('sendTransaction', [Buffer.from(badWire).toString('base64'), { encoding: 'base64', skipPreflight: true }]); // skip the pre-check so it lands on-chain with an error
  let badErr: unknown = null;
  let badSlot = 0;
  for (let i = 0; i < 120; i++) {
    const st = (await rpc<any>('getSignatureStatuses', [[badSig], { searchTransactionHistory: true }])).value[0];
    if (st?.confirmationStatus === 'finalized') { badErr = st.err; badSlot = st.slot; break; }
    await sleep(500);
  }
  r.fact('failed burn (BurnChecked, wrong decimals)', `${badSig} slot ${badSlot} landed FINALIZED with err ${JSON.stringify(badErr)}`);
  r.check('the failed transaction really landed on-chain with an error (so the engine had to decide)', badErr !== null && badSlot > 0);
  await sleep(6000); // several polling cycles
  const supplyAfterFail = BigInt((await rpc<any>('getTokenSupply', [A.mint.address, { commitment: 'finalized' }])).value.amount);
  r.check('failed transaction: not counted, no event, no incident, supply unchanged on-chain', !(await burnEvent('tok-a', badSig)) && (await status('tok-a')).totals.finalizedRaw === beforeFail && (await status('tok-a')).data.issues.count === 0 && SUPPLY_UI * UI - supplyAfterFail === sumRaw('tok-a'));

  /* ----------------- 7. per-burn verification, all projects ----------------- */
  await sleep(4000);
  for (const l of log) {
    const t = tokens.find((x) => x.id === l.project)!;
    const chain = await onChainBurns(t, l.signature);
    const own = chain.burns.find((b) => b.instructionPath === l.path);
    const ev = await burnEvent(l.project, l.signature, l.path);
    const row = (await dbPool.query('SELECT amount_raw::text AS a, slot::text AS s, commitment FROM burns WHERE project_id = $1 AND signature = $2 AND instruction_path = $3', [l.project, l.signature, l.path])).rows;
    const ok = !!own && own.amountRaw.toString() === l.amountRaw && !!ev && ev.burn.amountRaw === l.amountRaw && ev.burn.slot === chain.slot && row.length === 1 && row[0].a === l.amountRaw && row[0].commitment === 'finalized' && Number(row[0].s) === chain.slot;
    r.check(`${l.label} ${shortSig(l.signature)}: Devnet finalized = engine event = PostgreSQL row, exact amount ${l.amountRaw} raw`, ok);
  }

  /* ---------------- 8. totals, levels, supply, completeness ---------------- */
  for (const t of tokens) {
    const expected = sumRaw(t.id);
    const st = await status(t.id);
    const onChain = BigInt((await rpc<any>('getTokenSupply', [t.mint.address, { commitment: 'finalized' }])).value.amount);
    const rows = (await dbPool.query('SELECT count(*)::int AS n, coalesce(sum(amount_raw), 0)::text AS s FROM burns WHERE project_id = $1', [t.id])).rows[0];
    r.check(`${t.id}: REST total = PostgreSQL sum = sum of the burns sent`, st.totals.finalizedRaw === expected.toString() && rows.s === expected.toString() && rows.n === log.filter((l) => l.project === t.id).length, `${expected} raw`);
    r.check(`${t.id}: on-chain supply consistency (initial − supply = indexed burns)`, SUPPLY_UI * UI - onChain === expected, `supply ${onChain}`);
    await waitUntil(async () => (await status(t.id)).data.history.complete === true, `${t.id} completeness proven`, 90_000);
    r.check(`${t.id}: completeness PROVEN by the engine (history.complete = true via supply reconciliation)`, (await status(t.id)).data.history.verification === 'verified');
    const prog = (await api(`${t.id}/progression`)).json;
    const lvl = expected >= 200n * UI ? 'l3' : expected >= 50n * UI ? 'l2' : expected >= 10n * UI ? 'l1' : 'l0';
    r.check(`${t.id}: progression level ${lvl}`, prog.level.id === lvl);
    r.check(`${t.id}: no incident`, (await status(t.id)).data.issues.count === 0);
  }
  r.check('no mutation duplicated on any project', (await Promise.all(tokens.map(async (t) => { const m = await mutations(t.id); return new Set(m).size === m.length; }))).every(Boolean));
  r.check('engine logged no incident', booted.lines.filter((l) => l.event === 'incident').length === 0);

  /* --------------------------- 9. SSE contract --------------------------- */
  const evA = await eventsOf('tok-a');
  await waitUntil(() => follower.got.length === evA.length, 'SSE follower caught up', 60_000);
  const st = follower.stats();
  r.check('SSE follower (reconnecting with Last-Event-ID across 2 engine restarts + outage): every event once, in order, identical to REST', JSON.stringify(follower.got) === JSON.stringify(evA) && st.duplicates === 0, `${st.connections} connections, ${follower.got.length} events, ids 1..${st.last}`);
  r.check('SSE ids are contiguous (no event lost between history and live)', follower.got.every((e, i) => Number(e.id) === i + 1));
  await follower.stop();
  const mid = Number(evA[Math.floor(evA.length / 2)]!.id);
  const again = await openSse(`${booted.url}/api/v1/projects/tok-a/stream`, mid);
  await waitUntil(() => again.frames.filter((f) => f.id).length === evA.filter((e) => Number(e.id) > mid).length, 'SSE resume', 30_000);
  r.check('SSE reconnection from an arbitrary Last-Event-ID: exactly the later events', JSON.stringify(again.frames.filter((f) => f.id).map((f) => f.data)) === JSON.stringify(evA.filter((e) => Number(e.id) > mid)));
  again.close();

  r.fact('RPC requests/credits (local estimate, NOT billing)', booted.engine.meter.snapshot().total);
  console.log('\n=== TRANSACTIONS (Devnet, finalized) ===');
  for (const l of log) console.log(`${l.label.padEnd(5)} ${l.project}  ${l.kind.padEnd(11)} path ${l.path}  ${l.amountRaw.padStart(12)} raw  slot ${l.slot}  ${l.signature}`);
  r.fact('transactions', log);
} catch (e) {
  r.check('script completed without error', false, (e as Error).message);
  if (booted) { // diagnostics only: engine log lines are already redacted and contain no secret
    const keep = new Set(['sync_failed', 'warning', 'incident', 'recovered', 'lease_lost', 'supply_mismatch', 'reconcile_failed', 'burns_indexed', 'mutation', 'status_unavailable']);
    console.log('--- engine log (diagnostic, last 25 relevant lines) ---');
    for (const l of booted.lines.filter((x) => keep.has(x.event)).slice(-25)) console.log(JSON.stringify(l).slice(0, 400));
    for (const id of ['tok-a', 'tok-b']) console.log(`--- ${id} status ---`, JSON.stringify((await status(id).catch(() => null))?.data ?? null).slice(0, 600));
  }
} finally {
  await booted?.stop().catch(() => {});
  await proxy.close();
  await dbPool.end().catch(() => {});
  await run.dispose();
  r.finish(`e2e-${Date.now()}.json`);
}
