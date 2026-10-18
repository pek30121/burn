/* `npm run db:migrate` — applies pending migrations to DATABASE_URL. */
import { createPool, loadDbConfig } from './config.ts';
import { runMigrations } from './migrate.ts';

const pool = createPool(loadDbConfig());
try {
  const r = await runMigrations(pool);
  console.log(`migrations: ${r.applied.length} applied${r.applied.length ? ` (${r.applied.join(', ')})` : ''}, ${r.alreadyApplied} already applied`);
} catch (e) {
  console.error(`migration failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
