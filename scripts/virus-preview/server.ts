/* VIRUS.EXE PREVIEW SERVER — an isolated, self-contained demo of the site. `npm run virus:preview`.
 *
 * What it is: the REAL site (web/virus), the REAL web server (same routes as production: /virus/, /rpc, /api/v1, /dist) and the
 * REAL public API code (src/api), fed by SIMULATED data in memory: a demo project, a mock Solana RPC and a demo wallet.
 * Everything simulated is labelled DEMO on screen. There is no database, no indexer, no Solana connection, no key, no secret.
 *
 * Safety:
 *  - it refuses to start where a secret that belongs to the real engine exists (DATABASE_URL, HELIUS_API_KEY, SOLANA_RPC_URL,
 *    WEB_UPSTREAM_RPC_URL), so it can never run next to the production database or RPC key;
 *  - the demo controls (/demo/api/*) and the demo script (/virus-demo/demo.js) exist ONLY here: the production web server returns 404;
 *  - the demo wallet signs nothing real: its "signature" is random bytes that only this mock RPC accepts;
 *  - the demo mint is a made-up constant, not a token. Nothing here can burn anything on any network.
 * Production is never affected: the production supervisor does not start this file. */
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApiServer, type ApiConfig, type ApiServer } from '../../src/api/http.ts';
import type { ApiSource, ReachedLevel, StoredBurnRow, StoredEvent } from '../../src/api/types.ts';
import { GENESIS_HASHES } from '../../src/chain/rpc.ts';
import { ProjectRegistry } from '../../src/config/registry.ts';
import { parseProjectConfig, TOKEN_PROGRAMS, type ProjectConfig } from '../../src/config/schema.ts';
import { decodeBase58, encodeBase58 } from '../../src/core/base58.ts';
import { crossedLevels } from '../../src/core/progression.ts';
import { createLogger } from '../../src/engine/logger.ts';
import { emptyState, type IndexState, type Totals } from '../../src/indexer/store.ts';
import { fromBase64, parseMessage, splitTransaction, toBase64 } from '../../src/wallet/tx.ts';
import { createWebServer } from '../wallet-test/server.ts';

export const FORBIDDEN_ENV = ['DATABASE_URL', 'HELIUS_API_KEY', 'SOLANA_RPC_URL', 'WEB_UPSTREAM_RPC_URL'] as const;
const DECIMALS = 6;
const fill = (b: number) => encodeBase58(new Uint8Array(32).fill(b));
export const DEMO_MINT = fill(0xd3); // made-up constant: NOT a token
export const DEMO_OWNER = fill(0xa1);
export const DEMO_TOKEN_ACCOUNT = fill(0xb2);
const START_BALANCE_RAW = 1_000_000n * 10n ** BigInt(DECIMALS); // 1,000,000 demo tokens
const demoSignature = () => `DEMO${encodeBase58(crypto.getRandomValues(new Uint8Array(60)))}`.slice(0, 88);

/* ------------------------------ the simulated engine read side ------------------------------ */

export class DemoApiSource implements ApiSource {
  readonly events: StoredEvent[] = [];
  reached: ReachedLevel[] = [];
  finalized = 0n;
  state: IndexState = { ...emptyState(), finalizedHead: 'demo', finalizedHeadSlot: 1, backfill: 'done_exhausted' };
  readonly project: ProjectConfig;
  constructor(project: ProjectConfig) { this.project = project; }

  /** What the real engine does when a burn is finalized: one burn event, then one mutation event per level crossed. */
  addBurn(amountRaw: bigint, signature: string = demoSignature(), owner: string = DEMO_OWNER): void {
    if (amountRaw <= 0n) return;
    const prev = this.finalized;
    this.finalized += amountRaw;
    const now = new Date();
    const id = () => this.events.length + 1;
    this.events.push({ id: id(), type: 'burn', createdAt: now, burn: { signature, instructionPath: '0', slot: 1000 + this.events.length, blockTime: Math.floor(now.getTime() / 1000), owner, amountRaw, finalizedAt: now } });
    for (const l of crossedLevels(this.project.levels, prev, this.finalized)) {
      this.events.push({ id: id(), type: 'mutation', createdAt: now, mutation: { levelId: l.id, levelIndex: this.project.levels.indexOf(l), totalRaw: this.finalized, triggeredBy: `${signature}#0` } });
      this.reached.push({ levelId: l.id, at: now, triggeredBy: `${signature}#0` });
    }
  }
  reset(): void { this.events.length = 0; this.reached = []; this.finalized = 0n; }

  async latestEventId() { return this.events.length; }
  async finalizedBurnCount(_id: string, upTo: number) { return this.events.filter((e) => e.type === 'burn' && e.id <= upTo).length; }
  async eventsAfter(_id: string, after: number, limit: number) { return this.events.filter((e) => e.id > after).slice(0, limit); }
  async burnsPage(_id: string, before: number | null, limit: number): Promise<StoredBurnRow[]> {
    return this.events.filter((e): e is Extract<StoredEvent, { type: 'burn' }> => e.type === 'burn' && (before === null || e.id < before)).reverse().slice(0, limit).map((e) => ({ id: e.id, burn: e.burn }));
  }
  async reachedLevels() { return [...this.reached]; }
  async peekState() { return structuredClone(this.state); }
  async totals(): Promise<Totals> { return { finalizedRaw: this.finalized, confirmedRaw: this.finalized, count: this.events.length }; }
  async ping() {}
}

/** The demo project: the 7 levels of the example VIRUS entry (same ids and thresholds as the site), a made-up mint, Token-2022. */
export async function demoProject(root: string): Promise<ProjectConfig> {
  const example = (await ProjectRegistry.fromFile(join(root, '..', 'config', 'projects.example.json'))).require('virus');
  return parseProjectConfig({
    id: 'virus', name: 'VIRUS.EXE (DEMO)', ticker: 'VIRUS', cluster: 'mainnet-beta', mint: DEMO_MINT, decimals: DECIMALS, tokenProgram: 'token-2022',
    levels: example.levels.map((l) => ({ id: l.id, name: l.name, threshold: String(l.thresholdRaw / 10n ** BigInt(DECIMALS)) })),
  });
}

/* ------------------------------------ the simulated Solana node ------------------------------------ */

function mintBytes(supply: bigint): Uint8Array {
  const b = new Uint8Array(82);
  new DataView(b.buffer).setBigUint64(36, supply, true);
  b[44] = DECIMALS;
  b[45] = 1;
  return b;
}
function tokenAccountBytes(amount: bigint): Uint8Array {
  const b = new Uint8Array(165);
  b.set(decodeBase58(DEMO_MINT)!, 0);
  b.set(decodeBase58(DEMO_OWNER)!, 32);
  new DataView(b.buffer).setBigUint64(64, amount, true);
  b[108] = 1;
  return b;
}

export interface MockRpc { readonly url: string; readonly sent: string[]; setBalance(raw: bigint): void; balance(): bigint; close(): Promise<void> }

/** JSON-RPC mock: enough for the wallet flow. A "sent" burn is confirmed after 1.5 s, finalized after 4 s; at finalization the ENGINE (demo source) lists it. */
export async function startMockRpc(source: DemoApiSource, timing = { confirmMs: 1500, finalizeMs: 4000 }): Promise<MockRpc> {
  let balance = START_BALANCE_RAW;
  const phase = new Map<string, 'processed' | 'confirmed' | 'finalized'>();
  const sent: string[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let msg: { id: unknown; method: string; params: any[] };
      try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      const ok = (result: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
      const ctx = { slot: 1 };
      const account = (owner: string, data: Uint8Array) => ({ owner, lamports: 2_000_000, data: [toBase64(data), 'base64'], executable: false, rentEpoch: 0 });
      switch (msg.method) {
        case 'getGenesisHash': return ok(GENESIS_HASHES['mainnet-beta']);
        case 'getLatestBlockhash': return ok({ context: ctx, value: { blockhash: encodeBase58(new Uint8Array(32).fill(7)), lastValidBlockHeight: 1_000_000 } });
        case 'getBlockHeight': return ok(500);
        case 'getBalance': return ok({ context: ctx, value: 1_000_000_000 });
        case 'getAccountInfo': {
          const a = msg.params[0];
          if (a === DEMO_MINT) return ok({ context: ctx, value: account(TOKEN_PROGRAMS['token-2022'], mintBytes(1_000_000_000n * 10n ** BigInt(DECIMALS) - source.finalized)) });
          if (a === DEMO_TOKEN_ACCOUNT) return ok({ context: ctx, value: account(TOKEN_PROGRAMS['token-2022'], tokenAccountBytes(balance)) });
          return ok({ context: ctx, value: null });
        }
        case 'getTokenAccountsByOwner': return ok({ context: ctx, value: [{ pubkey: DEMO_TOKEN_ACCOUNT, account: account(TOKEN_PROGRAMS['token-2022'], tokenAccountBytes(balance)) }] });
        case 'getFeeForMessage': return ok({ context: ctx, value: 5000 });
        case 'simulateTransaction': return ok({ context: ctx, value: { err: null, logs: [], unitsConsumed: 1950 } });
        case 'sendTransaction': {
          // read what the wallet signed: the amount of the BurnChecked instruction (tag 15)
          let tx: ReturnType<typeof splitTransaction> | null = null;
          let ix: ReturnType<typeof parseMessage>['instructions'][number] | undefined;
          try {
            tx = splitTransaction(fromBase64(msg.params[0]));
            const m = parseMessage(tx.message);
            ix = m.instructions.find((i) => m.keys[i.programIdIndex] === TOKEN_PROGRAMS['token-2022'] && i.data[0] === 15);
          } catch { /* not a transaction: refused below */ }
          if (!tx || !ix) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'no burn in transaction' } })); return; }
          const amount = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true);
          const sig = encodeBase58(tx.signatures[0]!);
          sent.push(sig);
          phase.set(sig, 'processed');
          setTimeout(() => { phase.set(sig, 'confirmed'); balance -= amount; }, timing.confirmMs);
          setTimeout(() => { phase.set(sig, 'finalized'); source.addBurn(amount, sig, DEMO_OWNER); }, timing.finalizeMs);
          return ok(sig);
        }
        case 'getSignatureStatuses': return ok({ context: ctx, value: msg.params[0].map((s: string) => (phase.has(s) ? { slot: 600, err: null, confirmationStatus: phase.get(s) } : null)) });
        default: res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }));
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, sent, setBalance: (v) => { balance = v; }, balance: () => balance,
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

/* ------------------------------------------ the preview ------------------------------------------ */

export interface Preview { readonly url: string; readonly source: DemoApiSource; readonly rpc: MockRpc; close(): Promise<void> }

const API_CONFIG: ApiConfig = {
  host: '127.0.0.1', port: 0, corsOrigins: [], trustProxy: false, rateLimitPerMinute: 10_000,
  sse: { maxConnections: 100, maxPerIp: 50, heartbeatMs: 15_000, pollMs: 250, slowClientMs: 5_000 },
  statusCacheMs: 0, dbConcurrency: 4, dbQueue: 50, shutdownGraceMs: 500,
};

export async function startPreview(o: { port: number; host: string; root: string; trustProxy?: boolean; env?: Record<string, string | undefined>; timing?: { confirmMs: number; finalizeMs: number } }): Promise<Preview> {
  const env = o.env ?? process.env;
  const present = FORBIDDEN_ENV.filter((k) => env[k]);
  if (present.length) throw new Error(`refusing to start the preview: ${present.join(', ')} is set. The preview must never run where the real engine's database or RPC key exist (use a separate Replit without them).`);
  const project = await demoProject(o.root);
  const source = new DemoApiSource(project);
  const api: ApiServer = createApiServer({
    source, projects: [project], config: API_CONFIG, log: createLogger({ level: 'warn' }),
    runtime: { engineState: () => 'running', runner: () => ({ state: 'idle', consecutiveFailures: 0, lastSyncAt: new Date().toISOString(), lastError: null, holdsLease: true }) },
  });
  const apiPort = await api.listen();
  const rpc = await startMockRpc(source, o.timing);
  const web = createWebServer({ upstreamRpc: rpc.url, engineUrl: `http://127.0.0.1:${apiPort}`, ratePerMinute: 100_000, trustProxy: o.trustProxy ?? false });
  const webHandler = web.listeners('request')[0] as RequestListener;

  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const state = () => ({ demo: true, total: source.finalized.toString(), events: source.events.length, levels: project.levels.map((l) => ({ id: l.id, thresholdRaw: l.thresholdRaw.toString() })), account: DEMO_OWNER, decimals: DECIMALS, balanceRaw: rpc.balance().toString() });
  const indexHtml = async () => (await readFile(join(o.root, 'virus', 'index.html'), 'utf8')).replace('</body>', '  <script src="/virus-demo/demo.js"></script>\n</body>');

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const p = url.pathname;
        if (req.method === 'GET' && (p === '/virus/' || p === '/virus/index.html')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return void res.end(await indexHtml());
        }
        if (req.method === 'GET' && p === '/virus-demo/demo.js') {
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
          return void res.end(await readFile(join(o.root, 'virus-preview', 'demo.js')));
        }
        if (p.startsWith('/demo/api/')) {
          if (p === '/demo/api/state' && req.method === 'GET') return json(res, 200, state());
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
          const tokens = Number(url.searchParams.get('tokens'));
          if (p === '/demo/api/burn') {
            if (!Number.isInteger(tokens) || tokens < 1 || tokens > 1_000_000_000) return json(res, 400, { error: 'tokens must be an integer between 1 and 1,000,000,000' });
            source.addBurn(BigInt(tokens) * 10n ** BigInt(DECIMALS), demoSignature(), 'DemoControls');
            return json(res, 200, state());
          }
          if (p === '/demo/api/level') {
            const i = Number(url.searchParams.get('index'));
            const level = Number.isInteger(i) ? project.levels[i] : undefined;
            if (!level) return json(res, 400, { error: 'unknown level index' });
            if (level.thresholdRaw > source.finalized) source.addBurn(level.thresholdRaw - source.finalized, demoSignature(), 'DemoControls'); // lands exactly on the threshold
            return json(res, 200, state());
          }
          if (p === '/demo/api/reset') { source.reset(); rpc.setBalance(START_BALANCE_RAW); return json(res, 200, state()); }
          return json(res, 404, { error: 'not found' });
        }
        webHandler(req, res);
      } catch { json(res, 500, { error: 'internal error' }); }
    })();
  });
  await new Promise<void>((r) => server.listen(o.port, o.host, r));
  return {
    url: `http://${o.host === '0.0.0.0' ? '127.0.0.1' : o.host}:${(server.address() as { port: number }).port}`, source, rpc,
    close: async () => { await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); await api.close(); await rpc.close(); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? process.env.WEB_PORT ?? 8080);
  const root = process.env.WEB_ROOT ?? join(process.cwd(), 'web');
  const p = await startPreview({ port, host: process.env.WEB_HOST ?? '0.0.0.0', root, trustProxy: process.env.WEB_TRUST_PROXY === '1' });
  console.log(`VIRUS.EXE PREVIEW (demo data only, no token, no database, no secret): ${p.url}/virus/  — open /virus/ on this app's URL`);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void p.close().then(() => process.exit(0)));
}
