/* Real-PostgreSQL test harness. Requires TEST_DATABASE_URL pointing to a DEDICATED
 * database (its name must contain "test"). Every store gets its own throw-away schema,
 * so tests are isolated from each other and from any other data. Without the variable,
 * the PostgreSQL tests are reported as SKIPPED, never as passed. */
import { randomBytes } from 'node:crypto';
import { after } from 'node:test';
import type { Pool } from 'pg';
import { createPool, loadDbConfig } from '../src/db/config.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { PgStore } from '../src/indexer/pg-store.ts';
import type { ProjectConfig } from '../src/config/schema.ts';

export const TEST_URL = process.env.TEST_DATABASE_URL;
export const pgSkip: string | false = TEST_URL ? false : 'TEST_DATABASE_URL is not set: PostgreSQL integration tests were NOT run';

if (TEST_URL) {
  const dbName = decodeURIComponent(new URL(TEST_URL).pathname.slice(1));
  if (!/test/i.test(dbName)) throw new Error('TEST_DATABASE_URL must point to a dedicated database whose name contains "test"');
}

const cfg = () => loadDbConfig({ DATABASE_URL: TEST_URL, PG_POOL_MAX: '6', PG_IDLE_TIMEOUT_MS: '1000' });
const schemas = new Set<string>();
const pools = new Set<Pool>();

export interface PgCtx {
  pool: Pool;
  schema: string;
  /** Another pool on the same schema: simulates a second process / a restart. */
  newPool(): Pool;
}

/** A fresh, migrated schema. Cleaned up automatically when the test file ends. */
export async function freshSchema(): Promise<PgCtx> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = createPool(cfg());
  pools.add(admin);
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemas.add(schema);
  const newPool = () => {
    const p = createPool(cfg(), { schema });
    pools.add(p);
    return p;
  };
  const pool = newPool();
  await runMigrations(pool);
  return { pool, schema, newPool };
}

export async function freshStore(projects: readonly ProjectConfig[]): Promise<{ store: PgStore; ctx: PgCtx }> {
  const ctx = await freshSchema();
  return { store: await PgStore.create(ctx.pool, projects), ctx };
}

if (TEST_URL) {
  after(async () => {
    const admin = createPool(cfg());
    for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`).catch(() => {});
    await admin.end();
    await Promise.allSettled([...pools].map((p) => p.end()));
  });
}
