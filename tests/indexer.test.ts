import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Indexer, type IndexerOptions } from '../src/indexer/indexer.ts';
import { MemoryStore } from '../src/indexer/memory-store.ts';
import { parseProjectConfig } from '../src/config/schema.ts';
import type { LevelReachedEvent } from '../src/core/ledger.ts';
import { FakeChain } from './fake-chain.ts';
import { MINT_B, projectInput } from './helpers.ts';

const L1 = 1_000_000_000n; // raw threshold of level l1 (6 decimals)
const alpha = parseProjectConfig(projectInput({ initialSupply: '1000000' })); // 1e12 raw
const beta = parseProjectConfig(projectInput({ id: 'beta', mint: MINT_B }));

function setup(over: Partial<IndexerOptions> = {}, chain = new FakeChain(), store = new MemoryStore([alpha, beta])) {
  const mk = (o: Partial<IndexerOptions> = {}) => new Indexer({ project: alpha, rpc: chain, store, pageSize: 3, ...over, ...o });
  return { chain, store, ix: mk(), mk };
}
async function drain(ix: Indexer, max = 50) {
  for (let i = 0; i < max; i++) {
    const r = await ix.syncOnce();
    if (r.error) throw new Error(r.error);
    if (!r.moreWork) return;
  }
  throw new Error('did not converge');
}
const fin = (chain: FakeChain, slot = 1_000) => void (chain.finalizedSlot = slot);

test('backfill pages through the whole history; every burn counted once; completeness is NOT claimed', async () => {
  const { chain, ix, store } = setup();
  for (let s = 1; s <= 10; s++) chain.add({ slot: s, burns: [100n] });
  fin(chain);
  await drain(ix);
  assert.equal((await store.totals('alpha')).finalizedRaw, 1_000n);
  assert.equal((await store.totals('alpha')).count, 10);
  assert.equal(chain.calls.tx, 10); // no signature fetched twice
  const st = await ix.status();
  assert.equal(st.backfill, 'done_exhausted');
  assert.equal(st.complete, false);
  assert.equal(st.verification.status, 'unverified');
});

test('tail picks up new burns; failed transactions are skipped without fetching them; a quiet sync costs no getTransaction', async () => {
  const { chain, ix, store } = setup();
  for (let s = 1; s <= 4; s++) chain.add({ slot: s, burns: [10n] });
  fin(chain);
  await drain(ix);
  const base = chain.calls.tx;
  chain.add({ slot: 11, burns: [5n] });
  chain.add({ slot: 12, burns: [999n], err: { InstructionError: [0, 'x'] } });
  chain.add({ slot: 13, burns: [7n] });
  const r = await ix.syncOnce();
  assert.equal(r.burnsRecorded, 2);
  assert.equal(chain.calls.tx - base, 2); // the failed one is never fetched
  assert.equal((await store.totals('alpha')).finalizedRaw, 40n + 12n);
  const quiet = chain.calls.tx;
  assert.equal((await ix.syncOnce()).burnsRecorded, 0);
  assert.equal(chain.calls.tx, quiet);
});

test('restart after an interruption during backfill: resumes, no duplicates, no loss', async () => {
  const { chain, store, mk } = setup({ checkpointEvery: 1 });
  for (let s = 1; s <= 8; s++) chain.add({ slot: s, burns: [100n] });
  fin(chain);
  chain.txFault = { skip: 4, times: 100 };
  const first = await mk().syncOnce();
  assert.ok(first.error);
  const partial = (await store.totals('alpha')).finalizedRaw;
  assert.ok(partial > 0n && partial < 800n, `partial=${partial}`);

  chain.txFault = null;
  const calls = chain.calls.tx;
  await drain(mk()); // a brand-new Indexer on the same store = restart
  assert.equal((await store.totals('alpha')).finalizedRaw, 800n);
  assert.equal((await store.totals('alpha')).count, 8);
  assert.ok(chain.calls.tx - calls <= 5, 'resume should not refetch what the cursor already passed');
});

test('restart after an interruption during tail: the cursor never skips an unprocessed signature', async () => {
  const { chain, store, mk } = setup({ checkpointEvery: 1 });
  chain.add({ slot: 1, burns: [1n] });
  fin(chain);
  await drain(mk());
  for (let s = 2; s <= 7; s++) chain.add({ slot: s, burns: [10n] });
  const base = chain.calls.tx;
  chain.txFault = { skip: base + 2, times: 100 };
  assert.ok((await mk().syncOnce()).error);
  assert.equal((await store.totals('alpha')).finalizedRaw, 21n); // 1 + two oldest of the new ones
  chain.txFault = null;
  await drain(mk());
  assert.equal((await store.totals('alpha')).finalizedRaw, 61n);
  assert.equal((await store.totals('alpha')).count, 7);
});

test('RPC failure while listing signatures stops the sync without moving the cursor', async () => {
  const { chain, store, ix } = setup();
  chain.add({ slot: 1, burns: [5n] });
  fin(chain);
  chain.sigsFault = { skip: 0, times: 1 };
  const r = await ix.syncOnce();
  assert.match(r.error!, /injected/);
  assert.equal((await store.loadState('alpha')).finalizedHead, null);
  await drain(ix);
  assert.equal((await store.totals('alpha')).finalizedRaw, 5n);
});

test('a transaction the node cannot return is retried, then quarantined as a visible issue (never silently skipped)', async () => {
  const { chain, ix, store } = setup({ maxSignatureAttempts: 3 });
  chain.add({ slot: 1, burns: [1n] });
  fin(chain);
  await drain(ix);
  const lost = chain.add({ slot: 2, burns: [50n] });
  chain.add({ slot: 3, burns: [7n] });
  chain.nullFor.add(lost);
  assert.match((await ix.syncOnce()).error!, /tx_unavailable.*attempt 1\/3/);
  assert.match((await ix.syncOnce()).error!, /attempt 2\/3/);
  assert.equal((await ix.syncOnce()).error, null);
  assert.equal((await store.totals('alpha')).finalizedRaw, 8n); // 1 + 7, the lost 50 is missing...
  const st = await ix.status();
  assert.deepEqual(st.issues.map((i) => [i.code, i.signature]), [['tx_unavailable', lost]]); // ...and that is exposed
  assert.equal(st.complete, false);
  assert.equal((await ix.reconcile()).status, 'mismatch'); // the supply proves something is missing
});

test('malformed and unsupported-version transactions become issues; the rest of the history still counts', async () => {
  const { chain, ix, store } = setup({ maxSignatureAttempts: 2 });
  chain.add({ slot: 1, burns: [1n] });
  const bad = chain.add({ slot: 2, response: { nonsense: true } });
  const v2 = chain.add({ slot: 3, burns: [9n] });
  chain.add({ slot: 4, burns: [2n] });
  chain.versionErrorFor.add(v2);
  fin(chain);
  assert.ok((await ix.syncOnce()).error); // malformed: attempt 1
  await drain(ix);
  assert.equal((await store.totals('alpha')).finalizedRaw, 3n);
  const codes = Object.fromEntries((await ix.status()).issues.map((i) => [i.signature, i.code]));
  assert.deepEqual(codes, { [bad]: 'malformed', [v2]: 'unsupported_version' });
});

test('confirmed burns show in the optimistic total but never fire level events; finalization promotes and fires exactly once', async () => {
  const events: LevelReachedEvent[] = [];
  const { chain, ix, store } = setup({ trackConfirmed: true, onEvent: (e) => void events.push(e) });
  chain.add({ slot: 1 }); // creation-like tx, finalized
  chain.finalizedSlot = 1;
  await drain(ix);
  chain.add({ slot: 5, burns: [L1] }); // confirmed only
  const r1 = await ix.syncOnce();
  assert.equal(r1.burnsRecorded, 1);
  let t = await store.totals('alpha');
  assert.deepEqual([t.finalizedRaw, t.confirmedRaw], [0n, L1]);
  assert.equal((await ix.status()).progress.level.id, 'l0');
  assert.equal(events.length, 0);
  await ix.syncOnce(); // already seen: no refetch
  assert.equal(chain.calls.tx, 2);

  chain.finalizedSlot = 5;
  const r2 = await ix.syncOnce();
  assert.equal(r2.burnsPromoted, 1);
  t = await store.totals('alpha');
  assert.deepEqual([t.finalizedRaw, t.confirmedRaw], [L1, L1]);
  assert.deepEqual(events.map((e) => e.level.id), ['l1']);
  await ix.syncOnce();
  await ix.syncOnce();
  assert.equal(events.length, 1);
});

test('a confirmed burn on an abandoned fork is dropped once the finalized history passed its slot', async () => {
  const { chain, ix, store } = setup({ trackConfirmed: true });
  chain.add({ slot: 1 });
  chain.finalizedSlot = 1;
  await drain(ix);
  const forked = chain.add({ slot: 7, burns: [500n] });
  await ix.syncOnce();
  assert.equal((await store.totals('alpha')).confirmedRaw, 500n);
  chain.remove(forked);
  chain.add({ slot: 9 });
  chain.finalizedSlot = 9;
  const r = await ix.syncOnce();
  assert.equal(r.burnsDropped, 1);
  assert.deepEqual(await store.totals('alpha'), { finalizedRaw: 0n, confirmedRaw: 0n, count: 0 });
});

test('a confirmed-pass failure is only a warning; finalized indexing is unaffected', async () => {
  const { chain, ix, store } = setup({ trackConfirmed: true });
  chain.add({ slot: 1, burns: [3n] });
  fin(chain);
  await ix.syncOnce(); // init (sigs call #1)
  chain.sigsFault = { skip: chain.calls.sigs + 1, times: 1 }; // tail ok, confirmed listing fails
  const r = await ix.syncOnce();
  assert.equal(r.error, null);
  assert.match(r.warnings.join(), /confirmed pass/);
  assert.equal((await store.totals('alpha')).finalizedRaw, 3n);
});

test('level events are delivered at least once: a failing consumer keeps them in the outbox across restarts', async () => {
  const delivered: string[] = [];
  const { chain, store, mk } = setup();
  chain.add({ slot: 1, burns: [L1] });
  fin(chain);
  const r1 = await mk({ onEvent: () => { throw new Error('consumer down'); } }).syncOnce();
  assert.match(r1.warnings.join(), /event delivery failed/);
  assert.equal((await store.pendingEvents('alpha')).length, 1);

  const r2 = await mk({ onEvent: (e) => void delivered.push(e.level.id) }).syncOnce(); // restart
  assert.equal(r2.eventsDelivered, 1);
  assert.deepEqual(delivered, ['l1']);
  assert.equal((await store.pendingEvents('alpha')).length, 0);
  await mk({ onEvent: (e) => void delivered.push(e.level.id) }).syncOnce();
  assert.deepEqual(delivered, ['l1']);
});

test('projects are isolated: separate cursors, ledgers and events, even for a transaction burning both tokens', async () => {
  const chain = new FakeChain();
  const store = new MemoryStore([alpha, beta]);
  const ia = new Indexer({ project: alpha, rpc: chain, store, pageSize: 3 });
  const ib = new Indexer({ project: beta, rpc: chain, store, pageSize: 3 });
  chain.add({ slot: 1, burns: [100n], burnsB: [7n] }); // one transaction, two tokens
  chain.add({ slot: 2, burns: [50n] });
  fin(chain);
  await drain(ia);
  assert.equal((await store.totals('alpha')).finalizedRaw, 150n);
  assert.equal((await store.totals('beta')).finalizedRaw, 0n); // beta not synced yet
  assert.equal((await store.loadState('beta')).finalizedHead, null);
  await drain(ib);
  assert.equal((await store.totals('beta')).finalizedRaw, 7n);
  assert.equal((await store.totals('alpha')).finalizedRaw, 150n);
  await assert.rejects(store.totals('ghost'), /unknown project/);
});

test('startSlot: older signatures are never fetched and the backfill stops with an explicit reason', async () => {
  const p = parseProjectConfig(projectInput({ startSlot: 5 }));
  const chain = new FakeChain();
  const store = new MemoryStore([p]);
  const ix = new Indexer({ project: p, rpc: chain, store, pageSize: 3 });
  for (let s = 1; s <= 10; s++) chain.add({ slot: s, burns: [10n] });
  fin(chain);
  await drain(ix);
  assert.equal((await store.totals('alpha')).finalizedRaw, 60n); // slots 5..10
  assert.equal(chain.calls.tx, 6);
  assert.equal((await ix.status()).backfill, 'done_start_slot');
});

test('a gap larger than the tail window is reported, not papered over', async () => {
  const { chain, ix, store } = setup({ maxTailPages: 2 });
  const head = chain.add({ slot: 1, burns: [1n] });
  fin(chain);
  await drain(ix);
  const before = (await store.loadState('alpha')).finalizedHead;
  chain.remove(head); // node no longer knows the stored head (pruned) -> `until` ignored
  for (let s = 2; s <= 9; s++) chain.add({ slot: s, burns: [1n] });
  const r = await ix.syncOnce();
  assert.match(r.error!, /gap too large/);
  assert.equal((await store.loadState('alpha')).finalizedHead, before);
  assert.deepEqual((await ix.status()).issues.map((i) => i.code), ['tail_gap_too_large']);
});

test('signatures returned out of order are rejected as an inconsistent history', async () => {
  const { chain, ix, store } = setup();
  for (let s = 1; s <= 3; s++) chain.add({ slot: s, burns: [5n] });
  fin(chain);
  chain.scramble = true;
  const r = await ix.syncOnce();
  assert.match(r.error!, /inconsistent/);
  assert.equal((await store.totals('alpha')).count, 0);
  assert.deepEqual((await ix.status()).issues.map((i) => i.code), ['history_inconsistent']);
});

test('reconcile: verified only when initialSupply − supply equals the indexed burns; any change invalidates it', async () => {
  const { chain, ix } = setup();
  for (let s = 1; s <= 7; s++) chain.add({ slot: s, burns: [100n] });
  fin(chain);
  await drain(ix);
  const v = await ix.reconcile();
  assert.deepEqual(v, { status: 'verified', burnedRaw: '700' });
  assert.equal((await ix.status()).complete, true);

  chain.add({ slot: 20, burns: [30n] });
  fin(chain);
  await ix.syncOnce();
  assert.equal((await ix.status()).complete, false); // stale proof dropped
  assert.equal((await ix.reconcile()).status, 'verified');
});

test('reconcile: a burn missing from the node history is detected as a mismatch with the exact gap', async () => {
  const { chain, ix } = setup();
  chain.add({ slot: 1, burns: [100n] });
  chain.add({ slot: 2, burns: [40n], hidden: true });
  fin(chain);
  await drain(ix);
  assert.deepEqual(await ix.reconcile(), { status: 'mismatch', expectedBurnedRaw: '140', indexedBurnedRaw: '100' });
  assert.equal((await ix.status()).complete, false);
});

test('reconcile: retries when a burn lands between the supply reading and the catch-up sync', async () => {
  const { chain, ix } = setup();
  chain.add({ slot: 1, burns: [100n] });
  fin(chain);
  await drain(ix);
  let injected = false;
  chain.afterSupply = () => {
    if (injected) return;
    injected = true;
    chain.add({ slot: 30, burns: [25n] });
    fin(chain);
  };
  assert.deepEqual(await ix.reconcile(), { status: 'verified', burnedRaw: '125' });
  assert.equal(chain.calls.supply, 2);
});

test('reconcile refuses to conclude when it cannot compare', async () => {
  const noSupply = setup({ project: beta });
  noSupply.chain.add({ slot: 1 });
  assert.match((await noSupply.ix.reconcile() as any).reason, /initialSupply is not configured/);

  const { chain, ix } = setup();
  for (let s = 1; s <= 10; s++) chain.add({ slot: s, burns: [1n] });
  fin(chain);
  await ix.syncOnce(); // backfill still running (pageSize 3)
  const v = await ix.reconcile();
  assert.equal(v.status, 'unverified');
});

test('only one sync may run at a time', async () => {
  const { chain, ix } = setup();
  chain.add({ slot: 1, burns: [1n] });
  fin(chain);
  const first = ix.syncOnce();
  await assert.rejects(ix.syncOnce(), /already running/);
  await first;
});

test('run() polls until aborted, sleeping only when there is nothing more to do', async () => {
  const { chain, ix, store } = setup();
  for (let s = 1; s <= 7; s++) chain.add({ slot: s, burns: [2n] });
  fin(chain);
  const ctl = new AbortController();
  let sleeps = 0;
  await ix.run(ctl.signal, 1000, async () => {
    if (++sleeps === 2) ctl.abort();
  });
  assert.equal((await store.totals('alpha')).finalizedRaw, 14n);
  assert.equal(sleeps, 2);
});
