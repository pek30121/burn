import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '../scripts/devnet/chain.ts';
import { GENESIS_HASHES } from '../src/chain/rpc.ts';
import { TOKEN_PROGRAMS } from '../src/config/schema.ts';
import { BurnController, createBurnController, type BurnControllerOptions } from '../src/wallet/controller.ts';
import { BurnFlowError, describeTxError, isUserRejection, DEFAULT_MESSAGES } from '../src/wallet/errors.ts';
import { createWalletRegistry } from '../src/wallet/wallet-standard.ts';
import { EXT } from '../src/wallet/token-info.ts';
import { FakeEngine, FakeRpc, fakeWindow, mintBytes, MockWallet, tokenAccountBytes } from './wallet-helpers.ts';
import { randomPubkey } from './helpers.ts';

const MINT = randomPubkey();
const TOKEN_ACCOUNT = randomPubkey();

interface Rig {
  user: Keypair; wallet: MockWallet; win: ReturnType<typeof fakeWindow>; rpc: FakeRpc; engine: FakeEngine; c: BurnController; clock: { t: number };
}
function rig(o: { program?: 'spl-token' | 'token-2022'; amount?: bigint; frozen?: boolean; mintExt?: { type: number; data: Uint8Array }[]; wallet?: (u: Keypair) => MockWallet; opts?: Partial<BurnControllerOptions>; cluster?: 'devnet' | 'mainnet-beta' } = {}): Rig {
  const user = Keypair.generate();
  const program = o.program ?? 'spl-token';
  const cluster = o.cluster ?? 'devnet';
  const rpc = new FakeRpc(GENESIS_HASHES[cluster]);
  rpc.accounts.set(MINT, { owner: TOKEN_PROGRAMS[program], lamports: 1n, data: mintBytes({ decimals: 6, supply: 10n ** 12n, extensions: o.mintExt ?? [] }) });
  rpc.tokenAccounts = [{ address: TOKEN_ACCOUNT, account: { owner: TOKEN_PROGRAMS[program], lamports: 1n, data: tokenAccountBytes({ mint: MINT, owner: user.address, amount: o.amount ?? 50_000_000n, frozen: o.frozen ?? false }) } }];
  rpc.balances.set(user.address, 1_000_000_000n);
  const wallet = o.wallet ? o.wallet(user) : new MockWallet('Phantom', [user]);
  const win = fakeWindow();
  win.registerWallet(wallet);
  const registry = createWalletRegistry(win);
  const engine = new FakeEngine();
  const clock = { t: 1_000_000 };
  const c = createBurnController({
    project: { id: 'alpha', mint: MINT, cluster, tokenProgram: program, decimals: 6 }, registry, rpc, engine,
    now: () => clock.t, sleep: async () => { clock.t += 1000; await new Promise((r) => setTimeout(r, 1)); }, pollMs: 1, engineTimeoutMs: 600_000, txTimeoutMs: 600_000,
    ...o.opts,
  });
  return { user, wallet, win, rpc, engine, c, clock };
}
const connected = async (r: Rig) => { await r.c.connect('Phantom'); return r; };
const previewed = async (r: Rig, amount = '10') => { await connected(r); r.c.setAmount(amount); const p = await r.c.prepare(); assert.ok(p, `no preview: ${JSON.stringify(r.c.getState().error)}`); return p; };

test('[wallet] wallets are discovered through the Wallet Standard, before or after the app starts; non-Solana wallets are ignored', () => {
  const win = fakeWindow();
  const early = new MockWallet('Phantom', [Keypair.generate()]);
  win.registerWallet(early);
  const registry = createWalletRegistry(win);
  assert.deepEqual(registry.list().map((w) => w.name), ['Phantom']);
  let notified = 0;
  registry.subscribe(() => notified++);
  win.registerWallet(new MockWallet('Solflare', [Keypair.generate()])); // late registration
  win.registerWallet({ name: 'EthOnly', chains: ['eip155:1'], accounts: [], features: {} });
  assert.deepEqual(registry.list().map((w) => w.name).sort(), ['Phantom', 'Solflare']);
  assert.equal(notified, 1);
  registry.dispose();
});

test('[wallet] happy path: connect, balance, preview with fee, explicit confirm, signature by the wallet, finalized, counted by the ENGINE', async () => {
  const r = rig();
  await connected(r);
  let s = r.c.getState();
  assert.equal(s.status, 'ready');
  assert.equal(s.account, r.user.address);
  assert.equal(s.holding?.available, '50');
  assert.equal(s.holding?.availableRaw, 50_000_000n);
  assert.equal(s.token?.tokenProgram, 'spl-token');
  r.c.setAmount('12.5');
  assert.equal(r.c.getState().amountRaw, 12_500_000n);
  const p = (await r.c.prepare())!;
  assert.equal(p.amount, '12.5');
  assert.equal(p.remainingRaw, 37_500_000n);
  assert.equal(p.feeLamports, 5000n);
  assert.equal(p.feeExact, true);
  assert.equal(p.simulation.ok, true);
  assert.equal(r.c.getState().status, 'preview_ready');
  assert.equal(r.wallet.signed.length, 0, 'nothing is signed before the explicit confirmation');

  const before = r.engine.finalizedRaw;
  r.rpc.onSend = (b64) => {
    // The cluster finalizes it, then (later) the engine re-reads and counts it: only the engine writes the counter.
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const sig = Buffer.from(raw.slice(1, 65));
    queueMicrotask(() => setTimeout(() => import('../src/core/base58.ts').then((m) => r.engine.count(m.encodeBase58(sig), 12_500_000n, r.user.address)), 15));
  };
  await r.c.confirm(p.id);
  s = r.c.getState();
  assert.equal(r.wallet.signed.length, 1);
  assert.equal(r.rpc.sent.length, 1);
  assert.equal(s.tx.phase, 'finalized');
  assert.equal(s.tx.messageVerified, true);
  assert.equal(s.engine.phase, 'counted');
  assert.equal(s.engine.burnEventId, '1');
  assert.equal(s.counter.engine?.finalizedRaw, before + 12_500_000n, 'counter comes from the engine');
  assert.equal(s.error, null);
  assert.ok(s.tx.signature && s.tx.signature.length >= 80);
});

test('[wallet] the counter NEVER moves on a sent or finalized signature alone: the engine timeout leaves it untouched and reports "waiting"', async () => {
  const r = rig({ opts: { engineTimeoutMs: 20 } });
  const p = await previewed(r);
  const counterBefore = r.c.getState().counter;
  await r.c.confirm(p.id);
  const s = r.c.getState();
  assert.equal(s.tx.phase, 'finalized');
  assert.equal(s.engine.phase, 'timeout');
  assert.equal(s.engine.burnEventId, null);
  assert.equal(s.counter.engine?.finalizedRaw, counterBefore.engine?.finalizedRaw ?? 0n);
  assert.equal(r.engine.finalizedRaw, 0n);
  assert.equal(s.error, null, 'a slow engine is not an error');
});

test('[wallet] a burn counted by the engine for ANOTHER signature does not count ours', async () => {
  const r = rig({ opts: { engineTimeoutMs: 20 } });
  const p = await previewed(r);
  r.engine.count('someOtherSignature', 1n, randomPubkey());
  await r.c.confirm(p.id);
  assert.equal(r.c.getState().engine.phase, 'timeout');
});

test('[wallet] the user refuses in the wallet: nothing is sent, clear message, flow stays usable', async () => {
  const r = rig();
  const p = await previewed(r);
  r.wallet.rejectNext = true;
  await r.c.confirm(p.id);
  const s = r.c.getState();
  assert.equal(s.error?.code, 'user_rejected');
  assert.equal(s.error?.message, DEFAULT_MESSAGES.user_rejected);
  assert.equal(r.rpc.sent.length, 0);
  assert.equal(s.status, 'ready');
  const again = await previewed(Object.assign(r, {}), '1'); // a new preview works
  assert.ok(again.id > p.id);
});

test('[wallet] a wallet that returns a DIFFERENT transaction is refused and nothing is broadcast', async () => {
  const r = rig();
  const p = await previewed(r);
  r.wallet.tamper = (signed) => { const t = Uint8Array.from(signed); t[t.length - 1] = (t[t.length - 1] ?? 0) ^ 1; return t; };
  await r.c.confirm(p.id);
  assert.equal(r.c.getState().error?.code, 'signed_message_mismatch');
  assert.equal(r.rpc.sent.length, 0);
  r.wallet.tamper = null;
});

test('[wallet] an unsigned reply from the wallet is refused', async () => {
  const r = rig();
  const p = await previewed(r);
  r.wallet.unsignedReply = true;
  await r.c.confirm(p.id);
  assert.equal(r.c.getState().error?.code, 'signed_message_mismatch');
  assert.equal(r.rpc.sent.length, 0);
});

test('[wallet] explicit confirmation is required: no preview, stale preview and expired preview all refuse to sign', async () => {
  const r = rig();
  await connected(r);
  await r.c.confirm(1);
  assert.equal(r.c.getState().error?.code, 'preview_missing');
  r.c.setAmount('5');
  const p = (await r.c.prepare())!;
  await r.c.confirm(p.id + 1);
  assert.equal(r.c.getState().error?.code, 'preview_stale');
  r.c.setAmount('6'); // changing the amount invalidates the preview
  assert.equal(r.c.getState().preview, null);
  await r.c.confirm(p.id);
  assert.equal(r.c.getState().error?.code, 'preview_missing');
  const p2 = (await r.c.prepare())!;
  r.clock.t += 60_000;
  await r.c.confirm(p2.id);
  assert.equal(r.c.getState().error?.code, 'preview_expired');
  assert.equal(r.wallet.signed.length, 0, 'nothing was ever signed');
});

test('[wallet] a preview can be confirmed only once', async () => {
  const r = rig();
  const p = await previewed(r);
  await r.c.confirm(p.id);
  await r.c.confirm(p.id);
  assert.equal(r.wallet.signed.length, 1);
  assert.equal(r.c.getState().error?.code, 'preview_missing');
});

test('[wallet] amount handling: exact decimals, "max", zero, too many decimals, above balance, garbage, u64 overflow', async () => {
  const r = rig();
  await connected(r);
  r.c.setAmount('0.000001');
  assert.equal(r.c.getState().amountRaw, 1n);
  r.c.setAmount('max');
  assert.equal(r.c.getState().amountRaw, 50_000_000n);
  assert.equal(r.c.getState().amountInput, '50');
  r.c.setAmount('0');
  assert.equal(r.c.getState().error?.code, 'amount_zero');
  r.c.setAmount('1.0000001');
  assert.equal(r.c.getState().error?.code, 'amount_too_many_decimals');
  r.c.setAmount('50.000001');
  assert.equal(r.c.getState().error?.code, 'insufficient_token_balance');
  for (const bad of ['abc', '-1', '1e3', '1,5', '.5']) { r.c.setAmount(bad); assert.equal(r.c.getState().error?.code, 'amount_invalid', bad); }
  r.c.setAmount('99999999999999999999999');
  assert.ok(['amount_too_large', 'insufficient_token_balance'].includes(r.c.getState().error?.code ?? ''));
  assert.equal(await r.c.prepare(), null);
  r.c.setAmount('');
  assert.equal(r.c.getState().error, null);
  // no float anywhere: a value a JS number cannot represent is still exact
  const big = rig({ amount: 9_007_199_254_740_993n }); // 2^53 + 1 raw units: not representable as a JS number
  await connected(big);
  big.c.setAmount('9007199254.740993');
  assert.equal(big.c.getState().amountRaw, 9_007_199_254_740_993n);
  big.c.setAmount('max');
  assert.equal(big.c.getState().amountRaw, 9_007_199_254_740_993n);
  assert.equal(big.c.getState().holding?.available, '9007199254.740993');
});

test('[wallet] insufficient SOL for the fee blocks the preview before anything is signed', async () => {
  const r = rig();
  await connected(r);
  r.rpc.balances.set(r.user.address, 100n);
  r.c.setAmount('1');
  assert.equal(await r.c.prepare(), null);
  assert.equal(r.c.getState().error?.code, 'insufficient_sol');
});

test('[wallet] simulation failure (e.g. decimals mismatch, Custom 18) is shown and confirmation is refused', async () => {
  const r = rig();
  await connected(r);
  r.rpc.simulation = { err: { InstructionError: [0, { Custom: 18 }] }, logs: null, unitsConsumed: null };
  r.c.setAmount('1');
  const p = (await r.c.prepare())!;
  assert.equal(p.simulation.ok, false);
  assert.equal(r.c.getState().error?.code, 'simulation_failed');
  await r.c.confirm(p.id);
  assert.equal(r.c.getState().error?.code, 'simulation_failed');
  assert.equal(r.wallet.signed.length, 0);
});

test('[wallet] frozen account, no token account, wrong token program, wrong decimals', async () => {
  const frozen = rig({ frozen: true });
  await connected(frozen);
  assert.equal(frozen.c.getState().error?.code, 'account_frozen');
  assert.equal(frozen.c.getState().holding?.available, '0');
  frozen.c.setAmount('1');
  assert.equal(await frozen.c.prepare(), null);

  const none = rig();
  none.rpc.tokenAccounts = [];
  await connected(none);
  assert.equal(none.c.getState().error?.code, 'no_token_account');

  const mismatch = rig();
  mismatch.rpc.accounts.set(MINT, { owner: TOKEN_PROGRAMS['token-2022'], lamports: 1n, data: mintBytes({ decimals: 6, supply: 1n }) });
  await connected(mismatch);
  assert.equal(mismatch.c.getState().error?.code, 'token_program_mismatch');

  const decimals = rig();
  decimals.rpc.accounts.set(MINT, { owner: TOKEN_PROGRAMS['spl-token'], lamports: 1n, data: mintBytes({ decimals: 9, supply: 1n }) });
  await connected(decimals);
  assert.equal(decimals.c.getState().error?.code, 'token_program_mismatch');

  const gone = rig();
  gone.rpc.accounts.delete(MINT);
  await connected(gone);
  assert.equal(gone.c.getState().error?.code, 'token_not_found');
});

test('[wallet] Token-2022: a plain mint is supported; an incompatible or unknown extension is blocked with an explicit message', async () => {
  const ok = rig({ program: 'token-2022' });
  const p = await previewed(ok, '3');
  assert.equal(p.amountRaw, 3_000_000n);
  assert.equal(ok.c.getState().token?.tokenProgram, 'token-2022');

  const hooked = rig({ program: 'token-2022', mintExt: [{ type: EXT.TransferHook, data: new Uint8Array(64) }, { type: EXT.MetadataPointer, data: new Uint8Array(64) }] });
  await connected(hooked);
  assert.equal(hooked.c.getState().error, null, 'transfer hook / metadata do not affect a burn');

  const conf = rig({ program: 'token-2022', mintExt: [{ type: EXT.ConfidentialMintBurn, data: new Uint8Array(1) }] });
  await connected(conf);
  assert.equal(conf.c.getState().error?.code, 'token_blocked');
  assert.equal(conf.c.getState().error?.message, DEFAULT_MESSAGES.token_blocked);
  conf.c.setAmount('1');
  assert.equal(await conf.c.prepare(), null);

  const unknown = rig({ program: 'token-2022', mintExt: [{ type: 777, data: new Uint8Array(2) }] });
  await connected(unknown);
  assert.equal(unknown.c.getState().error?.code, 'token_blocked');
  assert.match(unknown.c.getState().error?.detail ?? '', /unknown_extension/);

  const warn = rig({ program: 'token-2022', mintExt: [{ type: EXT.ConfidentialTransferMint, data: new Uint8Array(65) }] });
  const wp = await previewed(warn, '1');
  assert.deepEqual(wp.warnings, ['confidential_balance_not_burnable']);
});

test('[wallet] wrong network: wallet account without the project chain, RPC on another cluster', async () => {
  const mainOnly = rig({ wallet: (u) => new MockWallet('Phantom', [u], { chains: ['solana:mainnet'] }) });
  await connected(mainOnly);
  assert.equal(mainOnly.c.getState().error?.code, 'wrong_network');
  mainOnly.c.setAmount('1');
  assert.equal(await mainOnly.c.prepare(), null);

  const rpcOther = rig();
  rpcOther.rpc.genesis = GENESIS_HASHES['mainnet-beta']; // project says devnet, node says mainnet
  await connected(rpcOther);
  assert.equal(rpcOther.c.getState().error?.code, 'rpc_wrong_network');
  assert.equal(rpcOther.wallet.signed.length, 0);
});

test('[wallet] network switched inside the wallet after the preview: the preview is dropped and signing is refused', async () => {
  const r = rig();
  const p = await previewed(r);
  r.wallet.setNetwork(['solana:mainnet']);
  await new Promise((x) => setImmediate(x));
  assert.equal(r.c.getState().error?.code, 'wrong_network');
  assert.equal(r.c.getState().preview, null);
  await r.c.confirm(p.id);
  assert.equal(r.wallet.signed.length, 0);
  r.wallet.setNetwork(['solana:devnet']); // back on the right network: the wrong-network error does not linger
  await new Promise((x) => setImmediate(x));
  assert.notEqual(r.c.getState().error?.code, 'wrong_network');
});

test('[wallet] account switched in the wallet: old balance, amount and preview are discarded, the new account is loaded', async () => {
  const r = rig();
  const p = await previewed(r);
  const second = Keypair.generate();
  r.rpc.tokenAccounts = [{ address: randomPubkey(), account: { owner: TOKEN_PROGRAMS['spl-token'], lamports: 1n, data: tokenAccountBytes({ mint: MINT, owner: second.address, amount: 7_000_000n }) } }];
  r.rpc.balances.set(second.address, 1_000_000_000n);
  r.wallet.switchTo(second);
  await new Promise((x) => setTimeout(x, 5));
  const s = r.c.getState();
  assert.equal(s.account, second.address);
  assert.equal(s.holding?.available, '7');
  assert.equal(s.preview, null);
  assert.equal(s.amountRaw, null);
  await r.c.confirm(p.id);
  assert.equal(r.wallet.signed.length, 0, 'the old preview cannot be signed for the new account');
});

test('[wallet] disconnect from the app and from the wallet UI both reset the flow; the engine counter is kept', async () => {
  const r = rig();
  await connected(r);
  await r.c.refreshCounter();
  r.engine.finalizedRaw = 42n;
  await r.c.refreshCounter();
  await r.c.disconnect();
  let s = r.c.getState();
  assert.equal(s.status, 'disconnected');
  assert.equal(s.account, null);
  assert.equal(s.holding, null);
  assert.equal(s.counter.engine?.finalizedRaw, 42n);
  const r2 = await connected(rig());
  r2.c.setAmount('1');
  r2.wallet.walletSideDisconnect();
  await new Promise((x) => setImmediate(x));
  s = r2.c.getState();
  assert.equal(s.status, 'disconnected');
  assert.equal(s.error?.code, 'wallet_not_connected');
});

test('[wallet] RPC outage while loading or previewing gives a clear error and no state corruption', async () => {
  const r = rig();
  r.rpc.down = true;
  await r.c.connect('Phantom');
  assert.equal(r.c.getState().error?.code, 'rpc_unavailable');
  r.rpc.down = false;
  await r.c.refresh();
  assert.equal(r.c.getState().error, null);
  assert.equal(r.c.getState().status, 'ready');
  r.c.setAmount('1');
  r.rpc.down = true;
  assert.equal(await r.c.prepare(), null);
  assert.equal(r.c.getState().error?.code, 'rpc_unavailable');
  assert.equal(r.c.getState().status, 'ready');
});

test('[wallet] send failure after signing: reported, flow ready, nothing counted', async () => {
  const r = rig();
  const p = await previewed(r);
  r.rpc.sendError = new Error('boom');
  await r.c.confirm(p.id);
  assert.equal(r.c.getState().error?.code, 'send_failed');
  assert.equal(r.c.getState().status, 'ready');
  assert.equal(r.c.getState().tx.signature, null);
});

test('[wallet] transaction that fails on-chain: explicit message, "failed", nothing counted', async () => {
  const r = rig();
  const p = await previewed(r);
  r.rpc.statusScript = [{ slot: 11, err: { InstructionError: [0, { Custom: 1 }] }, confidenceStatus: 'finalized' } as any];
  await r.c.confirm(p.id);
  const s = r.c.getState();
  assert.equal(s.status, 'failed');
  assert.equal(s.tx.phase, 'failed');
  assert.equal(s.error?.code, 'transaction_failed');
  assert.equal(s.engine.phase, 'idle');
  assert.equal(describeTxError({ InstructionError: [0, { Custom: 1 }] }), 'Solde insuffisant sur le compte de token.');
  assert.equal(describeTxError({ InstructionError: [0, { Custom: 18 }] }), 'Les décimales du token ne correspondent pas à celles attendues.');
  assert.equal(describeTxError('InsufficientFundsForFee'), DEFAULT_MESSAGES.insufficient_sol);
  assert.equal(describeTxError({ weird: 1 }), DEFAULT_MESSAGES.transaction_failed);
});

test('[wallet] blockhash expiry: not found past the last valid height is reported as "expired, nothing burned"', async () => {
  const r = rig();
  const p = await previewed(r);
  r.rpc.statusScript = [null];
  r.rpc.height = 5000; // beyond lastValidBlockHeight
  await r.c.confirm(p.id);
  const s = r.c.getState();
  assert.equal(s.tx.phase, 'expired');
  assert.equal(s.error?.code, 'blockhash_expired');
  assert.equal(s.engine.phase, 'idle');
});

test('[wallet] a wallet that can only sign-and-send is supported; the message cannot be pre-verified and the state says so', async () => {
  const user = Keypair.generate();
  let sentSig: Uint8Array | null = null;
  const r = rig({ wallet: () => new MockWallet('Phantom', [user], { signAndSendOnly: async (signed) => { sentSig = signed.slice(1, 65); return signed.slice(1, 65); } }) });
  // this rig builds balances for another keypair: point it at the wallet's account
  r.rpc.tokenAccounts = [{ address: TOKEN_ACCOUNT, account: { owner: TOKEN_PROGRAMS['spl-token'], lamports: 1n, data: tokenAccountBytes({ mint: MINT, owner: user.address, amount: 50_000_000n }) } }];
  r.rpc.balances.set(user.address, 1_000_000_000n);
  const p = await previewed(r);
  await r.c.confirm(p.id);
  const s = r.c.getState();
  assert.ok(sentSig);
  assert.equal(s.tx.messageVerified, false);
  assert.equal(s.tx.phase, 'finalized');
  assert.equal(r.rpc.sent.length, 0, 'the wallet submitted it, not us');
});

test('[wallet] concurrent operations are refused while one is running', async () => {
  const r = rig();
  await connected(r);
  r.c.setAmount('1');
  const first = r.c.prepare();
  await assert.rejects(() => r.c.prepare(), (e) => e instanceof BurnFlowError && e.code === 'busy');
  await first;
});

test('[wallet] errors carry stable codes; user rejections are recognised across wallets; no message leaks a URL or key', () => {
  assert.ok(isUserRejection({ code: 4001 }));
  assert.ok(isUserRejection(new Error('User rejected the request')));
  assert.ok(isUserRejection({ name: 'WalletSignTransactionError', message: 'Transaction cancelled' }));
  assert.ok(!isUserRejection(new Error('socket hang up')));
  for (const m of Object.values(DEFAULT_MESSAGES)) assert.doesNotMatch(m, /https?:|api-key|secret|private/i);
  const r = rig({ opts: { messages: { user_rejected: 'Refusé.' } } });
  r.wallet.rejectNext = true;
  return previewed(r).then(async (p) => { await r.c.confirm(p.id); assert.equal(r.c.getState().error?.message, 'Refusé.'); });
});

test('[wallet] nothing a controller state exposes contains key material: only the public address and signed bytes pass through', async () => {
  const r = rig();
  const p = await previewed(r);
  await r.c.confirm(p.id);
  const dump = JSON.stringify(r.c.getState(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  assert.ok(!dump.includes('seed') && !dump.includes('secret') && !dump.includes('private'));
});
