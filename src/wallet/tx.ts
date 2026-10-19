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
  /** Public, sanitized explanation (addresses and counts only): safe to show to the user. */
  readonly detail: string | undefined;
  constructor(message: string, detail?: string) {
    super(message);
    this.detail = detail;
  }
}

export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
/** Lighthouse instructions that are PURE READ-ONLY ASSERTIONS on ONE target account (they can only fail the transaction, never move
 * or change anything): AssertAccountInfo 5, AssertAccountInfoMulti 6, AssertTokenAccount 9, AssertTokenAccountMulti 10. Numbers read from the
 * program's published client (each takes a single read-only `targetAccount`) and cross-checked on real Mainnet transactions (6 and 10 seen, 1
 * account each, 6 targeting the signer's own account, which is exactly what Phantom adds). Everything else is refused, notably
 * MemoryWrite 0 / MemoryClose 1 (they take a payer signer and move lamports) and every other assertion kind. */
export const LIGHTHOUSE_ASSERTIONS: ReadonlySet<number> = new Set([5, 6, 9, 10]);
const MAX_LIGHTHOUSE_DATA = 512;
/** A wallet-added priority fee above this (lamports, worst case) is refused: the preview showed only the base fee. */
export const MAX_WALLET_PRIORITY_FEE_LAMPORTS = 500_000n;

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
  /** What was asked of the wallet: the reference every signed message is checked against. */
  readonly params: BuildBurnParams;
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
  return { params: p, message, transaction, feePayer: p.owner };
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


/* ---------------------------------------------------------------------------------------------------------------------
 * Signed-transaction verification.
 *
 * Some wallets do not return the exact bytes they were given: Phantom documents that it may add Lighthouse assertion
 * instructions (runtime safety checks) before signing, and a wallet may also re-serialize a legacy message as v0. A strict
 * byte comparison then refuses a perfectly good transaction. The check below is SEMANTIC and fail-closed:
 *   identical bytes                      -> accepted;
 *   otherwise every one of these must hold, or nothing is sent:
 *     - the fee payer is the owner and the owner is the ONLY required signer;
 *     - the recent blockhash is ours (the expiry tracking depends on it);
 *     - no address lookup table is used (accounts stay fully visible);
 *     - exactly one instruction is our BurnChecked: same token program, same token account, mint and owner, same amount and decimals;
 *     - every other instruction belongs to an allowlist: ComputeBudget (limit / price, with a capped worst-case fee) and
 *       Lighthouse READ-ONLY ASSERTIONS (LIGHTHOUSE_ASSERTIONS): exactly one target account, which must be one of the burn's
 *       own accounts (owner, token account, mint) and no key the wallet introduced. Phantom's assertions legitimately target
 *       the owner's own account (balance checks); an assertion cannot act with the owner's authority, any other Lighthouse
 *       instruction (memory write/close, unknown) is refused.
 * Anything else (another program, a bigger burn, a different destination, a second signer...) is refused with a public
 * explanation of what differs. */

export interface ParsedMessage {
  readonly version: 'legacy' | 0;
  readonly numRequiredSignatures: number;
  readonly numReadonlySigned: number;
  readonly numReadonlyUnsigned: number;
  readonly keys: string[];
  readonly recentBlockhash: string;
  readonly instructions: { programIdIndex: number; accounts: number[]; data: Uint8Array }[];
  readonly lookupTables: number;
}

function readCompact(b: Uint8Array, at: { pos: number }): number {
  let n = 0;
  let shift = 0;
  for (let i = 0; i < 3; i++) {
    const byte = b[at.pos++];
    if (byte === undefined) throw new TxError('malformed message');
    n |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return n;
    shift += 7;
  }
  throw new TxError('malformed message');
}

export function parseMessage(b: Uint8Array): ParsedMessage {
  const at = { pos: 0 };
  const first = b[0];
  if (first === undefined) throw new TxError('malformed message');
  let version: 'legacy' | 0 = 'legacy';
  if ((first & 0x80) !== 0) {
    if ((first & 0x7f) !== 0) throw new TxError('unsupported message version', `message version ${first & 0x7f} is not supported`);
    version = 0;
    at.pos = 1;
  }
  const take = (n: number): Uint8Array => {
    if (at.pos + n > b.length) throw new TxError('malformed message');
    const out = b.slice(at.pos, at.pos + n);
    at.pos += n;
    return out;
  };
  const [numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned] = [...take(3)] as [number, number, number];
  const nKeys = readCompact(b, at);
  const keys: string[] = [];
  for (let i = 0; i < nKeys; i++) keys.push(encodeBase58(take(32)));
  const recentBlockhash = encodeBase58(take(32));
  const nIx = readCompact(b, at);
  const instructions: ParsedMessage['instructions'] = [];
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = take(1)[0]!;
    const nAcc = readCompact(b, at);
    const accounts = [...take(nAcc)];
    const nData = readCompact(b, at);
    instructions.push({ programIdIndex, accounts, data: take(nData) });
  }
  let lookupTables = 0;
  if (version === 0) {
    lookupTables = readCompact(b, at);
    for (let i = 0; i < lookupTables; i++) {
      take(32);
      take(readCompact(b, at));
      take(readCompact(b, at));
    }
  }
  if (at.pos !== b.length) throw new TxError('malformed message');
  if (instructions.some((ix) => ix.programIdIndex >= keys.length || ix.accounts.some((a) => a >= keys.length))) {
    if (lookupTables === 0) throw new TxError('malformed message');
  }
  return { version, numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned, keys, recentBlockhash, instructions, lookupTables };
}

export interface WalletAdditions {
  readonly version: 'legacy' | 0;
  /** Instructions the wallet added around ours. */
  readonly computeBudget: number;
  readonly lighthouse: number;
  /** Worst-case extra fee from a wallet-added priority fee (lamports); 0 when none. */
  readonly priorityFeeLamports: bigint;
}

const NO_ADDITIONS = (version: 'legacy' | 0): WalletAdditions => ({ version, computeBudget: 0, lighthouse: 0, priorityFeeLamports: 0n });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A public, one-line description of how the returned message differs from the requested one (no secret in it). */
export function describeDifference(expected: ParsedMessage, actual: ParsedMessage): string {
  const programs = [...new Set(actual.instructions.map((ix) => actual.keys[ix.programIdIndex] ?? '?'))].map(short);
  return [
    `version ${expected.version}->${actual.version}`,
    `required signers ${expected.numRequiredSignatures}->${actual.numRequiredSignatures}`,
    `accounts ${expected.keys.length}->${actual.keys.length}`,
    `instructions ${expected.instructions.length}->${actual.instructions.length}`,
    `programs [${programs.join(', ')}]`,
    `payer ${expected.keys[0] === actual.keys[0] ? 'same' : 'different'}`,
    `blockhash ${expected.recentBlockhash === actual.recentBlockhash ? 'same' : 'different'}`,
    `lookup tables ${actual.lookupTables}`,
  ].join('; ');
}

const refuse = (why: string, expected: ParsedMessage, actual: ParsedMessage): never => {
  throw new TxError('the wallet returned a transaction different from the one previewed', `${why} (${describeDifference(expected, actual)})`);
};

/** Throws TxError unless `actual` is `expected` plus only the additions described above. */
export function verifyMessageSemantics(actual: ParsedMessage, expected: ParsedMessage, params: BuildBurnParams): WalletAdditions {
  const keyAt = (i: number) => actual.keys[i] ?? '';
  if (actual.lookupTables > 0) refuse('the wallet used an address lookup table', expected, actual);
  if (actual.numRequiredSignatures !== 1 || actual.numReadonlySigned !== 0) refuse('the wallet requires more than the owner\'s signature', expected, actual);
  if (keyAt(0) !== params.owner) refuse('the fee payer is not the owner', expected, actual);
  if (actual.recentBlockhash !== params.recentBlockhash) refuse('the blockhash was changed', expected, actual);

  const burnData = burnCheckedInstruction(params).data;
  const tokenProgramId = TOKEN_PROGRAMS[params.tokenProgram];
  let burns = 0;
  let computeBudget = 0;
  let lighthouse = 0;
  let limit: bigint | null = null;
  let price = 0n;
  for (const ix of actual.instructions) {
    const program = keyAt(ix.programIdIndex);
    if (program === tokenProgramId) {
      const [tokenAccount, mint, owner] = ix.accounts.map(keyAt);
      const same = ix.accounts.length === 3 && tokenAccount === params.tokenAccount && mint === params.mint && owner === params.owner &&
        ix.data.length === burnData.length && burnData.every((v, i) => ix.data[i] === v);
      if (!same) refuse('a token instruction differs from the previewed burn (amount, accounts or decimals)', expected, actual);
      burns++;
    } else if (program === COMPUTE_BUDGET_PROGRAM) {
      if (ix.accounts.length !== 0) refuse('unexpected accounts on a compute budget instruction', expected, actual);
      const tag = ix.data[0];
      const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
      if (tag === 2 && ix.data.length === 5) limit = BigInt(dv.getUint32(1, true));
      else if (tag === 3 && ix.data.length === 9) price = dv.getBigUint64(1, true);
      else refuse('an unsupported compute budget instruction', expected, actual);
      computeBudget++;
    } else if (program === LIGHTHOUSE_PROGRAM) {
      const disc = ix.data[0];
      if (disc === undefined || !LIGHTHOUSE_ASSERTIONS.has(disc)) refuse(`a Lighthouse instruction that is not a known read-only assertion (type ${disc ?? 'empty'})`, expected, actual);
      if (ix.data.length > MAX_LIGHTHOUSE_DATA) refuse('an oversized Lighthouse instruction', expected, actual);
      if (ix.accounts.length !== 1) refuse('a Lighthouse assertion must target exactly one account', expected, actual);
      const target = keyAt(ix.accounts[0]!);
      if (target !== params.owner && target !== params.tokenAccount && target !== params.mint) refuse('a Lighthouse assertion targets an account that is not part of the burn', expected, actual);
      lighthouse++;
    } else {
      refuse(`an instruction from an unexpected program (${program ? short(program) : 'unknown'})`, expected, actual);
    }
  }
  if (burns !== 1) refuse(burns === 0 ? 'the burn instruction is missing' : 'the burn instruction appears more than once', expected, actual);
  // Worst-case fee of a wallet-added priority fee: units x micro-lamports / 1e6 (200 000 units per instruction when no limit is set).
  const units = limit ?? BigInt(200_000 * Math.max(1, actual.instructions.length - computeBudget));
  const priorityFeeLamports = price === 0n ? 0n : (units * price + 999_999n) / 1_000_000n;
  if (priorityFeeLamports > MAX_WALLET_PRIORITY_FEE_LAMPORTS) refuse(`the wallet-added priority fee (${priorityFeeLamports} lamports) exceeds the cap`, expected, actual);
  return { version: actual.version, computeBudget, lighthouse, priorityFeeLamports };
}

/** Full check of the transaction a wallet returned. Returns its signature and what the wallet added (if anything). */
export function verifySignedTransaction(signedTransaction: Uint8Array, expected: UnsignedBurn): { signature: Uint8Array; signatureBase58: string; additions: WalletAdditions } {
  const parsed = splitTransaction(signedTransaction);
  const signature = parsed.signatures[0];
  if (parsed.signatures.length !== 1 || signature === undefined || signature.every((b) => b === 0)) {
    throw new TxError('the wallet returned an unsigned transaction', `the returned transaction carries ${parsed.signatures.length} signature slot(s) and the first is ${signature?.every((b) => b === 0) ? 'empty' : 'missing'}`);
  }
  const base = { signature, signatureBase58: encodeBase58(signature) };
  if (sameBytes(parsed.message, expected.message)) return { ...base, additions: NO_ADDITIONS('legacy') };
  const exp = parseMessage(expected.message);
  let act: ParsedMessage;
  try {
    act = parseMessage(parsed.message);
  } catch (e) {
    throw new TxError('the wallet returned a transaction different from the one previewed', `the returned message cannot be read (${(e as Error).message}); length ${parsed.message.length} vs ${expected.message.length}, first byte 0x${(parsed.message[0] ?? 0).toString(16)}`);
  }
  return { ...base, additions: verifyMessageSemantics(act, exp, expected.params) };
}
