/* `npm run mainnet:scan` — READ-ONLY audit of the burn-discovery hypothesis on real Mainnet blocks (D7 / E1).
 *
 * Reference source (independent of the address index): whole finalized blocks (`getBlock`). Every Token /
 * Token-2022 Burn and BurnChecked instruction, outer or inner (CPI), of every successful transaction is decoded
 * directly from the block. For each (mint, signature) we then ask the address index the way the engine does
 * (`getSignaturesForAddress(mint)`, finalized, 1000 per page, newest first) and check that it is listed.
 * A signature is only called MISSED if the pages read have already gone past the burn's slot (so the page
 * that should contain it was read); otherwise it is UNVERIFIABLE (too deep for the page budget), never "found". */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseBurns } from '../../src/chain/burn-parser.ts';
import { decodeBase58 } from '../../src/core/base58.ts';
import { TOKEN_PROGRAMS } from '../../src/config/schema.ts';
import { assertMainnet, call, describeMainnetRpc, engineRpc, stats } from './rpc.ts';

const BLOCKS = Number(process.env.AUDIT_BLOCKS ?? 40);
const MARGIN = Number(process.env.AUDIT_FINALITY_MARGIN ?? 300); // slots older than the finalized tip, so every index has caught up
const PAGE_BUDGET = Number(process.env.AUDIT_PAGE_BUDGET ?? 4);
const PROGRAMS = new Map<string, string>(Object.entries(TOKEN_PROGRAMS).map(([n, id]) => [id, n]));

console.log(`INFO  provider: ${describeMainnetRpc()}`);
await assertMainnet();
const rpc = engineRpc();
const tip = await call<number>('getSlot', [{ commitment: 'finalized' }]);
const end = tip - MARGIN;
const slots = (await call<number[]>('getBlocks', [end - BLOCKS * 2, end, { commitment: 'finalized' }])).slice(-BLOCKS);
console.log(`INFO  finalized tip ${tip}; scanning ${slots.length} blocks ${slots[0]}..${slots.at(-1)}`);

interface Hit { mintFrom: 'static' | 'alt'; authority: string; mint: string; signature: string; slot: number; path: string; amountRaw: bigint; program: string; kind: string; version: unknown; innerRecorded: boolean }
const hits: Hit[] = [];
let txs = 0, failedWithBurn = 0, blocksFetched = 0;
const raw = new Map<string, any>();

for (const slot of slots) {
  const b = await call<any>('getBlock', [slot, { encoding: 'json', transactionDetails: 'full', rewards: false, maxSupportedTransactionVersion: 1, commitment: 'finalized' }]).catch((e) => { console.log(`WARN  getBlock ${slot}: ${e.message}`); return null; });
  if (!b) continue;
  blocksFetched++;
  for (const t of b.transactions as any[]) {
    txs++;
    const msg = t.transaction.message;
    const keys: string[] = [...msg.accountKeys, ...(t.meta?.loadedAddresses?.writable ?? []), ...(t.meta?.loadedAddresses?.readonly ?? [])];
    const found: Omit<Hit, 'signature' | 'slot' | 'version' | 'innerRecorded'>[] = [];
    const nStatic = msg.accountKeys.length;
    const visit = (ix: any, path: string) => {
      const prog = PROGRAMS.get(keys[ix.programIdIndex]!);
      if (!prog) return;
      const d = decodeBase58(ix.data);
      if (!d || (d[0] !== 8 && d[0] !== 15)) return;
      const amount = new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(1, true);
      found.push({ mintFrom: ix.accounts[1] < nStatic ? 'static' : 'alt', authority: keys[ix.accounts[2]]!, mint: keys[ix.accounts[1]]!, path, amountRaw: amount, program: prog, kind: d[0] === 8 ? 'burn' : 'burnChecked' });
    };
    msg.instructions.forEach((ix: any, i: number) => visit(ix, String(i)));
    for (const g of t.meta?.innerInstructions ?? []) g.instructions.forEach((ix: any, j: number) => visit(ix, `${g.index}.${j}`));
    if (found.length === 0) continue;
    if (t.meta?.err !== null) { failedWithBurn++; continue; }
    const signature = t.transaction.signatures[0];
    raw.set(signature, { slot, blockTime: b.blockTime, ...t });
    for (const f of found) if (f.amountRaw > 0n) hits.push({ ...f, signature, slot, version: t.version ?? 'legacy', innerRecorded: t.meta?.innerInstructions != null });
  }
}
console.log(`INFO  blocks fetched ${blocksFetched}/${slots.length}, transactions ${txs}, successful burn instructions ${hits.length} (${new Set(hits.map((h) => h.signature)).size} tx, ${new Set(hits.map((h) => h.mint)).size} mints), failed txs containing a burn (ignored) ${failedWithBurn}`);

/* ---- engine parser agrees with the raw block decode? (same tx, parseBurns per mint) ---- */
let parserOk = 0, parserBad = 0;
const parserDiffs: string[] = [];
for (const [sig, mints] of groupBy(hits, (h) => `${h.signature}`)) {
  for (const mint of new Set(mints.map((m) => m.mint))) {
    const expected = mints.filter((m) => m.mint === mint);
    const p = parseBurns(raw.get(sig), { mint, expectedSignature: sig });
    const got = p.status === 'ok' ? p.burns.map((x) => `${x.instructionPath}:${x.amountRaw}`).sort() : [`status:${p.status}`];
    const exp = expected.map((x) => `${x.path}:${x.amountRaw}`).sort();
    if (JSON.stringify(got) === JSON.stringify(exp) && p.status === 'ok' && p.complete) parserOk++; else { parserBad++; parserDiffs.push(`${sig.slice(0, 12)}… ${mint.slice(0, 8)}… exp=${exp} got=${got}`); }
  }
}
console.log(`INFO  engine parser vs raw block decode: ${parserOk} (tx,mint) agree, ${parserBad} differ ${parserDiffs.slice(0, 5).join(' | ')}`);

/* ---- address index vs blocks ---- */
const verdicts = { found: 0, missed: [] as Hit[], unverifiable: [] as Hit[] };
const byMint = groupBy(hits, (h) => h.mint);
const mintInfo: Record<string, { burns: number; pages: number; deepest: number; status: string }> = {};
let mintNo = 0;
for (const [mint, list] of byMint) {
  mintNo++;
  const oldest = Math.min(...list.map((h) => h.slot));
  const listed = new Set<string>();
  let before: string | undefined, pages = 0, deepest = Infinity, exhausted = false;
  try {
    while (pages < PAGE_BUDGET) {
      const page = await rpc.getSignaturesForAddress(mint, { commitment: 'finalized', limit: 1000, ...(before ? { before } : {}) });
      pages++;
      for (const s of page) listed.add(s.signature);
      if (page.length < 1000) { exhausted = true; deepest = 0; break; }
      deepest = page.at(-1)!.slot;
      before = page.at(-1)!.signature;
      if (deepest < oldest) break; // went past every burn we are checking for this mint
    }
  } catch (e) { console.log(`WARN  mint ${mint}: ${(e as Error).message}`); }
  let status = 'ok';
  for (const h of list) {
    if (listed.has(h.signature)) verdicts.found++;
    else if (exhausted || deepest < h.slot) { verdicts.missed.push(h); status = 'MISSED'; }
    else { verdicts.unverifiable.push(h); if (status === 'ok') status = 'deep'; }
  }
  mintInfo[mint] = { burns: list.length, pages, deepest: Number.isFinite(deepest) ? deepest : -1, status };
  if (mintNo % 10 === 0) console.log(`INFO  ... ${mintNo}/${byMint.size} mints checked`);
}
console.log(`RESULT  burn instructions ${hits.length}: listed in the mint's signature history ${verdicts.found}, MISSED ${verdicts.missed.length}, unverifiable (history deeper than ${PAGE_BUDGET} pages) ${verdicts.unverifiable.length}`);
for (const h of verdicts.missed) console.log(`MISSED  mint ${h.mint} sig ${h.signature} path ${h.path} slot ${h.slot} ${h.kind} ${h.program} v${h.version} amountRaw ${h.amountRaw}`);
const dist = (f: (h: Hit) => string) => { const m: Record<string, number> = {}; for (const h of hits) m[f(h)] = (m[f(h)] ?? 0) + 1; return m; };
console.log('INFO  coverage of the sample:', JSON.stringify({ program: dist((h) => h.program), kind: dist((h) => h.kind), version: dist((h) => String(h.version)), cpi: dist((h) => (h.path.includes('.') ? 'cpi' : 'direct')), mintFrom: dist((h) => h.mintFrom), distinctAuthorities: new Set(hits.map((h) => h.authority)).size }));
console.log('INFO  RPC requests (local estimate, NOT billing):', JSON.stringify(stats));
mkdirSync(new URL('../../.mainnet/', import.meta.url).pathname, { recursive: true });
writeFileSync(new URL(`../../.mainnet/scan-${Date.now()}.json`, import.meta.url).pathname, JSON.stringify({ at: new Date().toISOString(), slots: [slots[0], slots.at(-1)], hits: hits.map((h) => ({ ...h, amountRaw: h.amountRaw.toString() })), mintInfo, missed: verdicts.missed.map((h) => ({ ...h, amountRaw: h.amountRaw.toString() })) }, null, 1));
if (verdicts.missed.length || parserBad) process.exitCode = 1;

function groupBy<T>(xs: T[], f: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) { const k = f(x); (m.get(k) ?? m.set(k, []).get(k)!).push(x); }
  return m;
}
