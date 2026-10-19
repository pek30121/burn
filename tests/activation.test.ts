/* Pre-launch activation: the schema of an `awaitMint` project, the pure checks on the mint, and the watcher (no network, no database). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, activateProject, parsePendingProject, TOKEN_PROGRAMS } from '../src/config/schema.ts';
import { ProjectRegistry } from '../src/config/registry.ts';
import { RpcError } from '../src/chain/rpc.ts';
import { ShutdownError } from '../src/engine/limiter.ts';
import { MintWatcher, assessMint, assessSupply, type WatcherOptions } from '../src/engine/activation.ts';
import { EXT, type MintInfo } from '../src/wallet/token-info.ts';
import { ConfigMismatchError } from '../src/db/errors.ts';
import { readMintHistory } from '../src/chain/mint-history.ts';
import { FakeChain } from './fake-chain.ts';
import { MINT_A, randomPubkey } from './helpers.ts';
import { createLogger } from '../src/engine/logger.ts';

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'virus', name: 'VIRUS.EXE', ticker: 'VIRUS', cluster: 'devnet', mint: MINT_A, awaitMint: true,
  levels: [{ id: 'l0', name: 'Zero', threshold: '0' }, { id: 'l1', name: 'One', threshold: '1000' }, { id: 'l2', name: 'Two', threshold: '5000.5' }],
  ...over,
});
const info = (over: Partial<MintInfo> = {}): MintInfo => ({ tokenProgram: 'spl-token', supplyRaw: 10n ** 15n, decimals: 6, mintAuthority: null, freezeAuthority: null, extensions: [], ...over });
const silent = createLogger({ level: 'error', write: () => {} });

test('[activation][schema] an awaitMint entry forbids chain-derived fields and validates the rest like an active project', () => {
  const p = parsePendingProject(entry());
  assert.equal(p.mint, MINT_A);
  assert.deepEqual(p.expect, { decimals: null, tokenProgram: null, supply: null });
  for (const k of ['decimals', 'tokenProgram', 'initialSupply']) {
    assert.throws(() => parsePendingProject(entry({ [k]: k === 'decimals' ? 6 : 'x' })), (e: unknown) => e instanceof ConfigError && e.issues.some((i) => i.includes(`${k}: not allowed`)));
  }
  assert.throws(() => parsePendingProject(entry({ mint: 'nope' })), ConfigError);
  assert.throws(() => parsePendingProject(entry({ levels: [{ id: 'a', name: 'A', threshold: '5' }] })), ConfigError);
  assert.throws(() => parsePendingProject(entry({ expect: { decimals: 99 } })), ConfigError);
  assert.throws(() => parsePendingProject(entry({ expect: { supply: '1e9' } })), ConfigError);
  assert.throws(() => parsePendingProject(entry({ expect: { other: 1 } })), ConfigError);
});

test('[activation][schema] the full project is built from the chain values only; thresholds follow the real decimals', () => {
  const p = parsePendingProject(entry());
  const a = activateProject(p, { decimals: 6, tokenProgram: 'token-2022', initialSupply: '1000000000' });
  assert.equal(a.decimals, 6);
  assert.equal(a.tokenProgram, 'token-2022');
  assert.equal(a.initialSupplyRaw, 1_000_000_000_000_000n);
  assert.deepEqual(a.levels.map((l) => l.thresholdRaw), [0n, 1_000_000_000n, 5_000_500_000n]);
  const b = activateProject(p, { decimals: 9, tokenProgram: 'spl-token', initialSupply: null });
  assert.equal(b.initialSupplyRaw, null);
  assert.equal(b.levels[1]!.thresholdRaw, 1_000_000_000_000n);
  assert.throws(() => activateProject(p, { decimals: 0, tokenProgram: 'spl-token', initialSupply: null }), ConfigError); // 5000.5 does not fit 0 decimals
});

test('[activation][registry] pending projects are not active, share the id/mint uniqueness with active ones', () => {
  const reg = new ProjectRegistry([entry(), { ...entry(), awaitMint: undefined, id: 'other', mint: randomPubkey(), decimals: 6, tokenProgram: 'spl-token' }]);
  assert.deepEqual(reg.list().map((p) => p.id), ['other']);
  assert.deepEqual(reg.pending().map((p) => p.id), ['virus']);
  assert.equal(reg.get('virus'), undefined);
  assert.throws(() => new ProjectRegistry([entry(), entry({ id: 'twin' })]), ConfigError); // same mint
  assert.throws(() => new ProjectRegistry([entry(), entry({ mint: randomPubkey() })]), ConfigError); // same id
});

test('[activation] assessMint: only a revoked-authority, readable, counted-safely mint passes; every refusal has a stable public code', () => {
  const p = parsePendingProject(entry());
  assert.equal(assessMint(p, info()), null);
  assert.equal(assessMint(p, info({ mintAuthority: randomPubkey() }))?.code, 'mint_authority_active');
  assert.equal(assessMint(p, info({ freezeAuthority: randomPubkey() }))?.code, 'freeze_authority_active');
  assert.equal(assessMint(p, info({ supplyRaw: 0n }))?.code, 'supply_zero');
  const ext = (type: number) => info({ tokenProgram: 'token-2022', extensions: [{ type, name: 'x', data: new Uint8Array() }] });
  assert.equal(assessMint(p, ext(EXT.ConfidentialMintBurn))?.code, 'unsupported_mint_extension');
  assert.equal(assessMint(p, ext(9999))?.code, 'unsupported_mint_extension');
  assert.equal(assessMint(p, ext(EXT.MetadataPointer)), null);
  const wsol = parsePendingProject(entry({ mint: 'So11111111111111111111111111111111111111112' }));
  assert.equal(assessMint(wsol, info())?.code, 'native_mint');
  const guarded = parsePendingProject(entry({ expect: { decimals: 6, tokenProgram: 'spl-token' } }));
  assert.equal(assessMint(guarded, info({ decimals: 9 }))?.code, 'decimals_mismatch');
  assert.equal(assessMint(guarded, info({ tokenProgram: 'token-2022' }))?.code, 'token_program_mismatch');
  assert.equal(assessMint(guarded, info()), null);
});

test('[activation] assessSupply: supply = created − burned must hold in the history; an expectation blocks a different creation supply; a long history is never guessed', () => {
  const p = parsePendingProject(entry());
  const full = (created: bigint, burned: bigint) => ({ complete: true, createdRaw: created, burnedRaw: burned, mintOps: 1, signatures: 3 });
  const ok = assessSupply(p, info({ supplyRaw: 90n }), full(100n, 10n));
  assert.deepEqual(ok.blocked === null && ok.initialSupplyRaw, 100n);
  assert.equal(assessSupply(p, info({ supplyRaw: 95n }), full(100n, 10n)).blocked?.code, 'supply_history_mismatch');
  const exp = parsePendingProject(entry({ expect: { supply: '1000000000' } }));
  assert.equal(assessSupply(exp, info({ supplyRaw: 10n ** 15n }), full(10n ** 15n, 0n)).blocked, null);
  assert.equal(assessSupply(exp, info({ supplyRaw: 5n * 10n ** 14n }), full(5n * 10n ** 14n, 0n)).blocked?.code, 'supply_mismatch');
  const long = { complete: false, createdRaw: 0n, burnedRaw: 0n, mintOps: 0, signatures: 1500 };
  const unknown = assessSupply(p, info(), long);
  assert.ok(unknown.blocked === null && unknown.initialSupplyRaw === null && unknown.warnings.includes('initial_supply_unknown'));
  assert.equal(assessSupply(exp, info({ supplyRaw: 2n * 10n ** 15n }), long).blocked?.code, 'supply_mismatch');
});

test('[activation] readMintHistory reads MintTo / Burn from the finalized history and refuses to guess when it is longer than the bound', async () => {
  const chain = new FakeChain();
  chain.finalizedSlot = 100;
  chain.add({ slot: 10, mints: [1_000_000n] });
  chain.add({ slot: 20, burns: [30n] });
  chain.add({ slot: 30, burns: [20n], err: { InstructionError: [0, 'x'] } }); // failed: never counts
  const h = await readMintHistory(chain, MINT_A, 100);
  assert.deepEqual([h.complete, h.createdRaw, h.burnedRaw, h.mintOps], [true, 1_000_000n, 30n, 1]);
  const short = await readMintHistory(chain, MINT_A, 2); // 3 listed signatures, bound 2 but pages are 1000: complete within one page
  assert.equal(short.complete, true);
  const big = new FakeChain();
  big.finalizedSlot = 5000;
  for (let i = 0; i < 1001; i++) big.add({ slot: i + 1 });
  assert.equal((await readMintHistory(big, MINT_A, 1000)).complete, false);
});

/* ---------------- the watcher ---------------- */

interface Rig { chain: FakeChain; owner: { v: string | null }; calls: string[]; activated: unknown[]; w: MintWatcher; ctl: AbortController; sleeps: number[]; failOnce: { n: number }; run: Promise<void> }

function rig(over: Partial<WatcherOptions> = {}, entryOver: Record<string, unknown> = {}): Rig {
  const chain = new FakeChain();
  chain.finalizedSlot = 100;
  const owner = { v: null as string | null };
  const calls: string[] = [];
  const failOnce = { n: 0 };
  const ctl = new AbortController();
  const sleeps: number[] = [];
  const activated: unknown[] = [];
  const rpc: WatcherOptions['rpc'] = {
    async getAccountOwner() { calls.push('owner'); if (failOnce.n > 0) { failOnce.n--; throw new RpcError('boom', { retryable: true }); } return owner.v; },
    getMintInfo: async (m, c) => { calls.push('mint'); const i = await chain.getMintInfo(m, c); return { ...i, tokenProgram: owner.v === TOKEN_PROGRAMS['token-2022'] ? 'token-2022' : 'spl-token' }; },
    getSignaturesForAddress: (a, q) => chain.getSignaturesForAddress(a, q),
    getTransaction: (s, c) => chain.getTransaction(s, c),
  };
  const r = { chain, owner, calls, activated, ctl, sleeps, failOnce } as unknown as Rig;
  r.w = new MintWatcher({
    pending: parsePendingProject(entry(entryOver)), rpc, log: silent, pollIntervalMs: 10, blockedRetryMs: 20, backoff: { baseMs: 5, maxMs: 20 }, maxHistorySignatures: 100,
    activate: async (p) => { activated.push(p); },
    sleep: async (ms) => { sleeps.push(ms); if (ctl.signal.aborted) throw new ShutdownError(); await new Promise((res) => setTimeout(res, 1)); if (sleeps.length > 200) ctl.abort(); },
    ...over,
  });
  r.run = r.w.run(ctl.signal);
  return r;
}
const until = async (c: () => boolean, what: string) => { for (let i = 0; i < 1000; i++) { if (c()) return; await new Promise((r) => setTimeout(r, 2)); } throw new Error(`timed out: ${what}`); };

test('[activation][watcher] waits while the mint does not exist (cheap polls), then activates with the REAL program, decimals, creation supply — nothing assumed', async () => {
  const r = rig();
  r.chain.add({ slot: 10, mints: [10n ** 15n] });
  r.chain.initialSupply = 10n ** 15n;
  r.chain.mintDecimals = 9; // the chain decides, not the config
  await until(() => r.sleeps.length >= 3, 'three idle polls');
  assert.equal(r.w.snapshot().lifecycle, 'awaiting_mint');
  assert.deepEqual([...new Set(r.calls)], ['owner']); // nothing but one account read per poll
  r.owner.v = TOKEN_PROGRAMS['token-2022']; // the first buy happened
  await r.run;
  const p = r.activated[0] as any;
  assert.equal(r.activated.length, 1);
  assert.deepEqual([p.tokenProgram, p.decimals, p.initialSupplyRaw], ['token-2022', 9, 10n ** 15n]);
  assert.equal(p.levels[1].thresholdRaw, 1000n * 10n ** 9n);
  assert.equal(r.w.snapshot().lifecycle, 'active');
});

test('[activation][watcher] RPC failures are not verdicts: they back off and retry, the project is never blocked by them', async () => {
  const r = rig();
  r.chain.add({ slot: 10, mints: [10n ** 15n] });
  r.chain.initialSupply = 10n ** 15n;
  r.owner.v = TOKEN_PROGRAMS['spl-token'];
  r.failOnce.n = 3;
  await r.run;
  assert.equal(r.activated.length, 1);
  assert.equal(r.w.snapshot().consecutiveFailures, 0);
  assert.ok(r.sleeps.slice(0, 3).every((ms) => ms <= 20), 'bounded backoff');
});

test('[activation][watcher] an unexpected mint blocks ONLY this project with a public code, and unblocks by itself once the cause is gone', async () => {
  const r = rig();
  r.chain.add({ slot: 10, mints: [10n ** 15n] });
  r.chain.initialSupply = 10n ** 15n;
  r.chain.mintAuthority = randomPubkey();
  r.owner.v = TOKEN_PROGRAMS['spl-token'];
  await until(() => r.w.snapshot().lifecycle === 'blocked', 'blocked');
  assert.equal(r.w.snapshot().code, 'mint_authority_active');
  assert.equal(r.activated.length, 0);
  r.chain.mintAuthority = null; // revoked later
  await r.run;
  assert.equal(r.activated.length, 1);
  assert.equal(r.w.snapshot().code, null);
});

test('[activation][watcher] a non-token account and a history that contradicts the supply are blocked; a stored-project conflict is blocked too', async () => {
  const a = rig();
  a.owner.v = randomPubkey(); // a real account, owned by some other program
  await until(() => a.w.snapshot().code === 'not_a_token_mint', 'not a mint');
  a.ctl.abort(); await a.run;
  const b = rig();
  b.chain.add({ slot: 10, mints: [10n ** 15n] });
  b.chain.initialSupply = 10n ** 15n - 7n; // supply that the history cannot explain
  b.owner.v = TOKEN_PROGRAMS['spl-token'];
  await until(() => b.w.snapshot().code === 'supply_history_mismatch', 'history mismatch');
  b.ctl.abort(); await b.run;
  const c = rig({ activate: async () => { throw new ConfigMismatchError('project "virus" already exists with different immutable settings: decimals'); } });
  c.chain.add({ slot: 10, mints: [10n ** 15n] });
  c.chain.initialSupply = 10n ** 15n;
  c.owner.v = TOKEN_PROGRAMS['spl-token'];
  await until(() => c.w.snapshot().code === 'stored_project_mismatch', 'stored mismatch');
  c.ctl.abort(); await c.run;
  const d = rig({}, { levels: [{ id: 'l0', name: 'Zero', threshold: '0' }, { id: 'l1', name: 'One', threshold: '0.0000001' }] });
  d.chain.add({ slot: 10, mints: [10n ** 15n] });
  d.chain.initialSupply = 10n ** 15n;
  d.owner.v = TOKEN_PROGRAMS['spl-token'];
  await until(() => d.w.snapshot().code === 'levels_incompatible', 'levels');
  d.ctl.abort(); await d.run;
});

test('[activation][watcher] a long history is not guessed: activation goes ahead without initialSupply and says so', async () => {
  const r = rig({ maxHistorySignatures: 1 });
  r.chain.finalizedSlot = 5000;
  for (let i = 0; i < 1001; i++) r.chain.add({ slot: i + 1 });
  r.chain.initialSupply = 10n ** 15n;
  r.owner.v = TOKEN_PROGRAMS['spl-token'];
  await r.run;
  assert.equal((r.activated[0] as any).initialSupplyRaw, null);
  assert.deepEqual(r.w.snapshot().warnings, ['initial_supply_unknown']);
});
