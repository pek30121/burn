/* Assembles the engine: config -> PostgreSQL (+ migrations check) -> one RPC client, indexer
 * and runner per project, all sharing one request limiter and one meter. Projects are
 * isolated: each has its own RPC client, indexer, cursor and failure/backoff state. */

import { SolanaRpc } from '../chain/rpc.ts';
import { createPool } from '../db/config.ts';
import { migrationStatus, runMigrations } from '../db/migrate.ts';
import { toStoreError } from '../db/errors.ts';
import { Indexer, type IndexerStatus } from '../indexer/indexer.ts';
import { PgStore } from '../indexer/pg-store.ts';
import type { LevelReachedEvent } from '../core/ledger.ts';
import type { EngineConfig } from './config.ts';
import { RequestLimiter, ShutdownError } from './limiter.ts';
import { jsonSafe, type Logger } from './logger.ts';
import { meteredFetch, RpcMeter, type MeterSnapshot } from './meter.ts';
import { ProjectRunner, type RunnerSnapshot } from './runner.ts';

export class EngineStartError extends Error {
  override name = 'EngineStartError';
}

export interface EngineDeps {
  readonly log: Logger;
  /** Replaceable transport (tests). Defaults to global fetch. */
  readonly fetch?: typeof fetch;
  /** Called (after logging) for every level reached on finalized data; at-least-once. */
  readonly onLevelReached?: (e: LevelReachedEvent) => void | Promise<void>;
}

export interface ProjectStatus {
  id: string;
  mint: string;
  runner: RunnerSnapshot;
  indexer: IndexerStatus | null;
  indexerError?: string;
}

export interface EngineStatus {
  state: 'running' | 'stopping' | 'stopped';
  startedAt: string;
  projects: ProjectStatus[];
  rpc: MeterSnapshot;
  limiter: { active: number; queued: number };
}

export interface Engine {
  status(): Promise<EngineStatus>;
  /** Idempotent. `clean` is false when the shutdown timeout elapsed with work still running. */
  stop(reason?: string): Promise<{ clean: boolean }>;
  readonly stopped: Promise<void>;
  readonly meter: RpcMeter;
}

const timeout = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms).unref());

export async function startEngine(cfg: EngineConfig, deps: EngineDeps): Promise<Engine> {
  const log = deps.log;
  const projects = cfg.registry.list();
  log.info('engine_starting', {
    cluster: cfg.cluster, projects: projects.map((p) => p.id), pollIntervalMs: cfg.pollIntervalMs,
    maxConcurrent: cfg.limits.maxConcurrent, minIntervalMs: cfg.limits.minIntervalMs, trackConfirmed: cfg.indexer.trackConfirmed,
  });

  // --- PostgreSQL: reachable, migrated, projects consistent with the stored ones ---
  const pool = createPool(cfg.db, { log: (m) => log.warn('db_idle_error', { message: m }) });
  let store: PgStore;
  try {
    try {
      await pool.query('SELECT 1');
    } catch (e) {
      throw new EngineStartError(`database is not reachable: ${toStoreError(e).message}`);
    }
    if (cfg.migrateOnStart) {
      const m = await runMigrations(pool);
      if (m.applied.length) log.info('migrations_applied', { applied: m.applied });
    } else {
      const m = await migrationStatus(pool);
      if (m.pending.length || m.modified.length) {
        throw new EngineStartError(`database schema is not up to date (pending: ${m.pending.join(', ') || 'none'}; modified: ${m.modified.join(', ') || 'none'}); run "npm run db:migrate"`);
      }
    }
    store = await PgStore.create(pool, projects);
  } catch (e) {
    await pool.end().catch(() => {});
    throw e instanceof EngineStartError ? e : new EngineStartError(toStoreError(e).message);
  }

  // --- shared infrastructure ---
  const abort = new AbortController();
  const limiter = new RequestLimiter(cfg.limits);
  const meter = new RpcMeter(cfg.creditCosts);
  const baseFetch = deps.fetch ?? fetch;
  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (abort.signal.aborted) return reject(new ShutdownError());
      const onAbort = () => {
        clearTimeout(t);
        reject(new ShutdownError());
      };
      const t = setTimeout(() => {
        abort.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      abort.signal.addEventListener('abort', onAbort, { once: true });
    });

  // --- one isolated pipeline per project ---
  const runners = new Map<string, ProjectRunner>();
  const indexers = new Map<string, Indexer>();
  for (const project of projects) {
    const plog = log.child({ project: project.id });
    const rpc = new SolanaRpc({
      url: cfg.rpc.url, maxRetries: cfg.rpc.maxRetries, timeoutMs: cfg.rpc.timeoutMs, baseDelayMs: cfg.rpc.baseDelayMs, sleep,
      fetch: meteredFetch({ base: baseFetch, project: project.id, meter, limiter }),
    });
    const indexer = new Indexer({
      project, rpc, store, ...cfg.indexer,
      onEvent: async (e) => {
        plog.info('mutation', { level: e.level.id, levelIndex: e.levelIndex, totalRaw: e.totalRaw, triggeredBy: e.triggeredBy });
        await deps.onLevelReached?.(e);
      },
      log: (m) => plog.debug('indexer', { message: m }),
    });
    indexers.set(project.id, indexer);
    runners.set(project.id, new ProjectRunner({
      projectId: project.id, indexer, store, log: plog, pollIntervalMs: cfg.pollIntervalMs,
      backoff: cfg.errorBackoff, leaseRetryMs: cfg.leaseRetryMs, sleep,
    }));
  }

  const startedAt = new Date().toISOString();
  let state: EngineStatus['state'] = 'running';
  const status = async (): Promise<EngineStatus> => ({
    state, startedAt, rpc: meter.snapshot(), limiter: limiter.stats,
    projects: await Promise.all(projects.map(async (p): Promise<ProjectStatus> => {
      const base = { id: p.id, mint: p.mint, runner: runners.get(p.id)!.snapshot() };
      try {
        return { ...base, indexer: await indexers.get(p.id)!.status() };
      } catch (e) {
        return { ...base, indexer: null, indexerError: toStoreError(e).message };
      }
    })),
  });

  try {
    for (const p of projects) {
      const s = await indexers.get(p.id)!.status();
      log.info('project_started', { project: p.id, mint: p.mint, backfill: s.backfill, totalFinalizedRaw: s.totals.finalizedRaw, burns: s.totals.count, knownIncidents: s.issues.length });
      if (s.finalizedHead) log.info('resumed', { project: p.id, fromSignature: s.finalizedHead, backfill: s.backfill });
    }
  } catch (e) {
    await store.close().catch(() => {});
    await pool.end().catch(() => {});
    throw new EngineStartError(toStoreError(e).message);
  }

  const running = [...runners.entries()].map(([id, r]) => r.run(abort.signal).catch((e) => log.error('runner_crashed', { project: id, error: e instanceof Error ? e.message : String(e) })));
  const statusTimer = cfg.statusLogIntervalMs > 0
    ? setInterval(() => void status().then((s) => log.info('engine_status', JSON.parse(jsonSafe(s)))).catch(() => {}), cfg.statusLogIntervalMs)
    : null;
  statusTimer?.unref();

  let stopPromise: Promise<{ clean: boolean }> | null = null;
  let markStopped!: () => void;
  const stopped = new Promise<void>((r) => (markStopped = r));

  const stop = (reason = 'requested'): Promise<{ clean: boolean }> =>
    (stopPromise ??= (async () => {
      state = 'stopping';
      log.info('engine_stopping', { reason, timeoutMs: cfg.shutdownTimeoutMs });
      if (statusTimer) clearInterval(statusTimer);
      abort.abort(); // wakes every sleeping runner
      limiter.drain(); // no new RPC request; those already in flight may finish
      const drained = (await Promise.race([Promise.allSettled(running).then(() => true as const), timeout(cfg.shutdownTimeoutMs)])) === true;
      if (!drained) log.warn('shutdown_timeout', { message: 'work still running; closing resources anyway' });
      await store.close().catch(() => {}); // release leases
      if ((await Promise.race([pool.end().then(() => 'ok' as const), timeout(5_000)])) === 'timeout') log.warn('pool_close_timeout');
      state = 'stopped';
      log.info('engine_stopped', { clean: drained });
      markStopped();
      return { clean: drained };
    })());

  log.info('engine_started', { projects: projects.length });
  return { status, stop, stopped, meter };
}
