import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, loadDbConfig } from '../src/db/config.ts';
import { ConfigMismatchError, StaleStateError, StoreError } from '../src/db/errors.ts';
import { MigrationError, runMigrations } from '../src/db/migrate.ts';
import { Indexer } from '../src/indexer/indexer.ts';
import { PgStore } from '../src/indexer/pg-store.ts';
import { parseProjectConfig } from '../src/config/schema.ts';
import { burnKey, type BurnInput } from '../src/core/ledger.ts';
import { FakeChain } from './fake-chain.ts';
import { burn, MINT_A, MINT_B, projectInput, randomSignature } from './helpers.ts';
import { freshSchema, freshStore, pgSkip, TEST_URL } from './pg-harness.ts';

const alpha = parseProjectConfig(projectInput());
const beta = parseProjectConfig(projectInput({ id: 'beta', mint: MINT_B }));
const L1 = 1_000_000_000n;
const opts = { skip: pgSkip };
const finalized = (o: Partial<BurnInput> = {}) => burn({ commitment: 'finalized', ...o });

/* ------------------------------ migrations ------------------------------ */

test('[pg] migrations apply once, are reproducible, and concurrent runners do not clash', opts, async () => {
  const ctx = await freshSchema(); // freshSchema already applied 0001
  const again = await runMigrations(ctx.pool);
  assert.deepEqual(again, { applied: [], alreadyApplied: 1 });

  // A brand-new schema migrated by 4 runners at the same time ends up with exactly one record.
  const other = await freshSchema().then(async (c) => {
    await c.pool.query('DROP TABLE schema_migrations, index_issues, index_state, level_events, project_counters, burns, levels, projects CASCADE');
    return c;
  });
  const results = await Promise.all([1, 2, 3, 4].map(() => runMigrations(other.newPool())));
  assert.equal(results.reduce((n, r) => n + r.applied.length, 0), 1);
  assert.equal((await other.pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 1);
});

test('[pg] a migration modified after being applied is refused; numbering gaps are refused', opts, async () => {
  const ctx = await freshSchema();
  const dir = await mkdtemp(join(tmpdir(), 'mig-'));
  const original = await readFile(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');
  await writeFile(join(dir, '0001_init.sql'), original + '\n-- tampered\n');
  await assert.rejects(runMigrations(ctx.pool, dir), (e: Error) => e instanceof MigrationError && /modified after being applied/.test(e.message));

  const gap = await mkdtemp(join(tmpdir(), 'mig-'));
  await writeFile(join(gap, '0002_x.sql'), 'SELECT 1');
  await assert.rejects(runMigrations(ctx.pool, gap), /without gaps/);
});

test('[pg] a failing migration rolls back completely and is not recorded', opts, async () => {
  const ctx = await freshSchema();
  const dir = await mkdtemp(join(tmpdir(), 'mig-'));
  await writeFile(join(dir, '0001_init.sql'), await readFile(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  await writeFile(join(dir, '0002_bad.sql'), 'CREATE TABLE half_done (id int); SELECT 1/0;');
  await assert.rejects(runMigrations(ctx.pool, dir), StoreError);
  assert.equal((await ctx.pool.query("SELECT to_regclass('half_done') AS t")).rows[0].t, null);
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 1);
});

/* ----------------------- uniqueness / exact amounts --------------------- */

test('[pg] the same burn is never counted twice, however often it is replayed', opts, async () => {
  const { store } = await freshStore([alpha]);
  const b = finalized({ amountRaw: 500n });
  assert.equal((await store.recordBurn('alpha', b)).status, 'inserted');
  for (let i = 0; i < 5; i++) assert.equal((await store.recordBurn('alpha', { ...b })).status, 'duplicate');
  assert.deepEqual(await store.totals('alpha'), { finalizedRaw: 500n, confirmedRaw: 500n, count: 1 });
  const conflict = await store.recordBurn('alpha', { ...b, amountRaw: 9n });
  assert.deepEqual(conflict, { status: 'rejected', reason: 'conflicts with an already recorded burn' });
  assert.equal((await store.totals('alpha')).finalizedRaw, 500n);
});

test('[pg] the database itself enforces uniqueness and amount bounds (not only the application)', opts, async () => {
  const { store, ctx } = await freshStore([alpha]);
  const b = finalized();
  await store.recordBurn('alpha', b);
  const ins = (sig: string, path: string, amount: string, commitment = 'finalized') =>
    ctx.pool.query(
      `INSERT INTO burns (project_id, signature, instruction_path, slot, owner, amount_raw, commitment, finalized_at)
       VALUES ('alpha', $1, $2, 1, 'o', $3, $4, CASE WHEN $4 = 'finalized' THEN now() END)`,
      [sig, path, amount, commitment],
    );
  await assert.rejects(ins(b.signature, b.instructionPath, '1'), (e: StoreError) => e.code === '23505');
  for (const bad of ['0', '-5', '18446744073709551616']) {
    await assert.rejects(ins(randomSignature(), '0', bad), (e: StoreError) => e.code === '23514', bad);
  }
  await assert.rejects(ins(randomSignature(), 'x.y', '1'), (e: StoreError) => e.code === '23514');
  await assert.rejects(ctx.pool.query(`INSERT INTO burns (project_id, signature, instruction_path, slot, owner, amount_raw, commitment) VALUES ('ghost','s','0',1,'o',1,'confirmed')`), (e: StoreError) => e.code === '23503');
});

test('[pg] amounts are exact beyond 2^53 and up to u64 max', opts, async () => {
  const { store } = await freshStore([alpha]);
  const max = 2n ** 64n - 1n;
  await store.recordBurn('alpha', finalized({ amountRaw: max }));
  assert.equal((await store.totals('alpha')).finalizedRaw, max);
  const { store: s2 } = await freshStore([alpha]);
  const odd = 9_007_199_254_740_993n;
  for (let i = 0; i < 3; i++) await s2.recordBurn('alpha', finalized({ amountRaw: odd }));
  assert.equal((await s2.totals('alpha')).finalizedRaw, odd * 3n);
});

/* ------------------------------ atomicity ------------------------------- */

test('[pg] a failure in the middle of recordBurn rolls back burn, counters and events together', opts, async () => {
  const { store, ctx } = await freshStore([alpha]);
  await ctx.pool.query(`
    CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
    CREATE TRIGGER fail_events BEFORE INSERT ON level_events FOR EACH ROW EXECUTE FUNCTION boom();`);
  const crossing = finalized({ amountRaw: L1 });
  await assert.rejects(store.recordBurn('alpha', crossing), /injected failure/);
  assert.deepEqual(await store.totals('alpha'), { finalizedRaw: 0n, confirmedRaw: 0n, count: 0 });
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM burns')).rows[0].n, 0);
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM level_events')).rows[0].n, 0);

  await ctx.pool.query('DROP TRIGGER fail_events ON level_events'); // incident over: the same burn is accepted exactly once
  const ok = await store.recordBurn('alpha', crossing);
  assert.equal(ok.status === 'inserted' && ok.events.map((e) => e.level.id).join(), 'l1');
  assert.equal((await store.recordBurn('alpha', crossing)).status, 'duplicate');
  assert.equal((await store.totals('alpha')).finalizedRaw, L1);
});

test('[pg] a failure while promoting or dropping also leaves everything untouched', opts, async () => {
  const { store, ctx } = await freshStore([alpha]);
  const c = burn({ amountRaw: L1, commitment: 'confirmed' });
  await store.recordBurn('alpha', c);
  await ctx.pool.query(`
    CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
    CREATE TRIGGER fail_events BEFORE INSERT ON level_events FOR EACH ROW EXECUTE FUNCTION boom();`);
  await assert.rejects(store.recordBurn('alpha', { ...c, commitment: 'finalized' }), /injected failure/);
  assert.equal((await store.pendingConfirmed('alpha')).length, 1); // still confirmed, not half-promoted
  assert.deepEqual(await store.totals('alpha'), { finalizedRaw: 0n, confirmedRaw: L1, count: 1 });
  await ctx.pool.query('DROP TRIGGER fail_events ON level_events');
  assert.equal((await store.recordBurn('alpha', { ...c, commitment: 'finalized' })).status, 'promoted');
  assert.equal(await store.dropConfirmed('alpha', burnKey(c.signature, c.instructionPath)), false); // finalized burns are never dropped
});

test('[pg] counters always equal the sum of the burn rows', opts, async () => {
  const { store, ctx } = await freshStore([alpha]);
  const rows = Array.from({ length: 12 }, (_, i) => burn({ amountRaw: BigInt(i + 1) * 1_000n, commitment: i % 3 === 0 ? 'confirmed' : 'finalized', slot: 100 + i }));
  for (const r of rows) await store.recordBurn('alpha', r);
  await store.recordBurn('alpha', { ...rows[0]!, commitment: 'finalized' }); // promote one
  await store.dropConfirmed('alpha', burnKey(rows[3]!.signature, rows[3]!.instructionPath)); // no-op: finalized
  await store.dropConfirmed('alpha', burnKey(rows[6]!.signature, rows[6]!.instructionPath)); // drops a confirmed one
  const t = await store.totals('alpha');
  const sums = (await ctx.pool.query(
    `SELECT coalesce(sum(amount_raw) FILTER (WHERE commitment='finalized'),0)::text AS f,
            coalesce(sum(amount_raw),0)::text AS a, count(*)::int AS n FROM burns WHERE project_id='alpha'`)).rows[0];
  assert.deepEqual([t.finalizedRaw.toString(), t.confirmedRaw.toString(), t.count], [sums.f, sums.a, sums.n]);
});

/* ------------------------------ concurrency ----------------------------- */

test('[pg] 25 concurrent writers of the same burn produce exactly one insert', opts, async () => {
  const { store } = await freshStore([alpha]);
  const b = finalized({ amountRaw: 777n });
  const results = await Promise.all(Array.from({ length: 25 }, () => store.recordBurn('alpha', { ...b })));
  assert.deepEqual(results.map((r) => r.status).sort().filter((s) => s === 'inserted').length, 1);
  assert.ok(results.every((r) => r.status === 'inserted' || r.status === 'duplicate'));
  assert.deepEqual(await store.totals('alpha'), { finalizedRaw: 777n, confirmedRaw: 777n, count: 1 });
});

test('[pg] concurrent distinct burns across a threshold: exact total and the level fires exactly once', opts, async () => {
  const { store, ctx } = await freshStore([alpha]);
  const burns = Array.from({ length: 40 }, () => finalized({ amountRaw: L1 / 10n })); // 40 × 0.1·L1 crosses l1 (and more)
  const results = await Promise.all(burns.map((b) => store.recordBurn('alpha', b)));
  assert.equal((await store.totals('alpha')).finalizedRaw, 4n * L1);
  const fired = results.flatMap((r) => (r.status === 'rejected' ? [] : r.events.map((e) => e.level.id)));
  assert.deepEqual(fired.sort(), ['l1']); // 4·L1 = 4000 UI < l2 (5000.5)
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM level_events')).rows[0].n, 1);
});

test('[pg] concurrent promote + duplicate + drop of the same burn stays consistent', opts, async () => {
  const { store } = await freshStore([alpha]);
  const c = burn({ amountRaw: 100n, commitment: 'confirmed' });
  await store.recordBurn('alpha', c);
  const key = burnKey(c.signature, c.instructionPath);
  const [a, b, d] = await Promise.all([store.recordBurn('alpha', { ...c, commitment: 'finalized' }), store.dropConfirmed('alpha', key), store.recordBurn('alpha', { ...c })]);
  const t = await store.totals('alpha');
  // Either the drop won (burn gone, then the others re-insert/duplicate) or the promotion won (drop is a no-op): never a mixed state.
  assert.ok(t.finalizedRaw === 0n || t.finalizedRaw === 100n);
  assert.ok(t.count === 0 || t.count === 1);
  assert.equal(t.confirmedRaw >= t.finalizedRaw, true);
  void a; void b; void d;
});

/* --------------------------- outbox / persistence ----------------------- */

test('[pg] level events survive a restart, are redelivered until acked, and never recreated by replays', opts, async () => {
  const { store, ctx } = await freshStore([alpha]);
  const b = finalized({ amountRaw: L1 });
  await store.recordBurn('alpha', b);

  const restarted = new PgStore(ctx.newPool(), [alpha]); // brand-new pool = new process
  const pending = await restarted.pendingEvents('alpha');
  assert.deepEqual(pending.map((e) => [e.level.id, e.levelIndex, e.totalRaw, e.triggeredBy]), [['l1', 1, L1, burnKey(b.signature, b.instructionPath)]]);
  assert.equal((await restarted.pendingEvents('alpha')).length, 1); // reading does not consume

  await restarted.ackEvent('alpha', 'l1');
  await restarted.ackEvent('alpha', 'l1'); // idempotent
  assert.equal((await new PgStore(ctx.newPool(), [alpha]).pendingEvents('alpha')).length, 0);

  // Replaying the burn, or a later one over the same level, must not resurrect the event.
  await restarted.recordBurn('alpha', { ...b });
  await restarted.recordBurn('alpha', finalized({ amountRaw: 5n }));
  assert.equal((await restarted.pendingEvents('alpha')).length, 0);
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM level_events')).rows[0].n, 1);
});

test('[pg] events come back in the order they were created', opts, async () => {
  const { store } = await freshStore([alpha]);
  await store.recordBurn('alpha', finalized({ amountRaw: 20_000n * 1_000_000n })); // jumps over l1, l2 and l3
  assert.deepEqual((await store.pendingEvents('alpha')).map((e) => e.level.id), ['l1', 'l2', 'l3']);
});

test('[pg] cursor, issues and verification persist across connections with the optimistic version', opts, async () => {
  const { store, ctx } = await freshStore([alpha]);
  const s = await store.loadState('alpha');
  s.finalizedHead = randomSignature();
  s.finalizedHeadSlot = 42;
  s.backfill = 'running';
  s.backfillBefore = randomSignature();
  s.issues = [{ code: 'malformed', signature: 'sigA', detail: 'd1' }, { code: 'tail_gap_too_large', detail: 'd2' }];
  s.verification = { status: 'mismatch', expectedBurnedRaw: '10', indexedBurnedRaw: '9' };
  await store.saveState('alpha', s);

  const reloaded = await new PgStore(ctx.newPool(), [alpha]).loadState('alpha');
  assert.deepEqual(reloaded, s);

  // dropping the oldest issue (the indexer caps the list) removes it in the database too
  const s2 = await store.loadState('alpha');
  s2.issues = s2.issues.slice(1);
  await store.saveState('alpha', s2);
  assert.deepEqual((await store.loadState('alpha')).issues, [{ code: 'tail_gap_too_large', detail: 'd2' }]);
});

test('[pg] a stale writer cannot overwrite a newer cursor', opts, async () => {
  const { store, ctx } = await freshStore([alpha]);
  const other = new PgStore(ctx.newPool(), [alpha]);
  const a = await store.loadState('alpha');
  const b = await other.loadState('alpha');
  a.finalizedHead = randomSignature();
  await store.saveState('alpha', a);
  b.finalizedHead = randomSignature();
  await assert.rejects(other.saveState('alpha', b), StaleStateError);
  assert.equal((await store.loadState('alpha')).finalizedHead, a.finalizedHead);
  await assert.rejects(new PgStore(ctx.newPool(), [alpha]).saveState('alpha', a), /before loadState/);
});

/* ------------------------------ isolation ------------------------------- */

test('[pg] projects are fully isolated: same signature in two projects, separate counters, cursors and events', opts, async () => {
  const { store, ctx } = await freshStore([alpha, beta]);
  const sig = randomSignature();
  await store.recordBurn('alpha', finalized({ signature: sig, mint: MINT_A, amountRaw: L1 }));
  await store.recordBurn('beta', finalized({ signature: sig, mint: MINT_B, amountRaw: 3n }));
  assert.equal((await store.totals('alpha')).finalizedRaw, L1);
  assert.equal((await store.totals('beta')).finalizedRaw, 3n);
  assert.equal((await store.pendingEvents('alpha')).length, 1);
  assert.equal((await store.pendingEvents('beta')).length, 0);

  assert.equal(await store.dropConfirmed('beta', burnKey(sig, '0')), false); // beta's burn is finalized; alpha untouched either way
  const b = await store.loadState('beta');
  b.finalizedHead = randomSignature();
  await store.saveState('beta', b);
  assert.equal((await store.loadState('alpha')).finalizedHead, null);
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM burns WHERE signature = $1', [sig])).rows[0].n, 2);
  await assert.rejects(store.totals('ghost'), /unknown project/);
  await assert.rejects(store.recordBurn('beta', burn({ mint: MINT_A })).then((r) => assert.equal(r.status, 'rejected')).then(() => Promise.reject(new Error('ok'))), /ok/);
});

test('[pg] project registration is idempotent and refuses to change immutable settings', opts, async () => {
  const { ctx } = await freshStore([alpha]);
  await PgStore.create(ctx.newPool(), [alpha]); // same config again: fine
  const renamed = parseProjectConfig(projectInput({ name: 'Renamed', initialSupply: '5' }));
  await PgStore.create(ctx.newPool(), [renamed]); // mutable fields may change
  assert.equal((await ctx.pool.query("SELECT name FROM projects WHERE id='alpha'")).rows[0].name, 'Renamed');

  for (const change of [{ mint: MINT_B }, { decimals: 9 }, { cluster: 'mainnet-beta' }, { tokenProgram: 'token-2022' }, { startSlot: 7 }]) {
    const bad = parseProjectConfig(projectInput(change));
    await assert.rejects(PgStore.create(ctx.newPool(), [bad]), ConfigMismatchError, JSON.stringify(change));
  }
  const fewerLevels = parseProjectConfig(projectInput({ levels: [{ id: 'l0', name: 'Zero', threshold: '0' }, { id: 'l1', name: 'One', threshold: '1000' }] }));
  await PgStore.create(ctx.newPool(), [fewerLevels]);
  assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM levels WHERE project_id='alpha'")).rows[0].n, 2);
});

test('[pg] a level that already fired cannot be removed from the configuration', opts, async () => {
  const { store, ctx } = await freshStore([alpha]);
  await store.recordBurn('alpha', finalized({ amountRaw: L1 })); // fires l1
  const noL1 = parseProjectConfig(projectInput({ levels: [{ id: 'l0', name: 'Zero', threshold: '0' }, { id: 'lx', name: 'X', threshold: '1000000' }] }));
  await assert.rejects(PgStore.create(ctx.newPool(), [noL1]), (e: StoreError) => e.code === '23503');
});

/* --------------------------- single-writer lease ------------------------ */

test('[pg] only one process can hold the indexing lease of a project; it is freed on release or disconnect', opts, async () => {
  const { store, ctx } = await freshStore([alpha, beta]);
  const second = new PgStore(ctx.newPool(), [alpha, beta]);
  assert.equal(await store.tryLockProject('alpha'), true);
  assert.equal(await store.tryLockProject('alpha'), true); // re-entrant for the holder
  assert.equal(await second.tryLockProject('alpha'), false);
  assert.equal(await second.tryLockProject('beta'), true); // other projects are independent
  await store.releaseProject('alpha');
  assert.equal(await second.tryLockProject('alpha'), true);
  await second.close();
  assert.equal(await store.tryLockProject('alpha'), true);
  await store.close();
});

/* ---------------------- crash recovery with real restarts --------------- */

test('[pg] engine restart on a new connection pool resumes without gaps or recounting', opts, async () => {
  const chain = new FakeChain();
  for (let s = 1; s <= 9; s++) chain.add({ slot: s, burns: [100n] });
  chain.finalizedSlot = 1_000;
  const ctx = await freshSchema();
  const store1 = await PgStore.create(ctx.pool, [alpha, beta]);
  chain.txFault = { skip: 5, times: 100 }; // process "crashes" after 5 transactions
  const first = await new Indexer({ project: alpha, rpc: chain, store: store1, pageSize: 3, checkpointEvery: 1 }).syncOnce();
  assert.ok(first.error);
  const partial = (await store1.totals('alpha')).finalizedRaw;
  assert.ok(partial > 0n && partial < 900n);
  await ctx.pool.end(); // the old process is gone

  chain.txFault = null;
  const store2 = await PgStore.create(ctx.newPool(), [alpha, beta]); // new process, state comes from the database only
  const ix2 = new Indexer({ project: alpha, rpc: chain, store: store2, pageSize: 3, checkpointEvery: 1 });
  for (let i = 0; i < 20; i++) if (!(await ix2.syncOnce()).moreWork) break;
  assert.deepEqual(await store2.totals('alpha'), { finalizedRaw: 900n, confirmedRaw: 900n, count: 9 });
  const again = await ix2.syncOnce();
  assert.equal(again.burnsRecorded, 0);
  assert.deepEqual(await store2.totals('alpha'), { finalizedRaw: 900n, confirmedRaw: 900n, count: 9 });
});

test('[pg] a cut between recording burns and saving the cursor is repaired by replay', opts, async () => {
  const chain = new FakeChain();
  for (let s = 1; s <= 4; s++) chain.add({ slot: s, burns: [10n] });
  chain.finalizedSlot = 1_000;
  const { store, ctx } = await freshStore([alpha]);
  const ix = new Indexer({ project: alpha, rpc: chain, store, pageSize: 10 });
  await ix.syncOnce();
  // Simulate the crash: burns are durable but the cursor write never happened.
  await ctx.pool.query("UPDATE index_state SET finalized_head = NULL, finalized_head_slot = NULL, backfill_before = NULL, backfill = 'pending', version = version + 1");
  const r = await new Indexer({ project: alpha, rpc: chain, store: new PgStore(ctx.newPool(), [alpha]), pageSize: 10 }).syncOnce();
  assert.equal(r.burnsRecorded, 0); // everything was already there
  assert.deepEqual(await store.totals('alpha'), { finalizedRaw: 40n, confirmedRaw: 40n, count: 4 });
});

/* ------------------------------ error hygiene --------------------------- */

test('[pg] connection errors never expose the URL or password', opts, async () => {
  const u = new URL(TEST_URL!);
  const badPw = `postgres://${u.username}:WrongPassw0rd!@${u.host}${u.pathname}`;
  const pool = createPool(loadDbConfig({ DATABASE_URL: badPw, PG_CONNECTION_TIMEOUT_MS: '2000' }));
  const store = new PgStore(pool, [alpha]);
  const err = await store.totals('alpha').catch((e) => e);
  assert.ok(err instanceof StoreError);
  assert.doesNotMatch(String(err.message) + (err.stack ?? ''), /WrongPassw0rd|postgres:\/\//);
  await pool.end();

  const dead = createPool(loadDbConfig({ DATABASE_URL: `postgres://u:Secr3tZ@127.0.0.1:1/x`, PG_CONNECTION_TIMEOUT_MS: '1000' }));
  const err2 = await new PgStore(dead, [alpha]).totals('alpha').catch((e) => e);
  assert.ok(err2 instanceof StoreError);
  assert.doesNotMatch(String(err2.message) + (err2.stack ?? ''), /Secr3tZ|postgres:\/\//);
  await dead.end();
});

test('[pg] a level never fires twice, even if the counters are restored to an older value (backup restore)', opts, async () => {
  const { store, ctx } = await freshStore([alpha]);
  await store.recordBurn('alpha', finalized({ amountRaw: L1 }));
  await store.ackEvent('alpha', 'l1');
  await ctx.pool.query("UPDATE project_counters SET finalized_raw = 0 WHERE project_id = 'alpha'"); // counters rolled back, event row kept
  const r = await store.recordBurn('alpha', finalized({ amountRaw: L1 })); // crosses l1 again on paper
  assert.deepEqual(r.status === 'inserted' ? r.events : null, []);
  assert.equal((await store.pendingEvents('alpha')).length, 0);
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM level_events')).rows[0].n, 1);
});

test('[pg] reading the state while it is being saved never makes the next save stale (status polling vs. indexing)', opts, async () => {
  const { store } = await freshStore([alpha]);
  for (let i = 0; i < 60; i++) {
    const s = await store.loadState('alpha');
    s.finalizedHeadSlot = i;
    await Promise.all([store.saveState('alpha', s), store.loadState('alpha')]); // a read racing with our own write
    await store.saveState('alpha', { ...s, finalizedHeadSlot: i + 1000 }); // the indexer saves again without reloading
  }
  assert.equal((await store.loadState('alpha')).finalizedHeadSlot, 1059);
});
