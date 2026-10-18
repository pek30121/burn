/* `npm run web:serve` — serves the wallet test page and gives the BROWSER what it needs without exposing any server secret:
 *
 *   /            static test page (web/wallet-test) and /dist (the wallet module built by `npm run web:build`)
 *   /rpc         allowlisted JSON-RPC proxy to the upstream Devnet node. The Helius key stays in this process only: the
 *                browser sees `/rpc`. Allowlist = what src/wallet needs; no batches; size and rate limits; Devnet only
 *                (the upstream genesis hash is checked at start, so this can never be pointed at Mainnet by mistake).
 *   /api, /health   reverse proxy (GET) to the engine's public read-only API, so the page needs a single origin.
 *
 * Env: HELIUS_API_KEY or WEB_UPSTREAM_RPC_URL (upstream), ENGINE_URL (default http://127.0.0.1:8787),
 *      WEB_PORT (8788), WEB_HOST (127.0.0.1; use 0.0.0.0 on a LAN), WEB_RATE_PER_MINUTE (120). */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { GENESIS_HASHES } from '../../src/chain/rpc.ts';

export const RPC_ALLOWLIST = new Set([
  'getGenesisHash', 'getLatestBlockhash', 'getBlockHeight', 'getBalance', 'getAccountInfo', 'getTokenAccountsByOwner',
  'getFeeForMessage', 'simulateTransaction', 'sendTransaction', 'getSignatureStatuses',
]);
const MAX_BODY = 64 * 1024;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css' };
const ROOT = new URL('../../web/', import.meta.url).pathname;

export interface WebServerOptions {
  upstreamRpc: string;
  engineUrl: string;
  ratePerMinute?: number;
  fetch?: typeof fetch;
  now?: () => number;
  /** Served as /config.json instead of the file (tests). */
  config?: unknown;
}

const redact = (s: string) => s.replace(/api-key=[^&\s"']+/gi, 'api-key=***');

export function createWebServer(o: WebServerOptions) {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const hits = new Map<string, number[]>();
  const limited = (ip: string): boolean => {
    const t = now();
    const recent = (hits.get(ip) ?? []).filter((x) => t - x < 60_000);
    recent.push(t);
    hits.set(ip, recent);
    return recent.length > (o.ratePerMinute ?? 120);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function rpcProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) return json(res, 413, { error: 'request too large' });
      chunks.push(c as Buffer);
    }
    let body: any;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: 'invalid JSON' }); }
    if (Array.isArray(body) || typeof body !== 'object' || body === null) return json(res, 400, { error: 'batches are not accepted' });
    if (typeof body.method !== 'string' || !RPC_ALLOWLIST.has(body.method)) return json(res, 403, { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: 'method not allowed on this proxy' } });
    try {
      const up = await doFetch(o.upstreamRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, method: body.method, params: Array.isArray(body.params) ? body.params : [] }), signal: AbortSignal.timeout(20_000) });
      const text = await up.text();
      res.writeHead(up.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(redact(text));
    } catch {
      json(res, 502, { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32003, message: 'upstream unavailable' } });
    }
  }

  async function engineProxy(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only (the engine API is read-only)' });
    try {
      const up = await doFetch(new URL(path, o.engineUrl), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
      res.end(Buffer.from(await up.arrayBuffer()));
    } catch {
      json(res, 502, { error: { code: 'engine_unreachable', message: 'The engine is not reachable from the test server.' } });
    }
  }

  async function staticFile(res: ServerResponse, urlPath: string): Promise<void> {
    const rel = urlPath === '/' ? '/wallet-test/index.html' : urlPath.startsWith('/dist/') ? urlPath : `/wallet-test${urlPath}`;
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) || !TYPES[extname(file)]) return json(res, 404, { error: 'not found' });
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)]!, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(data);
    } catch {
      json(res, 404, { error: 'not found' });
    }
  }

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const ip = req.socket.remoteAddress ?? '?';
        if (url.pathname === '/rpc' || url.pathname.startsWith('/api/')) if (limited(ip)) return json(res, 429, { error: 'rate limited' });
        if (url.pathname === '/rpc') return await rpcProxy(req, res);
        if (url.pathname === '/config.json' && o.config !== undefined) return json(res, 200, o.config);
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health/')) return await engineProxy(req, res, url.pathname + url.search);
        if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
        return await staticFile(res, url.pathname);
      } catch {
        json(res, 500, { error: 'internal error' });
      }
    })();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const key = process.env.HELIUS_API_KEY;
  const upstream = process.env.WEB_UPSTREAM_RPC_URL ?? (key ? `https://devnet.helius-rpc.com/?api-key=${key}` : 'https://api.devnet.solana.com');
  const genesis = (await (await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash' }) })).json() as { result?: string }).result;
  if (genesis !== GENESIS_HASHES.devnet) throw new Error('refusing to start: the upstream RPC is not Solana Devnet');
  const port = Number(process.env.WEB_PORT ?? 8788);
  const host = process.env.WEB_HOST ?? '127.0.0.1';
  const server = createWebServer({ upstreamRpc: upstream, engineUrl: process.env.ENGINE_URL ?? 'http://127.0.0.1:8787', ratePerMinute: Number(process.env.WEB_RATE_PER_MINUTE ?? 120) });
  server.listen(port, host, () => console.log(`wallet test page: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/  (RPC: ${process.env.WEB_UPSTREAM_RPC_URL ? 'custom upstream' : key ? 'Helius Devnet' : 'public Devnet'} via /rpc, key never sent to the browser; engine: ${process.env.ENGINE_URL ?? 'http://127.0.0.1:8787'})`));
}
