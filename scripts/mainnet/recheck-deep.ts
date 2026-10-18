/* `node scripts/mainnet/recheck-deep.ts` — READ-ONLY follow-up of `mainnet:scan`: re-verifies, with a larger page budget,
 * the mints whose history was too deep for the first pass (hot mints). Same rule: MISSED only if the pages read already
 * went past the burn's slot without listing its signature. */
import { readdirSync, readFileSync } from 'node:fs';
import { assertMainnet, describeMainnetRpc, engineRpc, stats } from './rpc.ts';

const BUDGET = Number(process.env.AUDIT_PAGE_BUDGET ?? 40);
const dir = new URL('../../.mainnet/', import.meta.url).pathname;
const file = readdirSync(dir).filter((f) => f.startsWith('scan-')).sort().at(-1)!;
const scan = JSON.parse(readFileSync(dir + file, 'utf8'));
console.log(`INFO  provider: ${describeMainnetRpc()}; re-verifying deep mints of ${file} with a ${BUDGET}-page budget`);
await assertMainnet();
const rpc = engineRpc();
const deep = Object.entries(scan.mintInfo as Record<string, { status: string }>).filter(([, v]) => v.status === 'deep').map(([m]) => m);
let found = 0, missed = 0, unverifiable = 0;
for (const mint of deep) {
  const burns = (scan.hits as any[]).filter((h) => h.mint === mint);
  const oldest = Math.min(...burns.map((h) => h.slot));
  const listed = new Set<string>();
  let before: string | undefined, pages = 0, deepest = Infinity, exhausted = false;
  while (pages < BUDGET) {
    const page = await rpc.getSignaturesForAddress(mint, { commitment: 'finalized', limit: 1000, ...(before ? { before } : {}) });
    pages++;
    for (const s of page) listed.add(s.signature);
    if (page.length < 1000) { exhausted = true; break; }
    deepest = page.at(-1)!.slot;
    before = page.at(-1)!.signature;
    if (deepest < oldest) break;
  }
  let f = 0, m = 0, u = 0;
  for (const h of burns) {
    if (listed.has(h.signature)) f++;
    else if (exhausted || deepest < h.slot) { m++; console.log(`MISSED  mint ${mint} sig ${h.signature} path ${h.path} slot ${h.slot}`); }
    else u++;
  }
  found += f; missed += m; unverifiable += u;
  console.log(`${m ? 'FAIL' : 'ok  '}  ${mint}  burns ${burns.length}  listed ${f}  missed ${m}  unverifiable ${u}  pages read ${pages}  (${listed.size} signatures)`);
}
console.log(`RESULT  deep mints ${deep.length}: listed ${found}, MISSED ${missed}, still unverifiable ${unverifiable}`);
console.log('INFO  RPC requests (local estimate, NOT billing):', JSON.stringify(stats));
if (missed) process.exitCode = 1;
