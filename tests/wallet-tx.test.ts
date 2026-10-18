import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildUnsignedTransaction, ix, Keypair, verifySignature } from '../scripts/devnet/chain.ts';
import { parseBurns } from '../src/chain/burn-parser.ts';
import { encodeBase58 } from '../src/core/base58.ts';
import { TOKEN_PROGRAMS } from '../src/config/schema.ts';
import { assertSameMessage, buildUnsignedBurn, burnCheckedInstruction, splitTransaction, TxError } from '../src/wallet/tx.ts';
import { assessBurn, extensionName, EXT, parseMint, parseTokenAccount, TokenDataError } from '../src/wallet/token-info.ts';
import { mintBytes, tokenAccountBytes } from './wallet-helpers.ts';
import { randomPubkey } from './helpers.ts';

const BLOCKHASH = encodeBase58(new Uint8Array(32).fill(9));
const owner = Keypair.generate();
const MINT = randomPubkey();
const ACCOUNT = randomPubkey();
const params = (over: object = {}) => ({ tokenProgram: 'spl-token' as const, owner: owner.address, tokenAccount: ACCOUNT, mint: MINT, amountRaw: 1_234_567n, decimals: 6, recentBlockhash: BLOCKHASH, ...over });

test('[wallet-tx] the unsigned burn is byte-identical to the transaction builder validated on real Devnet', () => {
  const ours = buildUnsignedBurn(params());
  const reference = buildUnsignedTransaction(owner.address, [ix.burnChecked(TOKEN_PROGRAMS['spl-token'], ACCOUNT, MINT, owner.address, 1_234_567n, 6)], BLOCKHASH);
  assert.deepEqual([...ours.transaction], [...reference]);
  const t22 = buildUnsignedBurn(params({ tokenProgram: 'token-2022' }));
  const ref22 = buildUnsignedTransaction(owner.address, [ix.burnChecked(TOKEN_PROGRAMS['token-2022'], ACCOUNT, MINT, owner.address, 1_234_567n, 6)], BLOCKHASH);
  assert.deepEqual([...t22.transaction], [...ref22]);
});

test('[wallet-tx] the engine parser reads back exactly the previewed burn (mint, account, owner, amount, decimals), for both token programs', () => {
  for (const tokenProgram of ['spl-token', 'token-2022'] as const) {
    for (const amountRaw of [1n, 1_234_567n, (1n << 64n) - 1n]) {
      const u = buildUnsignedBurn(params({ tokenProgram, amountRaw }));
      const sig = encodeBase58(new Uint8Array(64).fill(3));
      const m = decodeLegacy(u.message);
      const parsed = parseBurns(
        { slot: 5, blockTime: 1, version: 'legacy', transaction: { signatures: [sig], message: { accountKeys: m.keys, instructions: m.instructions.map((i) => ({ programIdIndex: i.program, accounts: i.accounts, data: encodeBase58(i.data) })) } }, meta: { err: null, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] } } },
        { mint: MINT, tokenProgram, decimals: 6, expectedSignature: sig },
      );
      assert.equal(parsed.status, 'ok');
      if (parsed.status !== 'ok') return;
      assert.equal(parsed.burns.length, 1);
      assert.equal(parsed.burns[0]!.amountRaw, amountRaw);
      assert.equal(parsed.burns[0]!.kind, 'burnChecked');
      assert.equal(parsed.burns[0]!.tokenAccount, ACCOUNT);
      assert.equal(parsed.burns[0]!.authority, owner.address);
    }
  }
});

test('[wallet-tx] the Token-2022 program id is the real on-chain one (REGRESSION: a wrong id made every Token-2022 burn invisible)', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/mainnet-token2022-accounts.json', import.meta.url), 'utf8'));
  assert.equal(fx.pyusdMint.owner, TOKEN_PROGRAMS['token-2022']); // recorded from a real Mainnet Token-2022 mint (read-only getAccountInfo)
  assert.equal(fx.usdcMint.owner, TOKEN_PROGRAMS['spl-token']);
  assert.equal(TOKEN_PROGRAMS['token-2022'], 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
});

test('[wallet-tx] priority fee adds two ComputeBudget instructions; invalid parameters are refused', () => {
  const u = buildUnsignedBurn(params({ computeUnitPriceMicroLamports: 1000n, computeUnitLimit: 20_000 }));
  const m = decodeLegacy(u.message);
  assert.equal(m.instructions.length, 3);
  assert.equal(m.instructions[0]!.data[0], 2);
  assert.equal(m.instructions[1]!.data[0], 3);
  assert.throws(() => buildUnsignedBurn(params({ computeUnitPriceMicroLamports: 1n })), TxError);
  assert.throws(() => buildUnsignedBurn(params({ amountRaw: 0n })), TxError);
  assert.throws(() => buildUnsignedBurn(params({ amountRaw: 1n << 64n })), TxError);
  assert.throws(() => buildUnsignedBurn(params({ recentBlockhash: 'nope' })), TxError);
  assert.throws(() => burnCheckedInstruction({ ...params(), decimals: 300 }), TxError);
});

test('[wallet-tx] only the wallet\'s own signature is accepted, and only over exactly the previewed message', () => {
  const u = buildUnsignedBurn(params());
  const signed = Uint8Array.from([1, ...owner.sign(u.message), ...u.message]);
  const r = assertSameMessage(signed, u);
  assert.equal(r.signature.length, 64);
  assert.ok(verifySignature(u.message, r.signature, owner.publicKey));
  // a wallet that changes the amount, the payer or the blockhash
  const other = buildUnsignedBurn(params({ amountRaw: 9_999_999n }));
  assert.throws(() => assertSameMessage(Uint8Array.from([1, ...owner.sign(other.message), ...other.message]), u), /different from the one previewed/);
  // unsigned (all-zero) reply
  assert.throws(() => assertSameMessage(u.transaction, u), /unsigned/);
  // truncated / garbage
  assert.throws(() => splitTransaction(new Uint8Array([1, 2, 3])), TxError);
});

/* -------------------------------- token account decoding -------------------------------- */

test('[wallet-token] real Mainnet accounts: USDC (Token) and PYUSD (Token-2022 with 8 extensions) decode exactly', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/mainnet-token2022-accounts.json', import.meta.url), 'utf8'));
  const bytes = (a: { dataBase64: string }) => new Uint8Array(Buffer.from(a.dataBase64, 'base64'));
  const usdc = parseMint(fx.usdcMint.owner, bytes(fx.usdcMint));
  assert.equal(usdc.decimals, 6);
  assert.equal(usdc.tokenProgram, 'spl-token');
  assert.equal(usdc.extensions.length, 0);
  const pyusd = parseMint(fx.pyusdMint.owner, bytes(fx.pyusdMint));
  assert.equal(pyusd.tokenProgram, 'token-2022');
  assert.deepEqual(pyusd.extensions.map((e) => e.name), ['MintCloseAuthority', 'PermanentDelegate', 'TransferFeeConfig', 'ConfidentialTransferMint', 'ConfidentialTransferFeeConfig', 'TransferHook', 'MetadataPointer', 'TokenMetadata']);
  const acct = parseTokenAccount(fx.pyusdTokenAccount.address, fx.pyusdTokenAccount.owner, bytes(fx.pyusdTokenAccount));
  assert.deepEqual(acct.extensions.map((e) => e.name), ['ImmutableOwner', 'TransferFeeAmount', 'TransferHookAccount']);
  const e = assessBurn(fx.pyusdMint.address, pyusd, acct, acct.owner);
  assert.equal(e.canBurn, true);
  assert.deepEqual([...e.warnings].sort(), ['confidential_balance_not_burnable', 'permanent_delegate']);
  assert.equal(e.availableRaw, acct.amountRaw);
});

test('[wallet-token] fail-closed Token-2022 rules, frozen and native accounts, wrong mint/owner/program', () => {
  const mintAddr = randomPubkey();
  const me = randomPubkey();
  const acc = (o: object = {}, ext: { type: number; data: Uint8Array }[] = []) => parseTokenAccount(randomPubkey(), TOKEN_PROGRAMS['token-2022'], tokenAccountBytes({ mint: mintAddr, owner: me, amount: 500n, extensions: ext, ...o }));
  const mint = (ext: { type: number; data: Uint8Array }[]) => parseMint(TOKEN_PROGRAMS['token-2022'], mintBytes({ decimals: 6, supply: 1000n, extensions: ext }));
  const ok = assessBurn(mintAddr, mint([{ type: EXT.MetadataPointer, data: new Uint8Array(64) }]), acc(), me);
  assert.equal(ok.canBurn, true);
  assert.equal(ok.availableRaw, 500n);
  // unknown extension id: blocked rather than assumed harmless
  const unk = assessBurn(mintAddr, mint([{ type: 999, data: new Uint8Array(1) }]), acc(), me);
  assert.deepEqual(unk.blocks.map((b) => b.code), ['unknown_extension']);
  assert.equal(unk.availableRaw, 0n);
  assert.equal(extensionName(999), 'Unknown(999)');
  // confidential mint/burn
  assert.deepEqual(assessBurn(mintAddr, mint([{ type: EXT.ConfidentialMintBurn, data: new Uint8Array(1) }]), acc(), me).blocks.map((b) => b.code), ['confidential_mint_burn']);
  // pausable: paused blocks, not paused passes, malformed fails closed
  const paused = new Uint8Array(33); paused[32] = 1;
  assert.deepEqual(assessBurn(mintAddr, mint([{ type: EXT.PausableConfig, data: paused }]), acc(), me).blocks.map((b) => b.code), ['mint_paused']);
  assert.equal(assessBurn(mintAddr, mint([{ type: EXT.PausableConfig, data: new Uint8Array(33) }]), acc(), me).canBurn, true);
  assert.deepEqual(assessBurn(mintAddr, mint([{ type: EXT.PausableConfig, data: new Uint8Array(5) }]), acc(), me).blocks.map((b) => b.code), ['malformed_extension']);
  // account side
  assert.deepEqual(assessBurn(mintAddr, mint([]), acc({ frozen: true }), me).blocks.map((b) => b.code), ['account_frozen']);
  assert.deepEqual(assessBurn(mintAddr, mint([]), acc({ native: true }), me).blocks.map((b) => b.code), ['native_account']);
  assert.deepEqual(assessBurn(mintAddr, mint([]), acc({}, [{ type: 4242, data: new Uint8Array(0) }]), me).blocks.map((b) => b.code), ['unknown_extension']);
  assert.ok(assessBurn(mintAddr, mint([]), acc({ delegate: randomPubkey() }), me).warnings.includes('delegate_present'));
  assert.deepEqual(assessBurn(randomPubkey(), mint([]), acc(), me).blocks.map((b) => b.code), ['wrong_mint']);
  assert.deepEqual(assessBurn(mintAddr, mint([]), acc(), randomPubkey()).blocks.map((b) => b.code), ['wrong_owner']);
  const legacyAcc = parseTokenAccount(randomPubkey(), TOKEN_PROGRAMS['spl-token'], tokenAccountBytes({ mint: mintAddr, owner: me, amount: 1n }));
  assert.deepEqual(assessBurn(mintAddr, mint([]), legacyAcc, me).blocks.map((b) => b.code), ['wrong_program']);
});

test('[wallet-token] malformed account data is refused, never guessed', () => {
  assert.throws(() => parseMint(TOKEN_PROGRAMS['spl-token'], new Uint8Array(10)), TokenDataError);
  assert.throws(() => parseMint(randomPubkey(), mintBytes({ decimals: 6, supply: 1n })), /not owned by a token program/);
  const uninit = mintBytes({ decimals: 6, supply: 1n }); uninit[45] = 0;
  assert.throws(() => parseMint(TOKEN_PROGRAMS['spl-token'], uninit), /not initialized/);
  const truncated = mintBytes({ decimals: 6, supply: 1n, extensions: [{ type: 18, data: new Uint8Array(64) }] }).slice(0, 200);
  assert.throws(() => parseMint(TOKEN_PROGRAMS['token-2022'], truncated), /truncated/);
  const wrongType = mintBytes({ decimals: 6, supply: 1n, extensions: [{ type: 18, data: new Uint8Array(64) }] }); wrongType[165] = 2;
  assert.throws(() => parseMint(TOKEN_PROGRAMS['token-2022'], wrongType), /does not match/);
  assert.throws(() => parseTokenAccount('x', TOKEN_PROGRAMS['spl-token'], new Uint8Array(200)), TokenDataError);
  const noState = tokenAccountBytes({ mint: randomPubkey(), owner: randomPubkey(), amount: 1n }); noState[108] = 0;
  assert.throws(() => parseTokenAccount('x', TOKEN_PROGRAMS['spl-token'], noState), /not initialized/);
});

/* ---------------------------------- helpers ---------------------------------- */

function decodeLegacy(message: Uint8Array) {
  let p = 3;
  const n = message[p++]!;
  const keys: string[] = [];
  for (let i = 0; i < n; i++) { keys.push(encodeBase58(message.slice(p, p + 32))); p += 32; }
  p += 32; // blockhash
  const count = message[p++]!;
  const instructions: { program: number; accounts: number[]; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    const program = message[p++]!;
    const na = message[p++]!;
    const accounts = [...message.slice(p, p + na)]; p += na;
    const nd = message[p++]!;
    const data = message.slice(p, p + nd); p += nd;
    instructions.push({ program, accounts, data });
  }
  assert.equal(p, message.length);
  return { keys, instructions };
}
