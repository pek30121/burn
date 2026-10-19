/* A wallet may return a transaction that is not byte-identical to the one it was given (Phantom documents that it can add
 * Lighthouse assertion instructions; a wallet may re-serialize as v0). These tests pin down exactly what is accepted and what
 * is refused. The "Phantom-like" transactions are built here; NO real Phantom was involved. */
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { compileMessage, compactU16, ix, Keypair, verifySignature, type Instruction } from '../scripts/devnet/chain.ts';
import { parseBurns } from '../src/chain/burn-parser.ts';
import { GENESIS_HASHES } from '../src/chain/rpc.ts';
import { encodeBase58 } from '../src/core/base58.ts';
import { TOKEN_PROGRAMS } from '../src/config/schema.ts';
import { createBurnController } from '../src/wallet/controller.ts';
import { createWalletRegistry, toBytes } from '../src/wallet/wallet-standard.ts';
import { assertSameMessage, buildUnsignedBurn, COMPUTE_BUDGET_PROGRAM, LIGHTHOUSE_PROGRAM, MAX_WALLET_PRIORITY_FEE_LAMPORTS, parseMessage, splitTransaction, TxError, verifySignedTransaction } from '../src/wallet/tx.ts';
import { FakeEngine, FakeRpc, fakeWindow, mintBytes, MockWallet, tokenAccountBytes } from './wallet-helpers.ts';
import { randomPubkey } from './helpers.ts';

const BLOCKHASH = encodeBase58(new Uint8Array(32).fill(9));
const owner = Keypair.generate();
const MINT = randomPubkey();
const ACCOUNT = randomPubkey();
const params = (over: object = {}) => ({ tokenProgram: 'spl-token' as const, owner: owner.address, tokenAccount: ACCOUNT, mint: MINT, amountRaw: 1_000_000n, decimals: 6, recentBlockhash: BLOCKHASH, ...over });
const unsigned = (over: object = {}) => buildUnsignedBurn(params(over));
const burnIx = (o: Partial<{ program: string; account: string; mint: string; amount: bigint; decimals: number }> = {}) =>
  ix.burnChecked(o.program ?? TOKEN_PROGRAMS['spl-token'], o.account ?? ACCOUNT, o.mint ?? MINT, owner.address, o.amount ?? 1_000_000n, o.decimals ?? 6);
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const u64 = (n: bigint) => { const out: number[] = []; for (let i = 0n; i < 8n; i++) out.push(Number((n >> (8n * i)) & 0xffn)); return out; };
const cbLimit = (n: number): Instruction => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Uint8Array.from([2, ...u32(n)]) });
const cbPrice = (n: bigint): Instruction => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Uint8Array.from([3, ...u64(n)]) });
/** A Phantom-like Lighthouse read-only assertion on ONE account (type 6 = AssertAccountInfoMulti by default, as seen on Mainnet). */
const lighthouse = (account: string = ACCOUNT, type = 6, extra: Partial<Instruction> = {}): Instruction => ({
  programId: LIGHTHOUSE_PROGRAM, keys: [{ pubkey: account, isSigner: account === owner.address, isWritable: false }], data: Uint8Array.from([type, 1, 2, 3]), ...extra,
});

/** What a wallet does: re-compile the message with its own instruction list (any order), optionally as v0, and sign it. */
function walletReturns(instructions: Instruction[], o: { v0?: boolean; blockhash?: string; payer?: string; signer?: Keypair; zeroSig?: boolean; extraSig?: boolean } = {}): Uint8Array {
  const { message } = compileMessage(o.payer ?? owner.address, instructions, o.blockhash ?? BLOCKHASH);
  let msg = message;
  if (o.v0) msg = Uint8Array.from([0x80, ...message, 0]); // version prefix + empty address table lookups
  const sig = o.zeroSig ? new Uint8Array(64) : (o.signer ?? owner).sign(msg);
  return Uint8Array.from([...compactU16(o.extraSig ? 2 : 1), ...sig, ...(o.extraSig ? new Uint8Array(64) : []), ...msg]);
}
const accepted = (instructions: Instruction[], o = {}, over: object = {}) => verifySignedTransaction(walletReturns(instructions, o), unsigned(over));
const refused = (instructions: Instruction[], pattern: RegExp, o = {}, over: object = {}) => {
  const e = (() => { try { accepted(instructions, o, over); } catch (x) { return x; } })();
  assert.ok(e instanceof TxError, `expected a refusal, got ${String(e)}`);
  assert.match(`${e.message} ${e.detail ?? ''}`, pattern);
  return e;
};

test('[phantom] identical bytes are accepted as before, with no additions', () => {
  const u = unsigned();
  const signed = Uint8Array.from([1, ...owner.sign(u.message), ...u.message]);
  const r = verifySignedTransaction(signed, u);
  assert.deepEqual(r.additions, { version: 'legacy', computeBudget: 0, lighthouse: 0, priorityFeeLamports: 0n });
  assert.ok(verifySignature(u.message, r.signature, owner.publicKey));
});

test('[phantom] REPRODUCTION: the former strict byte comparison refuses exactly this kind of transaction (what the iPhone test hit), the semantic check accepts it', () => {
  const u = unsigned();
  const returned = walletReturns([burnIx(), lighthouse()]);
  assert.throws(() => assertSameMessage(returned, u), /different from the one previewed/);
  assert.equal(verifySignedTransaction(returned, u).additions.lighthouse, 1);
});

test('[phantom] Lighthouse + compute budget instructions around our burn are accepted, in any order, and the burn is still read by the engine parser', () => {
  for (const order of [
    [burnIx(), lighthouse()],
    [lighthouse(), burnIx(), lighthouse(MINT)],
    [cbLimit(50_000), cbPrice(1_000n), lighthouse(), burnIx()],
    [burnIx(), lighthouse(), lighthouse()],
  ]) {
    const r = accepted(order);
    assert.equal(r.additions.lighthouse, order.filter((i) => i.programId === LIGHTHOUSE_PROGRAM).length);
    assert.equal(r.additions.computeBudget, order.filter((i) => i.programId === COMPUTE_BUDGET_PROGRAM).length);
  }
  // the transaction really parses on the engine side, whatever position the burn ended up at
  const tx = walletReturns([lighthouse(), cbLimit(30_000), cbPrice(10n), burnIx(), lighthouse(MINT)]);
  const m = parseMessage(splitTransaction(tx).message);
  const parsed = parseBurns({
    slot: 1, blockTime: 1, version: 'legacy',
    transaction: { signatures: [encodeBase58(splitTransaction(tx).signatures[0]!)], message: { accountKeys: m.keys, instructions: m.instructions.map((i) => ({ programIdIndex: i.programIdIndex, accounts: i.accounts, data: encodeBase58(i.data) })) } },
    meta: { err: null, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] } },
  }, { mint: MINT, tokenProgram: 'spl-token', decimals: 6 });
  assert.equal(parsed.status, 'ok');
  if (parsed.status === 'ok') {
    assert.equal(parsed.burns.length, 1);
    assert.equal(parsed.burns[0]!.amountRaw, 1_000_000n);
    assert.notEqual(parsed.burns[0]!.instructionPath, '0', 'the burn moved: the engine identifies it by (signature, path) anyway');
  }
});

test('[phantom] a legacy message re-serialized as v0 (no lookup table) is accepted; a v0 message WITH a lookup table is refused', () => {
  assert.equal(accepted([burnIx()], { v0: true }).additions.version, 0);
  assert.equal(accepted([lighthouse(), burnIx()], { v0: true }).additions.lighthouse, 1);
  const { message } = compileMessage(owner.address, [burnIx()], BLOCKHASH);
  const withLookup = Uint8Array.from([0x80, ...message, 1, ...new Uint8Array(32).fill(7), 1, 0, 0]);
  const tx = Uint8Array.from([1, ...owner.sign(withLookup), ...withLookup]);
  assert.throws(() => verifySignedTransaction(tx, unsigned()), (e: any) => e instanceof TxError && /lookup table/.test(e.detail ?? ""));
});

test('[phantom] priority fee added by the wallet: accepted within the cap, refused above it', () => {
  const ok = accepted([cbLimit(200_000), cbPrice(1_000_000n), burnIx()]); // 200 000 units x 1 lamport = 200 000 lamports
  assert.equal(ok.additions.priorityFeeLamports, 200_000n);
  refused([cbLimit(1_400_000), cbPrice(10_000_000n), burnIx()], /priority fee .* exceeds the cap/);
  refused([cbPrice(100_000_000n), burnIx()], /priority fee/);
  assert.ok(MAX_WALLET_PRIORITY_FEE_LAMPORTS <= 1_000_000n);
});

test('[phantom] REFUSED: a different amount, mint, token account, decimals, token program, or a second burn / no burn', () => {
  refused([burnIx({ amount: 5_000_000n })], /token instruction differs/);
  refused([burnIx({ mint: randomPubkey() })], /token instruction differs/);
  refused([burnIx({ account: randomPubkey() })], /token instruction differs/);
  refused([burnIx({ decimals: 9 })], /token instruction differs/);
  refused([burnIx({ program: TOKEN_PROGRAMS['token-2022'] })], /unexpected program/);
  refused([burnIx(), burnIx()], /more than once/);
  refused([lighthouse()], /burn instruction is missing/);
  // a transfer of the user's tokens smuggled next to the burn: same token program, different instruction data
  refused([burnIx(), ix.mintTo(TOKEN_PROGRAMS['spl-token'], MINT, ACCOUNT, owner.address, 1n)], /token instruction differs/);
});

test('[phantom] REFUSED: any other program next to the burn (e.g. a SOL transfer), with the offending program named', () => {
  const steal: Instruction = { programId: '11111111111111111111111111111111', keys: [{ pubkey: owner.address, isSigner: true, isWritable: true }, { pubkey: randomPubkey(), isSigner: false, isWritable: true }], data: Uint8Array.from([2, 0, 0, 0, ...u64(1_000_000_000n)]) };
  const e = refused([burnIx(), steal], /unexpected program \(111111…1111\)/);
  assert.match(e.detail ?? '', /instructions 1->2/);
  refused([burnIx(), { programId: randomPubkey(), keys: [], data: Uint8Array.from([1]) }], /unexpected program/);
});

test('[phantom] REFUSED: a second required signer, another fee payer, a changed blockhash', () => {
  const other = Keypair.generate();
  refused([burnIx(), { programId: LIGHTHOUSE_PROGRAM, keys: [{ pubkey: other.address, isSigner: true, isWritable: false }], data: Uint8Array.from([1]) }], /more than the owner/);
  refused([burnIx()], /fee payer is not the owner|more than the owner/, { payer: other.address });
  refused([burnIx()], /blockhash was changed/, { blockhash: encodeBase58(new Uint8Array(32).fill(1)) });
});

test('[phantom] REFUSED: unsigned reply, wrong number of signatures, garbage; the explanation never contains key material', () => {
  assert.throws(() => accepted([burnIx()], { zeroSig: true }), /unsigned/);
  assert.throws(() => accepted([burnIx()], { extraSig: true }), /unsigned|more than/);
  assert.throws(() => verifySignedTransaction(Uint8Array.from([1, ...new Uint8Array(64).fill(3), 9, 9, 9, 9]), unsigned()), (e: any) => e instanceof TxError && /cannot be read/.test(e.detail ?? "") && /first byte 0x9/.test(e.detail ?? ""));
  const e = refused([burnIx(), lighthouse(), { programId: randomPubkey(), keys: [], data: Uint8Array.from([1]) }], /unexpected program/);
  assert.doesNotMatch(`${e.message} ${e.detail}`, /seed|secret|private/i);
});

test('[phantom] cross-realm / array-like bytes returned by a wallet (in-app browsers) are normalized, anything else is refused', () => {
  const foreign = runInNewContext('new Uint8Array([1,2,3])') as Uint8Array;
  assert.equal(foreign instanceof Uint8Array, false, 'this is the case instanceof cannot see');
  assert.deepEqual([...toBytes(foreign)!], [1, 2, 3]);
  assert.deepEqual([...toBytes([4, 5])!], [4, 5]);
  assert.deepEqual([...toBytes(new Uint8Array([1, 2, 3, 4]).subarray(1, 3))!], [2, 3]);
  assert.equal(toBytes('abc'), null);
  assert.equal(toBytes([1, 300]), null);
  assert.equal(toBytes(undefined), null);
});

/* ------------------------- the whole flow with a wallet that behaves like Phantom ------------------------- */

const MINT_OK = randomPubkey();
interface Asked { user: Keypair; tokenAccount: string; mint: string; amount: bigint; blockhash: string }

function flow(modify: (a: Asked) => Uint8Array, o: { cross?: boolean } = {}) {
  const user = Keypair.generate();
  const tokenAccount = randomPubkey();
  const rpc = new FakeRpc(GENESIS_HASHES.devnet);
  rpc.accounts.set(MINT_OK, { owner: TOKEN_PROGRAMS['spl-token'], lamports: 1n, data: mintBytes({ decimals: 6, supply: 10n ** 12n }) });
  rpc.tokenAccounts = [{ address: tokenAccount, account: { owner: TOKEN_PROGRAMS['spl-token'], lamports: 1n, data: tokenAccountBytes({ mint: MINT_OK, owner: user.address, amount: 50_000_000n }) } }];
  rpc.balances.set(user.address, 1_000_000_000n);
  const wallet = new MockWallet('Phantom', [user]);
  wallet.features['solana:signTransaction'].signTransaction = async (...inputs: any[]) => {
    // what the wallet was asked to sign, read back from the bytes it received
    const asked = parseMessage(splitTransaction(inputs[0].transaction).message);
    const burn = asked.instructions[0]!;
    const amount = new DataView(burn.data.buffer, burn.data.byteOffset, burn.data.byteLength).getBigUint64(1, true);
    const bytes = modify({ user, tokenAccount, mint: MINT_OK, amount, blockhash: asked.recentBlockhash });
    return [{ signedTransaction: o.cross ? (runInNewContext(`new Uint8Array(${JSON.stringify([...bytes])})`) as Uint8Array) : bytes }];
  };
  const win = fakeWindow();
  win.registerWallet(wallet);
  const engine = new FakeEngine();
  const c = createBurnController({
    project: { id: 'alpha', mint: MINT_OK, cluster: 'devnet', tokenProgram: 'spl-token', decimals: 6 }, registry: createWalletRegistry(win), rpc, engine,
    sleep: async () => { await new Promise((r) => setTimeout(r, 1)); }, pollMs: 1, engineTimeoutMs: 400, txTimeoutMs: 5_000,
  });
  return { user, rpc, engine, c };
}

async function ready(f: ReturnType<typeof flow>, amount = '1') {
  await f.c.connect('Phantom');
  f.c.setAmount(amount);
  const p = (await f.c.prepare())!;
  assert.ok(p, JSON.stringify(f.c.getState().error));
  return p;
}
const burnFor = (a: Asked, amount = a.amount): Instruction => ix.burnChecked(TOKEN_PROGRAMS['spl-token'], a.tokenAccount, a.mint, a.user.address, amount, 6);
function signedBy(user: Keypair, instructions: Instruction[], blockhash: string, v0 = false): Uint8Array {
  const { message } = compileMessage(user.address, instructions, blockhash);
  const msg = v0 ? Uint8Array.from([0x80, ...message, 0]) : message;
  return Uint8Array.from([1, ...user.sign(msg), ...msg]);
}

test('[phantom] full flow: a Phantom-like wallet adds Lighthouse + priority fee, the flow completes, additions are reported, the sent bytes are the wallet\'s', async () => {
  const f = flow((a) => signedBy(a.user, [cbLimit(40_000), cbPrice(5_000n), burnFor(a), lighthouse(a.tokenAccount)], a.blockhash));
  const p = await ready(f);
  f.rpc.onSend = (b64) => {
    const sig = encodeBase58(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).slice(1, 65));
    setTimeout(() => f.engine.count(sig, 1_000_000n, f.user.address), 10);
  };
  await f.c.confirm(p.id);
  const s = f.c.getState();
  assert.equal(s.error, null, JSON.stringify(s.error));
  assert.equal(s.engine.phase, 'counted');
  assert.equal(s.tx.messageVerified, true);
  assert.equal(s.tx.walletAdditions?.lighthouse, 1);
  assert.equal(s.tx.walletAdditions?.computeBudget, 2);
  assert.equal(s.tx.walletAdditions?.priorityFeeLamports, 200n);
  assert.equal(f.rpc.sent.length, 1);
  const sentTx = Uint8Array.from(atob(f.rpc.sent[0]!), (c) => c.charCodeAt(0));
  assert.equal(parseMessage(splitTransaction(sentTx).message).instructions.length, 4, "the wallet's version is what was broadcast");
  assert.equal(s.tx.signature, encodeBase58(splitTransaction(sentTx).signatures[0]!));
  assert.equal(s.counter.engine?.finalizedRaw, 1_000_000n);
});

test('[phantom] full flow with bytes from another JavaScript realm (in-app browser) and a v0 re-serialization', async () => {
  const f = flow((a) => signedBy(a.user, [lighthouse(a.tokenAccount), burnFor(a)], a.blockhash, true), { cross: true });
  const p = await ready(f);
  await f.c.confirm(p.id);
  const s = f.c.getState();
  assert.equal(s.error, null, JSON.stringify(s.error));
  assert.equal(s.tx.walletAdditions?.version, 0);
  assert.equal(f.rpc.sent.length, 1);
});

test('[phantom] full flow: a wallet that changes the amount is refused, NOTHING is sent, and the screen shows why (public detail)', async () => {
  const f = flow((a) => signedBy(a.user, [burnFor(a, a.amount * 50n)], a.blockhash));
  const p = await ready(f);
  await f.c.confirm(p.id);
  const s = f.c.getState();
  assert.equal(s.error?.code, 'signed_message_mismatch');
  assert.match(s.error?.detail ?? '', /token instruction differs/);
  assert.match(s.error?.detail ?? '', /instructions 1->1/);
  assert.equal(f.rpc.sent.length, 0);
  assert.equal(s.status, 'ready');
});

test('[phantom] full flow: a wallet that adds a SOL transfer is refused with the program named; nothing is sent', async () => {
  const f = flow((a) => signedBy(a.user, [burnFor(a), { programId: '11111111111111111111111111111111', keys: [{ pubkey: a.user.address, isSigner: true, isWritable: true }, { pubkey: randomPubkey(), isSigner: false, isWritable: true }], data: Uint8Array.from([2, 0, 0, 0, ...u64(500_000_000n)]) }], a.blockhash));
  const p = await ready(f);
  await f.c.confirm(p.id);
  assert.equal(f.c.getState().error?.code, 'signed_message_mismatch');
  assert.match(f.c.getState().error?.detail ?? '', /unexpected program \(111111…1111\)/);
  assert.equal(f.rpc.sent.length, 0);
});

/* ------------- REGRESSION (Mainnet, iPhone Phantom): "a Lighthouse instruction references the signer account" ------------- */

test('[phantom][REGRESSION] Phantom Mainnet shape: legacy -> legacy, ComputeBudget + Lighthouse assertions on the signer\'s own account around a Token-2022 burn is ACCEPTED', () => {
  const t22 = { tokenProgram: 'token-2022' as const };
  const burn22 = ix.burnChecked(TOKEN_PROGRAMS['token-2022'], ACCOUNT, MINT, owner.address, 1_000_000n, 6);
  const tx = walletReturns([cbLimit(40_000), cbPrice(1_000n), lighthouse(owner.address, 6), burn22, lighthouse(owner.address, 6)]);
  const r = verifySignedTransaction(tx, unsigned(t22));
  assert.equal(r.additions.lighthouse, 2);
  assert.equal(r.additions.computeBudget, 2);
  assert.equal(r.additions.version, 'legacy');
  // the engine parser still reads exactly that burn from the returned message
  const m = parseMessage(splitTransaction(tx).message);
  assert.equal(m.keys[0], owner.address);
  assert.equal(m.numRequiredSignatures, 1);
});

test('[phantom] every allowed assertion type is accepted on each of the burn\'s own accounts; anything else is refused', () => {
  for (const type of [5, 6, 9, 10]) for (const acc of [owner.address, ACCOUNT, MINT]) accepted([lighthouse(acc, type), burnIx()]);
  // MemoryWrite (0) / MemoryClose (1) move lamports from the payer; the other assertion kinds and unknown numbers are not on the list
  for (const type of [0, 1, 2, 3, 4, 7, 8, 11, 14, 17, 255]) refused([lighthouse(owner.address, type), burnIx()], /not a known read-only assertion/);
  refused([{ programId: LIGHTHOUSE_PROGRAM, keys: [], data: new Uint8Array() }, burnIx()], /not a known read-only assertion \(type empty\)/);
});

test('[phantom][malicious] a Lighthouse instruction may not carry extra accounts, foreign accounts, a second signer or oversized data', () => {
  const two: Instruction = { programId: LIGHTHOUSE_PROGRAM, keys: [{ pubkey: owner.address, isSigner: true, isWritable: false }, { pubkey: MINT, isSigner: false, isWritable: false }], data: Uint8Array.from([6]) };
  refused([burnIx(), two], /exactly one account/);
  refused([burnIx(), { ...two, keys: [] }], /exactly one account/);
  refused([burnIx(), lighthouse(randomPubkey())], /not part of the burn/);
  const attacker = Keypair.generate();
  refused([burnIx(), { programId: LIGHTHOUSE_PROGRAM, keys: [{ pubkey: attacker.address, isSigner: true, isWritable: false }], data: Uint8Array.from([6]) }], /more than the owner|not part of the burn/);
  refused([burnIx(), lighthouse(owner.address, 6, { data: Uint8Array.from([6, ...new Uint8Array(600)]) })], /oversized/);
});

test('[phantom][malicious] smuggled instructions next to Phantom-like additions are still refused: transfer, second/bigger burn, approve/set-authority, system transfer, unknown program', () => {
  const sys = '11111111111111111111111111111111';
  const wrap = (bad: Instruction) => [cbLimit(40_000), lighthouse(owner.address, 6), burnIx(), bad, lighthouse(owner.address, 6)];
  const tokenData = (b: number[]): Instruction => ({ programId: TOKEN_PROGRAMS['spl-token'], keys: [{ pubkey: ACCOUNT, isSigner: false, isWritable: true }, { pubkey: randomPubkey(), isSigner: false, isWritable: true }, { pubkey: owner.address, isSigner: true, isWritable: false }], data: Uint8Array.from(b) });
  refused(wrap(tokenData([3, ...u64(1_000_000_000n)])), /token instruction differs/); // Transfer
  refused(wrap(tokenData([4, ...u64(1_000_000_000n)])), /token instruction differs/); // Approve (delegate)
  refused(wrap(tokenData([6, 2, 0])), /token instruction differs/); // SetAuthority
  refused(wrap(burnIx({ amount: 1_000_001n })), /token instruction differs/);
  refused(wrap(burnIx()), /more than once/);
  refused(wrap({ programId: sys, keys: [{ pubkey: owner.address, isSigner: true, isWritable: true }, { pubkey: randomPubkey(), isSigner: false, isWritable: true }], data: Uint8Array.from([2, 0, 0, 0, ...u64(1n)]) }), /unexpected program/);
  refused(wrap({ programId: randomPubkey(), keys: [{ pubkey: owner.address, isSigner: true, isWritable: true }], data: Uint8Array.from([1]) }), /unexpected program/);
});
