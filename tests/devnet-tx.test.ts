import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { decodeBase58, encodeBase58 } from '../src/core/base58.ts';
import { parseBurns } from '../src/chain/burn-parser.ts';
import {
  buildTransaction, compactU16, compileMessage, ix, Keypair, loadOrCreateKeypair, serializeLegacyMessage, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, verifySignature,
} from '../scripts/devnet/chain.ts';

const fixture = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BLOCKHASH = encodeBase58(new Uint8Array(32).fill(7));

test('compact-u16 matches the Solana encoding', () => {
  assert.deepEqual([0, 1, 127, 128, 255, 16383, 16384].map(compactU16), [[0], [1], [127], [0x80, 1], [0xff, 1], [0xff, 0x7f], [0x80, 0x80, 1]]);
});

test('message serialization reproduces the bytes a real Devnet transaction was signed over', () => {
  const fx = fixture('devnet-direct-burn.json').response;
  assert.equal(fx.version, 'legacy');
  const m = fx.transaction.message;
  const bytes = serializeLegacyMessage({
    numRequiredSignatures: m.header.numRequiredSignatures,
    numReadonlySigned: m.header.numReadonlySignedAccounts,
    numReadonlyUnsigned: m.header.numReadonlyUnsignedAccounts,
    accountKeys: m.accountKeys.map((k: string) => decodeBase58(k)!),
    recentBlockhash: decodeBase58(m.recentBlockhash)!,
    instructions: m.instructions.map((i: any) => ({ programIdIndex: i.programIdIndex, accounts: i.accounts, data: i.data === '' ? new Uint8Array() : decodeBase58(i.data)! })),
  });
  // The network's own signature verifies over our re-serialization: the wire format is exact.
  assert.ok(verifySignature(bytes, decodeBase58(fx.transaction.signatures[0])!, decodeBase58(m.accountKeys[0])!));
  bytes[0] = bytes[0]! ^ 1;
  assert.ok(!verifySignature(bytes, decodeBase58(fx.transaction.signatures[0])!, decodeBase58(m.accountKeys[0])!));
});

test('Ed25519 keypairs sign verifiably and never leak through JSON or inspect', () => {
  const k = Keypair.generate();
  const msg = Buffer.from('hello');
  assert.ok(verifySignature(msg, k.sign(msg), k.publicKey));
  assert.ok(!verifySignature(Buffer.from('other'), k.sign(msg), k.publicKey));
  assert.equal(encodeBase58(k.publicKey), k.address);
  const seed = k.exportSeedBase64();
  assert.doesNotMatch(JSON.stringify({ k }) + inspect(k) + String(k.address), new RegExp(seed.replace(/[+/=]/g, '.')));
  assert.deepEqual(Keypair.fromSeed(Buffer.from(seed, 'base64')).publicKey, k.publicKey);
});

test('the wallet file is created owner-only and reloads to the same address', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wallet-'));
  const path = join(dir, 'sub', 'wallet.json');
  const a = loadOrCreateKeypair(path);
  assert.equal(a.created, true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'sub')).mode & 0o777, 0o700);
  const b = loadOrCreateKeypair(path);
  assert.deepEqual([b.created, b.keypair.address], [false, a.keypair.address]);
});

test('account ordering and header counts follow the runtime rules; duplicates are merged', () => {
  const payer = Keypair.generate().address;
  const mint = Keypair.generate().address;
  const acct = Keypair.generate().address;
  const auth = Keypair.generate().address;
  const { message, signers } = compileMessage(payer, [
    ix.initializeAccount3(TOKEN_PROGRAM, acct, mint, auth),
    ix.burn(TOKEN_PROGRAM, acct, mint, auth, 5n),
    ix.burn(TOKEN_PROGRAM, acct, mint, payer, 1n), // fee payer is also the authority here
  ], BLOCKHASH);
  assert.deepEqual(signers, [payer, auth]);
  assert.deepEqual([message[0], message[1], message[2]], [2, 1, 1]); // 2 signers (auth read-only), token program read-only
  assert.equal(message[3], 5); // payer, auth, acct, mint, TOKEN
});

test('a built transaction decodes to what was asked, is signed by the right keys, and our parser reads its burns exactly', () => {
  const payer = Keypair.generate();
  const mintKp = Keypair.generate();
  const acctKp = Keypair.generate();
  const amounts = { plain: 1_234_567n, checked: 2n ** 64n - 1n };
  for (const [name, program] of [['spl-token', TOKEN_PROGRAM], ['token-2022', TOKEN_2022_PROGRAM]] as const) {
    const instructions = [
      ix.createAccount(payer.address, mintKp.address, 1_461_600n, 82n, program),
      ix.initializeMint2(program, mintKp.address, 6, payer.address, null),
      ix.createAccount(payer.address, acctKp.address, 2_039_280n, 165n, program),
      ix.initializeAccount3(program, acctKp.address, mintKp.address, payer.address),
      ix.mintTo(program, mintKp.address, acctKp.address, payer.address, 10n ** 12n),
      ix.burn(program, acctKp.address, mintKp.address, payer.address, amounts.plain),
      ix.burnChecked(program, acctKp.address, mintKp.address, payer.address, amounts.checked, 6),
      ix.revokeAuthority(program, mintKp.address, payer.address, 0),
    ];
    const wire = buildTransaction(payer, [mintKp, acctKp], instructions, BLOCKHASH);
    const { message, signers } = compileMessage(payer.address, instructions, BLOCKHASH);
    assert.deepEqual(signers, [payer.address, mintKp.address, acctKp.address]);
    assert.equal(wire[0], 3); // three signatures
    const sigs = [0, 1, 2].map((i) => wire.subarray(1 + i * 64, 65 + i * 64));
    assert.deepEqual(wire.subarray(1 + 3 * 64), message);
    [payer, mintKp, acctKp].forEach((k, i) => assert.ok(verifySignature(message, sigs[i]!, k.publicKey), `signature ${i}`));
    assert.ok(wire.length < 1232, `fits in a packet (${wire.length} bytes)`);

    // Rebuild the getTransaction shape from our own bytes' accounts and feed the engine's parser.
    const keys = signers.concat([...new Set(instructions.flatMap((i) => [i.programId, ...i.keys.map((k) => k.pubkey)]))].filter((k) => !signers.includes(k)));
    const tx = {
      slot: 1, blockTime: 1, version: 'legacy',
      meta: { err: null, innerInstructions: [], preTokenBalances: [], postTokenBalances: [], loadedAddresses: { writable: [], readonly: [] } },
      transaction: {
        signatures: [encodeBase58(sigs[0]!)],
        message: {
          accountKeys: keys, instructions: instructions.map((i) => ({ programIdIndex: keys.indexOf(i.programId), accounts: i.keys.map((k) => keys.indexOf(k.pubkey)), data: encodeBase58(i.data) })),
        },
      },
    };
    const parsed = parseBurns(tx, { mint: mintKp.address, tokenProgram: name, decimals: 6 });
    assert.equal(parsed.status, 'ok');
    if (parsed.status !== 'ok') return;
    assert.deepEqual(parsed.burns.map((b) => [b.instructionPath, b.kind, b.amountRaw, b.tokenProgram]), [['5', 'burn', amounts.plain, name], ['6', 'burnChecked', amounts.checked, name]]);
    assert.ok(parsed.burns.every((b) => b.authority === payer.address && b.tokenAccount === acctKp.address));
  }
});

test('instruction layouts match the SPL Token specification', () => {
  const a = Keypair.generate().address;
  const b = Keypair.generate().address;
  const c = Keypair.generate().address;
  assert.deepEqual([...ix.initializeMint2(TOKEN_PROGRAM, a, 6, b, null).data].slice(0, 2), [20, 6]);
  assert.equal(ix.initializeMint2(TOKEN_PROGRAM, a, 6, b, null).data.length, 67);
  assert.equal(ix.initializeMint2(TOKEN_PROGRAM, a, 6, b, c).data.length, 67);
  assert.deepEqual([...ix.revokeAuthority(TOKEN_PROGRAM, a, b, 0).data], [6, 0, 0]);
  assert.equal(ix.initializeAccount3(TOKEN_PROGRAM, a, b, c).data.length, 33);
  assert.equal(ix.createAccount(a, b, 1n, 2n, SYSTEM_PROGRAM).data.length, 52);
  assert.throws(() => ix.burn(TOKEN_PROGRAM, a, b, c, -1n), /u64/);
  assert.throws(() => ix.burn(TOKEN_PROGRAM, a, b, c, 2n ** 64n), /u64/);
  assert.deepEqual([...ix.mintTo(TOKEN_PROGRAM, a, b, c, 1n).data], [7, 1, 0, 0, 0, 0, 0, 0, 0]);
});
