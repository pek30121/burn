/* Single-container supervisor for the Replit deployment: runs the burn ENGINE (indexers + PostgreSQL + public read-only API on
 * 127.0.0.1) and the WEB server (test page + allowlisted /rpc proxy + /api proxy on the public port) side by side.
 *
 *  - each child is restarted with exponential backoff (1 s ... 30 s; the backoff resets once a child stayed up for a minute);
 *  - a crashing engine never takes the page down, and the page never hides an engine failure (exit codes are logged);
 *  - SIGTERM / SIGINT stop both children cleanly (SIGKILL after a grace period) and exit 0;
 *  - Devnet by default (rollback target): any other SOLANA_CLUSTER is refused. Mainnet only when DEPLOY_NETWORK=mainnet is set
 *    explicitly (engine on 127.0.0.1 + the web server on the public port: burn page for the configured Mainnet projects, allowlisted
 *    /rpc proxy checked against the Mainnet genesis hash, and the engine's read-only API relayed under /api, CORS decided by the engine);
 *  - without DATABASE_URL (no Replit database attached yet) only the web server starts, with an explicit warning;
 *  - no secret is ever printed: only names, exit codes and delays.
 * Plain Node (compiled by tsc): it needs no TypeScript support at runtime. */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface ChildSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface SupervisorOptions {
  readonly specs: readonly ChildSpec[];
  readonly spawn?: (command: string, args: readonly string[], env: Record<string, string | undefined>) => ChildProcess;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly stableAfterMs?: number;
  readonly killAfterMs?: number;
}

export interface Supervisor {
  /** Resolves when every child loop has ended (after stop()). */
  readonly done: Promise<void>;
  stop(signal?: NodeJS.Signals): Promise<void>;
  readonly restarts: Record<string, number>;
}

const defaultLog = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), component: 'supervisor', event, ...fields }));

export function supervise(o: SupervisorOptions): Supervisor {
  const log = o.log ?? defaultLog;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const spawn = o.spawn ?? ((command, args, env) => nodeSpawn(command, [...args], { env: env as NodeJS.ProcessEnv, stdio: 'inherit' }));
  const base = o.baseDelayMs ?? 1_000;
  const max = o.maxDelayMs ?? 30_000;
  const stableAfter = o.stableAfterMs ?? 60_000;
  const killAfter = o.killAfterMs ?? 20_000;
  const live = new Map<string, ChildProcess>();
  const restarts: Record<string, number> = {};
  let stopping = false;
  let wake: (() => void) | null = null;

  async function loop(spec: ChildSpec): Promise<void> {
    let failures = 0;
    restarts[spec.name] = 0;
    while (!stopping) {
      const startedAt = now();
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>((resolve) => {
        let child: ChildProcess;
        try {
          child = spawn(spec.command, spec.args, { ...spec.env });
        } catch (e) {
          resolve({ code: null, signal: null, error: e instanceof Error ? e.message : 'spawn failed' });
          return;
        }
        live.set(spec.name, child);
        log('child_started', { name: spec.name, pid: child.pid ?? null });
        child.once('error', (e) => resolve({ code: null, signal: null, error: e.message }));
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      live.delete(spec.name);
      if (stopping) break;
      failures = now() - startedAt >= stableAfter ? 1 : failures + 1;
      const delay = Math.min(max, base * 2 ** (failures - 1));
      restarts[spec.name]!++;
      log('child_exited', { name: spec.name, code: exit.code, signal: exit.signal, ...(exit.error ? { error: exit.error } : {}), restartInMs: delay, restarts: restarts[spec.name] });
      await Promise.race([sleep(delay), new Promise<void>((r) => (wake = r))]);
    }
  }

  const done = Promise.all(o.specs.map(loop)).then(() => {});
  return {
    done,
    restarts,
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (stopping) return done;
      stopping = true;
      wake?.();
      log('stopping', { signal, children: [...live.keys()] });
      for (const c of live.values()) c.kill(signal);
      const killer = setTimeout(() => {
        for (const [name, c] of live) {
          log('child_killed', { name, after: 'grace period' });
          c.kill('SIGKILL');
        }
      }, killAfter);
      await done;
      clearTimeout(killer);
      log('stopped', {});
    },
  };
}

/** The two children of the Replit deployment, from the environment (pure: tested). */
export function replitSpecs(env: Record<string, string | undefined>, cwd: string = process.cwd()): { specs: ChildSpec[]; warnings: string[] } {
  const warnings: string[] = [];
  if (env.DEPLOY_NETWORK === 'mainnet') return mainnetSpecs(env, cwd);
  if (env.DEPLOY_NETWORK !== undefined && env.DEPLOY_NETWORK !== 'devnet') throw new Error('refusing to start: DEPLOY_NETWORK must be "devnet" or "mainnet"');
  if ((env.SOLANA_CLUSTER ?? 'devnet') !== 'devnet') throw new Error('refusing to start: this deployment is Devnet only (SOLANA_CLUSTER must be "devnet" or unset)');
  const port = env.PORT ?? env.WEB_PORT ?? '8080';
  const common = { ...env, SOLANA_CLUSTER: 'devnet' };
  const web: ChildSpec = {
    name: 'web', command: process.execPath, args: [`${cwd}/web/serve-dist/scripts/wallet-test/server.js`],
    env: {
      ...common, WEB_HOST: '0.0.0.0', WEB_PORT: port, WEB_TRUST_PROXY: '1', ENGINE_URL: 'http://127.0.0.1:8787',
      WEB_CONFIG_FILE: env.WEB_CONFIG_FILE ?? 'deploy/wallet-test-config.json', WEB_ROOT: env.WEB_ROOT ?? `${cwd}/web`,
    },
  };
  const specs: ChildSpec[] = [web];
  if (!env.DATABASE_URL) {
    warnings.push('DATABASE_URL is not set: the engine is NOT started (add a PostgreSQL database to this Replit app). Only the test page runs.');
    return { specs, warnings };
  }
  const engineEnv: Record<string, string | undefined> = {
    ...common, HTTP_ENABLED: 'true', HTTP_HOST: '127.0.0.1', HTTP_PORT: '8787', TRUST_PROXY: 'true',
    PROJECTS_CONFIG: env.PROJECTS_CONFIG ?? 'deploy/projects.devnet.json', RPC_MONTHLY_CREDITS: env.RPC_MONTHLY_CREDITS ?? '10000000',
    // The page is same-origin (it reaches the API through the web server), so no CORS origin is required.
    PORT: undefined,
  };
  if (!env.HELIUS_API_KEY && !env.SOLANA_RPC_URL) {
    engineEnv.SOLANA_RPC_URL = 'https://api.devnet.solana.com';
    warnings.push('HELIUS_API_KEY is not set: the engine uses the public Devnet RPC (rate-limited; add HELIUS_API_KEY in Secrets for reliability).');
  }
  specs.unshift({ name: 'engine', command: process.execPath, args: [`${cwd}/dist/main.js`], env: engineEnv });
  return { specs, warnings };
}

/** Mainnet: the engine on 127.0.0.1 and the web server (burn page, /rpc, /api relay) on the public port. Fail-closed: every prerequisite is explicit. */
export function mainnetSpecs(env: Record<string, string | undefined>, cwd: string = process.cwd()): { specs: ChildSpec[]; warnings: string[] } {
  const missing: string[] = [];
  if (!env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!env.HELIUS_API_KEY) missing.push('HELIUS_API_KEY');
  if (!env.PROJECTS_CONFIG || /devnet/i.test(env.PROJECTS_CONFIG)) missing.push('PROJECTS_CONFIG (a Mainnet file such as deploy/projects.mainnet.json)');
  if (env.WEB_CONFIG_FILE && /devnet|wallet-test-config/i.test(env.WEB_CONFIG_FILE)) missing.push('WEB_CONFIG_FILE (a Mainnet page config such as deploy/wallet-config.mainnet.json)');
  if (env.SOLANA_RPC_URL || env.WEB_UPSTREAM_RPC_URL) missing.push('SOLANA_RPC_URL and WEB_UPSTREAM_RPC_URL must be unset (the Helius Mainnet host is derived from HELIUS_API_KEY)');
  if (missing.length) throw new Error(`refusing to start on Mainnet, missing or invalid: ${missing.join(', ')}`);
  const port = env.PORT ?? env.WEB_PORT ?? '8080';
  const common = { ...env, SOLANA_CLUSTER: 'mainnet-beta', WEB_CLUSTER: 'mainnet-beta' };
  const engineEnv: Record<string, string | undefined> = {
    ...common, HTTP_ENABLED: 'true', HTTP_HOST: '127.0.0.1', HTTP_PORT: '8787', TRUST_PROXY: 'true',
    RPC_MONTHLY_CREDITS: env.RPC_MONTHLY_CREDITS ?? '10000000', PORT: undefined,
  };
  const webEnv: Record<string, string | undefined> = {
    ...common, WEB_HOST: '0.0.0.0', WEB_PORT: port, WEB_TRUST_PROXY: '1', ENGINE_URL: 'http://127.0.0.1:8787',
    WEB_CONFIG_FILE: env.WEB_CONFIG_FILE ?? 'deploy/wallet-config.mainnet.json', WEB_ROOT: env.WEB_ROOT ?? `${cwd}/web`,
  };
  const warnings: string[] = [];
  if (!env.CORS_ORIGINS) warnings.push('CORS_ORIGINS is not set: browsers on other origins cannot read the public API (set it to your front-end origin).');
  return {
    specs: [
      { name: 'engine', command: process.execPath, args: [`${cwd}/dist/main.js`], env: engineEnv },
      { name: 'web', command: process.execPath, args: [`${cwd}/web/serve-dist/scripts/wallet-test/server.js`], env: webEnv },
    ],
    warnings,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { specs, warnings } = replitSpecs(process.env);
  for (const w of warnings) defaultLog('warning', { message: w });
  const sup = supervise({ specs });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => void sup.stop(sig).then(() => process.exit(0)));
  await sup.done;
}
