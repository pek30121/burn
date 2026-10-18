/* Mainnet READ-ONLY access for the audit scripts. There is no code path here that can send a transaction:
 * only the methods in READ_METHODS can be called, and the genesis hash must be Mainnet's. The key never leaves
 * the URL (describeRpc() is the only thing printed). Credits are a local estimate, NOT the provider's billing. */
import { GENESIS_HASHES, SolanaRpc } from '../../src/chain/rpc.ts';

export const READ_METHODS = new Set(['getGenesisHash', 'getSlot', 'getBlocks', 'getBlock', 'getSignaturesForAddress', 'getTransaction', 'getTokenSupply', 'getAccountInfo', 'getBlockTime']);

const key = process.env.HELIUS_API_KEY;
const custom = process.env.MAINNET_RPC_URL;
export const MAINNET_URL = custom ?? (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : 'https://api.mainnet-beta.solana.com');
export const describeMainnetRpc = (): string => (custom ? 'custom endpoint (MAINNET_RPC_URL)' : key ? 'Helius Mainnet (mainnet.helius-rpc.com)' : 'public Mainnet RPC (api.mainnet-beta.solana.com)');

export const stats = { requests: 0, byMethod: {} as Record<string, number>, retries: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastStart = 0;
const MIN_INTERVAL = Number(process.env.MAINNET_MIN_INTERVAL_MS ?? 120);

export async function call<T = any>(method: string, params: unknown[] = []): Promise<T> {
  if (!READ_METHODS.has(method)) throw new Error(`method not allowed in a read-only audit: ${method}`);
  for (let attempt = 0; ; attempt++) {
    const wait = lastStart + MIN_INTERVAL - Date.now();
    lastStart = Math.max(Date.now(), lastStart + MIN_INTERVAL);
    if (wait > 0) await sleep(wait);
    stats.requests++;
    stats.byMethod[method] = (stats.byMethod[method] ?? 0) + 1;
    let res: Response;
    try {
      res = await fetch(MAINNET_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
    } catch {
      if (attempt < 5) { stats.retries++; await sleep(1000 * (attempt + 1)); continue; }
      throw new Error(`${method}: network error`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 8) { stats.retries++; await sleep(1500 * (attempt + 1)); continue; }
    const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { code?: number; message?: string } };
    if (body.error) throw new Error(`${method}: rpc error ${body.error.code ?? '?'} ${String(body.error.message ?? '').replace(/api-key=[^\s&"]+/g, 'api-key=***').slice(0, 160)}`);
    return body.result as T;
  }
}

/** Engine RPC client (the production code path) pointed at Mainnet. */
export const engineRpc = (): SolanaRpc =>
  new SolanaRpc({
    url: MAINNET_URL,
    baseDelayMs: 800,
    fetch: (async (u: any, init: any) => {
      let m = '?';
      try { m = JSON.parse(init.body).method; } catch {}
      stats.requests++;
      stats.byMethod[m] = (stats.byMethod[m] ?? 0) + 1;
      const wait = lastStart + MIN_INTERVAL - Date.now();
      lastStart = Math.max(Date.now(), lastStart + MIN_INTERVAL);
      if (wait > 0) await sleep(wait);
      return fetch(u, init);
    }) as typeof fetch,
  });

export async function assertMainnet(): Promise<void> {
  const g = await call<string>('getGenesisHash');
  if (g !== GENESIS_HASHES['mainnet-beta']) throw new Error('the endpoint does not serve Mainnet; refusing to run the Mainnet audit');
}
