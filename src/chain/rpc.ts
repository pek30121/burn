/* Minimal Solana JSON-RPC client: only the calls the indexer needs.
 *
 * - Retries transient failures (network, timeout, HTTP 429/5xx, RPC -32005) with
 *   exponential backoff, honouring Retry-After. Everything else fails at once.
 * - `-32015` (transaction version newer than requested) is never retried and is
 *   surfaced as RpcUnsupportedVersionError: it means "stop", not "not found".
 * - Error messages never contain the endpoint URL, which usually embeds an API key. */

import { isPublicKey, isSignature } from '../core/base58.ts';
import type { Commitment } from '../core/ledger.ts';

export const MAX_SUPPORTED_TX_VERSION = 1;
export const SIGNATURES_PAGE_MAX = 1000;
const RETRYABLE_RPC_CODES = new Set([-32005]);

/** Genesis hash of each cluster: proves which network an RPC endpoint really serves. */
export const GENESIS_HASHES = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

export class RpcError extends Error {
  override name = 'RpcError';
  readonly code: number | null;
  readonly retryable: boolean;
  /** HTTP status when the failure was an HTTP one (e.g. 403 for a method the plan does not include). */
  readonly httpStatus: number | null;
  constructor(message: string, o: { code?: number | null; retryable?: boolean; httpStatus?: number | null } = {}) {
    super(message);
    this.code = o.code ?? null;
    this.retryable = o.retryable ?? false;
    this.httpStatus = o.httpStatus ?? null;
  }
}

export class RpcUnsupportedVersionError extends RpcError {
  override name = 'RpcUnsupportedVersionError';
}

export interface RpcOptions {
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface SignatureInfo {
  readonly signature: string;
  readonly slot: number;
  /** Non-null when the transaction failed on-chain (it can be skipped without fetching it). */
  readonly err: unknown;
  readonly blockTime: number | null;
}

export interface SignaturesQuery {
  readonly limit?: number;
  /** Start searching backwards from this signature (exclusive). */
  readonly before?: string;
  /** Stop when this signature is reached (exclusive). */
  readonly until?: string;
  readonly commitment: Commitment;
}

export interface BatchQuery {
  readonly slotGte: number;
  readonly slotLte: number;
  readonly limit?: number;
  readonly paginationToken?: string;
}

export interface BatchPage {
  /** Each item is a `getTransaction`-shaped response (slot, blockTime, version, transaction, meta), keyed by its signature. */
  readonly transactions: { signature: string; response: unknown }[];
  /** Items the node returned (what Helius bills: 10 credits per 100, minimum 10). */
  readonly returned: number;
  readonly paginationToken: string | null;
}

export class SolanaRpc {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  #nextId = 1;

  constructor(o: RpcOptions) {
    this.#url = o.url;
    this.#fetch = o.fetch ?? fetch;
    this.#maxRetries = o.maxRetries ?? 4;
    this.#timeoutMs = o.timeoutMs ?? 20_000;
    this.#baseDelayMs = o.baseDelayMs ?? 500;
    this.#maxDelayMs = o.maxDelayMs ?? 8_000;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#random = o.random ?? Math.random;
  }

  /** Genesis hash of the cluster served by the endpoint. */
  async getGenesisHash(): Promise<string> {
    const r = await this.#call('getGenesisHash', []);
    if (typeof r !== 'string' || r.length < 32 || r.length > 44) throw new RpcError('getGenesisHash: malformed response');
    return r;
  }

  /** Owner program of an account (no account data transferred), or null when the account does not exist. */
  async getAccountOwner(address: string, commitment: Commitment): Promise<string | null> {
    const result = (await this.#call('getAccountInfo', [address, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment }])) as { value?: { owner?: unknown } | null } | null;
    const v = result?.value;
    if (v === null) return null;
    if (!v || typeof v.owner !== 'string' || !isPublicKey(v.owner)) throw new RpcError('getAccountInfo: malformed response');
    return v.owner;
  }

  /** Newest first, at most 1000 per call; follow with `before` = last signature of the page. */
  async getSignaturesForAddress(address: string, q: SignaturesQuery): Promise<SignatureInfo[]> {
    const limit = q.limit ?? SIGNATURES_PAGE_MAX;
    if (!Number.isInteger(limit) || limit < 1 || limit > SIGNATURES_PAGE_MAX) {
      throw new RangeError(`limit must be an integer in [1, ${SIGNATURES_PAGE_MAX}]`);
    }
    const config: Record<string, unknown> = { limit, commitment: q.commitment };
    if (q.before !== undefined) config.before = q.before;
    if (q.until !== undefined) config.until = q.until;
    const result = await this.#call('getSignaturesForAddress', [address, config]);
    if (!Array.isArray(result)) throw new RpcError('getSignaturesForAddress: expected an array');
    return result.map((e: unknown, i) => {
      const o = e as Record<string, unknown> | null;
      if (
        typeof o !== 'object' || o === null || typeof o.signature !== 'string' || !isSignature(o.signature) ||
        !Number.isSafeInteger(o.slot) || (o.slot as number) < 0 || o.err === undefined ||
        !(o.blockTime == null || Number.isSafeInteger(o.blockTime))
      ) {
        throw new RpcError(`getSignaturesForAddress: malformed entry #${i}`);
      }
      return { signature: o.signature, slot: o.slot as number, err: o.err, blockTime: (o.blockTime as number | null | undefined) ?? null };
    });
  }

  /** Raw `getTransaction` response (encoding "json"), or null when the node does not have it at this commitment. */
  async getTransaction(signature: string, commitment: Commitment): Promise<unknown> {
    return this.#call('getTransaction', [
      signature,
      { encoding: 'json', maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION, commitment },
    ]);
  }

  /** Helius-only (`getTransactionsForAddress`): FULL successful transactions of an address in a slot range, newest first,
   * in the same shape and encoding as `getTransaction`. A cheaper TRANSPORT for transactions already listed by
   * `getSignaturesForAddress`, never a source of discovery: the caller falls back to `getTransaction` for anything absent. */
  async getTransactionsForAddress(address: string, q: BatchQuery): Promise<BatchPage> {
    const filters: Record<string, unknown> = { status: 'succeeded', slot: { gte: q.slotGte, lte: q.slotLte } };
    const config: Record<string, unknown> = {
      transactionDetails: 'full', encoding: 'json', maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION, commitment: 'finalized',
      sortOrder: 'desc', limit: q.limit ?? SIGNATURES_PAGE_MAX, filters,
    };
    if (q.paginationToken !== undefined) config.paginationToken = q.paginationToken;
    const result = (await this.#call('getTransactionsForAddress', [address, config])) as { data?: unknown; paginationToken?: unknown } | null;
    if (!result || !Array.isArray(result.data) || !(result.paginationToken === null || result.paginationToken === undefined || typeof result.paginationToken === 'string')) {
      throw new RpcError('getTransactionsForAddress: malformed response');
    }
    const transactions: BatchPage['transactions'] = [];
    for (const item of result.data) {
      // Entries that do not look like a transaction are skipped: the caller then fetches that signature on its own.
      const sig = (item as { transaction?: { signatures?: unknown[] } } | null)?.transaction?.signatures?.[0];
      if (typeof sig === 'string' && isSignature(sig)) transactions.push({ signature: sig, response: item });
    }
    return { transactions, returned: result.data.length, paginationToken: (result.paginationToken as string | null | undefined) ?? null };
  }

  /** Current supply in raw base units and the mint's decimals. */
  async getTokenSupply(mint: string, commitment: Commitment): Promise<{ amountRaw: bigint; decimals: number }> {
    const result = (await this.#call('getTokenSupply', [mint, { commitment }])) as { value?: { amount?: unknown; decimals?: unknown } } | null;
    const v = result?.value;
    if (!v || typeof v.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v.amount) || !Number.isInteger(v.decimals)) {
      throw new RpcError('getTokenSupply: malformed response');
    }
    return { amountRaw: BigInt(v.amount), decimals: v.decimals as number };
  }

  async #call(method: string, params: unknown[]): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#once(method, params);
      } catch (e) {
        const retryable = e instanceof RpcError ? e.retryable : false;
        if (!retryable || attempt >= this.#maxRetries) throw e;
        const hinted = (e as RpcError & { retryAfterMs?: number }).retryAfterMs;
        const backoff = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** attempt);
        await this.#sleep(Math.max(hinted ?? 0, Math.round(backoff * (0.5 + this.#random() / 2))));
      }
    }
  }

  async #once(method: string, params: unknown[]): Promise<unknown> {
    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method, params }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      // Deliberately drop the original error: it may quote the URL (and its API key).
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new RpcError(`${method}: ${timedOut ? 'request timed out' : 'network error'}`, { retryable: true });
    }
    if (res.status === 429 || res.status >= 500) {
      const err = new RpcError(`${method}: HTTP ${res.status}`, { retryable: true }) as RpcError & { retryAfterMs?: number };
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = Math.min(ra * 1000, 30_000);
      throw err;
    }
    if (!res.ok) throw new RpcError(`${method}: HTTP ${res.status}`, { httpStatus: res.status });

    let body: { result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new RpcError(`${method}: response is not valid JSON`, { retryable: true });
    }
    if (typeof body !== 'object' || body === null) throw new RpcError(`${method}: malformed response`);
    if (body.error) {
      const code = typeof body.error.code === 'number' ? body.error.code : null;
      if (code === -32015) {
        throw new RpcUnsupportedVersionError(`${method}: transaction version newer than ${MAX_SUPPORTED_TX_VERSION}`, { code });
      }
      throw new RpcError(`${method}: RPC error ${code ?? '?'}`, { code, retryable: code !== null && RETRYABLE_RPC_CODES.has(code) });
    }
    if (!('result' in body)) throw new RpcError(`${method}: response has neither result nor error`);
    return body.result;
  }
}
