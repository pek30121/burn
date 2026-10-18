/* Versioned SQL migrations: migrations/NNNN_name.sql, applied in order, each in
 * its own transaction, recorded with a checksum. Already-applied files must not
 * change. Safe to run concurrently (a transaction-level advisory lock serialises runners). */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { StoreError, toStoreError } from './errors.ts';

export const DEFAULT_MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export class MigrationError extends StoreError {
  override name = 'MigrationError';
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

export async function runMigrations(pool: Pool, dir: URL | string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationResult> {
  const folder = typeof dir === 'string' ? dir : fileURLToPath(dir);
  const names = (await readdir(folder)).filter((f) => FILE.test(f)).sort();
  names.forEach((n, i) => {
    if (Number(FILE.exec(n)![1]) !== i + 1) throw new MigrationError(`migration files must be numbered 0001.. without gaps (found ${n} at position ${i + 1})`);
  });

  const result: MigrationResult = { applied: [], alreadyApplied: 0 };
  try {
    for (const [i, name] of names.entries()) {
      const sql = await readFile(join(folder, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':migrations'))");
        // Created under the lock: concurrent CREATE TABLE IF NOT EXISTS can still collide.
        await c.query(
          `CREATE TABLE IF NOT EXISTS schema_migrations (
             version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
        );
        const done = await c.query('SELECT name, checksum FROM schema_migrations WHERE version = $1', [i + 1]);
        if (done.rowCount) {
          if (done.rows[0].checksum !== checksum || done.rows[0].name !== name) {
            throw new MigrationError(`migration ${name} was modified after being applied`);
          }
          result.alreadyApplied++;
        } else {
          await c.query(sql);
          await c.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [i + 1, name, checksum]);
          result.applied.push(name);
        }
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    }
  } catch (e) {
    throw e instanceof MigrationError ? e : toStoreError(e);
  }
  return result;
}
