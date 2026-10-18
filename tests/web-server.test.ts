import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebServer, RPC_ALLOWLIST } from '../scripts/wallet-test/server.ts';

const KEY = 'SERVER-ONLY-HELIUS-KEY-123';
interface Seen { url: string; body?: any }

async function start(over: { rate?: number; upstream?: (url: string, init?: RequestInit) => Response | Promise<Response> } = {}) {
  const seen: Seen[] = [];
  const fakeFetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (over.upstream) return over.upstream(url, init);
    if (url.startsWith('http://engine.local')) return new Response(JSON.stringify({ ok: true, path: new URL(url).pathname }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }));
  }) as typeof fetch;
  const server = createWebServer({ upstreamRpc: `https://devnet.helius-rpc.com/?api-key=${KEY}`, engineUrl: 'http://engine.local:8787', ratePerMinute: over.rate ?? 1000, fetch: fakeFetch, config: { cluster: 'devnet', rpcUrl: '/rpc', engineBase: '', projects: [] } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
const rpc = (base: string, body: unknown) => fetch(`${base}/rpc`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

test('[web] /rpc forwards only the allowlisted methods, with the server-side key, and never returns it', async () => {
  const s = await start();
  try {
    for (const method of RPC_ALLOWLIST) {
      const res = await rpc(s.base, { jsonrpc: '2.0', id: 7, method, params: [] });
      assert.equal(res.status, 200, method);
    }
    const up = s.seen.at(-1)!;
    assert.match(up.url, new RegExp(`api-key=${KEY}`), 'the upstream call carries the key (server side only)');
    assert.deepEqual(Object.keys(up.body).sort(), ['id', 'jsonrpc', 'method', 'params']);
    for (const method of ['getProgramAccounts', 'getTransaction', 'requestAirdrop', 'getSlot', 'getTokenLargestAccounts', 'sendBundle']) {
      const res = await rpc(s.base, { jsonrpc: '2.0', id: 1, method, params: [] });
      assert.equal(res.status, 403, method);
    }
    const before = s.seen.length;
    assert.equal((await rpc(s.base, [{ jsonrpc: '2.0', id: 1, method: 'getBalance' }])).status, 400, 'batches refused');
    assert.equal((await rpc(s.base, 'not json')).status, 400);
    assert.equal((await rpc(s.base, 'x'.repeat(70_000))).status, 413);
    assert.equal((await fetch(`${s.base}/rpc`)).status, 405);
    assert.equal(s.seen.length, before, 'refused requests never reach the upstream');
  } finally { await s.close(); }
});

test('[web] an upstream that echoes the key, fails, or is down cannot leak it', async () => {
  const echo = await start({ upstream: () => new Response(`{"error":{"message":"bad https://devnet.helius-rpc.com/?api-key=${KEY}"}}`) });
  try {
    const text = await (await rpc(echo.base, { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [] })).text();
    assert.doesNotMatch(text, new RegExp(KEY));
  } finally { await echo.close(); }
  const down = await start({ upstream: () => { throw new TypeError(`fetch failed https://devnet.helius-rpc.com/?api-key=${KEY}`); } });
  try {
    const res = await rpc(down.base, { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [] });
    assert.equal(res.status, 502);
    assert.doesNotMatch(await res.text(), new RegExp(`${KEY}|helius`));
  } finally { await down.close(); }
});

test('[web] rate limit per client', async () => {
  const s = await start({ rate: 3 });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await rpc(s.base, { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [] })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally { await s.close(); }
});

test('[web] the engine proxy is GET only and read-only; static files cannot escape the web directory', async () => {
  const s = await start();
  try {
    assert.equal((await fetch(`${s.base}/api/v1/projects/x/status`)).status, 200);
    assert.equal(s.seen.at(-1)!.url, 'http://engine.local:8787/api/v1/projects/x/status');
    assert.equal((await fetch(`${s.base}/api/v1/projects/x/status`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${s.base}/api/v1/projects/x/status`, { method: 'DELETE' })).status, 405);
    const index = await fetch(`${s.base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Burn — page de test wallet/);
    for (const evil of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/.env', '/dist/../../package.json', '/app.js%00.json']) {
      const res = await fetch(`${s.base}${evil}`);
      assert.ok(res.status === 404 || res.status === 400, `${evil} -> ${res.status}`);
      assert.doesNotMatch(await res.text(), /solana-token-engine/);
    }
    assert.deepEqual(await (await fetch(`${s.base}/config.json`)).json(), { cluster: 'devnet', rpcUrl: '/rpc', engineBase: '', projects: [] });
  } finally { await s.close(); }
});

test('[web] behind a reverse proxy the rate limit is per forwarded client, and the header is ignored unless trusted', async () => {
  const build = async (trustProxy: boolean) => {
    const server = createWebServer({ upstreamRpc: 'http://up.local', engineUrl: 'http://engine.local', ratePerMinute: 2, trustProxy, fetch: (async () => new Response('{"jsonrpc":"2.0","id":1,"result":1}')) as typeof fetch });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  };
  const call = (base: string, ip: string) => fetch(`${base}/rpc`, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":[]}' }).then((r) => r.status);
  const trusted = await build(true);
  try {
    assert.deepEqual([await call(trusted.base, '1.1.1.1'), await call(trusted.base, '1.1.1.1'), await call(trusted.base, '1.1.1.1'), await call(trusted.base, '2.2.2.2')], [200, 200, 429, 200]);
  } finally { trusted.server.closeAllConnections(); trusted.server.close(); }
  const direct = await build(false);
  try {
    // spoofing X-Forwarded-For must not give a client a fresh bucket when the proxy is not trusted
    assert.deepEqual([await call(direct.base, '1.1.1.1'), await call(direct.base, '2.2.2.2'), await call(direct.base, '3.3.3.3')], [200, 200, 429]);
  } finally { direct.server.closeAllConnections(); direct.server.close(); }
});

test('[web] the real client is the LAST X-Forwarded-For entry: a client cannot pick its own rate-limit bucket by prepending addresses', async () => {
  const server = createWebServer({ upstreamRpc: 'http://up.local', engineUrl: 'http://engine.local', ratePerMinute: 2, trustProxy: true, fetch: (async () => new Response('{"jsonrpc":"2.0","id":1,"result":1}')) as typeof fetch });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const call = (xff: string) => fetch(`${base}/rpc`, { method: 'POST', headers: { 'x-forwarded-for': xff }, body: '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":[]}' }).then((r) => r.status);
    // the proxy appends the real address last; the client forged different leading entries every time
    assert.deepEqual([await call('9.9.9.1, 7.7.7.7'), await call('9.9.9.2, 7.7.7.7'), await call('9.9.9.3, 7.7.7.7'), await call('9.9.9.4, 8.8.8.8')], [200, 200, 429, 200]);
  } finally { server.closeAllConnections(); server.close(); }
});

test('[web] event streams are passed through unbuffered with Last-Event-ID and the real client address, and closing the browser closes the upstream', async () => {
  const { createServer } = await import('node:http');
  const seen: { path: string; headers: Record<string, unknown> }[] = [];
  let upstreamClosed = false;
  const engine = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ready\ndata: {}\n\n');
    const t = setInterval(() => res.write('id: 5\nevent: burn\ndata: {"x":1}\n\n'), 20);
    res.on('close', () => { clearInterval(t); upstreamClosed = true; });
  });
  await new Promise<void>((r) => engine.listen(0, '127.0.0.1', r));
  const web = createWebServer({ upstreamRpc: 'http://up.local', engineUrl: `http://127.0.0.1:${(engine.address() as { port: number }).port}`, trustProxy: true, maxStreams: 1 });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
  try {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/v1/projects/wt-spl/stream`, { headers: { 'last-event-id': '4', 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }, signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('event: burn')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /event: ready/, 'frames arrive as the engine sends them, not at the end');
    assert.equal(seen[0]!.headers['last-event-id'], '4');
    assert.equal(seen[0]!.headers['x-forwarded-for'], '203.0.113.9', 'the engine gets ONE address: the last one');
    // a second stream beyond the cap is refused by the proxy itself
    assert.equal((await fetch(`${base}/api/v1/projects/wt-spl/stream`)).status, 503);
    ac.abort();
    for (let i = 0; i < 100 && !upstreamClosed; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(upstreamClosed, true);
    // a plain JSON route still works and stays GET-only
    const events = await fetch(`${base}/api/v1/projects/wt-spl/events`, { method: 'POST' });
    assert.equal(events.status, 405);
  } finally { web.closeAllConnections(); web.close(); engine.closeAllConnections(); engine.close(); }
});

test('[web] /rpc answers 503 until the upstream network is verified (the page itself is up regardless)', async () => {
  let ready = false;
  const server = createWebServer({ upstreamRpc: 'http://up.local', engineUrl: 'http://engine.local', rpcReady: () => ready, fetch: (async () => new Response('{"jsonrpc":"2.0","id":1,"result":"ok"}')) as typeof fetch });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const call = () => fetch(`${base}/rpc`, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":[]}' }).then((r) => r.status);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal(await call(), 503);
    ready = true;
    assert.equal(await call(), 200);
  } finally { server.closeAllConnections(); server.close(); }
});
