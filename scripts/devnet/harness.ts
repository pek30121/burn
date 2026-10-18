/* Boots the REAL engine (real RPC client, PostgreSQL, indexers, REST/SSE) for the Devnet scripts.
 * PostgreSQL: DEVNET_DATABASE_URL, else TEST_DATABASE_URL (a dedicated database; a throw-away schema per run). */
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, loadDbConfig } from '../../src/db/config.ts';
import { loadEngineConfig, type EngineConfig } from '../../src/engine/config.ts';
import { startEngine, type Engine } from '../../src/engine/engine.ts';
import { createLogger } from '../../src/engine/logger.ts';
import { RPC_URL } from './rpc.ts';

export interface Booted {
  engine: Engine;

  url: string;
  lines: any[];
  cfg: EngineConfig;
  stop(): Promise<{ clean: boolean }>;
}

export interface Run {
  schema: string;
  databaseUrl: string;
  dispose(): Promise<void>;
}

const baseUrl = () => {
  const u = process.env.DEVNET_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!u) throw new Error('set DEVNET_DATABASE_URL (or TEST_DATABASE_URL) to a dedicated PostgreSQL database whose name contains "test"');
  if (!/test/i.test(decodeURIComponent(new URL(u).pathname.slice(1)))) throw new Error('refusing to run: the database name must contain "test"');
  return u;
};

/** A new isolated schema for one validation run. */
export async function newRun(): Promise<Run> {
  const url = baseUrl();
  const schema = `devnet_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const admin = createPool(loadDbConfig({ DATABASE_URL: url, PG_POOL_MAX: '2' }));
  await admin.query(`CREATE SCHEMA ${schema}`);
  return {
    schema,
    databaseUrl: `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`,
    async dispose() {
      if (!process.env.KEEP_SCHEMA) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await admin.end().catch(() => {});
    },
  };
}

export interface BootOptions {
  projects: unknown[];
  rpcUrl?: string;
  trackConfirmed?: boolean;
  pollMs?: number;
  echo?: (line: any) => void;
}

export async function boot(run: Run, o: BootOptions): Promise<Booted> {
  const dir = await mkdtemp(join(tmpdir(), 'devnet-run-'));
  const file = join(dir, 'projects.json');
  await writeFile(file, JSON.stringify({ projects: o.projects }));
  const base = await loadEngineConfig({
    SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: o.rpcUrl ?? RPC_URL, DATABASE_URL: run.databaseUrl, PROJECTS_CONFIG: file,
    HTTP_PORT: '0', CORS_ORIGINS: 'https://app.example', TRACK_CONFIRMED: o.trackConfirmed ? 'true' : 'false',
  });
  const cfg: EngineConfig = {
    ...base, pollIntervalMs: o.pollMs ?? 2000, errorBackoff: { baseMs: 500, maxMs: 4000 }, leaseRetryMs: 500, statusLogIntervalMs: 0, shutdownTimeoutMs: 15_000, reconcileIntervalMs: 4000,
    indexer: { ...base.indexer, backfillPagesPerSync: 5 },
    http: { ...base.http, statusCacheMs: 0, rateLimitPerMinute: 100_000, sse: { ...base.http.sse, pollMs: 300, heartbeatMs: 5000 } },
  };
  const lines: any[] = [];
  const engine = await startEngine(cfg, {
    log: createLogger({ level: 'info', write: (l) => { const j = JSON.parse(l); lines.push(j); o.echo?.(j); } }),
  });
  return { engine, url: `http://127.0.0.1:${engine.httpPort}`, lines, cfg, stop: () => engine.stop('script') };
}

export const projectJson = (p: { id: string; mint: string; decimals: number; tokenProgram?: 'spl-token' | 'token-2022'; startSlot?: number; levels: { id: string; name: string; threshold: string }[]; initialSupply?: string }) => ({
  id: p.id, name: p.id, ticker: p.id.toUpperCase().slice(0, 8), cluster: 'devnet', mint: p.mint, decimals: p.decimals, tokenProgram: p.tokenProgram ?? 'spl-token',
  startSlot: p.startSlot ?? 0, ...(p.initialSupply ? { initialSupply: p.initialSupply } : {}), levels: p.levels,
});
