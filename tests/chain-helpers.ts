import { encodeBase58 } from '../src/core/base58.ts';
import { TOKEN_PROGRAMS } from '../src/config/schema.ts';
import { MINT_A, randomPubkey, randomSignature } from './helpers.ts';

export const TOKEN = TOKEN_PROGRAMS['spl-token'];
export const TOKEN_2022 = TOKEN_PROGRAMS['token-2022'];

export function burnData(amount: bigint, extra: number[] = []): string {
  const b = Buffer.alloc(9);
  b[0] = 8;
  b.writeBigUInt64LE(amount, 1);
  return encodeBase58(Uint8Array.from([...b, ...extra]));
}

export function burnCheckedData(amount: bigint, decimals: number, extra: number[] = []): string {
  const b = Buffer.alloc(10);
  b[0] = 15;
  b.writeBigUInt64LE(amount, 1);
  b[9] = decimals;
  return encodeBase58(Uint8Array.from([...b, ...extra]));
}

export const rawData = (bytes: number[]) => encodeBase58(Uint8Array.from(bytes));

export interface Ix {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

/** Static key table used by most tests. */
export const K = {
  payer: 0,
  acct: 1,
  mint: 2,
  auth: 3,
  token: 4,
  token22: 5,
  fake: 6,
  otherMint: 7,
  otherAcct: 8,
} as const;

export function baseKeys() {
  return {
    payer: randomPubkey(),
    acct: randomPubkey(),
    mint: MINT_A,
    auth: randomPubkey(),
    otherMint: randomPubkey(),
    otherAcct: randomPubkey(),
    fake: randomPubkey(),
  };
}

export type Keys = ReturnType<typeof baseKeys>;

export const staticKeys = (k: Keys) => [k.payer, k.acct, k.mint, k.auth, TOKEN, TOKEN_2022, k.fake, k.otherMint, k.otherAcct];

export const burnIx = (amount: bigint, o: { program?: number; acct?: number; mint?: number; auth?: number } = {}): Ix => ({
  programIdIndex: o.program ?? K.token,
  accounts: [o.acct ?? K.acct, o.mint ?? K.mint, o.auth ?? K.auth],
  data: burnData(amount),
});

export const burnCheckedIx = (amount: bigint, decimals: number, o: { program?: number } = {}): Ix => ({
  programIdIndex: o.program ?? K.token,
  accounts: [K.acct, K.mint, K.auth],
  data: burnCheckedData(amount, decimals),
});

export interface TxSpec {
  keys?: string[];
  instructions: unknown[];
  inner?: { index: number; instructions: unknown[] }[] | null;
  err?: unknown;
  version?: unknown;
  loaded?: { writable: string[]; readonly: string[] };
  lookups?: { accountKey: string; writableIndexes: number[]; readonlyIndexes: number[] }[];
  signature?: string;
  slot?: number;
  blockTime?: number | null;
  preTokenBalances?: unknown[];
  postTokenBalances?: unknown[];
}

/** A `getTransaction` response (encoding "json") built from a compact spec. */
export function makeTx(k: Keys, s: TxSpec): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    err: s.err === undefined ? null : s.err,
    fee: 5000,
    preTokenBalances: s.preTokenBalances ?? [],
    postTokenBalances: s.postTokenBalances ?? [],
    loadedAddresses: s.loaded ?? { writable: [], readonly: [] },
  };
  if (s.inner !== null) meta.innerInstructions = s.inner ?? [];
  const message: Record<string, unknown> = {
    accountKeys: s.keys ?? staticKeys(k),
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
    instructions: s.instructions,
    recentBlockhash: randomPubkey(),
  };
  if (s.lookups) message.addressTableLookups = s.lookups;
  return {
    slot: s.slot ?? 1234,
    blockTime: s.blockTime === undefined ? 1_700_000_000 : s.blockTime,
    version: s.version === undefined ? 'legacy' : s.version,
    meta,
    transaction: { signatures: [s.signature ?? randomSignature()], message },
  };
}
