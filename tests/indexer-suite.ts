import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Indexer, type IndexerOptions } from '../src/indexer/indexer.ts';
import type { IndexerStore } from '../src/indexer/store.ts';
import type { ProjectConfig } from '../src/config/schema.ts';
import { parseProjectConfig } from '../src/config/schema.ts';
import type { LevelReachedEvent } from '../src/core/ledger.ts';
import { FakeChain } from './fake-chain.ts';
import { MINT_B, projectInput } from './helpers.ts';

const L1 = 1_000_000_000n; // raw threshold of level l1 (6 decimals)
const alpha = parseProjectConfig(projectInput({ initialSupply: '1000000' })); // 1e12 raw
const beta = parseProjectConfig(projectInput({ id: 'beta', mint: MINT_B }));

/** A proof/mismatch carries the time it was computed (`at`): check it is a recent ISO date, then compare the rest. */
const withoutAt = (v: any) => { assert.ok(v.at === undefined || Math.abs(Date.now() - Date.parse(v.at)) < 60_000, 'verification time is recent'); const { at, ...rest } = v; return rest; };

export type StoreFactory = (projects: readonly ProjectConfig[]) => Promise<IndexerStore>;

/** The behaviour every IndexerStore must give the indexer; run against each implementation. */
export function indexerSuite(label: string, makeStore: StoreFactory) {
const t = (name: string, fn: () => Promise<void>) => test(`[${label}] ${name}`, fn);

async function setup(over: Partial<IndexerOptions> = {}, chain = new FakeChain()) {
  const store = await makeStore([alpha, beta]);
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

t('backfill pages through the whole history; every burn counted once; completeness is NOT claimed', async () => {
  const { chain, ix, store } = await setup();
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

t('tail picks up new burns; failed transactions are skipped without fetching them; a quiet sync costs no getTransaction', async () => {
  const { chain, ix, store } = await setup();
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

t('restart after an interruption during backfill: resumes, no duplicates, no loss', async () => {
  const { chain, store, mk } = await setup({ checkpointEvery: 1 });
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

t('restart after an interruption during tail: the cursor never skips an unprocessed signature', async () => {
  const { chain, store, mk } = await setup({ checkpointEvery: 1 });
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

t('RPC failure while listing signatures stops the sync without moving the cursor', async () => {
  const { chain, store, ix } = await setup();
  chain.add({ slot: 1, burns: [5n] });
  fin(chain);
  chain.sigsFault = { skip: 0, times: 1 };
  const r = await ix.syncOnce();
  assert.match(r.error!, /injected/);
  assert.equal((await store.loadState('alpha')).finalizedHead, null);
  await drain(ix);
  assert.equal((await store.totals('alpha')).finalizedRaw, 5n);
});

t('a transaction the node cannot return is retried, then quarantined as a visible issue (never silently skipped)', async () => {
  const { chain, ix, store } = await setup({ maxSignatureAttempts: 3 });
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

t('malformed and unsupported-version transactions become issues; the rest of the history still counts', async () => {
  const { chain, ix, store } = await setup({ maxSignatureAttempts: 2 });
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

t('confirmed burns show in the optimistic total but never fire level events; finalization promotes and fires exactly once', async () => {
  const events: LevelReachedEvent[] = [];
  const { chain, ix, store } = await setup({ trackConfirmed: true, onEvent: (e) => void events.push(e) });
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

t('a confirmed burn on an abandoned fork is dropped once the finalized history passed its slot', async () => {
  const { chain, ix, store } = await setup({ trackConfirmed: true });
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

t('a confirmed-pass failure is only a warning; finalized indexing is unaffected', async () => {
  const { chain, ix, store } = await setup({ trackConfirmed: true });
  chain.add({ slot: 1, burns: [3n] });
  fin(chain);
  await ix.syncOnce(); // init (sigs call #1)
  chain.sigsFault = { skip: chain.calls.sigs + 1, times: 1 }; // tail ok, confirmed listing fails
  const r = await ix.syncOnce();
  assert.equal(r.error, null);
  assert.match(r.warnings.join(), /confirmed pass/);
  assert.equal((await store.totals('alpha')).finalizedRaw, 3n);
});

t('level events are delivered at least once: a failing consumer keeps them in the outbox across restarts', async () => {
  const delivered: string[] = [];
  const { chain, store, mk } = await setup();
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

t('projects are isolated: separate cursors, ledgers and events, even for a transaction burning both tokens', async () => {
  const chain = new FakeChain();
  const store = await makeStore([alpha, beta]);
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

t('startSlot: older signatures are never fetched and the backfill stops with an explicit reason', async () => {
  const p = parseProjectConfig(projectInput({ startSlot: 5 }));
  const chain = new FakeChain();
  const store = await makeStore([p]);
  const ix = new Indexer({ project: p, rpc: chain, store, pageSize: 3 });
  for (let s = 1; s <= 10; s++) chain.add({ slot: s, burns: [10n] });
  fin(chain);
  await drain(ix);
  assert.equal((await store.totals('alpha')).finalizedRaw, 60n); // slots 5..10
  assert.equal(chain.calls.tx, 6);
  assert.equal((await ix.status()).backfill, 'done_start_slot');
});

t('a gap larger than the tail window is reported, not papered over', async () => {
  const { chain, ix, store } = await setup({ maxTailPages: 2 });
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

t('signatures returned out of order are rejected as an inconsistent history', async () => {
  const { chain, ix, store } = await setup();
  for (let s = 1; s <= 3; s++) chain.add({ slot: s, burns: [5n] });
  fin(chain);
  chain.scramble = true;
  const r = await ix.syncOnce();
  assert.match(r.error!, /inconsistent/);
  assert.equal((await store.totals('alpha')).count, 0);
  assert.deepEqual((await ix.status()).issues.map((i) => i.code), ['history_inconsistent']);
});

t('reconcile: verified only when initialSupply − supply equals the indexed burns; any change invalidates it', async () => {
  const { chain, ix } = await setup();
  for (let s = 1; s <= 7; s++) chain.add({ slot: s, burns: [100n] });
  fin(chain);
  await drain(ix);
  const v = await ix.reconcile();
  assert.deepEqual(withoutAt(v), { status: 'verified', burnedRaw: '700' });
  assert.ok(typeof (v as any).at === 'string', 'the proof is time-stamped');
  assert.equal((await ix.status()).complete, true);

  chain.add({ slot: 20, burns: [30n] });
  fin(chain);
  await ix.syncOnce();
  assert.equal((await ix.status()).complete, false); // stale proof dropped
  assert.equal((await ix.reconcile()).status, 'verified');
});

t('C1: an ACTIVE mint authority makes the proof invalid: never "verified", with a stable public code (no supply is even read)', async () => {
  const { chain, ix, store } = await setup();
  for (let s = 1; s <= 4; s++) chain.add({ slot: s, burns: [100n] });
  fin(chain);
  chain.mintAuthority = 'AuthorityAuthorityAuthorityAuthority11111';
  await drain(ix);
  const v = await ix.reconcile();
  assert.equal(v.status, 'unverified');
  assert.equal((v as any).code, 'mint_authority_active');
  assert.match((v as any).reason, /authority is still active/);
  assert.equal(chain.calls.supply, 0, 'nothing is compared when the comparison would be meaningless');
  assert.equal((await ix.status()).complete, false);
  assert.equal((await store.loadState('alpha')).verification.status, 'unverified');
  // the authority is revoked later: the next proof (re-checked on-chain each time) is accepted
  chain.mintAuthority = null;
  assert.equal((await ix.reconcile()).status, 'verified');
  // ...and if it were ever active again, a stored "verified" is withdrawn
  chain.mintAuthority = 'AuthorityAuthorityAuthorityAuthority11111';
  assert.equal(((await ix.reconcile()) as any).code, 'mint_authority_active');
  assert.equal((await ix.status()).complete, false);
});

t('C1: confidential mint/burn (invisible burns), the wrapped-SOL mint and a decimals mismatch are never proven either', async () => {
  const a = await setup();
  for (let s = 1; s <= 3; s++) a.chain.add({ slot: s, burns: [100n] });
  fin(a.chain);
  await drain(a.ix);
  a.chain.mintExtensions = [{ type: 24, name: 'ConfidentialMintBurn', data: new Uint8Array(1) }];
  assert.equal(((await a.ix.reconcile()) as any).code, 'unsupported_mint_extension');
  a.chain.mintExtensions = [{ type: 18, name: 'MetadataPointer', data: new Uint8Array(64) }]; // harmless extensions do not block
  assert.equal((await a.ix.reconcile()).status, 'verified');
  a.chain.mintDecimals = 9;
  assert.equal(((await a.ix.reconcile()) as any).code, 'decimals_mismatch');

  const native = parseProjectConfig(projectInput({ id: 'native', mint: MINT_B, initialSupply: '1000000' }));
  const store = await makeStore([native]);
  const chain = new FakeChain();
  const ix = new Indexer({ project: native, rpc: chain, store, pageSize: 3 });
  assert.equal(((await ix.reconcile()) as any).code, 'native_mint');
  assert.equal(chain.calls.mintInfo ?? 0, 0);
});

t('C2: every non-proven state carries a stable code; a proof and a mismatch carry the time they were computed', async () => {
  const { chain, ix } = await setup();
  assert.equal((await ix.status()).verification.status, 'unverified');
  assert.equal(((await ix.status()).verification as any).code, 'history_not_read');
  for (let s = 1; s <= 3; s++) chain.add({ slot: s, burns: [100n] });
  chain.add({ slot: 4, burns: [7n], hidden: true });
  fin(chain);
  await drain(ix);
  const mismatch = await ix.reconcile();
  assert.equal(mismatch.status, 'mismatch');
  assert.ok(Math.abs(Date.now() - Date.parse((mismatch as any).at)) < 60_000);
  const noSupply = new Indexer({ project: parseProjectConfig(projectInput({ id: 'beta', mint: MINT_B })), rpc: chain, store: await makeStore([parseProjectConfig(projectInput({ id: 'beta', mint: MINT_B }))]), pageSize: 3 });
  assert.equal(((await noSupply.reconcile()) as any).code, 'initial_supply_not_configured');
  const late = parseProjectConfig(projectInput({ id: 'late', startSlot: 5, initialSupply: '1000000' }));
  const lateIx = new Indexer({ project: late, rpc: chain, store: await makeStore([late]), pageSize: 3 });
  assert.equal(((await lateIx.reconcile()) as any).code, 'start_slot_not_zero');
  // burns indexed after a proof: the stale proof is withdrawn with an explicit code until the next check
  const ok = await setup();
  ok.chain.add({ slot: 1, burns: [100n] });
  fin(ok.chain);
  await drain(ok.ix);
  assert.equal((await ok.ix.reconcile()).status, 'verified');
  ok.chain.add({ slot: 9, burns: [5n] });
  await ok.ix.syncOnce();
  assert.equal(((await ok.ix.status()).verification as any).code, 'indexed_changed');
});

t('C3: after a tail gap too large, widening the window catches up exactly AND the stale incident is resolved (no eternal "incomplete")', async () => {
  const { chain, store, mk } = await setup({ maxTailPages: 2 });
  chain.add({ slot: 1, burns: [100n] });
  fin(chain);
  const first = mk();
  await drain(first);
  for (let s = 2; s <= 21; s++) chain.add({ slot: s, burns: [100n] }); // a long interruption: 20 burns while the engine was down
  for (let i = 0; i < 3; i++) assert.match((await first.syncOnce()).error!, /gap too large/);
  assert.equal((await store.totals('alpha')).finalizedRaw, 100n, 'nothing skipped, nothing counted out of order');
  assert.deepEqual((await first.status()).issues.map((i) => i.code), ['tail_gap_too_large']);
  const wider = mk({ maxTailPages: 20 });
  assert.equal((await wider.syncOnce()).error, null);
  assert.equal((await store.totals('alpha')).finalizedRaw, 2100n);
  assert.equal((await store.totals('alpha')).count, 21);
  assert.deepEqual((await wider.status()).issues, [], 'the resolved incident is gone');
  assert.equal((await wider.reconcile()).status, 'verified');
  assert.equal((await wider.status()).complete, true);
});

t('C3: incidents that are NOT about listing (a quarantined transaction) are never auto-resolved', async () => {
  const { chain, ix } = await setup({ maxSignatureAttempts: 1 });
  const bad = chain.add({ slot: 1, burns: [100n] });
  chain.add({ slot: 2, burns: [5n] });
  fin(chain);
  chain.nullFor.add(bad);
  for (let i = 0; i < 3; i++) await ix.syncOnce();
  assert.ok((await ix.status()).issues.some((i) => i.code === 'tx_unavailable'));
  await ix.syncOnce();
  assert.ok((await ix.status()).issues.some((i) => i.code === 'tx_unavailable'), 'still visible: the history cannot be called complete');
});

t('reconcile: a burn missing from the node history is detected as a mismatch with the exact gap', async () => {
  const { chain, ix } = await setup();
  chain.add({ slot: 1, burns: [100n] });
  chain.add({ slot: 2, burns: [40n], hidden: true });
  fin(chain);
  await drain(ix);
  assert.deepEqual(withoutAt(await ix.reconcile()), { status: 'mismatch', expectedBurnedRaw: '140', indexedBurnedRaw: '100' });
  assert.equal((await ix.status()).complete, false);
});

t('reconcile: retries when a burn lands between the supply reading and the catch-up sync', async () => {
  const { chain, ix } = await setup();
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
  assert.deepEqual(withoutAt(await ix.reconcile()), { status: 'verified', burnedRaw: '125' });
  assert.equal(chain.calls.supply, 2);
});

t('reconcile refuses to conclude when it cannot compare', async () => {
  const noSupply = await setup({ project: beta });
  noSupply.chain.add({ slot: 1 });
  assert.match((await noSupply.ix.reconcile() as any).reason, /initialSupply is not configured/);

  const { chain, ix } = await setup();
  for (let s = 1; s <= 10; s++) chain.add({ slot: s, burns: [1n] });
  fin(chain);
  await ix.syncOnce(); // backfill still running (pageSize 3)
  const v = await ix.reconcile();
  assert.equal(v.status, 'unverified');
});

t('only one sync may run at a time', async () => {
  const { chain, ix } = await setup();
  chain.add({ slot: 1, burns: [1n] });
  fin(chain);
  const first = ix.syncOnce();
  await assert.rejects(ix.syncOnce(), /already running/);
  await first;
});

t('run() polls until aborted, sleeping only when there is nothing more to do', async () => {
  const { chain, ix, store } = await setup();
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
}
