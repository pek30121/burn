/* Full-engine integration tests on a real PostgreSQL: startEngine() with the real RPC client,
 * limiter, meter, indexers, PgStore and migrations; only the network is simulated. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadEngineConfig, type EngineConfig } from '../src/engine/config.ts';
import { EngineStartError, startEngine, type Engine } from '../src/engine/engine.ts';
import { createLogger } from '../src/engine/logger.ts';
import { PgStore } from '../src/indexer/pg-store.ts';
import { parseProjectConfig } from '../src/config/schema.ts';
import type { LevelReachedEvent } from '../src/core/ledger.ts';
import { FakeChain } from './fake-chain.ts';
import { count, fakeFetch, newHooks, startRpcServer, type RpcHooks } from './fake-rpc.ts';
import { MINT_A, MINT_B, projectInput, randomPubkey } from './helpers.ts';
import { bareSchema, pgSkip, TEST_URL, type BareSchema } from './pg-harness.ts';

const opts = { skip: pgSkip };
const L1 = 1_000_000_000n;
const RPC_SECRET = 'ENGINE-SECRET-KEY-123';
const alpha = projectInput({ id: 'alpha' });
const beta = projectInput({ id: 'beta', mint: MINT_B });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, what: string, ms = 8_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function projectsFile(projects: unknown[] = [alpha, beta]) {
  const dir = await mkdtemp(join(tmpdir(), 'engproj-'));
  const file = join(dir, 'projects.json');
  await writeFile(file, JSON.stringify({ projects }));
  return file;
}

interface Boot {
  engine: Engine;
  lines: any[];
  cfg: EngineConfig;
  events: LevelReachedEvent[];
  ev(name: string, project?: string): any[];
}

async function envFor(db: BareSchema, extra: Record<string, string | undefined> = {}, projects?: unknown[]) {
  return {
    SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: `https://rpc.invalid/?api-key=${RPC_SECRET}`, DATABASE_URL: db.url,
    PROJECTS_CONFIG: await projectsFile(projects), ...extra,
  };
}

/** Fast-polling config so tests take milliseconds, not minutes. */
const fast = (cfg: EngineConfig, over: Partial<EngineConfig> = {}): EngineConfig => ({
  ...cfg, pollIntervalMs: 20, errorBackoff: { baseMs: 20, maxMs: 80 }, leaseRetryMs: 50, shutdownTimeoutMs: 3_000, statusLogIntervalMs: 0,
  rpc: { ...cfg.rpc, maxRetries: 1, baseDelayMs: 1 }, limits: { maxConcurrent: 4, minIntervalMs: 0 },
  indexer: { ...cfg.indexer, pageSize: 3, backfillPagesPerSync: 5 }, http: { ...cfg.http, enabled: false }, ...over,
});

async function boot(db: BareSchema, chain: FakeChain, hooks: RpcHooks, o: { over?: Partial<EngineConfig>; env?: Record<string, string | undefined>; projects?: unknown[]; handler?: (e: LevelReachedEvent) => void | Promise<void> } = {}): Promise<Boot> {
  const lines: any[] = [];
  const events: LevelReachedEvent[] = [];
  const cfg = fast(await loadEngineConfig(await envFor(db, o.env, o.projects)), o.over);
  const engine = await startEngine(cfg, {
    log: createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l)) }),
    fetch: fakeFetch(chain, hooks),
    onLevelReached: async (e) => {
      if (o.handler) await o.handler(e);
      events.push(e);
    },
  });
  return { engine, lines, cfg, events, ev: (name, project) => lines.filter((l) => l.event === name && (project === undefined || l.project === project)) };
}

const projectStatus = async (b: Boot, id: string) => (await b.engine.status()).projects.find((p) => p.id === id)!;
const settled = async (b: Boot, id: string) => {
  const s = await projectStatus(b, id);
  return s.indexer !== null && (s.indexer.backfill === 'done_exhausted' || s.indexer.backfill === 'done_start_slot') && s.runner.state !== 'syncing';
};
const burnedRaw = async (b: Boot, id: string) => (await projectStatus(b, id)).indexer!.totals.finalizedRaw;

function chainWith(a: number, b = 0): FakeChain {
  const chain = new FakeChain();
  for (let s = 1; s <= Math.max(a, b); s++) chain.add({ slot: s, ...(s <= a ? { burns: [100n] } : {}), ...(s <= b ? { burnsB: [7n] } : {}) });
  chain.finalizedSlot = 1_000;
  return chain;
}

/* ---------------------------------------------------------------------- */

test('[engine] full start: several tokens watched at once, exact totals, structured logs without secrets', opts, async () => {
  const db = await bareSchema();
  const hooks = newHooks();
  const b = await boot(db, chainWith(8, 5), hooks); // 8 burns for alpha, 5 for beta (same transactions for slots 1..5)
  try {
    await waitFor(async () => (await settled(b, 'alpha')) && (await settled(b, 'beta')), 'both projects indexed');
    const st = await b.engine.status();
    assert.equal(st.state, 'running');
    assert.deepEqual(st.projects.map((p) => [p.id, p.indexer!.totals.finalizedRaw, p.indexer!.totals.count]), [['alpha', 800n, 8], ['beta', 35n, 5]]);
    assert.ok(st.projects.every((p) => p.runner.holdsLease && p.runner.consecutiveFailures === 0));

    for (const name of ['engine_starting', 'migrations_applied', 'project_started', 'engine_started', 'burns_indexed']) assert.ok(b.ev(name).length > 0, name);
    assert.equal(b.ev('project_started').length, 2);
    assert.ok(b.ev('burns_indexed', 'alpha').length > 0 && b.ev('burns_indexed', 'beta').length > 0);

    // RPC counters: per project, estimate present and clearly not a bill
    assert.ok(st.rpc.projects.alpha!.requests > 0 && st.rpc.projects.beta!.requests > 0);
    assert.equal(st.rpc.total.estimatedCredits, st.rpc.total.requests); // default cost: 1 credit per request
    assert.match(st.rpc.note, /NOT the provider billing/);

    const stopped = await b.engine.stop('test');
    assert.equal(stopped.clean, true);
    await b.engine.stopped;
    assert.ok(b.ev('engine_stopped')[0].clean);
    assert.ok(b.ev('project_stopped').length === 2);
    // everything written to the logs is free of secrets
    const all = JSON.stringify(b.lines);
    assert.doesNotMatch(all, new RegExp(`${RPC_SECRET}|engine_test_pw|rpc\\.invalid`));
    // leases were released: another process can take them now
    const other = new PgStore(db.newPool(), b.cfg.registry.list());
    assert.equal(await other.tryLockProject('alpha'), true);
    await other.close();
  } finally {
    await b.engine.stop();
  }
});

test('[engine] RPC counters equal what the server really received (retries and 429s included)', opts, async () => {
  const db = await bareSchema();
  const hooks = newHooks();
  let throttled = 0;
  hooks.fail = (r) => (r.method === 'getSignaturesForAddress' && throttled < 3 ? (throttled++, 429) : null);
  const b = await boot(db, chainWith(6, 2), hooks);
  try {
    await waitFor(async () => (await settled(b, 'alpha')) && (await settled(b, 'beta')), 'indexed despite 429s');
    await b.engine.stop();
    const snap = b.engine.meter.snapshot();
    const sum = (m: string) => Object.values(snap.projects).reduce((n, p) => n + (p.byMethod[m]?.requests ?? 0), 0);
    assert.equal(sum('getSignaturesForAddress'), count(hooks, 'getSignaturesForAddress'));
    assert.equal(sum('getTransaction'), count(hooks, 'getTransaction'));
    assert.equal(snap.total.requests, hooks.requests.length);
    assert.equal(snap.total.rateLimited, 3);
    for (const [id, mint] of [['alpha', MINT_A], ['beta', MINT_B]] as const) {
      assert.equal(snap.projects[id]!.byMethod.getSignaturesForAddress?.requests, count(hooks, 'getSignaturesForAddress', mint), id);
    }
  } finally {
    await b.engine.stop();
  }
});

test('[engine] a failing project backs off on its own while the others keep indexing; it recovers by itself', opts, async () => {
  const db = await bareSchema();
  const hooks = newHooks();
  let betaDown = true;
  hooks.fail = (r) => (betaDown && r.address === MINT_B ? 500 : null);
  const b = await boot(db, chainWith(6, 4), hooks);
  try {
    await waitFor(async () => (await settled(b, 'alpha')) && (await burnedRaw(b, 'alpha')) === 600n, 'alpha indexed while beta is down');
    await waitFor(() => b.ev('sync_failed', 'beta').length >= 4, 'beta failures');
    const beta1 = await projectStatus(b, 'beta');
    assert.equal(beta1.runner.state === 'backoff' || beta1.runner.state === 'syncing', true);
    assert.ok(beta1.runner.consecutiveFailures >= 4 && beta1.runner.lastError);
    assert.equal(b.ev('sync_failed', 'alpha').length, 0);

    const delays = b.ev('sync_failed', 'beta').map((l) => l.retryInMs as number);
    assert.ok(delays.every((d) => d <= 80), `delays are capped: ${delays}`);
    assert.ok(Math.max(...delays) > Math.min(...delays), 'delays grow');
    await sleep(300);
    // not a tight loop: a handful of attempts, not hundreds
    assert.ok(count(hooks, 'getSignaturesForAddress', MINT_B) < 60, `attempts=${count(hooks, 'getSignaturesForAddress', MINT_B)}`);

    betaDown = false;
    await waitFor(async () => (await settled(b, 'beta')) && (await burnedRaw(b, 'beta')) === 28n, 'beta recovered');
    assert.ok(b.ev('recovered', 'beta').length >= 1);
    assert.equal((await projectStatus(b, 'alpha')).indexer!.totals.finalizedRaw, 600n); // untouched
  } finally {
    await b.engine.stop();
  }
});

test('[engine] only finalized data triggers a mutation: confirmed burns wait for finalization', opts, async () => {
  const db = await bareSchema();
  const chain = new FakeChain();
  chain.add({ slot: 1 });
  chain.finalizedSlot = 1;
  chain.add({ slot: 5, burns: [L1] }); // crosses level l1, but only confirmed so far
  const called: string[] = [];
  const b = await boot(db, chain, newHooks(), { over: { indexer: { pageSize: 3, backfillPagesPerSync: 5, trackConfirmed: true, maxTailPages: 100 } }, handler: (e) => void called.push(e.level.id) });
  try {
    await waitFor(async () => (await projectStatus(b, 'alpha')).indexer!.totals.confirmedRaw === L1, 'confirmed burn seen');
    await sleep(150);
    const t = (await projectStatus(b, 'alpha')).indexer!.totals;
    assert.deepEqual([t.finalizedRaw, t.confirmedRaw], [0n, L1]);
    assert.equal(b.ev('mutation').length, 0);
    assert.deepEqual(called, []);

    chain.finalizedSlot = 5;
    await waitFor(() => b.ev('mutation').length === 1, 'mutation after finalization');
    await sleep(150);
    assert.equal(b.ev('mutation').length, 1);
    assert.deepEqual(called, ['l1']);
    assert.equal((await projectStatus(b, 'alpha')).indexer!.totals.finalizedRaw, L1);
  } finally {
    await b.engine.stop();
  }
});

test('[engine] graceful stop: the in-flight request finishes, nothing new starts, state is resumable without double counting', opts, async () => {
  const db = await bareSchema();
  const chain = chainWith(12, 0);
  const hooks = newHooks();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let txSeen = 0;
  hooks.hold = async (r) => {
    if (r.method === 'getTransaction' && ++txSeen === 6) await gate; // the 6th transaction fetch stays in flight
  };
  const b1 = await boot(db, chain, hooks);
  await waitFor(() => txSeen === 6, 'a request in flight');

  let stopped = false;
  const stopping = b1.engine.stop('SIGTERM').then((r) => ((stopped = true), r));
  await sleep(150);
  assert.equal(stopped, false, 'stop waits for the in-flight operation');
  assert.equal((await b1.engine.status()).state, 'stopping');
  release();
  assert.deepEqual(await stopping, { clean: true });
  assert.equal(count(hooks, 'getTransaction'), 6, 'no request started after the stop');
  assert.ok(b1.ev('engine_stopped')[0].clean);

  // restart: continues from the stored cursors, every burn counted exactly once
  const before = count(hooks, 'getTransaction');
  const b2 = await boot(db, chain, hooks);
  try {
    assert.ok(b2.ev('resumed', 'alpha').length === 1, 'resume is logged');
    await waitFor(async () => (await settled(b2, 'alpha')) && (await projectStatus(b2, 'alpha')).indexer!.totals.count === 12, 'resumed run complete');
    const t = (await projectStatus(b2, 'alpha')).indexer!.totals;
    assert.deepEqual([t.finalizedRaw, t.count], [1200n, 12]);
    assert.equal(count(hooks, 'getTransaction') - before, 6, 'only the 6 remaining transactions were fetched');
  } finally {
    await b2.engine.stop();
  }
});

test('[engine] a hung operation cannot block shutdown beyond the timeout; resources are still released', opts, async () => {
  const db = await bareSchema();
  const hooks = newHooks();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let seen = false;
  hooks.hold = async (r) => {
    if (r.method === 'getTransaction') {
      seen = true;
      await gate;
    }
  };
  const b = await boot(db, chainWith(4, 0), hooks, { over: { shutdownTimeoutMs: 200 } });
  try {
    await waitFor(() => seen, 'hung request');
    const t0 = Date.now();
    const r = await b.engine.stop('SIGTERM');
    assert.equal(r.clean, false);
    assert.ok(Date.now() - t0 < 3_000);
    assert.ok(b.ev('shutdown_timeout').length === 1);
    const other = new PgStore(db.newPool(), b.cfg.registry.list());
    assert.equal(await other.tryLockProject('alpha'), true); // lease freed
    await other.close();
  } finally {
    release();
    await sleep(100);
  }
});

test('[engine] undelivered level events are not lost: they are redelivered after a restart, once, then never again', opts, async () => {
  const db = await bareSchema();
  const chain = new FakeChain();
  chain.add({ slot: 1, burns: [L1] });
  chain.finalizedSlot = 10;
  const b1 = await boot(db, chain, newHooks(), { handler: () => { throw new Error('consumer down'); } });
  await waitFor(() => b1.ev('warning').some((w) => /event delivery failed/.test(w.message)), 'delivery failure');
  await b1.engine.stop();
  assert.equal(b1.events.length, 0);
  const probe = new PgStore(db.newPool(), [parseProjectConfig(alpha), parseProjectConfig(beta)]);
  assert.deepEqual((await probe.pendingEvents('alpha')).map((e) => e.level.id), ['l1']);

  const b2 = await boot(db, chain, newHooks());
  await waitFor(() => b2.events.length === 1, 'redelivery');
  await b2.engine.stop();
  assert.deepEqual(b2.events.map((e) => [e.level.id, e.totalRaw]), [['l1', L1]]);
  assert.equal((await probe.pendingEvents('alpha')).length, 0);

  const b3 = await boot(db, chain, newHooks());
  await sleep(200);
  await b3.engine.stop();
  assert.equal(b3.events.length, 0);
});

test('[engine] two engines on the same database: the second waits for the lease and takes over without recounting', opts, async () => {
  const db = await bareSchema();
  const chain = chainWith(5, 0);
  const b1 = await boot(db, chain, newHooks());
  await waitFor(async () => (await settled(b1, 'alpha')) && (await burnedRaw(b1, 'alpha')) === 500n, 'first engine done');

  const hooks2 = newHooks();
  const b2 = await boot(db, chain, hooks2);
  try {
    await waitFor(() => b2.ev('lease_held_elsewhere').length === 2, 'second engine blocked');
    const sent = Object.entries(b2.engine.meter.snapshot().projects).filter(([id]) => id !== '_startup');
    assert.deepEqual(sent, [], 'a blocked engine sends no project RPC request (only the one-off network check at start-up)');
    assert.equal((await projectStatus(b2, 'alpha')).runner.state, 'waiting_lease');

    await b1.engine.stop();
    await waitFor(() => b2.ev('lease_acquired').length === 2, 'takeover');
    await waitFor(async () => (await settled(b2, 'alpha')) && hooks2.requests.length > 0, 'second engine syncing');
    assert.deepEqual((await projectStatus(b2, 'alpha')).indexer!.totals, { finalizedRaw: 500n, confirmedRaw: 500n, count: 5 });
  } finally {
    await b1.engine.stop();
    await b2.engine.stop();
  }
});

test('[engine] refuses to start on a bad setup, with explicit errors that contain no secret', opts, async () => {
  const log = createLogger({ write: () => {} });
  const mk = async (db: BareSchema, extra: Record<string, string | undefined> = {}, projects?: unknown[]) => fast(await loadEngineConfig(await envFor(db, extra, projects)));

  // database unreachable
  const bad = await bareSchema();
  const unreachable = await mk({ ...bad, url: 'postgres://u:Leak3dPassw0rd@127.0.0.1:1/x' });
  const e1 = await startEngine(unreachable, { log, fetch: fakeFetch(new FakeChain(), newHooks()) }).catch((e) => e);
  assert.ok(e1 instanceof EngineStartError && /not reachable/.test(e1.message), String(e1?.message));
  assert.doesNotMatch(e1.message + e1.stack, /Leak3dPassw0rd|postgres:\/\//);

  // schema not migrated and MIGRATE_ON_START=false
  const fresh = await bareSchema();
  const e2 = await startEngine(await mk(fresh, { MIGRATE_ON_START: 'false' }), { log, fetch: fakeFetch(new FakeChain(), newHooks()) }).catch((e) => e);
  assert.ok(e2 instanceof EngineStartError && /not up to date.*0001_init\.sql/.test(e2.message), String(e2?.message));

  // a stored project must not silently change its mint
  const db = await bareSchema();
  const ok = await startEngine(await mk(db), { log, fetch: fakeFetch(new FakeChain(), newHooks()) });
  await ok.stop();
  const e3 = await startEngine(await mk(db, {}, [projectInput({ id: 'alpha', mint: randomPubkey() })]), { log, fetch: fakeFetch(new FakeChain(), newHooks()) }).catch((e) => e);
  assert.ok(e3 instanceof EngineStartError && /different immutable settings: mint/.test(e3.message), String(e3?.message));
});

test('[engine] REGRESSION: killing the lease connection of a running engine is survived — lease_lost, re-acquired, indexing continues', opts, async () => {
  const db = await bareSchema();
  const chain = chainWith(4, 0);
  const b = await boot(db, chain, newHooks());
  const probe = db.newPool();
  try {
    await waitFor(async () => (await settled(b, 'alpha')) && (await burnedRaw(b, 'alpha')) === 400n, 'initial indexing');
    const lease = await probe.query(
      `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = (hashtext($1)::bigint & 4294967295)::oid AND objid = (hashtext('alpha')::bigint & 4294967295)::oid`,
      [`${db.schema}:project`],
    );
    assert.equal(lease.rowCount, 1);
    await probe.query('SELECT pg_terminate_backend($1)', [lease.rows[0].pid]);

    await waitFor(() => b.ev('lease_lost', 'alpha').length === 1, 'lease_lost');
    await waitFor(() => b.ev('lease_acquired', 'alpha').length === 2, 'lease re-acquired');
    chain.add({ slot: 20, burns: [25n] }); // the engine keeps working after the incident
    await waitFor(async () => (await burnedRaw(b, 'alpha')) === 425n, 'indexing continues');
    const t = (await projectStatus(b, 'alpha')).indexer!.totals;
    assert.deepEqual([t.finalizedRaw, t.count], [425n, 5]); // nothing lost, nothing counted twice
    assert.equal((await b.engine.status()).state, 'running');
  } finally {
    await b.engine.stop();
  }
});

/* ----------------------- supply reconciliation (completeness proof) ----------------------- */

const withSupply = [{ ...alpha, initialSupply: '1000000' }, beta]; // FakeChain starts from 1e12 raw = 1,000,000 UI

test('[engine] REGRESSION: the engine now runs the supply check, so completeness can actually be proven (and is dropped when burns change)', opts, async () => {
  const db = await bareSchema();
  const chain = chainWith(5, 0);
  const b = await boot(db, chain, newHooks(), { projects: withSupply, over: { reconcileIntervalMs: 50 } });
  try {
    await waitFor(async () => (await projectStatus(b, 'alpha')).indexer?.verification.status === 'verified', 'verified');
    const s = (await projectStatus(b, 'alpha')).indexer!;
    assert.deepEqual([s.complete, s.verification], [true, { status: 'verified', burnedRaw: '500' }]);
    assert.equal(b.ev('supply_verified', 'alpha').length, 1);
    chain.add({ slot: 50, burns: [40n] });
    await waitFor(() => b.ev('supply_verified', 'alpha').length === 2, 'verified again after a new burn');
    assert.equal(b.ev('supply_verified', 'alpha')[1].burnedRaw, '540');
    assert.equal((await projectStatus(b, 'beta')).indexer?.verification.status, 'unverified'); // no initialSupply: never claimed
  } finally {
    await b.engine.stop();
  }
});

test('[engine] REGRESSION: a burn missing from the node history is flagged as a supply mismatch (never "complete")', opts, async () => {
  const db = await bareSchema();
  const chain = chainWith(5, 0);
  chain.add({ slot: 60, burns: [40n], hidden: true }); // on-chain (supply) but not discoverable through the signature history
  const b = await boot(db, chain, newHooks(), { projects: withSupply, over: { reconcileIntervalMs: 50 } });
  try {
    await waitFor(() => b.ev('supply_mismatch', 'alpha').length === 1, 'mismatch');
    const m = b.ev('supply_mismatch', 'alpha')[0];
    assert.deepEqual([m.expectedBurnedRaw, m.indexedBurnedRaw], ['540', '500']);
    const s = (await projectStatus(b, 'alpha')).indexer!;
    assert.deepEqual([s.complete, s.verification.status], [false, 'mismatch']);
    await sleep(300);
    assert.equal(b.ev('supply_mismatch', 'alpha').length, 1, 'reported once, not on every check');
  } finally {
    await b.engine.stop();
  }
});

test('[engine] projects without initialSupply are never sent a supply request', opts, async () => {
  const db = await bareSchema();
  const hooks = newHooks();
  const b = await boot(db, chainWith(3, 0), hooks, { over: { reconcileIntervalMs: 20 } });
  try {
    await waitFor(async () => (await settled(b, 'alpha')) && (await burnedRaw(b, 'alpha')) === 300n, 'indexed');
    await sleep(200);
    assert.equal(count(hooks, 'getTokenSupply'), 0);
  } finally {
    await b.engine.stop();
  }
});

/* ----------------------- the real entry point, as a process ------------------------ */

function runMain(env: Record<string, string>) {
  const child = spawn(process.execPath, ['src/main.ts'], { cwd: new URL('..', import.meta.url).pathname, env: { PATH: process.env.PATH ?? '', ...env } });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, exited, out: () => out, err: () => err, lines: () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

test('[main] `npm start` process: indexes, then exits 0 on SIGTERM with a clean shutdown and no secret in its output', opts, async () => {
  const db = await bareSchema();
  const chain = chainWith(6, 3);
  const hooks = newHooks();
  const server = await startRpcServer(chain, hooks);
  const pool = db.newPool();
  try {
    const p = runMain({
      SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: `${server.url}?api-key=PROC-SECRET-KEY-77`, DATABASE_URL: db.url, PROJECTS_CONFIG: await projectsFile(),
      HTTP_ENABLED: 'false', POLL_INTERVAL_MS: '1000', RPC_MIN_INTERVAL_MS: '0', INDEXER_PAGE_SIZE: '3', BACKFILL_PAGES_PER_SYNC: '5', STATUS_LOG_INTERVAL_MS: '0',
    });
    await waitFor(async () => {
      const r = await pool.query("SELECT project_id, burn_count::int AS n FROM project_counters ORDER BY project_id").catch(() => ({ rows: [] }));
      return r.rows.length === 2 && r.rows[0].n === 6 && r.rows[1].n === 3;
    }, 'process indexed both projects', 15_000);
    p.child.kill('SIGTERM');
    assert.equal(await p.exited, 0);
    const names = p.lines().map((l) => l.event);
    for (const n of ['engine_starting', 'engine_started', 'burns_indexed', 'engine_stopping', 'engine_stopped']) assert.ok(names.includes(n), n);
    assert.equal(p.lines().find((l) => l.event === 'engine_stopped').clean, true);
    assert.doesNotMatch(p.out() + p.err(), /PROC-SECRET-KEY-77|engine_test_pw/);
    assert.ok(hooks.requests.length > 0);
  } finally {
    await server.close();
  }
});

test('[main] the process refuses to start with explicit errors and exit code 1', opts, async () => {
  const p = runMain({ DATABASE_URL: `postgres://u:ProcLeakPw42@127.0.0.1:5432/${new URL(TEST_URL!).pathname.slice(1)}` });
  assert.equal(await p.exited, 1);
  const fail = p.lines().find((l) => l.event === 'startup_failed');
  assert.ok(fail);
  for (const v of ['SOLANA_CLUSTER', 'SOLANA_RPC_URL', 'PROJECTS_CONFIG']) assert.match(fail.error, new RegExp(v));
  assert.doesNotMatch(p.out() + p.err(), /ProcLeakPw42/);
});

test('[main] a SIGTERM that arrives while the engine is still starting still ends in a clean shutdown (exit 0)', opts, async () => {
  const db = await bareSchema();
  const server = await startRpcServer(chainWith(4, 0), newHooks());
  try {
    const p = runMain({ SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: server.url, DATABASE_URL: db.url, PROJECTS_CONFIG: await projectsFile(), STATUS_LOG_INTERVAL_MS: '0', HTTP_ENABLED: 'false' });
    await waitFor(() => p.out().includes('engine_starting'), 'start-up begun');
    p.child.kill('SIGTERM'); // before engine_started
    assert.equal(await p.exited, 0);
    const names = p.lines().map((l) => l.event);
    assert.ok(names.includes('engine_stopped'), names.join());
    assert.equal(p.lines().find((l) => l.event === 'engine_stopped').clean, true);
  } finally {
    await server.close();
  }
});
