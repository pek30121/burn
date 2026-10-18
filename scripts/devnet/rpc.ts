/* Devnet JSON-RPC helpers for the validation scripts. Refuses to run against anything that is not Devnet. */
import { encodeBase58 } from '../../src/core/base58.ts';

export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
// Endpoint: DEVNET_RPC_URL (any provider), else HELIUS_API_KEY (one Helius key serves every network; this builds the
// Devnet host), else the public Devnet RPC. The URL contains the key: it is never printed (see describeRpc()).
export const RPC_URL = process.env.DEVNET_RPC_URL ?? (process.env.HELIUS_API_KEY ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 'https://api.devnet.solana.com');
export const describeRpc = (): string => (process.env.DEVNET_RPC_URL ? 'custom endpoint (DEVNET_RPC_URL)' : process.env.HELIUS_API_KEY ? 'Helius Devnet (devnet.helius-rpc.com)' : 'public Devnet RPC (api.devnet.solana.com)');
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export class RpcFailure extends Error {
  readonly code: number | null;
  constructor(method: string, code: number | null, message: string) {
    super(`${method}: ${message}`);
    this.code = code;
  }
}

export async function rpc<T = any>(method: string, params: unknown[] = [], url: string = RPC_URL): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    } catch {
      if (attempt < 4) { await sleep(1000 * (attempt + 1)); continue; }
      throw new RpcFailure(method, null, 'network error');
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 6) { await sleep(1500 * (attempt + 1)); continue; }
    const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { code?: number; message?: string } };
    if (body.error) throw new RpcFailure(method, body.error.code ?? null, body.error.message ?? 'rpc error');
    return body.result as T;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Throws unless the endpoint is really Devnet (genesis hash), so no script can ever touch Mainnet. */
export async function assertDevnet(url: string = RPC_URL): Promise<void> {
  const genesis = await rpc<string>('getGenesisHash', [], url);
  if (genesis !== DEVNET_GENESIS) throw new Error('refusing to run: the RPC endpoint is not Solana Devnet');
}

export async function getBalance(address: string): Promise<bigint> {
  return BigInt((await rpc<{ value: number }>('getBalance', [address, { commitment: 'finalized' }])).value);
}

export async function requestAirdrop(address: string, lamports: bigint): Promise<string> {
  return rpc<string>('requestAirdrop', [address, Number(lamports)]);
}

export async function latestBlockhash(): Promise<string> {
  return (await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
}

export async function rentExempt(space: number): Promise<bigint> {
  return BigInt(await rpc<number>('getMinimumBalanceForRentExemption', [space]));
}

export interface Sent {
  signature: string;
  slot: number;
}

/** Sends a signed transaction and waits until it is FINALIZED; throws if it failed on-chain. */
export async function sendAndFinalize(wire: Uint8Array, timeoutMs = 120_000): Promise<Sent> {
  const signature = await rpc<string>('sendTransaction', [Buffer.from(wire).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = (await rpc<{ value: ({ slot: number; err: unknown; confirmationStatus: string } | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).value[0];
    if (st?.err) throw new Error(`transaction ${signature} failed on-chain: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'finalized') return { signature, slot: st.slot };
    await sleep(1000);
  }
  throw new Error(`transaction ${signature} not finalized within ${timeoutMs} ms`);
}

export const shortSig = (s: string) => `${s.slice(0, 8)}…${s.slice(-6)}`;
void encodeBase58;
