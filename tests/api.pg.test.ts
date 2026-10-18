/* Public API on a real PostgreSQL: the durable event log, the REST endpoints and the SSE stream
 * fed by the real PgStore, indexers and engine (only the Solana network is simulated). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEngineConfig, type EngineConfig } from '../src/engine/config.ts';
import { startEngine, type Engine } from '../src/engine/engine.ts';
import { createLogger } from '../src/engine/logger.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { PgStore } from '../src/indexer/pg-store.ts';
import { parseProjectConfig } from '../src/config/schema.ts';
import { burnKey, type BurnInput } from '../src/core/ledger.ts';
import { FakeChain } from './fake-chain.ts';
import { fakeFetch, newHooks, type RpcHooks } from './fake-rpc.ts';
import { burn, MINT_B, projectInput } from './helpers.ts';
import { eventIds, get, healthyRunner, openSse, startTestApi, waitUntil } from './api-helpers.ts';
import { bareSchema, freshSchema, freshStore, pgSkip, type BareSchema } from './pg-harness.ts';

const opts = { skip: pgSkip };
const L1 = 1_000_000_000n;
const alpha = parseProjectConfig(projectInput());
const betaP = parseProjectConfig(projectInput({ id: 'beta', mint: MINT_B }));
const fin = (o: Partial<BurnInput> = {}) => burn({ commitment: 'finalized', ...o });
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ========================= the durable event log ========================= */

test('[api-pg] finalized burns and the levels they trigger enter the log in id order; confirmed burns do not', opts, async () => {
  const { store } = await freshStore([alpha]);
  const pendingBurn = burn({ amountRaw: 5n, commitment: 'confirmed' });
  await store.recordBurn('alpha', pendingBurn);
  assert.equal(await store.latestEventId('alpha'), 0); // confirmed data is never published
  assert.deepEqual(await store.eventsAfter('alpha', 0, 100), []);

  const small = fin({ amountRaw: 100n, slot: 10 });
  const crossing = fin({ amountRaw: L1, slot: 11 });
  await store.recordBurn('alpha', small); // id 1
  await store.recordBurn('alpha', crossing); // id 2 (burn) + id 3 (mutation l1)
  await store.recordBurn('alpha', { ...pendingBurn, commitment: 'finalized' }); // promotion: id 4
  for (const b of [small, crossing, { ...pendingBurn, commitment: 'finalized' as const }]) await store.recordBurn('alpha', { ...b }); // replays: nothing new
  assert.equal(await store.latestEventId('alpha'), 4);

  const ev = await store.eventsAfter('alpha', 0, 100);
  assert.deepEqual(ev.map((e) => [e.id, e.type]), [[1, 'burn'], [2, 'burn'], [3, 'mutation'], [4, 'burn']]);
  const e2 = ev[1] as Extract<(typeof ev)[number], { type: 'burn' }>;
  assert.deepEqual([e2.burn.signature, e2.burn.amountRaw, e2.burn.slot, e2.burn.owner], [crossing.signature, L1, 11, crossing.owner]);
  const m = ev[2] as Extract<(typeof ev)[number], { type: 'mutation' }>;
  assert.deepEqual(m.mutation, { levelId: 'l1', levelIndex: 1, totalRaw: 100n + L1, triggeredBy: burnKey(crossing.signature, '0') });
  assert.deepEqual((await store.eventsAfter('alpha', 2, 1)).map((e) => e.id), [3]); // paging
  assert.deepEqual((await store.eventsAfter('alpha', 4, 10)), []);

  assert.deepEqual((await store.burnsPage('alpha', null, 2)).map((r) => r.id), [4, 2]); // newest first, burns only
  assert.deepEqual((await store.burnsPage('alpha', 2, 10)).map((r) => r.id), [1]);
  assert.deepEqual((await store.reachedLevels('alpha')).map((r) => r.levelId), ['l1']);
});

test('[api-pg] a rolled-back transaction publishes nothing and consumes no id (no gaps)', opts, async () => {
  const { store, ctx } = await freshStore([alpha]);
  await store.recordBurn('alpha', fin({ amountRaw: 1n }));
  await ctx.pool.query(`
    CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
    CREATE TRIGGER fail_events BEFORE INSERT ON level_events FOR EACH ROW EXECUTE FUNCTION boom();`);
  const crossing = fin({ amountRaw: L1 });
  await assert.rejects(store.recordBurn('alpha', crossing), /injected failure/);
  assert.equal(await store.latestEventId('alpha'), 1);
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM project_events')).rows[0].n, 1);
  await ctx.pool.query('DROP TRIGGER fail_events ON level_events');
  await store.recordBurn('alpha', crossing);
  assert.deepEqual((await store.eventsAfter('alpha', 0, 100)).map((e) => e.id), [1, 2, 3]); // contiguous after the failure
});

test('[api-pg] concurrent writers: ids are unique and contiguous, each mutation follows the burn that caused it, and a reader that keeps advancing its cursor never skips an id', opts, async () => {
  const { store } = await freshStore([alpha]);
  const writers = Array.from({ length: 40 }, (_, i) => fin({ amountRaw: L1 / 10n, slot: 100 + i }));
  let writing = true;
  const readerIds: number[] = [];
  const reader = (async () => {
    let cursor = 0;
    while (writing || (await store.latestEventId('alpha')) > cursor) {
      for (const e of await store.eventsAfter('alpha', cursor, 7)) {
        readerIds.push(e.id);
        cursor = e.id;
      }
      await sleep(1);
    }
  })();
  await Promise.all(writers.map((w) => store.recordBurn('alpha', w)));
  writing = false;
  await reader;

  const all = await store.eventsAfter('alpha', 0, 1000);
  assert.deepEqual(all.map((e) => e.id), range(1, 41)); // 40 burns + 1 mutation, no hole
  assert.deepEqual(readerIds, range(1, 41)); // the concurrent reader saw every id exactly once, in order
  const mutations = all.filter((e) => e.type === 'mutation');
  assert.equal(mutations.length, 1);
  const i = all.indexOf(mutations[0]!);
  const before = all[i - 1] as Extract<(typeof all)[number], { type: 'burn' }>;
  assert.equal((mutations[0] as any).mutation.triggeredBy, burnKey(before.burn.signature, before.burn.instructionPath));
});

test('[api-pg] each project has its own id sequence and its own data', opts, async () => {
  const { store } = await freshStore([alpha, betaP]);
  await store.recordBurn('alpha', fin({ amountRaw: 1n }));
  await store.recordBurn('beta', fin({ mint: MINT_B, amountRaw: 2n }));
  await store.recordBurn('beta', fin({ mint: MINT_B, amountRaw: 3n }));
  assert.deepEqual([await store.latestEventId('alpha'), await store.latestEventId('beta')], [1, 2]);
  assert.deepEqual((await store.eventsAfter('beta', 0, 10)).map((e) => (e as any).burn.amountRaw), [2n, 3n]);
  assert.deepEqual((await store.burnsPage('alpha', null, 10)).map((r) => r.burn.amountRaw), [1n]);
});

test('[api-pg] migration 0002 rebuilds the log of a database created before it existed', opts, async () => {
  const ctx = await freshSchema(); // fully migrated; rebuild the "old" state by hand below
  const old = await freshSchema();
  await old.pool.query('DROP TABLE schema_migrations, index_issues, index_state, project_events, level_events, project_counters, burns, levels, projects CASCADE');
  const dir = await mkdtemp(join(tmpdir(), 'mig1-'));
  const src = new URL('../migrations/', import.meta.url);
  await writeFile(join(dir, '0001_init.sql'), await readFile(new URL('0001_init.sql', src), 'utf8'));
  await runMigrations(old.pool, dir); // only 0001
  void ctx;

  const q = (sql: string, p: unknown[] = []) => old.pool.query(sql, p);
  await q("INSERT INTO projects (id,name,ticker,cluster,mint,decimals,token_program) VALUES ('alpha','A','A','devnet',$1,6,'spl-token')", [alpha.mint]);
  for (const [i, l] of ['l0', 'l1'].entries()) await q('INSERT INTO levels (project_id,position,level_id,name,threshold_raw) VALUES (\'alpha\',$1,$2,$2,$3)', [i, l, i === 0 ? 0 : 1000]);
  await q("INSERT INTO project_counters (project_id, finalized_raw, burn_count) VALUES ('alpha', 600, 4)");
  const row = (sig: string, slot: number, amount: number, commitment: string, at: string) =>
    q("INSERT INTO burns (project_id,signature,instruction_path,slot,owner,amount_raw,commitment,finalized_at) VALUES ('alpha',$1,'0',$2,'o',$3,$4,$5)", [sig, slot, amount, commitment, commitment === 'finalized' ? at : null]);
  await row('sigC', 3, 100, 'finalized', '2026-01-01T00:00:03Z');
  await row('sigA', 1, 100, 'finalized', '2026-01-01T00:00:01Z');
  await row('sigB', 2, 400, 'finalized', '2026-01-01T00:00:02Z');
  await row('sigP', 4, 7, 'confirmed', '2026-01-01T00:00:04Z');
  await q("INSERT INTO level_events (project_id,level_id,level_index,total_raw,triggered_by) VALUES ('alpha','l1',1,600,'sigC#0')");

  const mig = await runMigrations(old.pool, join(src.pathname)); // now both
  assert.equal(mig.applied.length, 1);
  const ev = (await q("SELECT seq::int, kind, signature, level_id FROM project_events WHERE project_id='alpha' ORDER BY seq")).rows;
  assert.deepEqual(ev.map((e) => [e.seq, e.kind, e.signature ?? e.level_id]), [[1, 'burn', 'sigA'], [2, 'burn', 'sigB'], [3, 'burn', 'sigC'], [4, 'mutation', 'l1']]); // confirmed burn excluded
  assert.equal((await q("SELECT event_seq::int AS n FROM project_counters WHERE project_id='alpha'")).rows[0].n, 4);

  const store = new PgStore(old.pool, [alpha]);
  await store.recordBurn('alpha', fin({ amountRaw: 1n }));
  assert.equal(await store.latestEventId('alpha'), 5); // new events continue the sequence
});

/* ============== the whole engine with its HTTP API on PostgreSQL ============== */

const RPC_KEY = 'API-SECRET-KEY-456';
async function projectsFile() {
  const dir = await mkdtemp(join(tmpdir(), 'apiproj-'));
  const f = join(dir, 'projects.json');
  await writeFile(f, JSON.stringify({ projects: [projectInput({ id: 'alpha' }), projectInput({ id: 'beta', mint: MINT_B })] }));
  return f;
}

interface Boot {
  engine: Engine;
  url: string;
  lines: any[];
  cfg: EngineConfig;
}
async function boot(db: BareSchema, chain: FakeChain, hooks: RpcHooks, over: Partial<EngineConfig> = {}): Promise<Boot> {
  const lines: any[] = [];
  const base = await loadEngineConfig({
    SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: `https://rpc.invalid/?api-key=${RPC_KEY}`, DATABASE_URL: db.url, PROJECTS_CONFIG: await projectsFile(),
    HTTP_PORT: '0', CORS_ORIGINS: 'https://app.example',
  });
  const cfg: EngineConfig = {
    ...base, pollIntervalMs: 20, errorBackoff: { baseMs: 20, maxMs: 80 }, leaseRetryMs: 50, shutdownTimeoutMs: 3_000, statusLogIntervalMs: 0,
    rpc: { ...base.rpc, maxRetries: 1, baseDelayMs: 1 }, limits: { maxConcurrent: 4, minIntervalMs: 0 },
    indexer: { ...base.indexer, pageSize: 3, backfillPagesPerSync: 5 },
    http: { ...base.http, statusCacheMs: 0, rateLimitPerMinute: 100_000, shutdownGraceMs: 300, sse: { ...base.http.sse, pollMs: 20, heartbeatMs: 200 } },
    ...over,
  };
  const engine = await startEngine(cfg, { log: createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l)) }), fetch: fakeFetch(chain, hooks) });
  return { engine, url: `http://127.0.0.1:${engine.httpPort}`, lines, cfg };
}

function chainOf(a: number, b = 0) {
  const chain = new FakeChain();
  for (let s = 1; s <= Math.max(a, b); s++) {
    chain.add({ slot: s, ...(s <= a ? { burns: [s === 3 ? L1 : 100n] } : {}), ...(s <= b ? { burnsB: [7n] } : {}) });
  }
  chain.finalizedSlot = 10_000;
  return chain;
}
const apiDone = async (url: string, id: string) => {
  const r = await get(`${url}/api/v1/projects/${id}/status`);
  return r.status === 200 && r.json.data.state === 'synced' && r.json.data.history.backfill !== 'pending';
};

test('[api-e2e] engine + HTTP: every route reflects PostgreSQL, SSE equals /events, isolation, exact amounts, no secret anywhere', opts, async () => {
  const db = await bareSchema();
  const b = await boot(db, chainOf(12, 5), newHooks());
  try {
    const stream = await openSse(`${b.url}/api/v1/projects/alpha/stream`, { lastEventId: 0 }); // connected while indexing is under way
    await waitUntil(async () => (await apiDone(b.url, 'alpha')) && (await apiDone(b.url, 'beta')), 'both synced', 15_000);
    await stream.waitFor((f) => f.filter((x) => x.id).length === 13, 'all alpha events', 10_000); // 12 burns + level l1

    const status = (await get(`${b.url}/api/v1/projects/alpha/status`)).json;
    assert.equal(status.totals.finalizedRaw, (L1 + 11n * 100n).toString());
    assert.equal(status.data.state, 'synced');
    assert.equal(status.data.history.verification, 'unverified');
    assert.equal(status.progression.level.id, 'l1');
    assert.equal(status.latestEventId, '13');

    // the three read paths agree: REST /events, SSE and REST /burns
    const rest = (await get(`${b.url}/api/v1/projects/alpha/events?limit=500`)).json;
    assert.deepEqual(rest.data.map((e: any) => e.id), range(1, 13).map(String));
    const sse = new Map(stream.frames.filter((f) => f.id).map((f) => [f.id, f.data]));
    for (const e of rest.data) assert.deepEqual(sse.get(e.id), e);
    assert.equal(rest.data.filter((e: any) => e.type === 'mutation').length, 1);
    const burnIds: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = (await get(`${b.url}/api/v1/projects/alpha/burns?limit=5${cursor ? `&cursor=${cursor}` : ''}`)).json;
      burnIds.push(...r.data.map((x: any) => x.id));
      cursor = r.page.nextCursor;
    } while (cursor);
    assert.deepEqual(burnIds.sort((x, y) => Number(x) - Number(y)), rest.data.filter((e: any) => e.type === 'burn').map((e: any) => e.id));

    const prog = (await get(`${b.url}/api/v1/projects/alpha/progression`)).json;
    assert.deepEqual([prog.level.id, prog.levels.filter((l: any) => l.reached).length], ['l1', 2]);

    // isolation: beta only has its own 5 burns of 7 raw units
    const beta = (await get(`${b.url}/api/v1/projects/beta/events`)).json;
    assert.deepEqual([beta.data.length, [...new Set(beta.data.map((e: any) => e.burn.amountRaw))]], [5, ['7']]);
    assert.equal((await get(`${b.url}/api/v1/projects/beta/status`)).json.totals.finalizedRaw, '35');

    assert.equal((await get(`${b.url}/health/ready`)).status, 200);
    const everything = JSON.stringify([status, rest, prog, (await get(`${b.url}/api/v1/projects`)).json, b.lines]);
    assert.doesNotMatch(everything, new RegExp(`${RPC_KEY}|engine_test_pw|rpc\\.invalid`));
    stream.close();
  } finally {
    await b.engine.stop();
  }
});

test('[api-e2e] full engine restart: the stream resumes with Last-Event-ID, nothing lost or repeated, ids stable', opts, async () => {
  const db = await bareSchema();
  const chain = chainOf(6);
  const b1 = await boot(db, chain, newHooks());
  const first = await openSse(`${b1.url}/api/v1/projects/alpha/stream`, { lastEventId: 0 });
  await first.waitFor((f) => f.filter((x) => x.id).length === 7, 'first run events', 10_000); // 6 burns + level
  const seen1 = eventIds(first);

  const stopped = await b1.engine.stop('restart');
  assert.equal(stopped.clean, true);
  await first.ended;
  assert.ok(first.frames.some((f) => f.event === 'shutdown'));

  for (let s = 7; s <= 11; s++) chain.add({ slot: s, burns: [50n] }); // happens while the engine is down
  const b2 = await boot(db, chain, newHooks());
  try {
    const second = await openSse(`${b2.url}/api/v1/projects/alpha/stream`, { lastEventId: Math.max(...seen1) });
    await second.waitFor((f) => f.filter((x) => x.id).length === 5, 'events after restart', 10_000);
    assert.deepEqual([...seen1, ...eventIds(second)], range(1, 12));
    const rest = (await get(`${b2.url}/api/v1/projects/alpha/events?limit=500`)).json;
    assert.deepEqual(rest.data.map((e: any) => e.id), range(1, 12).map(String));
    second.close();
  } finally {
    await b2.engine.stop();
  }
});

test('[api-e2e] a degraded project is reported explicitly while the API keeps serving every project', opts, async () => {
  const db = await bareSchema();
  const hooks = newHooks();
  hooks.fail = (r) => (r.address === MINT_B ? 500 : null);
  const b = await boot(db, chainOf(5, 4), hooks);
  try {
    await waitUntil(() => apiDone(b.url, 'alpha'), 'alpha synced', 15_000);
    await waitUntil(async () => (await get(`${b.url}/api/v1/projects/beta/status`)).json.data.reasons.includes('sync_failing'), 'beta flagged', 15_000);
    const beta = (await get(`${b.url}/api/v1/projects/beta/status`)).json;
    assert.deepEqual([beta.data.state, beta.data.reasons.includes('sync_failing')], ['incomplete', true]);
    assert.doesNotMatch(JSON.stringify(beta), /500|HTTP|error/i); // the reason is a code, never the underlying failure text
    assert.equal((await get(`${b.url}/api/v1/projects/beta/burns`)).status, 200);
    assert.equal((await get(`${b.url}/api/v1/projects/alpha/status`)).json.data.state, 'synced');
    assert.equal((await get(`${b.url}/health/ready`)).status, 200);
  } finally {
    await b.engine.stop();
  }
});

test('[api-e2e] a clean shutdown ends open streams, frees the port and stays within the time limit', opts, async () => {
  const db = await bareSchema();
  const b = await boot(db, chainOf(3), newHooks());
  await waitUntil(() => apiDone(b.url, 'alpha'), 'synced', 15_000);
  const s1 = await openSse(`${b.url}/api/v1/projects/alpha/stream`);
  const s2 = await openSse(`${b.url}/api/v1/projects/beta/stream`);
  const t0 = Date.now();
  const r = await b.engine.stop('SIGTERM');
  assert.equal(r.clean, true);
  assert.ok(Date.now() - t0 < 4_000);
  await Promise.all([s1.ended, s2.ended]);
  assert.ok(s1.frames.some((f) => f.event === 'shutdown'));
  await assert.rejects(get(`${b.url}/health/live`)); // port released
  assert.ok(b.lines.some((l) => l.event === 'engine_stopped' && l.clean === true));
});

test('[api-e2e] the HTTP server failing to start aborts the engine start without leaking resources', opts, async () => {
  const db = await bareSchema();
  const first = await boot(db, chainOf(1), newHooks());
  try {
    const clash = await bareSchema();
    await assert.rejects(boot(clash, chainOf(1), newHooks(), { http: { ...first.cfg.http, port: first.engine.httpPort! } }), /cannot listen \(EADDRINUSE\)/);
  } finally {
    await first.engine.stop();
  }
});

/* ================= PostgreSQL problems seen from the API ================= */

test('[api-pg] a PostgreSQL problem gives 503 data_unavailable (never a crash or a leak); streams survive and catch up after recovery', opts, async () => {
  const { store, ctx } = await freshStore([alpha]);
  const api = await startTestApi(store, { projects: [alpha] });
  api.runtime.runners.alpha = healthyRunner();
  try {
    await store.recordBurn('alpha', fin({ amountRaw: 10n }));
    assert.equal((await get(`${api.url}/api/v1/projects/alpha/status`)).status, 200);
    const stream = await openSse(`${api.url}/api/v1/projects/alpha/stream`, { lastEventId: 0 });
    await stream.waitFor((f) => f.some((x) => x.id === '1'), 'first event');

    await ctx.pool.query('ALTER TABLE project_counters RENAME TO pc_hidden; ALTER TABLE project_events RENAME TO pe_hidden'); // data layer broken, connectivity fine
    for (const p of ['status', 'burns', 'progression', 'events']) {
      const r = await get(`${api.url}/api/v1/projects/alpha/${p}`);
      assert.deepEqual([r.status, r.json.error.code, r.json.dataState], [503, 'data_unavailable', 'unavailable'], p);
      assert.doesNotMatch(r.text, /relation|pc_hidden|pe_hidden|project_counters|project_events|SQL|postgres/i);
    }
    await assert.rejects(openSse(`${api.url}/api/v1/projects/alpha/stream`), (e: any) => e.status === 503);
    assert.equal((await get(`${api.url}/health/live`)).status, 200);
    await sleep(100);
    assert.equal(api.api.stats().sse.connections, 1); // the open stream is kept

    await ctx.pool.query('ALTER TABLE pc_hidden RENAME TO project_counters; ALTER TABLE pe_hidden RENAME TO project_events');
    await store.recordBurn('alpha', fin({ amountRaw: 20n }));
    await stream.waitFor((f) => f.some((x) => x.id === '2'), 'stream recovered');
    assert.deepEqual(eventIds(stream), [1, 2]);
    assert.equal((await get(`${api.url}/api/v1/projects/alpha/status`)).status, 200);
    stream.close();

    // the connection pool itself goes away: readiness and data both report it
    await ctx.pool.end();
    api.clock.t += 5_000;
    const ready = await get(`${api.url}/health/ready`);
    assert.deepEqual([ready.status, ready.json.checks.database], [503, 'unavailable']);
    assert.equal((await get(`${api.url}/api/v1/projects/alpha/events`)).status, 503);
    assert.equal((await get(`${api.url}/api/v1/projects`)).status, 200);
  } finally {
    await api.close();
  }
});
