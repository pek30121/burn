/* A JSON-RPC front for FakeChain, usable as an injected `fetch` or as a real local HTTP
 * server. Hooks add faults (HTTP status per request) and delays, and every request is logged
 * so tests can compare what the engine counted with what the "server" really received. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeChain } from './fake-chain.ts';

export interface SeenRequest {
  method: string;
  address: string | null;
}

export interface RpcHooks {
  requests: SeenRequest[];
  /** Return an HTTP status (e.g. 429, 500) to fail this request instead of answering it. */
  fail?: (r: SeenRequest) => number | null;
  /** Awaited before answering (use it to hold a request in flight). */
  hold?: (r: SeenRequest) => Promise<void> | void;
  /** Genesis hash answered by getGenesisHash (default: Devnet). */
  genesis?: string;
  /** Owner program answered by getAccountInfo, per address (null = the account does not exist). Default: the SPL Token program. */
  owners?: Record<string, string | null>;
}

export const newHooks = (): RpcHooks => ({ requests: [] });

export async function handleRpc(chain: FakeChain, hooks: RpcHooks, raw: string): Promise<{ status: number; body: string; headers?: Record<string, string> }> {
  const req = JSON.parse(raw) as { id: number; method: string; params: any[] };
  const seen: SeenRequest = { method: req.method, address: typeof req.params?.[0] === 'string' && req.method !== 'getTransaction' ? req.params[0] : null };
  hooks.requests.push(seen);
  await hooks.hold?.(seen);
  const status = hooks.fail?.(seen);
  if (status) return { status, body: '{}', ...(status === 429 ? { headers: { 'retry-after': '0' } } : {}) };
  const ok = (result: unknown) => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) });
  try {
    switch (req.method) {
      case 'getGenesisHash':
        return ok(hooks.genesis ?? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
      case 'getAccountInfo': {
        const owner = hooks.owners && req.params[0] in hooks.owners ? hooks.owners[req.params[0]] : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
        if (owner === null) return ok({ context: { slot: chain.finalizedSlot }, value: null });
        // Full account data (the supply proof reads the mint): an 82-byte Token mint with a revoked authority; owner-only reads get no data.
        const full = !req.params[1]?.dataSlice;
        const mint = new Uint8Array(82);
        const dv = new DataView(mint.buffer);
        dv.setBigUint64(36, chain.initialSupply - chain.burned(), true);
        if (chain.mintAuthority !== null) { dv.setUint32(0, 1, true); mint.fill(7, 4, 36); } // an active mint authority
        mint[44] = chain.mintDecimals;
        mint[45] = 1;
        return ok({ context: { slot: chain.finalizedSlot }, value: { owner, lamports: 1, executable: false, rentEpoch: 0, data: [full ? Buffer.from(mint).toString('base64') : '', 'base64'] } });
      }
      case 'getSignaturesForAddress':
        return ok(await chain.getSignaturesForAddress(req.params[0], req.params[1]));
      case 'getTransaction':
        return ok(await chain.getTransaction(req.params[0], req.params[1].commitment));
      case 'getTokenSupply': {
        const s = await chain.getTokenSupply(req.params[0], req.params[1].commitment);
        return ok({ value: { amount: s.amountRaw.toString(), decimals: s.decimals } });
      }
      default:
        return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } }) };
    }
  } catch (e) {
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: (e as Error).message } }) };
  }
}

export function fakeFetch(chain: FakeChain, hooks: RpcHooks): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const r = await handleRpc(chain, hooks, init!.body as string);
    return new Response(r.body, { status: r.status, headers: r.headers ?? {} });
  }) as typeof fetch;
}

export async function startRpcServer(chain: FakeChain, hooks: RpcHooks): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', async () => {
      const r = await handleRpc(chain, hooks, data);
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(r.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export const count = (hooks: RpcHooks, method: string, address?: string) =>
  hooks.requests.filter((r) => r.method === method && (address === undefined || r.address === address)).length;
