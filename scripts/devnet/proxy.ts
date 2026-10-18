/* A local JSON-RPC pass-through to Devnet that can be "cut" on demand, to test engine behaviour during
 * an RPC outage with REAL data. The outage is simulated (the proxy refuses requests); the data is real. */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RPC_URL } from './rpc.ts';

/** The engine's start-up guards (cluster genesis hash, mint owner) run before any indexing; an "outage" that also blocked them
 * would stop the engine from starting at all instead of testing how indexing behaves during an outage. */
const STARTUP_GUARDS = new Set(['getGenesisHash', 'getAccountInfo']);
const methodOf = (body: string): string => { try { return String(JSON.parse(body).method); } catch { return ''; } };

export async function startCuttableProxy(target: string = RPC_URL) {
  let cut = false;
  let forwarded = 0;
  let refused = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (cut && !STARTUP_GUARDS.has(methodOf(body))) {
        refused++;
        res.writeHead(503).end();
        return;
      }
      forwarded++;
      try {
        const up = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        res.writeHead(up.status, { 'content-type': 'application/json' }).end(await up.text());
      } catch {
        res.writeHead(502).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    cut: (v: boolean) => void (cut = v),
    stats: () => ({ forwarded, refused }),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
