/* Engine configuration from environment variables + the projects file.
 * Every problem is reported at once; messages name variables, never values. */

import { loadDbConfig, DbConfigError, type DbConfig } from '../db/config.ts';
import { registerSecret } from '../db/errors.ts';
import { CLUSTERS, ConfigError, type Cluster } from '../config/schema.ts';
import { ProjectRegistry } from '../config/registry.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export class EngineConfigError extends Error {
  override name = 'EngineConfigError';
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`invalid engine configuration:\n  - ${issues.join('\n  - ')}`);
    this.issues = issues;
  }
}

export interface EngineConfig {
  readonly cluster: Cluster;
  readonly rpc: { readonly url: string; readonly maxRetries: number; readonly timeoutMs: number; readonly baseDelayMs: number };
  readonly db: DbConfig;
  readonly registry: ProjectRegistry;
  readonly pollIntervalMs: number;
  readonly errorBackoff: { readonly baseMs: number; readonly maxMs: number };
  readonly leaseRetryMs: number;
  readonly limits: { readonly maxConcurrent: number; readonly minIntervalMs: number };
  readonly indexer: { readonly pageSize: number; readonly backfillPagesPerSync: number; readonly trackConfirmed: boolean; readonly maxTailPages: number };
  /** Local estimate only (credits per RPC method). NOT the provider's billing. */
  readonly creditCosts: Readonly<Record<string, number>>;
  readonly shutdownTimeoutMs: number;
  readonly statusLogIntervalMs: number;
  readonly migrateOnStart: boolean;
  readonly logLevel: LogLevel;
}

export const DEFAULT_CREDIT_COSTS = { getSignaturesForAddress: 1, getTransaction: 1, getTokenSupply: 1 } as const;

type Env = Record<string, string | undefined>;

/** Registers the RPC URL and any key-looking part of it so logs and errors can never show it. */
function protectRpcUrl(raw: string): void {
  registerSecret(raw);
  const u = new URL(raw);
  registerSecret(u.password && decodeURIComponent(u.password));
  registerSecret(u.username && decodeURIComponent(u.username));
  for (const [k, v] of u.searchParams) if (/key|token|secret|auth|sig/i.test(k)) registerSecret(v);
  for (const seg of u.pathname.split('/')) if (seg.length >= 16) registerSecret(seg);
  if (!/^(localhost|127\.|\[::1\])/.test(u.hostname)) registerSecret(u.hostname); // a private node address is not for logs either
}

export async function loadEngineConfig(env: Env = process.env): Promise<EngineConfig> {
  const issues: string[] = [];
  const int = (key: string, def: number, min: number, max: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      issues.push(`${key}: expected an integer in [${min}, ${max}]`);
      return def;
    }
    return n;
  };
  const bool = (key: string, def: boolean): boolean => {
    const raw = env[key];
    if (raw === undefined || raw === '') return def;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    issues.push(`${key}: expected true or false`);
    return def;
  };

  const cluster = env.SOLANA_CLUSTER as Cluster | undefined;
  if (!cluster || !CLUSTERS.includes(cluster)) issues.push(`SOLANA_CLUSTER: expected one of ${CLUSTERS.join(', ')}`);

  const rpcUrl = env.SOLANA_RPC_URL;
  if (!rpcUrl) issues.push('SOLANA_RPC_URL: is not set');
  else {
    try {
      const u = new URL(rpcUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
      protectRpcUrl(rpcUrl);
    } catch {
      issues.push('SOLANA_RPC_URL: expected an http(s) URL');
    }
  }

  let db: DbConfig | undefined;
  try {
    db = loadDbConfig(env);
  } catch (e) {
    issues.push(e instanceof DbConfigError ? e.message : 'DATABASE_URL: invalid');
  }

  let registry: ProjectRegistry | undefined;
  if (!env.PROJECTS_CONFIG) issues.push('PROJECTS_CONFIG: is not set');
  else {
    try {
      registry = await ProjectRegistry.fromFile(env.PROJECTS_CONFIG);
      if (registry.list().length === 0) issues.push('PROJECTS_CONFIG: no project configured');
      const wrong = registry.list().filter((p) => cluster && p.cluster !== cluster).map((p) => p.id);
      if (wrong.length) issues.push(`PROJECTS_CONFIG: projects ${wrong.join(', ')} are not on SOLANA_CLUSTER=${cluster}`);
    } catch (e) {
      if (e instanceof ConfigError) issues.push(...e.issues.map((i) => `PROJECTS_CONFIG: ${i}`));
      else issues.push('PROJECTS_CONFIG: cannot be read or is not valid JSON');
    }
  }

  const creditCosts: Record<string, number> = { ...DEFAULT_CREDIT_COSTS };
  if (env.RPC_CREDIT_COSTS) {
    try {
      const parsed = JSON.parse(env.RPC_CREDIT_COSTS) as Record<string, unknown>;
      for (const [m, c] of Object.entries(parsed)) {
        if (typeof c !== 'number' || !Number.isFinite(c) || c < 0) throw new Error();
        creditCosts[m] = c;
      }
    } catch {
      issues.push('RPC_CREDIT_COSTS: expected a JSON object of non-negative numbers, e.g. {"getTransaction":1}');
    }
  }

  const logLevel = (env.LOG_LEVEL ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) issues.push(`LOG_LEVEL: expected one of ${LOG_LEVELS.join(', ')}`);

  const cfg = {
    rpc: {
      url: rpcUrl ?? '',
      maxRetries: int('RPC_MAX_RETRIES', 4, 0, 10),
      timeoutMs: int('RPC_TIMEOUT_MS', 20_000, 500, 120_000),
      baseDelayMs: int('RPC_RETRY_BASE_MS', 500, 1, 60_000),
    },
    pollIntervalMs: int('POLL_INTERVAL_MS', 10_000, 1_000, 3_600_000),
    errorBackoff: { baseMs: int('ERROR_BACKOFF_BASE_MS', 2_000, 100, 600_000), maxMs: int('ERROR_BACKOFF_MAX_MS', 60_000, 1_000, 3_600_000) },
    leaseRetryMs: int('LEASE_RETRY_MS', 15_000, 500, 3_600_000),
    limits: { maxConcurrent: int('RPC_MAX_CONCURRENCY', 4, 1, 64), minIntervalMs: int('RPC_MIN_INTERVAL_MS', 100, 0, 60_000) },
    indexer: {
      pageSize: int('INDEXER_PAGE_SIZE', 1000, 1, 1000),
      backfillPagesPerSync: int('BACKFILL_PAGES_PER_SYNC', 1, 1, 100),
      trackConfirmed: bool('TRACK_CONFIRMED', false),
      maxTailPages: int('MAX_TAIL_PAGES', 100, 1, 10_000),
    },
    shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 20_000, 100, 600_000),
    statusLogIntervalMs: int('STATUS_LOG_INTERVAL_MS', 300_000, 0, 86_400_000),
    migrateOnStart: bool('MIGRATE_ON_START', true),
  };
  if (cfg.errorBackoff.maxMs < cfg.errorBackoff.baseMs) issues.push('ERROR_BACKOFF_MAX_MS: must be >= ERROR_BACKOFF_BASE_MS');

  if (issues.length) throw new EngineConfigError(issues);
  return { cluster: cluster!, db: db!, registry: registry!, creditCosts, logLevel, ...cfg };
}
