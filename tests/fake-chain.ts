/* In-memory Solana node for indexer tests: serves getSignaturesForAddress /
 * getTransaction / getTokenSupply with real paging semantics, commitments and
 * fault injection. Transactions are real-shaped getTransaction responses. */
import { RpcError, RpcUnsupportedVersionError, type SignatureInfo } from '../src/chain/rpc.ts';
import { K, baseKeys, burnIx, makeTx, rawData } from './chain-helpers.ts';
import { MINT_A, MINT_B, randomSignature } from './helpers.ts';
import type { Commitment } from '../src/core/ledger.ts';

interface FakeTx {
  sig: string;
  slot: number;
  mints: string[];
  burns: { mint: string; amount: bigint }[];
  response: unknown;
  err: unknown;
  hidden: boolean;
}

export interface AddOpts {
  slot: number;
  /** Burn amounts of MINT_A, one outer instruction each. */
  burns?: bigint[];
  /** Burn amounts of MINT_B in the same transaction. */
  burnsB?: bigint[];
  err?: unknown;
  response?: unknown;
  /** Counted in the supply but never listed by getSignaturesForAddress. */
  hidden?: boolean;
}

export class FakeChain {
  txs: FakeTx[] = [];
  finalizedSlot = 0;
  initialSupply = 1_000_000_000_000n;
  calls = { sigs: 0, tx: 0, supply: 0 };
  nullFor = new Set<string>();
  versionErrorFor = new Set<string>();
  scramble = false;
  afterSupply: (() => void) | null = null;
  /** Let `skip` calls through, then fail the next `times` calls with a non-retryable RPC error. */
  txFault: { skip: number; times: number } | null = null;
  sigsFault: { skip: number; times: number } | null = null;

  add(o: AddOpts): string {
    const sig = randomSignature();
    const k = { ...baseKeys(), otherMint: MINT_B };
    const ixs = [...(o.burns ?? []).map((a) => burnIx(a)), ...(o.burnsB ?? []).map((a) => burnIx(a, { mint: K.otherMint, acct: K.otherAcct }))];
    if (ixs.length === 0) ixs.push({ programIdIndex: K.fake, accounts: [K.acct, K.mint], data: rawData([1]) }); // touches the mint, no burn
    const response = o.response ?? makeTx(k, { signature: sig, slot: o.slot, instructions: ixs, err: o.err });
    this.txs.push({
      sig, slot: o.slot, hidden: o.hidden ?? false, err: o.err ?? null, response,
      mints: [MINT_A, ...(o.burnsB?.length ? [MINT_B] : [])],
      burns: [...(o.burns ?? []).map((amount) => ({ mint: MINT_A, amount })), ...(o.burnsB ?? []).map((amount) => ({ mint: MINT_B, amount }))],
    });
    return sig;
  }

  remove(sig: string): void {
    this.txs = this.txs.filter((t) => t.sig !== sig);
  }

  burned(mint = MINT_A, upTo = this.finalizedSlot): bigint {
    return this.txs.filter((t) => t.slot <= upTo && t.err === null).flatMap((t) => t.burns).filter((b) => b.mint === mint).reduce((a, b) => a + b.amount, 0n);
  }

  #visible(t: FakeTx, c: Commitment) {
    return c === 'confirmed' || t.slot <= this.finalizedSlot;
  }

  #fault(f: { skip: number; times: number } | null, calls: number): boolean {
    return f !== null && calls > f.skip && calls <= f.skip + f.times;
  }

  async getSignaturesForAddress(address: string, q: { limit?: number; before?: string; until?: string; commitment: Commitment }): Promise<SignatureInfo[]> {
    this.calls.sigs++;
    if (this.#fault(this.sigsFault, this.calls.sigs)) throw new RpcError('getSignaturesForAddress: injected failure');
    let list = this.txs.filter((t) => t.mints.includes(address) && !t.hidden && this.#visible(t, q.commitment)).reverse();
    if (q.before !== undefined) {
      const i = list.findIndex((t) => t.sig === q.before);
      if (i < 0) throw new RpcError('before: unknown signature');
      list = list.slice(i + 1);
    }
    if (q.until !== undefined) {
      const i = list.findIndex((t) => t.sig === q.until);
      if (i >= 0) list = list.slice(0, i); // like a node: an unknown `until` is ignored
    }
    let page = list.slice(0, q.limit ?? 1000);
    if (this.scramble) page = [...page].reverse();
    return page.map((t) => ({ signature: t.sig, slot: t.slot, err: t.err, blockTime: 1_700_000_000 + t.slot }));
  }

  async getTransaction(sig: string, commitment: Commitment): Promise<unknown> {
    this.calls.tx++;
    if (this.#fault(this.txFault, this.calls.tx)) throw new RpcError('getTransaction: injected failure');
    if (this.versionErrorFor.has(sig)) throw new RpcUnsupportedVersionError('getTransaction: version');
    const t = this.txs.find((x) => x.sig === sig);
    if (!t || this.nullFor.has(sig) || !this.#visible(t, commitment)) return null;
    return t.response;
  }

  async getTokenSupply(_mint: string, _commitment: Commitment): Promise<{ amountRaw: bigint; decimals: number }> {
    this.calls.supply++;
    const out = { amountRaw: this.initialSupply - this.burned(), decimals: 6 };
    this.afterSupply?.();
    return out;
  }
}
