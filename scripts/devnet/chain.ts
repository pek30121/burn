/* Minimal Solana transaction toolkit for the Devnet validation scripts (test tooling, not part of the
 * engine): Ed25519 keys via node:crypto, legacy message serialization, and the few instructions the
 * scenarios need. No dependency. Private keys never leave this module's files. */

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeBase58, encodeBase58 } from '../../src/core/base58.ts';
import { TOKEN_PROGRAMS } from '../../src/config/schema.ts';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = TOKEN_PROGRAMS['spl-token'];
export const TOKEN_2022_PROGRAM = TOKEN_PROGRAMS['token-2022'];

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class Keypair {
  readonly #seed: Buffer;
  readonly publicKey: Uint8Array;
  readonly address: string;

  private constructor(seed: Buffer) {
    this.#seed = seed;
    const pub = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' }));
    this.publicKey = new Uint8Array(pub.export({ format: 'der', type: 'spki' }).subarray(12));
    this.address = encodeBase58(this.publicKey);
  }

  static generate(): Keypair {
    return new Keypair(randomBytes(32));
  }

  static fromSeed(seed: Uint8Array): Keypair {
    if (seed.length !== 32) throw new Error('seed must be 32 bytes');
    return new Keypair(Buffer.from(seed));
  }

  sign(message: Uint8Array): Uint8Array {
    return new Uint8Array(sign(null, message, createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, this.#seed]), format: 'der', type: 'pkcs8' })));
  }

  /** Only for writing the protected wallet file. */
  exportSeedBase64(): string {
    return this.#seed.toString('base64');
  }

  // Never let a keypair reach a log line or a JSON dump.
  toJSON(): { address: string } {
    return { address: this.address };
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Keypair(${this.address})`;
  }
}

export function verifySignature(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  return verify(null, message, createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' }), signature);
}

/** Loads the keypair stored at `path`, creating it (directory 0700, file 0600) when absent. */
export function loadOrCreateKeypair(path: string): { keypair: Keypair; created: boolean } {
  if (existsSync(path)) {
    const j = JSON.parse(readFileSync(path, 'utf8')) as { seed?: string };
    return { keypair: Keypair.fromSeed(Buffer.from(j.seed ?? '', 'base64')), created: false };
  }
  const keypair = Keypair.generate();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ network: 'devnet-only', seed: keypair.exportSeedBase64() }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { keypair, created: true };
}

/* ----------------------------- serialization ----------------------------- */

export function compactU16(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

export interface CompiledInstruction {
  programIdIndex: number;
  accounts: number[];
  data: Uint8Array;
}

export interface MessageParts {
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  accountKeys: Uint8Array[];
  recentBlockhash: Uint8Array;
  instructions: CompiledInstruction[];
}

export function serializeLegacyMessage(m: MessageParts): Uint8Array {
  const out: number[] = [m.numRequiredSignatures, m.numReadonlySigned, m.numReadonlyUnsigned, ...compactU16(m.accountKeys.length)];
  for (const k of m.accountKeys) out.push(...k);
  out.push(...m.recentBlockhash, ...compactU16(m.instructions.length));
  for (const ix of m.instructions) out.push(ix.programIdIndex, ...compactU16(ix.accounts.length), ...ix.accounts, ...compactU16(ix.data.length), ...ix.data);
  return Uint8Array.from(out);
}

export interface AccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}
export interface Instruction {
  programId: string;
  keys: AccountMeta[];
  data: Uint8Array;
}

/** Orders accounts as the runtime requires (signer+w, signer+ro, other+w, other+ro; fee payer first). */
export function compileMessage(feePayer: string, instructions: Instruction[], recentBlockhash: string): { message: Uint8Array; signers: string[] } {
  const meta = new Map<string, { signer: boolean; writable: boolean }>();
  const touch = (pubkey: string, signer: boolean, writable: boolean) => {
    const m = meta.get(pubkey) ?? { signer: false, writable: false };
    meta.set(pubkey, { signer: m.signer || signer, writable: m.writable || writable });
  };
  touch(feePayer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) touch(k.pubkey, k.isSigner, k.isWritable);
    touch(ix.programId, false, false);
  }
  const first = [...meta.keys()];
  const group = (signer: boolean, writable: boolean) => first.filter((k) => k !== feePayer && meta.get(k)!.signer === signer && meta.get(k)!.writable === writable);
  const ordered = [feePayer, ...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  const signers = ordered.filter((k) => meta.get(k)!.signer);
  const index = new Map(ordered.map((k, i) => [k, i]));
  const key32 = (a: string): Uint8Array => {
    const b = decodeBase58(a);
    if (!b || b.length !== 32) throw new Error(`invalid address ${a}`);
    return b;
  };
  const hash = decodeBase58(recentBlockhash);
  if (!hash || hash.length !== 32) throw new Error('invalid blockhash');
  const message = serializeLegacyMessage({
    numRequiredSignatures: signers.length,
    numReadonlySigned: group(true, false).length,
    numReadonlyUnsigned: group(false, false).length,
    accountKeys: ordered.map(key32),
    recentBlockhash: hash,
    instructions: instructions.map((ix) => ({ programIdIndex: index.get(ix.programId)!, accounts: ix.keys.map((k) => index.get(k.pubkey)!), data: ix.data })),
  });
  return { message, signers };
}

export function buildTransaction(feePayer: Keypair, extraSigners: Keypair[], instructions: Instruction[], recentBlockhash: string): Uint8Array {
  const { message, signers } = compileMessage(feePayer.address, instructions, recentBlockhash);
  const byAddress = new Map([feePayer, ...extraSigners].map((k) => [k.address, k]));
  const sigs = signers.map((a) => {
    const k = byAddress.get(a);
    if (!k) throw new Error(`missing signer ${a}`);
    return k.sign(message);
  });
  return Uint8Array.from([...compactU16(sigs.length), ...sigs.flatMap((s) => [...s]), ...message]);
}

/* ------------------------------- instructions ------------------------------- */

const u64 = (n: bigint): number[] => {
  if (n < 0n || n >= 1n << 64n) throw new Error('u64 out of range');
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return [...b];
};
const key = (a: string): number[] => [...(decodeBase58(a) ?? [])];
const meta = (pubkey: string, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });

export const ix = {
  createAccount(payer: string, newAccount: string, lamports: bigint, space: bigint, owner: string): Instruction {
    return { programId: SYSTEM_PROGRAM, keys: [meta(payer, true, true), meta(newAccount, true, true)], data: Uint8Array.from([0, 0, 0, 0, ...u64(lamports), ...u64(space), ...key(owner)]) };
  },
  initializeMint2(program: string, mint: string, decimals: number, mintAuthority: string, freezeAuthority: string | null): Instruction {
    return { programId: program, keys: [meta(mint, false, true)], data: Uint8Array.from([20, decimals, ...key(mintAuthority), freezeAuthority ? 1 : 0, ...(freezeAuthority ? key(freezeAuthority) : new Array(32).fill(0))]) };
  },
  initializeAccount3(program: string, account: string, mint: string, owner: string): Instruction {
    return { programId: program, keys: [meta(account, false, true), meta(mint, false, false)], data: Uint8Array.from([18, ...key(owner)]) };
  },
  mintTo(program: string, mint: string, account: string, authority: string, amount: bigint): Instruction {
    return { programId: program, keys: [meta(mint, false, true), meta(account, false, true), meta(authority, true, false)], data: Uint8Array.from([7, ...u64(amount)]) };
  },
  /** authorityType 0 = MintTokens. Passing no new authority revokes it permanently. */
  revokeAuthority(program: string, mint: string, current: string, authorityType: number): Instruction {
    return { programId: program, keys: [meta(mint, false, true), meta(current, true, false)], data: Uint8Array.from([6, authorityType, 0]) };
  },
  burn(program: string, account: string, mint: string, authority: string, amount: bigint): Instruction {
    return { programId: program, keys: [meta(account, false, true), meta(mint, false, true), meta(authority, true, false)], data: Uint8Array.from([8, ...u64(amount)]) };
  },
  burnChecked(program: string, account: string, mint: string, authority: string, amount: bigint, decimals: number): Instruction {
    return { programId: program, keys: [meta(account, false, true), meta(mint, false, true), meta(authority, true, false)], data: Uint8Array.from([15, ...u64(amount), decimals]) };
  },
};

/** Unsigned transaction (all-zero signatures) — only for `simulateTransaction` with sigVerify:false. */
export function buildUnsignedTransaction(feePayer: string, instructions: Instruction[], recentBlockhash: string): Uint8Array {
  const { message, signers } = compileMessage(feePayer, instructions, recentBlockhash);
  return Uint8Array.from([...compactU16(signers.length), ...new Array(signers.length * 64).fill(0), ...message]);
}
