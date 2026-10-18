import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineConfigError, loadEngineConfig } from '../src/engine/config.ts';
import { createLogger } from '../src/engine/logger.ts';
import { RequestLimiter, ShutdownError } from '../src/engine/limiter.ts';
import { meteredFetch, RpcMeter } from '../src/engine/meter.ts';
import { ProjectRunner, type RunnerOptions } from '../src/engine/runner.ts';
import { redact } from '../src/db/errors.ts';
import { MINT_A, MINT_B, projectInput } from './helpers.ts';

const SECRET_RPC = 'https://rpc.example.org/v2/abcdef0123456789abcdef?api-key=SUPER-SECRET-KEY';
const SECRET_PW = 'Sup3rDbPassw0rd';

async function env(over: Record<string, string | undefined> = {}, projects: unknown[] = [projectInput({ id: 'alpha' }), projectInput({ id: 'beta', mint: MINT_B })]) {
  const dir = await mkdtemp(join(tmpdir(), 'eng-'));
  const file = join(dir, 'projects.json');
  await writeFile(file, JSON.stringify({ projects }));
  return {
    SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: SECRET_RPC, DATABASE_URL: `postgres://u:${SECRET_PW}@db.host:5432/x`, PROJECTS_CONFIG: file, ...over,
  } as Record<string, string | undefined>;
}
const issues = async (e: Record<string, string | undefined>) => {
  try {
    await loadEngineConfig(e);
  } catch (err) {
    assert.ok(err instanceof EngineConfigError);
    return err.issues.join('\n');
  }
  assert.fail('expected EngineConfigError');
};

/* ------------------------------- config -------------------------------- */

test('config: valid environment with safe, API-frugal defaults', async () => {
  const c = await loadEngineConfig(await env());
  assert.equal(c.registry.list().length, 2);
  assert.deepEqual([c.pollIntervalMs, c.limits.maxConcurrent, c.limits.minIntervalMs, c.indexer.trackConfirmed, c.migrateOnStart], [10_000, 4, 100, false, true]);
  assert.deepEqual(c.creditCosts, { getSignaturesForAddress: 1, getTransaction: 1, getTokenSupply: 1 });
});

test('config: every problem is reported at once, and no message contains a secret', async () => {
  const text = await issues(await env({ SOLANA_CLUSTER: 'testnet', SOLANA_RPC_URL: 'ftp://x/?api-key=SUPER-SECRET-KEY', DATABASE_URL: `mysql://u:${SECRET_PW}@h/d`, POLL_INTERVAL_MS: '5', RPC_CREDIT_COSTS: '{"a":"x"}', TRACK_CONFIRMED: 'maybe', LOG_LEVEL: 'loud' }));
  for (const name of ['SOLANA_CLUSTER', 'SOLANA_RPC_URL', 'DATABASE_URL', 'POLL_INTERVAL_MS', 'RPC_CREDIT_COSTS', 'TRACK_CONFIRMED', 'LOG_LEVEL']) assert.match(text, new RegExp(name));
  assert.doesNotMatch(text, new RegExp(`SUPER-SECRET|${SECRET_PW}`));
  assert.match(await issues({}), /PROJECTS_CONFIG: is not set/);
});

test('config: projects must belong to the configured cluster and exist', async () => {
  assert.match(await issues(await env({ SOLANA_CLUSTER: 'mainnet-beta' })), /alpha, beta are not on SOLANA_CLUSTER=mainnet-beta/);
  assert.match(await issues(await env({}, [])), /no project configured/);
  assert.match(await issues(await env({}, [projectInput({ mint: 'nope' })])), /PROJECTS_CONFIG:.*mint/s);
  assert.match(await issues(await env({ PROJECTS_CONFIG: '/does/not/exist.json' })), /cannot be read/);
});

test('config: once loaded, the RPC URL and its key can never appear in logs or errors', async () => {
  await loadEngineConfig(await env());
  assert.doesNotMatch(redact(`failed ${SECRET_RPC} and key=SUPER-SECRET-KEY and abcdef0123456789abcdef`), /SUPER-SECRET|abcdef0123456789abcdef|rpc\.example/);
  const lines: string[] = [];
  createLogger({ write: (l) => lines.push(l) }).error('boom', { error: `GET ${SECRET_RPC} -> 500`, other: 'api-key=SUPER-SECRET-KEY' });
  assert.doesNotMatch(lines[0]!, /SUPER-SECRET|rpc\.example/);
});

test('config: credit costs are overridable', async () => {
  const c = await loadEngineConfig(await env({ RPC_CREDIT_COSTS: '{"getTransaction":10}' }));
  assert.equal(c.creditCosts.getTransaction, 10);
  assert.equal(c.creditCosts.getSignaturesForAddress, 1);
});

/* -------------------------------- logger ------------------------------- */

test('logger: one JSON object per line, level filter, child context, bigint safe', () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'info', write: (l) => lines.push(l), now: () => new Date('2026-01-01T00:00:00Z') });
  log.debug('hidden');
  log.child({ project: 'alpha' }).warn('thing', { total: 12345678901234567890n });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), { time: '2026-01-01T00:00:00.000Z', level: 'warn', event: 'thing', project: 'alpha', total: '12345678901234567890' });
});

/* ------------------------------- limiter ------------------------------- */

test('limiter: never more than maxConcurrent in flight, FIFO order', async () => {
  const lim = new RequestLimiter({ maxConcurrent: 2, minIntervalMs: 0 });
  const order: number[] = [];
  let active = 0;
  let peak = 0;
  await Promise.all([1, 2, 3, 4, 5].map(async (n) => {
    const release = await lim.acquire();
    order.push(n);
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    release();
  }));
  assert.equal(peak, 2);
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
});

test('limiter: enforces the minimum interval between request starts', async () => {
  let t = 1_000;
  const sleeps: number[] = [];
  const lim = new RequestLimiter({ maxConcurrent: 10, minIntervalMs: 100, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
  for (let i = 0; i < 3; i++) (await lim.acquire())();
  assert.deepEqual(sleeps, [100, 100]); // first start is free, the next two wait the full interval
});

test('limiter: drain refuses queued and future requests but lets in-flight ones finish', async () => {
  const lim = new RequestLimiter({ maxConcurrent: 1, minIntervalMs: 0 });
  const first = await lim.acquire();
  const queued = lim.acquire();
  lim.drain();
  await assert.rejects(queued, ShutdownError);
  await assert.rejects(lim.acquire(), ShutdownError);
  first(); // in-flight request completes normally
  assert.deepEqual(lim.stats, { active: 0, queued: 0 });
});

/* -------------------------------- meter -------------------------------- */

test('meter: counts real requests per project and method (429s and errors apart) and estimates credits locally', async () => {
  const meter = new RpcMeter({ getTransaction: 5 });
  const limiter = new RequestLimiter({ maxConcurrent: 4, minIntervalMs: 0 });
  const statuses = [200, 429, 500, 200];
  const base = (async () => new Response('{}', { status: statuses.shift()! })) as typeof fetch;
  const mk = (project: string) => meteredFetch({ base, project, meter, limiter });
  const call = (f: typeof fetch, method: string) => f('http://x', { method: 'POST', body: JSON.stringify({ method }) });
  await call(mk('alpha'), 'getTransaction');
  await call(mk('alpha'), 'getTransaction');
  await call(mk('beta'), 'getSignaturesForAddress');
  await call(mk('beta'), 'getTransaction');
  await assert.rejects(meteredFetch({ base: (async () => { throw new Error('down'); }) as typeof fetch, project: 'beta', meter, limiter })('http://x', { body: '{"method":"getTokenSupply"}' }));

  const s = meter.snapshot();
  assert.deepEqual(s.projects.alpha!.byMethod.getTransaction, { requests: 2, errors: 0, rateLimited: 1 });
  assert.deepEqual([s.projects.alpha!.requests, s.projects.alpha!.estimatedCredits], [2, 10]);
  assert.deepEqual(s.projects.beta!.byMethod.getSignaturesForAddress, { requests: 1, errors: 1, rateLimited: 0 });
  assert.deepEqual(s.projects.beta!.byMethod.getTokenSupply, { requests: 1, errors: 1, rateLimited: 0 });
  assert.deepEqual([s.total.requests, s.total.errors, s.total.rateLimited, s.total.estimatedCredits], [5, 2, 1, 10 + 5 + 1 + 1]); // unknown method costs 1
  assert.match(s.note, /NOT the provider billing/);
});

test('meter: after drain, no request is sent and nothing is counted', async () => {
  const meter = new RpcMeter({});
  const limiter = new RequestLimiter({ maxConcurrent: 1, minIntervalMs: 0 });
  let sent = 0;
  const f = meteredFetch({ base: (async () => (sent++, new Response('{}'))) as typeof fetch, project: 'a', meter, limiter });
  limiter.drain();
  await assert.rejects(f('http://x', { body: '{"method":"m"}' }), ShutdownError);
  assert.equal(sent, 0);
  assert.equal(meter.snapshot().total.requests, 0);
});

/* -------------------------------- runner ------------------------------- */

type SyncResult = Awaited<ReturnType<RunnerOptions['indexer']['syncOnce']>>;
const ok = (o: Partial<SyncResult> = {}): SyncResult => ({ burnsRecorded: 0, burnsPromoted: 0, burnsDropped: 0, eventsDelivered: 0, moreWork: false, error: null, warnings: [], ...o });

function harness(script: (n: number) => SyncResult | Error, extra: Partial<RunnerOptions> = {}, stopAfterSleeps = 8) {
  const ctl = new AbortController();
  const sleeps: number[] = [];
  const logs: any[] = [];
  let calls = 0;
  const runner = new ProjectRunner({
    projectId: 'alpha',
    indexer: {
      syncOnce: async () => {
        const r = script(++calls);
        if (r instanceof Error) throw r;
        return r;
      },
      status: async () => ({ projectId: 'alpha', backfill: 'done_exhausted', finalizedHead: null, totals: { finalizedRaw: 0n, confirmedRaw: 0n, count: 0 }, progress: { level: { id: 'l0' } } as any, issues: [], verification: { status: 'unverified', reason: '' }, complete: false }),
    },
    store: {}, log: createLogger({ level: 'debug', write: (l) => logs.push(JSON.parse(l)) }),
    pollIntervalMs: 1000, backoff: { baseMs: 100, maxMs: 800 }, leaseRetryMs: 500, random: () => 1,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length >= stopAfterSleeps) {
        ctl.abort();
        throw new ShutdownError();
      }
    },
    ...extra,
  });
  return { runner, ctl, sleeps, logs, calls: () => calls, done: runner.run(ctl.signal) };
}

test('runner: exponential backoff after failures, capped; a recovery is logged; no tight loop', async () => {
  const h = harness((n) => (n <= 5 ? ok({ error: 'rpc down' }) : n === 6 ? new Error('thrown failure') : ok()), {}, 8);
  await h.done;
  assert.deepEqual(h.sleeps.slice(0, 6), [100, 200, 400, 800, 800, 800]); // doubled, then capped at maxMs
  assert.ok(h.sleeps.every((s) => s >= 100), 'every failure waits before retrying');
  const failed = h.logs.filter((l) => l.event === 'sync_failed');
  assert.deepEqual(failed.map((l) => l.consecutiveFailures), [1, 2, 3, 4, 5, 6]);
  assert.equal(failed[5].error, 'thrown failure');
  assert.equal(h.logs.find((l) => l.event === 'recovered').afterFailures, 6);
  assert.equal(h.sleeps[6], 1000); // healthy again: normal poll interval
});

test('runner: with backfill pending it keeps going without sleeping; when caught up it waits the poll interval', async () => {
  const h = harness((n) => ok({ moreWork: n < 4 }), {}, 2);
  await h.done;
  assert.equal(h.calls(), 5); // 4 immediate syncs (3 with moreWork) + the one that found nothing more, then two idle sleeps
  assert.deepEqual(h.sleeps, [1000, 1000]);
});

test('runner: waits for the lease instead of indexing, then indexes and releases it on stop', async () => {
  let granted = false;
  const locks: string[] = [];
  const h = harness(() => ok(), {
    store: { tryLockProject: async () => { locks.push('try'); const g = granted; granted = true; return g; }, releaseProject: async () => void locks.push('release') },
  }, 3);
  await h.done;
  assert.deepEqual(locks, ['try', 'try', 'release']);
  assert.equal(h.sleeps[0], 500); // waited leaseRetryMs, no sync meanwhile
  assert.equal(h.logs.filter((l) => l.event === 'lease_held_elsewhere').length, 1);
  assert.ok(h.logs.some((l) => l.event === 'lease_acquired'));
  assert.ok(h.calls() >= 1);
  assert.equal(h.runner.snapshot().state, 'stopped');
});

test('runner: a failing project does not stop another one (isolation)', async () => {
  const bad = harness(() => ok({ error: 'down' }), {}, 50);
  const good = harness(() => ok(), {}, 5);
  await Promise.all([bad.done, good.done]);
  assert.ok(bad.calls() >= 20 && good.calls() >= 4); // both kept running independently
});

test('runner: new incidents are logged once; those already known at start are not repeated', async () => {
  let issues: any[] = [{ code: 'malformed', signature: 's1', detail: 'old' }];
  const lines: any[] = [];
  const ctl = new AbortController();
  let sleeps = 0;
  await new ProjectRunner({
    projectId: 'alpha', store: {}, log: createLogger({ write: (l) => lines.push(JSON.parse(l)) }), pollIntervalMs: 1, backoff: { baseMs: 1, maxMs: 2 }, leaseRetryMs: 1,
    indexer: {
      syncOnce: async () => ok(),
      status: async () => ({ projectId: 'alpha', backfill: 'running', finalizedHead: null, totals: { finalizedRaw: 0n, confirmedRaw: 0n, count: 0 }, progress: { level: { id: 'l0' } } as any, issues, verification: { status: 'unverified', reason: '' }, complete: false }),
    },
    sleep: async () => {
      sleeps++;
      if (sleeps === 1) issues = [...issues, { code: 'tx_unavailable', signature: 's2', detail: 'new' }];
      if (sleeps === 2) issues = [...issues, { code: 'unsupported_version', signature: 's3', detail: 'v9' }];
      if (sleeps >= 4) {
        ctl.abort();
        throw new ShutdownError();
      }
    },
  }).run(ctl.signal);
  assert.deepEqual(lines.filter((l) => l.event === 'incident').map((l) => l.code), ['tx_unavailable', 'unsupported_version']); // s1 was known at start; no repeats
});

test('runner: stop wakes a sleeping runner immediately', async () => {
  const ctl = new AbortController();
  const logs: any[] = [];
  const runner = new ProjectRunner({
    projectId: 'alpha', store: {}, log: createLogger({ write: (l) => logs.push(JSON.parse(l)) }), pollIntervalMs: 60_000, backoff: { baseMs: 1, maxMs: 2 }, leaseRetryMs: 1,
    indexer: { syncOnce: async () => ok(), status: async () => { throw new Error('no db'); } },
    sleep: (ms) => new Promise((res, rej) => { const t = setTimeout(res, ms); ctl.signal.addEventListener('abort', () => { clearTimeout(t); rej(new ShutdownError()); }); }),
  });
  const done = runner.run(ctl.signal);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runner.snapshot().state, 'idle');
  const t0 = Date.now();
  ctl.abort();
  await done;
  assert.ok(Date.now() - t0 < 500);
  assert.equal(runner.snapshot().state, 'stopped');
  void MINT_A;
});
