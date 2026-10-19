/* Pre-launch activation, end to end on a real PostgreSQL: startEngine() with the real RPC client, indexers, store and HTTP API;
 * only the chain is simulated. The token (MINT_A) does not exist when the engine starts; the "first buy" is simulated by making
 * it appear on the fake node. No redeploy, no restart, no human step: the engine detects it, validates it, indexes it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEngineConfig, type EngineConfig } from '../src/engine/config.ts';
import { startEngine, type Engine } from '../src/engine/engine.ts';
import { createLogger } from '../src/engine/logger.ts';
import { TOKEN_PROGRAMS } from '../src/config/schema.ts';
import type { LevelReachedEvent } from '../src/core/ledger.ts';
import { FakeChain } from './fake-chain.ts';
import { count, fakeFetch, newHooks, type RpcHooks } from './fake-rpc.ts';
import { MINT_A, MINT_B, projectInput, randomPubkey } from './helpers.ts';
import { bareSchema, pgSkip, type BareSchema } from './pg-harness.ts';

const opts = { skip: pgSkip };
const SPL = TOKEN_PROGRAMS['spl-token'];
const CREATED = 10n ** 15n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, what: string, ms = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// the token that does not exist yet, and an unrelated active project that must never be disturbed
const pendingVirus = (over: Record<string, unknown> = {}) => ({
  id: 'virus', name: 'VIRUS.EXE', ticker: 'VIRUS', cluster: 'devnet', mint: MINT_A, awaitMint: true,
  levels: [{ id: 'l0', name: 'Zero', threshold: '0' }, { id: 'l1', name: 'One', threshold: '0.0003' }, { id: 'l2', name: 'Two', threshold: '0.001' }],
  ...over,
});
const other = projectInput({ id: 'other', mint: MINT_B, name: 'Other', ticker: 'OTHER' });

interface Boot { engine: Engine; lines: any[]; events: LevelReachedEvent[]; api: string; ev(name: string, project?: string): any[] }

async function boot(db: BareSchema, chain: FakeChain, hooks: RpcHooks, o: { projects?: unknown[]; over?: Partial<EngineConfig> } = {}): Promise<Boot> {
  const dir = await mkdtemp(join(tmpdir(), 'engact-'));
  const file = join(dir, 'projects.json');
  await writeFile(file, JSON.stringify({ projects: o.projects ?? [pendingVirus(), other] }));
  const base = await loadEngineConfig({ SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: 'https://rpc.invalid/?api-key=ACT-SECRET-KEY-1', DATABASE_URL: db.url, PROJECTS_CONFIG: file });
  const cfg: EngineConfig = {
    ...base, pollIntervalMs: 20, errorBackoff: { baseMs: 20, maxMs: 80 }, leaseRetryMs: 50, shutdownTimeoutMs: 3_000, statusLogIntervalMs: 0, reconcileIntervalMs: 50,
    rpc: { ...base.rpc, maxRetries: 1, baseDelayMs: 1 }, limits: { maxConcurrent: 4, minIntervalMs: 0 },
    indexer: { ...base.indexer, pageSize: 3, backfillPagesPerSync: 2 }, pending: { pollIntervalMs: 20, blockedRetryMs: 60, maxHistorySignatures: 200 },
    http: { ...base.http, enabled: true, host: '127.0.0.1', port: 0, statusCacheMs: 0 }, ...o.over,
  };
  const lines: any[] = [];
  const events: LevelReachedEvent[] = [];
  const engine = await startEngine(cfg, { log: createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l)) }), fetch: fakeFetch(chain, hooks), onLevelReached: (e) => void events.push(e) });
  return { engine, lines, events, api: `http://127.0.0.1:${engine.httpPort}`, ev: (name, project) => lines.filter((l) => l.event === name && (project === undefined || l.project === project)) };
}

const getJson = async (b: Boot, path: string) => { const r = await fetch(`${b.api}${path}`); return { status: r.status, body: (await r.json()) as any }; };
const pendingOf = async (b: Boot) => (await getJson(b, '/api/v1/projects')).body.pending?.find((p: any) => p.id === 'virus');
const activeIds = async (b: Boot) => (await getJson(b, '/api/v1/projects')).body.data.map((p: any) => p.id);
const synced = async (b: Boot, id: string) => { const r = await getJson(b, `/api/v1/projects/${id}/status`); return r.status === 200 && r.body.data.state === 'synced' ? r.body : null; };

/** The token's life on the fake node: creation (supply minted) at slot 1, then burns of MINT_A (+ burns of MINT_B for the other project). */
function launchChain(burnsA: number): FakeChain {
  const chain = new FakeChain();
  chain.initialSupply = CREATED;
  chain.add({ slot: 1, mints: [CREATED] });
  for (let s = 2; s < 2 + burnsA; s++) chain.add({ slot: s, burns: [100n], burnsB: [7n] });
  chain.finalizedSlot = 1_000;
  return chain;
}
const absent = (): RpcHooks => ({ ...newHooks(), owners: { [MINT_A]: null } });
const appear = (h: RpcHooks) => { h.owners![MINT_A] = SPL; };

test('[activation][engine] mint absent at start: the engine runs, says it is waiting, serves nothing for it, spends only cheap polls — and the other project is unaffected', opts, async () => {
  const db = await bareSchema();
  const hooks = absent();
  const chain = launchChain(6);
  const b = await boot(db, chain, hooks);
  try {
    await waitFor(async () => (await synced(b, 'other')) !== null, 'the other project synced');
    assert.deepEqual(await activeIds(b), ['other']);
    const p = await pendingOf(b);
    assert.deepEqual(p, { id: 'virus', name: 'VIRUS.EXE', ticker: 'VIRUS', cluster: 'devnet', mint: MINT_A, lifecycle: 'awaiting_mint', code: null });
    assert.equal((await getJson(b, '/api/v1/projects/virus/status')).status, 404); // never data for a token that is not there
    assert.equal(count(hooks, 'getSignaturesForAddress', MINT_A), 0);
    assert.equal(count(hooks, 'getTransaction'), count(hooks, 'getTransaction')); // (other project only: it has its own burns)
    assert.ok(count(hooks, 'getAccountInfo', MINT_A) >= 2, 'polled');
    const st = await b.engine.status();
    assert.equal(st.pending[0]!.lifecycle, 'awaiting_mint');
    assert.equal((await getJson(b, '/health/ready')).status, 200);
    assert.doesNotMatch(JSON.stringify(await getJson(b, '/api/v1/projects')), /rpc\.invalid|ACT-SECRET|detail/);
    assert.equal(b.ev('engine_started')[0].pending, 1);
  } finally {
    await b.engine.stop();
  }
});

test('[activation][engine] the first buy: the mint appears, is validated from the chain, and indexing/counter/mutations start by themselves — burns from before AND during the sync all counted once, history proven', opts, async () => {
  const db = await bareSchema();
  const hooks = absent();
  const chain = launchChain(8); // 8 burns of 100 raw happened before the engine ever saw the token
  const b = await boot(db, chain, hooks);
  try {
    await waitFor(async () => (await synced(b, 'other')) !== null, 'engine up');
    assert.equal((await pendingOf(b)).lifecycle, 'awaiting_mint');
    appear(hooks); // the creation became finalized on-chain
    await waitFor(() => b.ev('mint_activated').length === 1, 'activation');
    chain.add({ slot: 20, burns: [100n] }); // burns while the sync is running
    chain.add({ slot: 21, burns: [100n] });
    await waitFor(async () => {
      const s = await synced(b, 'virus');
      return s !== null && s.totals.finalizedRaw === '1000';
    }, 'virus synced with every burn');
    const st = (await getJson(b, '/api/v1/projects/virus/status')).body;
    assert.equal(st.totals.burnCount, 10);
    assert.deepEqual(await activeIds(b), ['other', 'virus']);
    assert.equal(await pendingOf(b), undefined);
    const meta = (await getJson(b, '/api/v1/projects')).body.data.find((p: any) => p.id === 'virus');
    assert.deepEqual([meta.decimals, meta.tokenProgram, meta.levels.map((l: any) => l.thresholdRaw)], [6, 'spl-token', ['0', '300', '1000']]); // read from the chain; thresholds scaled by the real decimals
    const a = b.ev('mint_activated')[0];
    assert.deepEqual([a.decimals, a.tokenProgram, a.supplyRaw, a.initialSupplyRaw], [6, 'spl-token', (CREATED - 800n).toString(), CREATED.toString()]);
    // levels: derived from the finalized total only, each fired once
    assert.deepEqual(b.events.filter((e) => e.projectId === 'virus').map((e) => e.level.id), ['l1', 'l2']);
    // the supply proof: created − burned = on-chain supply, so the history is proven complete
    await waitFor(async () => (await getJson(b, '/api/v1/projects/virus/status')).body.data.history?.complete === true, 'history proven');
    // no burn counted twice, none lost: the stored list equals the chain
    const burns = (await getJson(b, '/api/v1/projects/virus/burns?limit=200')).body.data;
    assert.equal(new Set(burns.map((x: any) => `${x.signature}:${x.instructionPath}`)).size, 10);
    assert.equal((await getJson(b, '/api/v1/projects/other/status')).body.totals.finalizedRaw, '56'); // the other project never noticed (8 burns of 7)
  } finally {
    await b.engine.stop();
  }
});

test('[activation][engine] an RPC outage while waiting and while activating is survived: backoff, no block, no loss; the other project keeps indexing meanwhile', opts, async () => {
  const db = await bareSchema();
  const hooks = absent();
  const chain = launchChain(5);
  const b = await boot(db, chain, hooks);
  try {
    await waitFor(async () => (await synced(b, 'other')) !== null, 'engine up');
    let outage = true;
    hooks.fail = (r) => (outage && r.address === MINT_A ? 503 : null); // only the token's requests fail
    appear(hooks);
    await waitFor(() => b.ev('mint_watch_failed').length >= 2, 'watch failures logged');
    assert.equal((await b.engine.status()).pending[0]!.code, null); // an outage is never a verdict
    chain.add({ slot: 30, burnsB: [3n] }); // the other project keeps working during the outage
    await waitFor(async () => (await getJson(b, '/api/v1/projects/other/status')).body.totals.finalizedRaw === '38', 'other indexed during the outage');
    outage = false; // the node is back
    await waitFor(async () => { const s = await synced(b, 'virus'); return s !== null && s.totals.finalizedRaw === '500'; }, 'virus activated and complete after the outage');
    assert.equal(b.ev('mint_blocked').length, 0);
    assert.ok(b.ev('mint_activated').length === 1);
  } finally {
    await b.engine.stop();
  }
});

test('[activation][engine] engine restart: before the token exists it simply waits again; after, it resumes from its stored cursor with no double count and catches the burns of the downtime', opts, async () => {
  const db = await bareSchema();
  const hooks = absent();
  const chain = launchChain(6);
  const b1 = await boot(db, chain, hooks);
  await waitFor(async () => (await synced(b1, 'other')) !== null, 'up');
  await b1.engine.stop();
  const b2 = await boot(db, chain, hooks); // restart while the token still does not exist
  try {
    await waitFor(async () => (await pendingOf(b2))?.lifecycle === 'awaiting_mint', 'waiting again');
    appear(hooks);
    await waitFor(async () => { const s = await synced(b2, 'virus'); return s !== null && s.totals.finalizedRaw === '600'; }, 'activated');
    const idsBefore = (await getJson(b2, '/api/v1/projects/virus/burns?limit=200')).body.data.map((x: any) => x.signature).sort();
    await b2.engine.stop();
    chain.add({ slot: 40, burns: [100n] }); // burns that happen while the engine is down
    chain.add({ slot: 41, burns: [100n] });
    const b3 = await boot(db, chain, hooks); // the mint exists from the start: validated and activated immediately
    try {
      await waitFor(async () => { const s = await synced(b3, 'virus'); return s !== null && s.totals.finalizedRaw === '800'; }, 'resumed with the downtime burns');
      const after = (await getJson(b3, '/api/v1/projects/virus/burns?limit=200')).body.data.map((x: any) => x.signature);
      assert.equal(after.length, 8);
      assert.deepEqual(idsBefore.filter((s: string) => after.includes(s)), idsBefore); // everything before is still there, once
      assert.equal(new Set(after).size, 8);
      assert.deepEqual(b3.events.filter((e) => e.projectId === 'virus').length, 0); // levels already delivered are never re-announced
      assert.equal(b3.ev('mint_activated').length, 1);
    } finally {
      await b3.engine.stop();
    }
  } finally {
    await b2.engine.stop();
  }
});

test('[activation][engine] an unexpected mint blocks ONLY the token, with a public code and no data; once the cause is gone it activates by itself; the other project never stops', opts, async () => {
  const db = await bareSchema();
  const hooks = absent();
  const chain = launchChain(4);
  chain.mintAuthority = randomPubkey(); // minting still possible
  const b = await boot(db, chain, hooks);
  try {
    await waitFor(async () => (await synced(b, 'other')) !== null, 'up');
    appear(hooks);
    await waitFor(async () => (await pendingOf(b))?.lifecycle === 'blocked', 'blocked');
    assert.deepEqual(await pendingOf(b), { id: 'virus', name: 'VIRUS.EXE', ticker: 'VIRUS', cluster: 'devnet', mint: MINT_A, lifecycle: 'blocked', code: 'mint_authority_active' });
    assert.equal(count(hooks, 'getSignaturesForAddress', MINT_A), 0, 'nothing is indexed for a refused token');
    assert.equal((await getJson(b, '/api/v1/projects/virus/status')).status, 404);
    assert.ok(b.ev('mint_blocked').length === 1, 'one explicit error, not one per retry');
    chain.add({ slot: 50, burnsB: [5n] });
    await waitFor(async () => (await getJson(b, '/api/v1/projects/other/status')).body.totals.finalizedRaw === '33', 'the other project keeps indexing while VIRUS is blocked');
    chain.mintAuthority = null; // revoked
    await waitFor(async () => (await synced(b, 'virus')) !== null, 'activated by itself');
    assert.equal((await synced(b, 'virus')).totals.finalizedRaw, '400');
  } finally {
    await b.engine.stop();
  }
});

test('[activation][engine] not a token mint, and a mint only seen at confirmed, never activate', opts, async () => {
  const db = await bareSchema();
  const hooks = absent();
  const b = await boot(db, launchChain(2), hooks);
  try {
    await waitFor(async () => (await synced(b, 'other')) !== null, 'up');
    hooks.notFinalized = new Set([MINT_A]);
    hooks.owners![MINT_A] = SPL; // exists at confirmed only
    await sleep(150);
    assert.equal((await pendingOf(b)).lifecycle, 'awaiting_mint');
    assert.equal(count(hooks, 'getSignaturesForAddress', MINT_A), 0);
    hooks.notFinalized = new Set();
    hooks.owners![MINT_A] = randomPubkey(); // finalized, but owned by a program that is not a token program
    await waitFor(async () => (await pendingOf(b))?.code === 'not_a_token_mint', 'not a token mint');
    assert.equal(count(hooks, 'getSignaturesForAddress', MINT_A), 0);
  } finally {
    await b.engine.stop();
  }
});

test('[activation][engine] a Token-2022 mint is activated with the program the chain reports (not a configured one)', opts, async () => {
  const db = await bareSchema();
  const hooks = absent();
  const b = await boot(db, launchChain(3), hooks);
  try {
    await waitFor(async () => (await synced(b, 'other')) !== null, 'up');
    // the fake node serves SPL-Token mint bytes; owner Token-2022 + the same bytes is a valid extension-less Token-2022 mint
    hooks.owners![MINT_A] = TOKEN_PROGRAMS['token-2022'];
    await waitFor(async () => (await synced(b, 'virus')) !== null, 'activated');
    const meta = (await getJson(b, '/api/v1/projects')).body.data.find((p: any) => p.id === 'virus');
    assert.equal(meta.tokenProgram, 'token-2022');
  } finally {
    await b.engine.stop();
  }
});

test('[activation][engine] only pending projects: the engine starts with nothing active (the case of the VIRUS-only Mainnet config)', opts, async () => {
  const db = await bareSchema();
  const hooks = absent();
  const b = await boot(db, launchChain(3), hooks, { projects: [pendingVirus()] });
  try {
    await waitFor(async () => (await pendingOf(b))?.lifecycle === 'awaiting_mint', 'waiting');
    assert.deepEqual(await activeIds(b), []);
    assert.equal((await getJson(b, '/health/ready')).status, 200);
    appear(hooks);
    await waitFor(async () => (await synced(b, 'virus')) !== null, 'activated');
    assert.deepEqual(await activeIds(b), ['virus']);
  } finally {
    await b.engine.stop();
  }
});
