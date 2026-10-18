/* `npm run mainnet:reconcile` — READ-ONLY full-history audit of real Mainnet tokens through the PRODUCTION indexer.
 *
 * For each candidate mint (mint authority revoked, signature history small enough for the audit budget):
 *   1. read every transaction of the mint's history ourselves and sum all successful MintTo/MintToChecked
 *      (= everything ever created) -> `minted`;
 *   2. run the real Indexer (real SolanaRpc, MemoryStore) from slot 0 with `initialSupply = minted`;
 *   3. the engine's own supply check (Indexer.reconcile, D8) compares `minted - supply_now` (account state, not the
 *      signature index) with the indexed burns. `verified` = the index lost no burn; `mismatch` = it did.
 * Candidates come from the latest `.mainnet/scan-*.json` (mints seen burning in real blocks) or MINTS=a,b,c. */
import { readdirSync, readFileSync } from 'node:fs';
import { parseProjectConfig } from '../../src/config/schema.ts';
import { formatUiAmount } from '../../src/core/amount.ts';
import { Indexer } from '../../src/indexer/indexer.ts';
import { MemoryStore } from '../../src/indexer/memory-store.ts';
import { parseMint } from '../../src/wallet/token-info.ts';
import { listHistory, sumHistory } from './history.ts';
import { assertMainnet, call, describeMainnetRpc, engineRpc, stats } from './rpc.ts';

const MAX_SIGS = Number(process.env.AUDIT_MAX_SIGS ?? 600);
const MAX_MINTS = Number(process.env.AUDIT_MAX_MINTS ?? 5);
console.log(`INFO  provider: ${describeMainnetRpc()}`);
await assertMainnet();

let candidates: string[];
if (process.env.MINTS) candidates = process.env.MINTS.split(',');
else {
  const dir = new URL('../../.mainnet/', import.meta.url).pathname;
  const file = readdirSync(dir).filter((f) => f.startsWith('scan-')).sort().at(-1);
  if (!file) throw new Error('run `npm run mainnet:scan` first, or pass MINTS=a,b');
  const scan = JSON.parse(readFileSync(dir + file, 'utf8'));
  candidates = Object.entries(scan.mintInfo as Record<string, { burns: number; status: string }>).filter(([, v]) => v.status !== 'deep').map(([m]) => m);
  console.log(`INFO  ${candidates.length} candidate mints from ${file}`);
}

const rpc = engineRpc();
let verified = 0, mismatched = 0, skipped = 0;
const report: unknown[] = [];
for (const mint of candidates) {
  if (verified + mismatched >= MAX_MINTS) break;
  const short = `${mint.slice(0, 6)}…`;
  const acc = await call<any>('getAccountInfo', [mint, { encoding: 'base64', commitment: 'finalized' }]);
  if (!acc?.value) { skipped++; continue; }
  let info;
  try { info = parseMint(acc.value.owner, new Uint8Array(Buffer.from(acc.value.data[0], 'base64'))); } catch (e) { console.log(`SKIP  ${short} cannot parse mint (${(e as Error).message})`); skipped++; continue; }
  if (info.mintAuthority !== null) { console.log(`SKIP  ${short} mint authority not revoked (supply check not valid)`); skipped++; continue; }
  if (info.tokenProgram === 'token-2022' && info.extensions.length > 0) console.log(`INFO  ${short} Token-2022 extensions: ${info.extensions.map((e) => e.name).join(',')}`);
  // whole history, bounded
  const { sigs, exhausted } = await listHistory(rpc, mint, MAX_SIGS);
  if (!exhausted) { console.log(`SKIP  ${short} history larger than ${MAX_SIGS} signatures (audit budget)`); skipped++; continue; }

  // (1) everything ever minted and burned, read from the raw transactions
  const sums = await sumHistory(rpc, mint, sigs);
  const { minted, burned: rawBurned, burnOps: burnInstr, transactions: txCount } = sums;
  if (sums.unavailable) console.log(`WARN  ${short} ${sums.unavailable} transaction(s) returned null`);
  const supplyNow = (await rpc.getTokenSupply(mint, 'finalized')).amountRaw;
  const project = parseProjectConfig({ id: 'audit', name: 'audit', ticker: 'AUDIT', cluster: 'mainnet-beta', mint, decimals: info.decimals, tokenProgram: info.tokenProgram, initialSupply: formatUiAmount(minted, info.decimals), levels: [{ id: 'l0', name: 'Zero', threshold: '0' }] });
  const store = new MemoryStore([project]);
  const ix = new Indexer({ project, rpc, store, pageSize: 1000, backfillPagesPerSync: 50, maxTailPages: 50 });
  const t0 = Date.now();
  const v = await ix.reconcile();
  const total = (await store.totals('audit')).finalizedRaw;
  const ok = v.status === 'verified' && total === rawBurned && minted - supplyNow === total;
  ok ? verified++ : mismatched++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${mint}  program ${info.tokenProgram}  signatures ${sigs.length} (${txCount} successful)  minted ${minted}  supply now ${supplyNow}  burned by supply ${minted - supplyNow}  burned by indexer ${total}  burned by raw decode ${rawBurned} (${burnInstr} instr)  engine verdict: ${v.status}  ${Math.round((Date.now() - t0) / 1000)} s`);
  report.push({ mint, program: info.tokenProgram, signatures: sigs.length, minted: String(minted), supplyNow: String(supplyNow), burnedIndexer: String(total), burnedRaw: String(rawBurned), verdict: v.status });
}
console.log(`RESULT  verified ${verified}, MISMATCH ${mismatched}, skipped ${skipped}`);
console.log('INFO  RPC requests (local estimate, NOT billing):', JSON.stringify(stats));
if (mismatched) process.exitCode = 1;
