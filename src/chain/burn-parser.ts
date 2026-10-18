/* Extracts SPL Token / Token-2022 burns from one `getTransaction` response.
 *
 * Input format: `encoding: "json"` with `maxSupportedTransactionVersion` set
 * (instructions are `{ programIdIndex, accounts: number[], data: base58 }`).
 * We decode the instruction bytes ourselves instead of trusting the RPC's
 * `jsonParsed` output: the program id, the mint account and the amount are all
 * checked here, and the result does not depend on the RPC's parser version.
 *
 * Pure function, no I/O. Three outcomes:
 *  - ok:        burns found (possibly none); `complete` says whether inner
 *               (CPI) instructions were available to inspect;
 *  - failed:    the transaction errored on-chain, nothing is counted;
 *  - malformed: the response is inconsistent. This is NOT "no burn": the
 *               caller must retry or alert, never skip silently. */

import { decodeBase58, isPublicKey, isSignature } from '../core/base58.ts';
import { TOKEN_PROGRAMS, type TokenProgram } from '../config/schema.ts';
import type { BurnInput, Commitment } from '../core/ledger.ts';

export const SPL_BURN_TAG = 8;
export const SPL_BURN_CHECKED_TAG = 15;
/** Transaction versions whose message layout this parser has been checked against. */
export const SUPPORTED_VERSIONS: readonly (number | 'legacy')[] = ['legacy', 0, 1];

export type BurnKind = 'burn' | 'burnChecked';

export interface ParsedBurn {
  readonly mint: string;
  readonly signature: string;
  /** "3" for an outer instruction, "3.1" for the 2nd recorded inner instruction of outer #3. */
  readonly instructionPath: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly tokenProgram: TokenProgram;
  readonly kind: BurnKind;
  readonly tokenAccount: string;
  /** Account that authorised the burn (token account owner, delegate, or multisig). */
  readonly authority: string;
  /** Owner of the burned token account according to the token balances metadata, when present. */
  readonly holder: string | null;
  readonly amountRaw: bigint;
  /** Decimals asserted by BurnChecked; null for plain Burn. */
  readonly decimals: number | null;
}

export type ParseWarning =
  | { code: 'inner_instructions_unavailable' }
  | { code: 'zero_amount_burn_ignored'; path: string }
  | { code: 'other_token_program_ignored'; path: string };

export type ParsedTransaction =
  | {
      status: 'ok';
      signature: string;
      slot: number;
      blockTime: number | null;
      version: number | 'legacy';
      burns: ParsedBurn[];
      warnings: ParseWarning[];
      /** false when CPI burns could not be ruled out (inner instructions not recorded by the node). */
      complete: boolean;
    }
  | { status: 'failed'; signature: string; slot: number; blockTime: number | null; error: unknown }
  | { status: 'malformed'; reason: string };

export interface ParseOptions {
  readonly mint: string;
  /** Only count burns executed by this token program (the project's); both are accepted when omitted. */
  readonly tokenProgram?: TokenProgram;
  /** Expected mint decimals; a BurnChecked asserting anything else is reported as malformed. */
  readonly decimals?: number;
  /** Signature that was requested; the response must be for exactly this transaction. */
  readonly expectedSignature?: string;
}

const PROGRAM_BY_ID = new Map<string, TokenProgram>(
  (Object.entries(TOKEN_PROGRAMS) as [TokenProgram, string][]).map(([name, id]) => [id, name]),
);

class Malformed extends Error {}

type Rec = Record<string, unknown>;
const bad = (msg: string): never => {
  throw new Malformed(msg);
};
const rec = (v: unknown, what: string): Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : bad(`${what}: expected an object`);
const arr = (v: unknown, what: string): unknown[] => (Array.isArray(v) ? v : bad(`${what}: expected an array`));
const uint = (v: unknown, what: string): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : bad(`${what}: expected a non-negative integer`);
const strings = (v: unknown, what: string): string[] =>
  arr(v, what).map((s, i) => (typeof s === 'string' ? s : bad(`${what}[${i}]: expected a string`)));

interface RawInstruction {
  readonly programIdIndex: number;
  readonly accounts: unknown;
  readonly data: unknown;
}

function instruction(v: unknown, what: string, keyCount: number): RawInstruction {
  const o = rec(v, what);
  const programIdIndex = uint(o.programIdIndex, `${what}.programIdIndex`);
  if (programIdIndex >= keyCount) bad(`${what}.programIdIndex: ${programIdIndex} is out of range`);
  return { programIdIndex, accounts: o.accounts, data: o.data };
}

export function parseBurns(raw: unknown, opts: ParseOptions): ParsedTransaction {
  try {
    return parse(raw, opts);
  } catch (e) {
    if (e instanceof Malformed) return { status: 'malformed', reason: e.message };
    throw e;
  }
}

function parse(raw: unknown, opts: ParseOptions): ParsedTransaction {
  const res = rec(raw, 'transaction response');
  const slot = uint(res.slot, 'slot');
  const blockTime = res.blockTime == null ? null : uint(res.blockTime, 'blockTime');

  const tx = rec(res.transaction, 'transaction');
  const sigs = strings(tx.signatures, 'transaction.signatures');
  const signature = sigs[0];
  if (signature === undefined || !isSignature(signature)) bad('transaction.signatures[0]: not a valid signature');
  if (opts.expectedSignature !== undefined && signature !== opts.expectedSignature) {
    bad('response is for a different transaction than the one requested');
  }

  const version = res.version === undefined ? 'legacy' : res.version;
  if (!SUPPORTED_VERSIONS.includes(version as number | 'legacy')) bad(`unsupported transaction version: ${String(version)}`);

  const meta = rec(res.meta, 'meta');
  if (meta.err === undefined) bad('meta.err: missing');
  if (meta.err !== null) return { status: 'failed', signature: signature!, slot, blockTime, error: meta.err };

  // Account list in the order instructions index it: static keys, then keys
  // loaded from address lookup tables (all writable ones, then all read-only ones).
  const message = rec(tx.message, 'transaction.message');
  const staticKeys = strings(message.accountKeys, 'message.accountKeys');
  const lookups = message.addressTableLookups === undefined ? [] : arr(message.addressTableLookups, 'message.addressTableLookups');
  let wantW = 0;
  let wantR = 0;
  lookups.forEach((l, i) => {
    const o = rec(l, `addressTableLookups[${i}]`);
    wantW += arr(o.writableIndexes, `addressTableLookups[${i}].writableIndexes`).length;
    wantR += arr(o.readonlyIndexes, `addressTableLookups[${i}].readonlyIndexes`).length;
  });
  const loaded = meta.loadedAddresses === undefined || meta.loadedAddresses === null ? {} : rec(meta.loadedAddresses, 'meta.loadedAddresses');
  const loadedW = loaded.writable === undefined ? [] : strings(loaded.writable, 'loadedAddresses.writable');
  const loadedR = loaded.readonly === undefined ? [] : strings(loaded.readonly, 'loadedAddresses.readonly');
  if (loadedW.length !== wantW || loadedR.length !== wantR) {
    bad(`loaded addresses (${loadedW.length}w/${loadedR.length}r) do not match the table lookups (${wantW}w/${wantR}r)`);
  }
  const keys = [...staticKeys, ...loadedW, ...loadedR];

  const outer = arr(message.instructions, 'message.instructions');
  const warnings: ParseWarning[] = [];
  const found: { order: number; burn: ParsedBurn }[] = [];

  const visit = (v: unknown, path: string, order: number): void => {
    const ix = instruction(v, `instruction ${path}`, keys.length);
    const tokenProgram = PROGRAM_BY_ID.get(keys[ix.programIdIndex]!);
    if (tokenProgram === undefined) return;
    if (typeof ix.data !== 'string') bad(`instruction ${path}.data: expected a string`);
    const data = ix.data === '' ? new Uint8Array() : decodeBase58(ix.data as string);
    if (data === null) return bad(`instruction ${path}.data: not valid base58`);
    const tag = data[0];
    if (tag !== SPL_BURN_TAG && tag !== SPL_BURN_CHECKED_TAG) return;

    const accounts = arr(ix.accounts, `instruction ${path}.accounts`).map((a, i) => {
      const idx = uint(a, `instruction ${path}.accounts[${i}]`);
      return idx < keys.length ? idx : bad(`instruction ${path}.accounts[${i}]: ${idx} is out of range`);
    });
    // Burn / BurnChecked accounts: [token account, mint, authority, ...multisig signers].
    if (accounts.length < 3) bad(`instruction ${path}: a burn needs at least 3 accounts, got ${accounts.length}`);
    if (keys[accounts[1]!] !== opts.mint) return; // another token's burn

    if (opts.tokenProgram !== undefined && tokenProgram !== opts.tokenProgram) {
      warnings.push({ code: 'other_token_program_ignored', path });
      return;
    }

    // Like the on-chain unpacker, accept trailing bytes after the fixed fields.
    const checked = tag === SPL_BURN_CHECKED_TAG;
    if (data.length < (checked ? 10 : 9)) bad(`instruction ${path}: burn data too short (${data.length} bytes)`);
    const amountRaw = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true);
    const decimals = checked ? data[9]! : null;
    if (decimals !== null && opts.decimals !== undefined && decimals !== opts.decimals) {
      bad(`instruction ${path}: BurnChecked decimals ${decimals} differ from the configured ${opts.decimals}`);
    }
    if (amountRaw === 0n) {
      warnings.push({ code: 'zero_amount_burn_ignored', path });
      return;
    }

    const tokenAccount = keys[accounts[0]!]!;
    const authority = keys[accounts[2]!]!;
    if (!isPublicKey(tokenAccount) || !isPublicKey(authority)) bad(`instruction ${path}: account is not a valid address`);
    found.push({
      order,
      burn: {
        mint: opts.mint,
        signature: signature!,
        instructionPath: path,
        slot,
        blockTime,
        tokenProgram,
        kind: checked ? 'burnChecked' : 'burn',
        tokenAccount,
        authority,
        holder: holderOf(meta, accounts[0]!, opts.mint),
        amountRaw,
        decimals,
      },
    });
  };

  // Execution order: an outer instruction, then its CPIs, then the next outer one.
  outer.forEach((ix, i) => visit(ix, String(i), i * 1000));

  let complete = true;
  if (meta.innerInstructions === undefined || meta.innerInstructions === null) {
    // The node did not record CPIs for this transaction: a CPI burn cannot be ruled out.
    complete = false;
    warnings.push({ code: 'inner_instructions_unavailable' });
  } else {
    const seen = new Set<number>();
    arr(meta.innerInstructions, 'meta.innerInstructions').forEach((g, k) => {
      const group = rec(g, `innerInstructions[${k}]`);
      const index = uint(group.index, `innerInstructions[${k}].index`);
      if (index >= outer.length) bad(`innerInstructions[${k}].index: ${index} has no outer instruction`);
      if (seen.has(index)) bad(`innerInstructions: duplicate group for outer instruction ${index}`);
      seen.add(index);
      arr(group.instructions, `innerInstructions[${k}].instructions`).forEach((ix, j) => {
        if (j >= 999) bad(`innerInstructions[${k}]: too many inner instructions`);
        visit(ix, `${index}.${j}`, index * 1000 + 1 + j);
      });
    });
  }

  found.sort((a, b) => a.order - b.order);
  return {
    status: 'ok',
    signature: signature!,
    slot,
    blockTime,
    version: version as number | 'legacy',
    burns: found.map((f) => f.burn),
    warnings,
    complete,
  };
}

/** Owner of a token account from the pre/post token balance metadata (pre first: the account may be closed afterwards). */
function holderOf(meta: Rec, accountIndex: number, mint: string): string | null {
  for (const field of ['preTokenBalances', 'postTokenBalances']) {
    const list = meta[field];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Rec;
      if (e.accountIndex === accountIndex && e.mint === mint && typeof e.owner === 'string' && isPublicKey(e.owner)) {
        return e.owner;
      }
    }
  }
  return null;
}

/** Ledger input for a parsed burn. The caller supplies the commitment the transaction was fetched at. */
export function toBurnInput(burn: ParsedBurn, commitment: Commitment): BurnInput {
  return {
    mint: burn.mint,
    signature: burn.signature,
    instructionPath: burn.instructionPath,
    slot: burn.slot,
    blockTime: burn.blockTime,
    owner: burn.holder ?? burn.authority,
    amountRaw: burn.amountRaw,
    commitment,
  };
}
