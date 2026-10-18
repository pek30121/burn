/* Bulk transaction transport (Helius getTransactionsForAddress) in the indexer: it must change ONLY the number of credits,
 * never what is counted. Run against each IndexerStore implementation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcError } from '../src/chain/rpc.ts';
import { Indexer, type IndexerOptions } from '../src/indexer/indexer.ts';
import type { IndexerStore } from '../src/indexer/store.ts';
import { parseProjectConfig, type ProjectConfig } from '../src/config/schema.ts';
import { FakeChain } from './fake-chain.ts';
import { projectInput } from './helpers.ts';

const alpha = parseProjectConfig(projectInput({ initialSupply: '1000000' }));
const late = parseProjectConfig(projectInput({ id: 'late', startSlot: 6 }));
export type StoreFactory = (projects: readonly ProjectConfig[]) => Promise<IndexerStore>;

export function bulkSuite(label: string, makeStore: StoreFactory) {
const t = (name: string, fn: () => Promise<void>) => test(`[${label}][bulk] ${name}`, fn);

async function setup(over: Partial<IndexerOptions> = {}, project = alpha) {
  const chain = new FakeChain();
  const store = await makeStore([project]);
  const mk = (o: Partial<IndexerOptions> = {}) => new Indexer({ project, rpc: chain, store, pageSize: 4, batchFetch: true, batchMinTransactions: 3, ...over, ...o });
  return { chain, store, mk, ix: mk() };
}
async function drain(ix: Indexer, max = 80) {
  for (let i = 0; i < max; i++) {
    const r = await ix.syncOnce();
    if (r.error) throw new Error(r.error);
    if (!r.moreWork) return;
  }
  throw new Error('did not converge');
}
const history = (chain: FakeChain, n = 12) => { for (let s = 1; s <= n; s++) chain.add({ slot: s, burns: [BigInt(s) * 10n] }); chain.finalizedSlot = 1_000; };
const expected = (n: number) => BigInt((n * (n + 1)) / 2) * 10n;
const rows = async (store: IndexerStore, id = 'alpha') => (await store.totals(id));

t('same totals and same stored burns as the individual path, with (almost) no getTransaction', async () => {
  const bulk = await setup();
  history(bulk.chain);
  await drain(bulk.ix);
  const single = await setup({ batchFetch: false });
  history(single.chain);
  await drain(single.ix);
  assert.equal((await rows(bulk.store)).finalizedRaw, expected(12));
  assert.deepEqual(await rows(bulk.store), await rows(single.store));
  assert.equal(single.chain.bulkCalls, 0);
  assert.equal(single.chain.calls.tx, 12);
  assert.equal(bulk.chain.calls.tx, 0, 'every transaction came from the bulk call');
  assert.ok(bulk.chain.bulkCalls >= 3, 'one bulk request per page of 4 signatures');
  const st = bulk.ix.fetchStats();
  assert.equal(st.singleRequests, 0);
  assert.equal(st.fallbacks, 0);
  assert.equal(st.bulkDisabled, false);
});

t('disabled unless asked: no bulk request at all', async () => {
  const { chain, ix } = await setup({ batchFetch: false });
  history(chain);
  await drain(ix);
  assert.equal(chain.bulkCalls, 0);
});

t('a page smaller than the break-even size is fetched one by one (a bulk request has a 10-credit minimum)', async () => {
  const { chain, ix, store } = await setup({ pageSize: 2, batchMinTransactions: 3 });
  history(chain, 6);
  await drain(ix);
  assert.equal(chain.bulkCalls, 0);
  assert.equal(chain.calls.tx, 6);
  assert.equal((await rows(store)).finalizedRaw, expected(6));
});

t('entries the bulk answer omits are fetched individually: nothing is lost, only those cost a request', async () => {
  const { chain, ix, store } = await setup();
  history(chain);
  chain.bulkOmit = new Set([chain.txs[2]!.sig, chain.txs[9]!.sig]);
  await drain(ix);
  assert.equal((await rows(store)).finalizedRaw, expected(12));
  assert.equal(chain.calls.tx, 2);
  assert.equal(ix.fetchStats().fallbacks >= 2, true);
});

t('entries that are not transactions are skipped by the client and fetched individually', async () => {
  const { chain, ix, store } = await setup();
  history(chain);
  chain.bulkGarbage = new Set([chain.txs[0]!.sig, chain.txs[5]!.sig, chain.txs[11]!.sig]);
  await drain(ix);
  assert.equal((await rows(store)).finalizedRaw, expected(12));
  assert.equal(chain.calls.tx, 3);
});

t('an entry holding ANOTHER transaction is rejected by the signature check and re-read: the swapped amount is never counted', async () => {
  const { chain, ix, store } = await setup();
  history(chain);
  chain.bulkSwap = new Map([[chain.txs[1]!.sig, chain.txs[10]!.sig]]); // tx #2 (20) would be read as tx #11 (110)
  await drain(ix);
  assert.equal((await rows(store)).finalizedRaw, expected(12));
  assert.equal((await rows(store)).count, 12);
  assert.equal(chain.calls.tx, 1);
});

t('a bulk entry without inner instructions (CPI burns cannot be ruled out) is re-read before being trusted', async () => {
  const { chain, ix, store } = await setup();
  history(chain);
  chain.bulkNoInner = new Set([chain.txs[3]!.sig]);
  await drain(ix);
  assert.equal((await rows(store)).finalizedRaw, expected(12));
  assert.equal(chain.calls.tx, 1);
  assert.equal((await ix.status()).issues.length, 0, 'no incomplete_parse incident: the individual read was complete');
});

t('a bulk entry claiming "failed" for a transaction the listing says succeeded is re-read, not dropped', async () => {
  const { chain, ix, store } = await setup();
  history(chain);
  chain.bulkFailed = new Set([chain.txs[4]!.sig]);
  await drain(ix);
  assert.equal((await rows(store)).finalizedRaw, expected(12));
  assert.equal(chain.calls.tx, 1);
});

t('a method the plan does not include (non-retryable error) switches the bulk path off for good; counting continues unchanged', async () => {
  const { chain, ix, store } = await setup();
  history(chain);
  chain.bulkError = new RpcError('getTransactionsForAddress: HTTP 403', { httpStatus: 403 });
  await drain(ix);
  assert.equal(chain.bulkCalls, 1, 'tried once, then never again');
  assert.equal(chain.calls.tx, 12);
  assert.equal(ix.fetchStats().bulkDisabled, true);
  assert.equal((await rows(store)).finalizedRaw, expected(12));
});

t('a transient bulk failure skips only that chunk; the next chunk tries again', async () => {
  const { chain, ix, store } = await setup();
  history(chain);
  chain.bulkFault = { skip: 0, times: 1, error: new RpcError('getTransactionsForAddress: HTTP 503', { retryable: true, httpStatus: 503 }) };
  await drain(ix);
  assert.equal(chain.calls.tx, 4, 'the first page of 4 fell back');
  assert.equal(ix.fetchStats().bulkDisabled, false);
  assert.ok(chain.bulkCalls >= 3);
  assert.equal((await rows(store)).finalizedRaw, expected(12));
});

t('bulk pagination: a chunk spread over several bulk pages is still fully served by the bulk call', async () => {
  const { chain, ix, store } = await setup({ pageSize: 20 });
  history(chain, 20);
  chain.bulkPageSize = 6;
  await drain(ix);
  assert.equal(chain.calls.tx, 0);
  assert.equal(chain.bulkCalls, 4, '20 transactions / 6 per page');
  assert.equal((await rows(store)).finalizedRaw, expected(20));
});

t('more than one chunk (1000+) in a single tail pass: every chunk is bulk-fetched, memory stays per-chunk, totals exact', async () => {
  const { chain, ix, store } = await setup({ pageSize: 1000, batchMinTransactions: 10 });
  chain.add({ slot: 1, burns: [1n] });
  chain.finalizedSlot = 5_000;
  await drain(ix);
  for (let s = 2; s <= 2600; s++) chain.add({ slot: s, burns: [1n] });
  const base = chain.calls.tx;
  await drain(ix);
  assert.equal((await rows(store)).finalizedRaw, 2600n);
  assert.equal((await rows(store)).count, 2600);
  assert.equal(chain.calls.tx - base, 0);
  assert.ok(chain.bulkCalls >= 3);
});

t('failed transactions are not requested; transactions before startSlot are not requested', async () => {
  const { chain, ix, store } = await setup({}, late);
  for (let s = 1; s <= 10; s++) chain.add({ slot: s, burns: [10n], ...(s === 8 ? { err: { InstructionError: [0, 'x'] } } : {}) });
  chain.finalizedSlot = 1_000;
  await drain(ix);
  assert.equal((await rows(store, 'late')).finalizedRaw, 10n * 4n, 'slots 6,7,9,10 only');
  assert.equal(chain.calls.tx, 1, 'only slot 6 (a lone transaction below the break-even size); slots 1-5 and the failed slot 8 are never requested');
});

t('restart after an interruption: bulk never double counts and never skips (cursor logic unchanged)', async () => {
  const { chain, store, mk } = await setup({ checkpointEvery: 1 });
  history(chain);
  chain.bulkOmit = new Set(chain.txs.map((x) => x.sig)); // force individual reads...
  chain.txFault = { skip: 5, times: 100 }; // ...which die half way
  const first = await mk().syncOnce();
  assert.ok(first.error);
  const partial = (await rows(store)).finalizedRaw;
  assert.ok(partial > 0n && partial < expected(12));
  chain.txFault = null;
  chain.bulkOmit = new Set();
  await drain(mk()); // a brand-new indexer on the same store = a restart, now served by bulk
  assert.equal((await rows(store)).finalizedRaw, expected(12));
  assert.equal((await rows(store)).count, 12);
  await drain(mk());
  assert.equal((await rows(store)).count, 12, 'syncing again adds nothing');
});

t('tail: new burns arrive by bulk; a quiet sync costs no transaction fetch at all', async () => {
  const { chain, ix, store } = await setup();
  history(chain, 8);
  await drain(ix);
  const calls = { tx: chain.calls.tx, bulk: chain.bulkCalls };
  await ix.syncOnce();
  assert.deepEqual({ tx: chain.calls.tx, bulk: chain.bulkCalls }, calls);
  for (let s = 9; s <= 14; s++) chain.add({ slot: s, burns: [10n] });
  const r = await ix.syncOnce();
  assert.equal(r.burnsRecorded, 6);
  assert.equal(chain.calls.tx - calls.tx, 0);
  assert.equal((await rows(store)).finalizedRaw, expected(8) + 60n);
});

t('confirmed (not yet finalized) burns still use the individual call and are promoted once finalized, exactly once', async () => {
  const { chain, ix, store } = await setup({ trackConfirmed: true });
  history(chain, 6);
  await drain(ix);
  chain.add({ slot: 2_000, burns: [500n] }); // confirmed only (finalized slot is 1000)
  const r = await ix.syncOnce();
  assert.equal(r.burnsRecorded, 1);
  assert.equal((await rows(store)).finalizedRaw, expected(6), 'not counted as finalized');
  assert.equal((await rows(store)).confirmedRaw, expected(6) + 500n);
  chain.finalizedSlot = 3_000;
  const r2 = await ix.syncOnce();
  assert.equal(r2.burnsPromoted, 1);
  assert.equal((await rows(store)).finalizedRaw, expected(6) + 500n);
  assert.equal((await rows(store)).count, 7);
});

t('reconciliation against the supply still proves completeness when the transactions came from the bulk call', async () => {
  const { chain, ix } = await setup();
  history(chain);
  chain.initialSupply = 1_000_000_000_000n;
  await drain(ix);
  const v = await ix.reconcile();
  assert.equal(v.status, 'verified');
  chain.add({ slot: 13, burns: [7n], hidden: true }); // counted in the supply, never listed: still detected
  const v2 = await ix.reconcile();
  assert.equal(v2.status, 'mismatch');
});
}
