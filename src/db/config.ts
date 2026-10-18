/* PostgreSQL connection settings, read from the environment only. Error
 * messages name the variable, never its value. */

import pg from 'pg';
import { registerSecret, toStoreError } from './errors.ts';

export interface DbConfig {
  readonly connectionString: string;
  readonly poolMax: number;
  readonly idleTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export class DbConfigError extends Error {
  override name = 'DbConfigError';
}

function int(env: Record<string, string | undefined>, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new DbConfigError(`${key}: expected an integer in [${min}, ${max}]`);
  return n;
}

export function loadDbConfig(env: Record<string, string | undefined> = process.env): DbConfig {
  const url = env.DATABASE_URL;
  if (!url) throw new DbConfigError('DATABASE_URL is not set');
  if (!/^postgres(?:ql)?:\/\//i.test(url)) throw new DbConfigError('DATABASE_URL: expected a postgres:// or postgresql:// URL');
  registerSecret(url);
  try {
    registerSecret(new URL(url).password && decodeURIComponent(new URL(url).password));
  } catch {
    throw new DbConfigError('DATABASE_URL: not a valid URL');
  }
  return {
    connectionString: url,
    poolMax: int(env, 'PG_POOL_MAX', 10, 1, 100),
    idleTimeoutMs: int(env, 'PG_IDLE_TIMEOUT_MS', 30_000, 1_000, 3_600_000),
    connectionTimeoutMs: int(env, 'PG_CONNECTION_TIMEOUT_MS', 5_000, 100, 120_000),
    statementTimeoutMs: int(env, 'PG_STATEMENT_TIMEOUT_MS', 15_000, 100, 600_000),
  };
}

export interface PoolExtras {
  /** Schema to use for every connection (tests run each case in its own schema). */
  readonly schema?: string;
  readonly log?: (msg: string) => void;
}

export function createPool(cfg: DbConfig, extras: PoolExtras = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: cfg.connectionString,
    max: cfg.poolMax,
    idleTimeoutMillis: cfg.idleTimeoutMs,
    connectionTimeoutMillis: cfg.connectionTimeoutMs,
    statement_timeout: cfg.statementTimeoutMs,
    ...(extras.schema ? { options: `-c search_path=${extras.schema}` } : {}),
  });
  // An idle client dying must not crash the process; the next query reconnects.
  pool.on('error', (e) => extras.log?.(`idle database client error: ${toStoreError(e).message}`));
  return pool;
}
