/* Browser-side JSON-RPC client for the wallet flow (balances, blockhash, simulation, send, status).
 *
 * IMPORTANT: this endpoint is called FROM THE BROWSER, so it must be a browser-safe URL (a public RPC, or a
 * provider URL restricted by origin). The engine's Helius key must never be used here (D22): it would be
 * readable by every visitor. Errors never contain the URL. */

import { fromBase64 } from './tx.ts';

export type WalletCommitment = 'processed' | 'confirmed' | 'finalized';

export class WalletRpcError extends Error {
  override name = 'WalletRpcError';
  readonly code: number | null;
  readonly data: unknown;
  constructor(message: string, code: number | null = null, data: unknown = undefined) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface RawAccount {
  readonly owner: string;
  readonly lamports: bigint;
  readonly data: Uint8Array;
}

export interface SignatureStatus {
  readonly slot: number;
  readonly err: unknown;
  readonly confirmationStatus: WalletCommitment | null;
}

export interface SimulationResult {
  readonly err: unknown;
  readonly logs: readonly string[] | null;
  readonly unitsConsumed: number | null;
}

/** Everything the wallet flow needs from a node. Injectable so tests need no network. */
export interface WalletRpc {
  getGenesisHash(): Promise<string>;
  getLatestBlockhash(commitment: WalletCommitment): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getBlockHeight(commitment: WalletCommitment): Promise<number>;
  getBalance(address: string): Promise<bigint>;
  getAccountInfo(address: string): Promise<RawAccount | null>;
  getTokenAccountsByOwner(owner: string, programId: string): Promise<{ address: string; account: RawAccount }[]>;
  getFeeForMessage(messageBase64: string): Promise<bigint | null>;
  simulateTransaction(transactionBase64: string): Promise<SimulationResult>;
  sendTransaction(transactionBase64: string): Promise<string>;
  getSignatureStatus(signature: string): Promise<SignatureStatus | null>;
}

export interface JsonRpcOptions {
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createJsonRpc(o: JsonRpcOptions): WalletRpc {
  const doFetch = o.fetch ?? fetch;
  let id = 1;
  async function call(method: string, params: unknown[]): Promise<any> {
    let res: Response;
    try {
      res = await doFetch(o.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }), signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
      });
    } catch {
      throw new WalletRpcError(`${method}: network error`); // original error dropped: it may quote the URL
    }
    if (!res.ok) throw new WalletRpcError(`${method}: HTTP ${res.status}`, res.status);
    let body: any;
    try { body = await res.json(); } catch { throw new WalletRpcError(`${method}: invalid response`); }
    if (body?.error) throw new WalletRpcError(`${method}: RPC error ${body.error.code ?? '?'}`, typeof body.error.code === 'number' ? body.error.code : null, body.error.data);
    if (!body || !('result' in body)) throw new WalletRpcError(`${method}: invalid response`);
    return body.result;
  }
  const account = (v: any): RawAccount => {
    if (!v || typeof v.owner !== 'string' || !Array.isArray(v.data) || typeof v.data[0] !== 'string') throw new WalletRpcError('malformed account');
    return { owner: v.owner, lamports: BigInt(v.lamports), data: fromBase64(v.data[0]) };
  };
  return {
    async getGenesisHash() { return String(await call('getGenesisHash', [])); },
    async getLatestBlockhash(commitment) {
      const r = (await call('getLatestBlockhash', [{ commitment }])).value;
      if (typeof r?.blockhash !== 'string' || !Number.isSafeInteger(r.lastValidBlockHeight)) throw new WalletRpcError('malformed blockhash');
      return { blockhash: r.blockhash, lastValidBlockHeight: r.lastValidBlockHeight };
    },
    async getBlockHeight(commitment) {
      const h = await call('getBlockHeight', [{ commitment }]);
      if (!Number.isSafeInteger(h)) throw new WalletRpcError('malformed block height');
      return h;
    },
    async getBalance(address) { return BigInt((await call('getBalance', [address, { commitment: 'confirmed' }])).value); },
    async getAccountInfo(address) {
      const v = (await call('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }])).value;
      return v === null ? null : account(v);
    },
    async getTokenAccountsByOwner(owner, programId) {
      const r = (await call('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'base64', commitment: 'confirmed' }])).value;
      if (!Array.isArray(r)) throw new WalletRpcError('malformed token accounts');
      return r.map((e: any) => ({ address: String(e.pubkey), account: account(e.account) }));
    },
    async getFeeForMessage(messageBase64) {
      const v = (await call('getFeeForMessage', [messageBase64, { commitment: 'confirmed' }])).value;
      return v === null || v === undefined ? null : BigInt(v);
    },
    async simulateTransaction(transactionBase64) {
      const v = (await call('simulateTransaction', [transactionBase64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' }])).value;
      return { err: v?.err ?? null, logs: Array.isArray(v?.logs) ? v.logs : null, unitsConsumed: Number.isSafeInteger(v?.unitsConsumed) ? v.unitsConsumed : null };
    },
    async sendTransaction(transactionBase64) {
      const sig = await call('sendTransaction', [transactionBase64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
      if (typeof sig !== 'string') throw new WalletRpcError('malformed signature');
      return sig;
    },
    async getSignatureStatus(signature) {
      const v = (await call('getSignatureStatuses', [[signature], { searchTransactionHistory: false }])).value?.[0];
      if (!v) return null;
      return { slot: v.slot, err: v.err ?? null, confirmationStatus: v.confirmationStatus ?? null };
    },
  };
}
