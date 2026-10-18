/* Burn flow controller: framework-agnostic state machine (no DOM, no UI). An integrator renders `getState()` and
 * calls the methods; nothing here depends on the site's design.
 *
 *   connect -> loadToken -> setAmount -> prepare (preview) -> confirm (explicit) -> sign in the wallet ->
 *   send -> follow to `finalized` -> wait for OUR engine to list the burn -> counter refreshed from the engine.
 *
 * Invariants:
 *  - the only signature is the one returned by the user's wallet; the signed message must equal the previewed one;
 *  - the counter shown comes from the engine's API only (`engine.counter`); a sent or even finalized signature never
 *    changes it, and the burn is reported as `counted` only when the engine's durable event journal lists it;
 *  - every async result is dropped if the account, network, token or wallet changed meanwhile (generation guard);
 *  - amounts are bigint raw units, parsed from the user's decimal string with no float. */

import { AmountError, formatUiAmount, parseUiAmount } from '../core/amount.ts';
import { GENESIS_HASHES } from '../chain/rpc.ts';
import { TOKEN_PROGRAMS, type Cluster, type TokenProgram } from '../config/schema.ts';
import { BurnFlowError, describeTxError, isUserRejection, type BurnErrorCode } from './errors.ts';
import type { EngineApi, EngineStatus } from './engine-client.ts';
import type { WalletRpc } from './rpc.ts';
import { assessBurn, parseMint, parseTokenAccount, type BurnBlock, type BurnEligibility, type MintInfo, type TokenAccountInfo } from './token-info.ts';
import { assertSameMessage, BASE_FEE_LAMPORTS, buildUnsignedBurn, toBase64, TxError, type UnsignedBurn } from './tx.ts';
import { chainOfCluster, type SolanaChain, type WalletAccount, type WalletProvider, type WalletRegistry } from './wallet-standard.ts';
import { encodeBase58 } from '../core/base58.ts';

export type FlowStatus =
  | 'disconnected' | 'connecting' | 'connected' | 'loading_token' | 'ready' | 'previewing' | 'preview_ready'
  | 'awaiting_signature' | 'sending' | 'confirming' | 'finalized' | 'failed';
export type EnginePhase = 'idle' | 'waiting' | 'counted' | 'timeout';
export type TxPhase = 'none' | 'sent' | 'processed' | 'confirmed' | 'finalized' | 'failed' | 'expired';

export interface FlowError { readonly code: BurnErrorCode; readonly message: string; readonly detail?: string }

export interface BurnPreview {
  readonly id: number;
  readonly owner: string;
  readonly tokenAccount: string;
  readonly mint: string;
  readonly amountRaw: bigint;
  readonly amount: string;
  readonly decimals: number;
  readonly remainingRaw: bigint;
  readonly feeLamports: bigint;
  /** true when the fee came from the node (`getFeeForMessage`), false when it is the 5000-lamport base estimate. */
  readonly feeExact: boolean;
  readonly solBalanceLamports: bigint;
  readonly simulation: { readonly ok: boolean; readonly unitsConsumed: number | null; readonly message: string | null };
  readonly warnings: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface Holding {
  readonly tokenAccount: string;
  readonly balanceRaw: bigint;
  readonly balance: string;
  readonly availableRaw: bigint;
  readonly available: string;
  readonly eligibility: BurnEligibility;
  /** Every account the wallet owns for this mint (the largest burnable one is selected by default). */
  readonly accounts: readonly { address: string; balanceRaw: bigint; frozen: boolean }[];
}

export interface BurnState {
  readonly status: FlowStatus;
  readonly wallet: { readonly name: string; readonly icon: string | null } | null;
  readonly account: string | null;
  readonly accounts: readonly string[];
  readonly token: { readonly mint: string; readonly decimals: number; readonly tokenProgram: TokenProgram; readonly cluster: Cluster; readonly extensions: readonly string[] } | null;
  readonly holding: Holding | null;
  readonly solBalanceLamports: bigint | null;
  readonly amountInput: string;
  readonly amountRaw: bigint | null;
  readonly preview: BurnPreview | null;
  readonly tx: { readonly signature: string | null; readonly phase: TxPhase; readonly slot: number | null; readonly messageVerified: boolean };
  /** Written by the engine only. `counted` = our engine's journal lists this burn. */
  readonly engine: { readonly phase: EnginePhase; readonly burnEventId: string | null };
  readonly counter: { readonly status: 'unknown' | 'ok' | 'unavailable'; readonly engine: EngineStatus | null };
  readonly error: FlowError | null;
}

export interface BurnControllerOptions {
  readonly project: { readonly id: string; readonly mint: string; readonly cluster: Cluster; readonly tokenProgram: TokenProgram; readonly decimals: number };
  readonly registry: WalletRegistry;
  readonly rpc: WalletRpc;
  readonly engine: EngineApi;
  /** Default 45 s: well inside the ~60-90 s life of a blockhash. */
  readonly previewTtlMs?: number;
  readonly pollMs?: number;
  readonly engineTimeoutMs?: number;
  readonly txTimeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly messages?: Partial<Record<BurnErrorCode, string>>;
}

const initial = (): BurnState => ({
  status: 'disconnected', wallet: null, account: null, accounts: [], token: null, holding: null, solBalanceLamports: null,
  amountInput: '', amountRaw: null, preview: null,
  tx: { signature: null, phase: 'none', slot: null, messageVerified: false },
  engine: { phase: 'idle', burnEventId: null }, counter: { status: 'unknown', engine: null }, error: null,
});

const BUSY: ReadonlySet<FlowStatus> = new Set(['connecting', 'loading_token', 'previewing', 'awaiting_signature', 'sending', 'confirming']);

export class BurnController {
  readonly #o: BurnControllerOptions;
  readonly #listeners = new Set<(s: BurnState) => void>();
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #state: BurnState = initial();
  #provider: WalletProvider | null = null;
  #unsubscribeWallet: (() => void) | null = null;
  #account: WalletAccount | null = null;
  #gen = 0; // bumped whenever account / wallet / token context changes: results from older generations are dropped
  #previewSeq = 0;
  #unsigned: UnsignedBurn | null = null;
  #lastValidBlockHeight = 0;
  #mint: MintInfo | null = null;
  #selected: TokenAccountInfo | null = null;
  #disposed = false;

  constructor(o: BurnControllerOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => Date.now());
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  getState(): BurnState { return this.#state; }
  subscribe(l: (s: BurnState) => void): () => void { this.#listeners.add(l); return () => this.#listeners.delete(l); }
  get chain(): SolanaChain { return chainOfCluster(this.#o.project.cluster); }
  listWallets(): { name: string; icon: string | null }[] { return this.#o.registry.list().map((w) => ({ name: w.name, icon: w.icon })); }

  dispose(): void {
    this.#disposed = true;
    this.#gen++;
    this.#unsubscribeWallet?.();
    this.#listeners.clear();
  }

  /* ------------------------------ state helpers ------------------------------ */

  #set(patch: Partial<BurnState>): void {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    for (const l of this.#listeners) l(this.#state);
  }
  #fail(code: BurnErrorCode, detail?: string, status?: FlowStatus): FlowError {
    const e: FlowError = { code, message: this.#o.messages?.[code] ?? new BurnFlowError(code).message, ...(detail !== undefined ? { detail } : {}) };
    this.#set({ error: e, ...(status ? { status } : {}) });
    return e;
  }
  #fromUnknown(e: unknown): BurnErrorCode {
    if (e instanceof BurnFlowError) return e.code;
    if (isUserRejection(e)) return 'user_rejected';
    if (e instanceof TxError) return 'signed_message_mismatch';
    return 'rpc_unavailable';
  }

  /* --------------------------------- wallet --------------------------------- */

  async connect(walletName: string): Promise<void> {
    if (BUSY.has(this.#state.status)) throw new BurnFlowError('busy');
    const provider = this.#o.registry.list().find((w) => w.name === walletName);
    if (!provider) { this.#fail('no_wallet'); return; }
    await this.#teardownWallet();
    const gen = ++this.#gen;
    this.#set({ ...initial(), status: 'connecting', counter: this.#state.counter });
    try {
      const accounts = await provider.connect();
      if (gen !== this.#gen) return;
      if (accounts.length === 0) throw new BurnFlowError('wallet_not_connected');
      this.#provider = provider;
      this.#unsubscribeWallet = provider.onChange((ev) => void this.#onWalletEvent(ev.kind, provider));
      await this.#adoptAccount(accounts[0]!, accounts, gen);
    } catch (e) {
      if (gen !== this.#gen) return;
      this.#provider = null;
      this.#set({ status: 'disconnected' });
      this.#fail(this.#fromUnknown(e) === 'rpc_unavailable' ? 'wallet_error' : this.#fromUnknown(e));
    }
  }

  async disconnect(): Promise<void> {
    const provider = this.#provider;
    await this.#teardownWallet();
    this.#set({ ...initial(), counter: this.#state.counter });
    try { await provider?.disconnect(); } catch { /* the wallet may not implement disconnect: local state is already clean */ }
  }

  async #teardownWallet(): Promise<void> {
    this.#gen++;
    this.#unsubscribeWallet?.();
    this.#unsubscribeWallet = null;
    this.#provider = null;
    this.#account = null;
    this.#unsigned = null;
    this.#mint = null;
    this.#selected = null;
  }

  /** Switch the active account (one of the accounts the wallet exposes). */
  async selectAccount(address: string): Promise<void> {
    const p = this.#provider;
    const acc = p?.accounts().find((a) => a.address === address);
    if (!p || !acc) throw new BurnFlowError('wallet_not_connected');
    if (BUSY.has(this.#state.status)) throw new BurnFlowError('busy');
    await this.#adoptAccount(acc, p.accounts(), ++this.#gen);
  }

  async #onWalletEvent(kind: 'accounts' | 'chains' | 'features', provider: WalletProvider): Promise<void> {
    if (this.#provider !== provider || this.#disposed) return;
    const accounts = provider.accounts();
    const inFlight = this.#state.status === 'awaiting_signature' || this.#state.status === 'sending';
    if (accounts.length === 0) {
      // Wallet disconnected from its own UI. A transaction already sent keeps being followed; nothing unsent survives.
      if (this.#state.status === 'confirming' || this.#state.status === 'finalized') { this.#set({ account: null, accounts: [] }); return; }
      await this.#teardownWallet();
      this.#set({ ...initial(), counter: this.#state.counter });
      this.#fail('wallet_not_connected');
      return;
    }
    const current = this.#account?.address;
    const still = accounts.find((a) => a.address === current);
    if (kind === 'accounts' && !still) {
      // The user switched account in the wallet: everything derived from the old account is invalid.
      const gen = ++this.#gen;
      this.#unsigned = null;
      this.#fail('account_changed');
      if (!inFlight) await this.#adoptAccount(accounts[0]!, accounts, gen, true);
      return;
    }
    if (still) {
      this.#account = still;
      this.#set({ accounts: accounts.map((a) => a.address) });
      if (!this.#supportsChain(still) && this.#state.status !== 'confirming' && this.#state.status !== 'finalized') {
        this.#unsigned = null;
        this.#set({ preview: null });
        this.#fail('wrong_network', undefined, this.#state.token ? 'ready' : 'connected');
      } else if (this.#state.error?.code === 'wrong_network' && this.#supportsChain(still)) {
        this.#set({ error: null });
      }
    }
  }

  #supportsChain(a: WalletAccount): boolean {
    return a.chains.length === 0 || a.chains.includes(this.chain);
  }

  async #adoptAccount(acc: WalletAccount, all: readonly WalletAccount[], gen: number, keepError = false): Promise<void> {
    this.#account = acc;
    this.#unsigned = null;
    this.#set({
      status: 'connected', wallet: this.#provider ? { name: this.#provider.name, icon: this.#provider.icon } : null, account: acc.address,
      accounts: all.map((a) => a.address), token: null, holding: null, solBalanceLamports: null, amountInput: '', amountRaw: null, preview: null,
      tx: { signature: null, phase: 'none', slot: null, messageVerified: false }, engine: { phase: 'idle', burnEventId: null },
      ...(keepError ? {} : { error: null }),
    });
    if (!this.#supportsChain(acc)) { this.#fail('wrong_network', undefined, 'connected'); return; }
    await this.loadToken(gen);
  }

  /* ---------------------------------- token ---------------------------------- */

  async loadToken(gen: number = this.#gen): Promise<void> {
    const owner = this.#account?.address;
    if (!owner || !this.#provider) { this.#fail('wallet_not_connected'); return; }
    const p = this.#o.project;
    this.#set({ status: 'loading_token', error: null });
    try {
      if ((await this.#o.rpc.getGenesisHash()) !== GENESIS_HASHES[p.cluster]) throw new BurnFlowError('rpc_wrong_network');
      const mintAcc = await this.#o.rpc.getAccountInfo(p.mint);
      if (gen !== this.#gen) return;
      if (!mintAcc) throw new BurnFlowError('token_not_found');
      const mint = parseMint(mintAcc.owner, mintAcc.data);
      if (mint.tokenProgram !== p.tokenProgram || mint.decimals !== p.decimals) throw new BurnFlowError('token_program_mismatch');
      const [accounts, sol] = await Promise.all([
        this.#o.rpc.getTokenAccountsByOwner(owner, TOKEN_PROGRAMS[mint.tokenProgram]),
        this.#o.rpc.getBalance(owner),
      ]);
      if (gen !== this.#gen) return;
      const mine = accounts.map((a) => parseTokenAccount(a.address, a.account.owner, a.account.data)).filter((a) => a.mint === p.mint && a.owner === owner);
      this.#mint = mint;
      const base = {
        token: { mint: p.mint, decimals: mint.decimals, tokenProgram: mint.tokenProgram, cluster: p.cluster, extensions: mint.extensions.map((e) => e.name) },
        solBalanceLamports: sol,
      };
      if (mine.length === 0) {
        this.#selected = null;
        this.#set({ ...base, holding: null, status: 'ready' });
        this.#fail('no_token_account');
        return;
      }
      const scored = mine.map((a) => ({ a, e: assessBurn(p.mint, mint, a, owner) }));
      scored.sort((x, y) => (x.e.availableRaw === y.e.availableRaw ? 0 : x.e.availableRaw > y.e.availableRaw ? -1 : 1));
      const best = scored[0]!;
      this.#selected = best.a;
      this.#set({ ...base, holding: this.#holdingOf(best.a, best.e, mine, mint.decimals), status: 'ready' });
      if (!best.e.canBurn) this.#fail(this.#blockCode(best.e.blocks[0]?.code), best.e.blocks.map((b) => b.code).join(','));
    } catch (e) {
      if (gen !== this.#gen) return;
      this.#set({ status: this.#account ? 'connected' : 'disconnected' });
      this.#fail(this.#fromUnknown(e));
    }
  }

  #blockCode(b: BurnBlock | undefined): BurnErrorCode {
    return b === 'account_frozen' ? 'account_frozen' : 'token_blocked';
  }

  #holdingOf(a: TokenAccountInfo, e: BurnEligibility, all: readonly TokenAccountInfo[], decimals: number): Holding {
    return {
      tokenAccount: a.address, balanceRaw: a.amountRaw, balance: formatUiAmount(a.amountRaw, decimals),
      availableRaw: e.availableRaw, available: formatUiAmount(e.availableRaw, decimals), eligibility: e,
      accounts: all.map((x) => ({ address: x.address, balanceRaw: x.amountRaw, frozen: x.state === 'frozen' })),
    };
  }

  /** Re-read balances (call after a burn or when the user returns to the page). */
  async refresh(): Promise<void> { if (!BUSY.has(this.#state.status)) await this.loadToken(); }

  /* ---------------------------------- amount --------------------------------- */

  /** Accepts a decimal string ("12.5") or 'max'. Never uses a JS number. */
  setAmount(input: string): void {
    if (BUSY.has(this.#state.status) && this.#state.status !== 'previewing') return;
    this.#unsigned = null;
    const token = this.#state.token;
    const holding = this.#state.holding;
    if (!token || !holding) { this.#set({ amountInput: input, amountRaw: null, preview: null }); return; }
    const status: FlowStatus = this.#state.status === 'preview_ready' || this.#state.status === 'previewing' ? 'ready' : this.#state.status;
    if (input.trim() === '') { this.#set({ amountInput: input, amountRaw: null, preview: null, error: null, status }); return; }
    try {
      const raw = input.trim().toLowerCase() === 'max' ? holding.availableRaw : parseUiAmount(input, token.decimals);
      const text = input.trim().toLowerCase() === 'max' ? formatUiAmount(raw, token.decimals) : input;
      if (raw === 0n) { this.#set({ amountInput: text, amountRaw: raw, preview: null, status }); this.#fail('amount_zero'); return; }
      if (raw > holding.availableRaw) { this.#set({ amountInput: text, amountRaw: raw, preview: null, status }); this.#fail('insufficient_token_balance'); return; }
      this.#set({ amountInput: text, amountRaw: raw, preview: null, error: null, status });
    } catch (e) {
      const code: BurnErrorCode = e instanceof AmountError && /fractional digits/.test(e.message) ? 'amount_too_many_decimals' : e instanceof AmountError && /u64/.test(e.message) ? 'amount_too_large' : 'amount_invalid';
      this.#set({ amountInput: input, amountRaw: null, preview: null, status });
      this.#fail(code);
    }
  }

  /* --------------------------------- preview --------------------------------- */

  async prepare(): Promise<BurnPreview | null> {
    const s = this.#state;
    if (BUSY.has(s.status)) throw new BurnFlowError('busy');
    const acc = this.#account;
    const sel = this.#selected;
    if (!this.#provider || !acc) { this.#fail('wallet_not_connected'); return null; }
    if (!s.token || !s.holding || !sel || !this.#mint) { this.#fail('no_token_account'); return null; }
    if (!s.holding.eligibility.canBurn) { this.#fail(this.#blockCode(s.holding.eligibility.blocks[0]?.code)); return null; }
    if (!this.#supportsChain(acc)) { this.#fail('wrong_network'); return null; }
    if (s.amountRaw === null || s.amountRaw === 0n) { this.#fail(s.amountRaw === 0n ? 'amount_zero' : 'amount_invalid'); return null; }
    if (s.amountRaw > s.holding.availableRaw) { this.#fail('insufficient_token_balance'); return null; }
    const gen = this.#gen;
    const amountRaw = s.amountRaw;
    this.#set({ status: 'previewing', error: null, preview: null });
    try {
      const { blockhash, lastValidBlockHeight } = await this.#o.rpc.getLatestBlockhash('confirmed');
      const unsigned = buildUnsignedBurn({ tokenProgram: s.token.tokenProgram, owner: acc.address, tokenAccount: sel.address, mint: s.token.mint, amountRaw, decimals: s.token.decimals, recentBlockhash: blockhash });
      const [feeNode, sol, sim] = await Promise.all([
        this.#o.rpc.getFeeForMessage(toBase64(unsigned.message)).catch(() => null),
        this.#o.rpc.getBalance(acc.address),
        this.#o.rpc.simulateTransaction(toBase64(unsigned.transaction)),
      ]);
      if (gen !== this.#gen) return null;
      const fee = feeNode ?? BASE_FEE_LAMPORTS;
      if (sol < fee) { this.#set({ status: 'ready', solBalanceLamports: sol }); this.#fail('insufficient_sol'); return null; }
      const simMessage = sim.err === null ? null : describeTxError(sim.err);
      const created = this.#now();
      const preview: BurnPreview = {
        id: ++this.#previewSeq, owner: acc.address, tokenAccount: sel.address, mint: s.token.mint, amountRaw, amount: formatUiAmount(amountRaw, s.token.decimals),
        decimals: s.token.decimals, remainingRaw: s.holding.balanceRaw - amountRaw, feeLamports: fee, feeExact: feeNode !== null, solBalanceLamports: sol,
        simulation: { ok: sim.err === null, unitsConsumed: sim.unitsConsumed, message: simMessage }, warnings: [...s.holding.eligibility.warnings],
        createdAt: created, expiresAt: created + (this.#o.previewTtlMs ?? 45_000),
      };
      this.#unsigned = unsigned;
      this.#lastValidBlockHeight = lastValidBlockHeight;
      this.#set({ status: 'preview_ready', preview, solBalanceLamports: sol });
      if (!preview.simulation.ok) { this.#fail('simulation_failed', simMessage ?? undefined); }
      return preview;
    } catch (e) {
      if (gen !== this.#gen) return null;
      this.#set({ status: 'ready', preview: null });
      this.#fail(this.#fromUnknown(e));
      return null;
    }
  }

  /* ------------------------------ confirm and burn ----------------------------- */

  /** Explicit confirmation of exactly the preview shown to the user (`previewId`). */
  async confirm(previewId: number): Promise<void> {
    const s = this.#state;
    if (BUSY.has(s.status)) throw new BurnFlowError('busy');
    const preview = s.preview;
    const unsigned = this.#unsigned;
    const acc = this.#account;
    const provider = this.#provider;
    if (!preview || !unsigned) { this.#fail('preview_missing'); return; }
    if (preview.id !== previewId || s.amountRaw !== preview.amountRaw || acc?.address !== preview.owner) { this.#fail('preview_stale'); return; }
    if (this.#now() > preview.expiresAt) { this.#unsigned = null; this.#set({ preview: null, status: 'ready' }); this.#fail('preview_expired'); return; }
    if (!preview.simulation.ok) { this.#fail('simulation_failed', preview.simulation.message ?? undefined); return; }
    if (!provider || !acc) { this.#fail('wallet_not_connected'); return; }
    if (!this.#supportsChain(acc)) { this.#fail('wrong_network'); return; }

    const gen = this.#gen;
    this.#unsigned = null; // a preview can be confirmed once
    this.#set({ status: 'awaiting_signature', error: null, tx: { signature: null, phase: 'none', slot: null, messageVerified: false }, engine: { phase: 'idle', burnEventId: null } });
    let signature: string;
    let verified = true;
    try {
      // Baseline BEFORE sending: the engine event we wait for must come after it.
      const baseline = await this.#o.engine.getStatus().then((st) => { this.#set({ counter: { status: 'ok', engine: st } }); return st.latestEventId; }).catch(() => null);
      let signedBytes: Uint8Array | null = null;
      if (provider.canSign) {
        signedBytes = await provider.signTransaction(acc, unsigned.transaction, this.chain);
        if (gen !== this.#gen) return;
        signature = assertSameMessage(signedBytes, unsigned).signatureBase58;
        this.#set({ status: 'sending' });
        const sent = await this.#o.rpc.sendTransaction(toBase64(signedBytes));
        if (sent !== signature) throw new BurnFlowError('send_failed', 'signature mismatch');
      } else {
        verified = false; // the wallet submits by itself: we cannot compare the message beforehand (the engine still re-reads the chain)
        const sigBytes = await provider.signAndSendTransaction(acc, unsigned.transaction, this.chain);
        if (gen !== this.#gen) return;
        signature = encodeBase58(sigBytes);
        this.#set({ status: 'sending' });
      }
      this.#set({ status: 'confirming', tx: { signature, phase: 'sent', slot: null, messageVerified: verified } });
      await this.#follow(signature, baseline, unsigned);
    } catch (e) {
      if (gen !== this.#gen) return;
      let code = this.#fromUnknown(e);
      if (code === 'rpc_unavailable') code = 'send_failed'; // anything that fails between signing and sending
      // Nothing sent: the flow is ready for another try. (After sending, #follow reports its own outcome.)
      if (this.#state.tx.signature === null) this.#set({ status: 'ready', preview: null });
      this.#fail(code);
    }
  }

  async #follow(signature: string, baseline: string | null, unsigned: UnsignedBurn): Promise<void> {
    void unsigned;
    const poll = this.#o.pollMs ?? 1_000;
    const deadline = this.#now() + (this.#o.txTimeoutMs ?? 120_000);
    let phase: TxPhase = 'sent';
    for (;;) {
      if (this.#disposed) return;
      let st = null;
      try { st = await this.#o.rpc.getSignatureStatus(signature); } catch { /* transient: keep polling until the deadline */ }
      if (st) {
        if (st.err !== null) {
          this.#set({ status: 'failed', tx: { ...this.#state.tx, phase: 'failed', slot: st.slot } });
          this.#fail('transaction_failed', describeTxError(st.err));
          return;
        }
        const next: TxPhase = st.confirmationStatus === 'finalized' ? 'finalized' : st.confirmationStatus === 'confirmed' ? 'confirmed' : 'processed';
        if (next !== phase) { phase = next; this.#set({ tx: { ...this.#state.tx, phase, slot: st.slot } }); }
        if (phase === 'finalized') break;
      } else {
        let expired = false;
        try { expired = (await this.#o.rpc.getBlockHeight('confirmed')) > this.#lastValidBlockHeight; } catch { /* unknown: keep waiting */ }
        if (expired) {
          // Re-check once: the status may have appeared between the two calls.
          const again = await this.#o.rpc.getSignatureStatus(signature).catch(() => null);
          if (!again) {
            this.#set({ status: 'failed', tx: { ...this.#state.tx, phase: 'expired' } });
            this.#fail('blockhash_expired');
            return;
          }
          continue;
        }
      }
      if (this.#now() > deadline) { this.#fail('send_failed', 'timeout while waiting for the cluster'); return; }
      await this.#sleep(poll);
    }
    this.#set({ status: 'finalized', engine: { phase: 'waiting', burnEventId: null } });
    await this.#awaitEngine(signature, baseline ?? '0');
  }

  /** Waits until OUR engine lists the burn in its durable journal; only then is it `counted`. */
  async #awaitEngine(signature: string, baseline: string): Promise<void> {
    const poll = this.#o.pollMs ?? 1_000;
    const deadline = this.#now() + (this.#o.engineTimeoutMs ?? 120_000);
    let after = baseline;
    for (;;) {
      if (this.#disposed) return;
      try {
        const page = await this.#o.engine.eventsAfter(after);
        const hit = page.burns.find((b) => b.signature === signature);
        if (hit) {
          this.#set({ engine: { phase: 'counted', burnEventId: hit.eventId } });
          await this.#refreshCounter();
          await this.refresh();
          return;
        }
        after = page.nextAfter;
        if (page.hasMore) continue;
      } catch { /* engine briefly unreachable: keep trying until the deadline */ }
      if (this.#now() > deadline) { this.#set({ engine: { phase: 'timeout', burnEventId: null } }); return; }
      await this.#sleep(poll);
    }
  }

  /** Counter from the engine only. */
  async #refreshCounter(): Promise<void> {
    try {
      const st = await this.#o.engine.getStatus();
      this.#set({ counter: { status: 'ok', engine: st } });
    } catch {
      this.#set({ counter: { status: 'unavailable', engine: this.#state.counter.engine } });
    }
  }

  async refreshCounter(): Promise<void> { await this.#refreshCounter(); }

  /** Back to the ready state after a finished or failed attempt. */
  reset(): void {
    if (BUSY.has(this.#state.status)) return;
    this.#unsigned = null;
    this.#set({
      status: this.#state.holding ? 'ready' : this.#account ? 'connected' : 'disconnected', amountInput: '', amountRaw: null, preview: null,
      tx: { signature: null, phase: 'none', slot: null, messageVerified: false }, engine: { phase: 'idle', burnEventId: null }, error: null,
    });
  }
}

export function createBurnController(o: BurnControllerOptions): BurnController { return new BurnController(o); }
