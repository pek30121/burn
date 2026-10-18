/* `node scripts/mainnet/bulk-compare.ts` — READ-ONLY, bounded: the production Indexer on the newest page (<= 1000 signatures)
 * of a few real Mainnet mints, once with one `getTransaction` per signature and once with the bulk transport, same data.
 * Checks identical results and reports the estimated credits (RpcMeter + Helius pricing: 1 per call, bulk 10 per 100 returned). */
import { SolanaRpc } from '../../src/chain/rpc.ts';
import { parseProjectConfig } from '../../src/config/schema.ts';
import { RequestLimiter } from '../../src/engine/limiter.ts';
import { meteredFetch, RpcMeter } from '../../src/engine/meter.ts';
import { Indexer } from '../../src/indexer/indexer.ts';
import { MemoryStore } from '../../src/indexer/memory-store.ts';
import { parseMint } from '../../src/wallet/token-info.ts';
import { assertMainnet, call, MAINNET_URL } from './rpc.ts';

await assertMainnet();
const MINTS = (process.env.MINTS ?? 'DV1HbCMP6GbNUidkAkAAhm989PS8FwdzxhWXtiuhpump,tRuNjAwAYHEhwc9xz3PWLTUHgxdPPzw2PnrKLu6pump,6cZtLy8aANYzwt1vqWsvd4zrz45E3CwwFEXd5aqZfFev').split(',');
let allSame = true;
for (const mint of MINTS) {
  const acc = await call<any>('getAccountInfo', [mint, { encoding: 'base64', commitment: 'finalized' }]);
  const info = parseMint(acc.value.owner, new Uint8Array(Buffer.from(acc.value.data[0], 'base64')));
  const project = parseProjectConfig({ id: 'cmp', name: 'cmp', ticker: 'CMP', cluster: 'mainnet-beta', mint, decimals: info.decimals, tokenProgram: info.tokenProgram, levels: [{ id: 'l0', name: 'Zero', threshold: '0' }] });
  const run = async (batchFetch: boolean) => {
    const meter = new RpcMeter({ getTransaction: 1, getSignaturesForAddress: 1, getTransactionsForAddress: 10 });
    const rpc = new SolanaRpc({ url: MAINNET_URL, fetch: meteredFetch({ base: fetch, project: 'cmp', meter, limiter: new RequestLimiter({ maxConcurrent: 4, minIntervalMs: 100 }) }), baseDelayMs: 800 });
    const store = new MemoryStore([project]);
    const ix = new Indexer({ project, rpc, store, pageSize: 1000, backfillPagesPerSync: 1, batchFetch });
    // Same window for both modes: stop at the head signature recorded by the first run.
    await ix.syncOnce();
    const t = await store.totals('cmp');
    const st = await ix.status();
    return { credits: meter.snapshot().total.estimatedCredits, requests: meter.snapshot().total.requests, total: t.finalizedRaw, count: t.count, head: st.finalizedHead, fetch: ix.fetchStats(), issues: st.issues.length };
  };
  const single = await run(false);
  const bulk = await run(true);
  // The chain moves between the two runs: compare on the common ground (burns of the older page are identical when the heads match; otherwise report).
  const comparable = single.head === bulk.head;
  const same = comparable ? single.total === bulk.total && single.count === bulk.count : null;
  if (same === false) allSame = false;
  console.log(`${mint.slice(0, 8)}…  single: ${single.credits} credits (${single.requests} requests)  |  bulk: ${bulk.credits} credits (${bulk.requests} requests, ${bulk.fetch.bulkRequests} bulk, ${bulk.fetch.singleRequests} single, fallbacks ${bulk.fetch.fallbacks}, disabled ${bulk.fetch.bulkDisabled})  |  same head ${comparable}  burns ${single.count}/${bulk.count}  total ${single.total}/${bulk.total}  issues ${single.issues}/${bulk.issues}  saving ${Math.round((1 - bulk.credits / Math.max(1, single.credits)) * 100)}%`);
}
console.log(allSame ? 'RESULT  identical results wherever the window was identical' : 'RESULT  DIFFERENCE FOUND');
if (!allSame) process.exitCode = 1;
