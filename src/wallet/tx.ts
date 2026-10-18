/* Client-side transaction construction. Pure, no I/O, no Node-only API (runs in a browser).
 *
 * Builds an UNSIGNED legacy transaction that burns tokens from the user's own token account with the user as
 * fee payer and sole signer. Nothing in this module can sign: the only signature that ever ends up in a
 * transaction is the one the user's wallet returns (see `attachSignature` / `assertSameMessage`). */

import { decodeBase58, encodeBase58 } from '../core/base58.ts';
import { TOKEN_PROGRAMS, type TokenProgram } from '../config/schema.ts';
import { U64_MAX } from '../core/amount.ts';

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const SIGNATURE_BYTES = 64;
/** Fee charged per signature on Solana (the exact fee still comes from `getFeeForMessage`). */
export const BASE_FEE_LAMPORTS = 5_000n;
/** A legacy transaction must fit in one packet. */
export const MAX_TRANSACTION_BYTES = 1232;

export class TxError extends Error {
  override name = 'TxError';
}

const key32 = (address: string, what: string): Uint8Array => {
  const b = decodeBase58(address);
  if (!b || b.length !== 32) throw new TxError(`${what}: not a valid address`);
  return b;
};

const compactU16 = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) return [...out, b];
    out.push(b | 0x80);
  }
};

const u64le = (n: bigint): number[] => {
  if (n < 0n || n > U64_MAX) throw new TxError('amount does not fit in a u64');
  const out: number[] = [];
  for (let i = 0n; i < 8n; i++) out.push(Number((n >> (8n * i)) & 0xffn));
  return out;
};

export interface BurnInstructionParams {
  readonly tokenProgram: TokenProgram;
  readonly owner: string;
  readonly tokenAccount: string;
  readonly mint: string;
  readonly amountRaw: bigint;
  readonly decimals: number;
}

export interface BuildBurnParams extends BurnInstructionParams {
  readonly recentBlockhash: string;
  /** Optional priority fee, in micro-lamports per compute unit (requires `computeUnitLimit`). */
  readonly computeUnitPriceMicroLamports?: bigint;
  readonly computeUnitLimit?: number;
}

interface Ix {
  programId: string;
  keys: { pubkey: string; signer: boolean; writable: boolean }[];
  data: number[];
}

/** SPL Token `BurnChecked` (tag 15): accounts [token account (w), mint (w), owner (signer)]. */
export function burnCheckedInstruction(p: BurnInstructionParams): Ix {
  if (!Number.isInteger(p.decimals) || p.decimals < 0 || p.decimals > 255) throw new TxError('decimals out of range');
  if (p.amountRaw <= 0n) throw new TxError('the amount to burn must be greater than zero');
  return {
    programId: TOKEN_PROGRAMS[p.tokenProgram],
    keys: [
      { pubkey: p.tokenAccount, signer: false, writable: true },
      { pubkey: p.mint, signer: false, writable: true },
      { pubkey: p.owner, signer: true, writable: false },
    ],
    data: [15, ...u64le(p.amountRaw), p.decimals],
  };
}

export interface UnsignedBurn {
  /** Serialized message: exactly the bytes the wallet signs. */
  readonly message: Uint8Array;
  /** Serialized transaction with an all-zero signature slot, ready to hand to a wallet. */
  readonly transaction: Uint8Array;
  readonly feePayer: string;
}

export function buildUnsignedBurn(p: BuildBurnParams): UnsignedBurn {
  const ixs: Ix[] = [];
  if (p.computeUnitPriceMicroLamports !== undefined) {
    if (p.computeUnitLimit === undefined || !Number.isInteger(p.computeUnitLimit) || p.computeUnitLimit < 1 || p.computeUnitLimit > 1_400_000) {
      throw new TxError('a priority fee needs a compute unit limit in [1, 1400000]');
    }
    ixs.push({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: [2, p.computeUnitLimit & 0xff, (p.computeUnitLimit >> 8) & 0xff, (p.computeUnitLimit >> 16) & 0xff, (p.computeUnitLimit >>> 24) & 0xff] });
    ixs.push({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: [3, ...u64le(p.computeUnitPriceMicroLamports)] });
  }
  ixs.push(burnCheckedInstruction(p));

  // Account order required by the runtime: fee payer (signer, writable), writable non-signers, read-only (programs).
  const writable: string[] = [];
  const readonly: string[] = [];
  const addWritable = (k: string) => { if (k !== p.owner && !writable.includes(k)) writable.push(k); };
  const addReadonly = (k: string) => { if (k !== p.owner && !writable.includes(k) && !readonly.includes(k)) readonly.push(k); };
  for (const ix of ixs) for (const k of ix.keys) if (k.writable) addWritable(k.pubkey); else if (!k.signer) addReadonly(k.pubkey);
  for (const ix of ixs) addReadonly(ix.programId);
  const ordered = [p.owner, ...writable, ...readonly];
  const index = (k: string) => ordered.indexOf(k);

  const hash = decodeBase58(p.recentBlockhash);
  if (!hash || hash.length !== 32) throw new TxError('invalid blockhash');
  const out: number[] = [1, 0, readonly.length, ...compactU16(ordered.length)];
  for (const k of ordered) out.push(...key32(k, 'account'));
  out.push(...hash, ...compactU16(ixs.length));
  for (const ix of ixs) out.push(index(ix.programId), ...compactU16(ix.keys.length), ...ix.keys.map((k) => index(k.pubkey)), ...compactU16(ix.data.length), ...ix.data);
  const message = Uint8Array.from(out);
  const transaction = Uint8Array.from([1, ...new Array(SIGNATURE_BYTES).fill(0), ...message]);
  if (transaction.length > MAX_TRANSACTION_BYTES) throw new TxError('transaction too large');
  return { message, transaction, feePayer: p.owner };
}

export interface ParsedTransaction {
  readonly signatures: Uint8Array[];
  readonly message: Uint8Array;
}

/** Splits a serialized transaction into its signatures and message bytes (legacy and v0 share this prefix). */
export function splitTransaction(tx: Uint8Array): ParsedTransaction {
  let n = 0;
  let shift = 0;
  let pos = 0;
  for (;;) {
    const b = tx[pos++];
    if (b === undefined || pos > 3) throw new TxError('malformed transaction');
    n |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  const end = pos + n * SIGNATURE_BYTES;
  if (end >= tx.length) throw new TxError('malformed transaction');
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < n; i++) signatures.push(tx.slice(pos + i * SIGNATURE_BYTES, pos + (i + 1) * SIGNATURE_BYTES));
  return { signatures, message: tx.slice(end) };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The wallet must sign exactly the message we built: any difference (instructions, payer, blockhash) is refused. */
export function assertSameMessage(signedTransaction: Uint8Array, expected: UnsignedBurn): { signature: Uint8Array; signatureBase58: string } {
  const parsed = splitTransaction(signedTransaction);
  if (!sameBytes(parsed.message, expected.message)) throw new TxError('the wallet returned a transaction different from the one previewed');
  const signature = parsed.signatures[0];
  if (parsed.signatures.length !== 1 || signature === undefined || signature.every((b) => b === 0)) {
    throw new TxError('the wallet returned an unsigned transaction');
  }
  return { signature, signatureBase58: encodeBase58(signature) };
}

export const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
