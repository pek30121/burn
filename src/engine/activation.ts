/* Pre-launch activation. A project declared with `awaitMint` is watched until its mint exists on-chain (finalized); the moment it
 * does, the real token program, decimals, supply and authorities are READ from the chain and validated, and only if everything is
 * consistent the project is handed to the engine (`activate`), which starts its indexer without any restart. Nothing about the
 * token is assumed: operator-provided `expect` values are guard rails that BLOCK on a difference.
 *
 * A mint that is unexpected blocks ONLY this project (explicit public code, retried slowly because an authority can still be
 * revoked); every other project keeps running. RPC failures are not verdicts: they back off and retry. */

import { ConfigError, TOKEN_PROGRAMS, activateProject, type PendingProject, type ProjectConfig, type TokenProgram } from '../config/schema.ts';
import { formatUiAmount, parseUiAmount } from '../core/amount.ts';
import { RpcError, type SolanaRpc } from '../chain/rpc.ts';
import { readMintHistory, type MintHistory } from '../chain/mint-history.ts';
import { EXT, type MintInfo } from '../wallet/token-info.ts';
import type { Logger } from './logger.ts';
import { ShutdownError } from './limiter.ts';

export type Lifecycle = 'awaiting_mint' | 'validating' | 'activating' | 'active' | 'blocked';

/** Stable, public reasons (never internal text). */
export type BlockCode =
  | 'not_a_token_mint' | 'native_mint' | 'mint_authority_active' | 'freeze_authority_active' | 'unsupported_mint_extension'
  | 'decimals_mismatch' | 'token_program_mismatch' | 'supply_zero' | 'supply_mismatch' | 'supply_history_mismatch'
  | 'levels_incompatible' | 'stored_project_mismatch';

export interface Blocked { readonly code: BlockCode; readonly detail: string }

const NATIVE_MINTS: ReadonlySet<string> = new Set(['So11111111111111111111111111111111111111112', '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP']);
const KNOWN_EXTENSIONS: ReadonlySet<number> = new Set(Object.values(EXT));

/** Checks that need only the mint account. Returns the first problem, or null. */
export function assessMint(p: PendingProject, info: MintInfo): Blocked | null {
  if (NATIVE_MINTS.has(p.mint)) return { code: 'native_mint', detail: 'wrapped SOL is not a project token' };
  if (info.mintAuthority !== null) return { code: 'mint_authority_active', detail: 'the mint authority is still active: the supply can grow' };
  if (info.freezeAuthority !== null) return { code: 'freeze_authority_active', detail: 'a freeze authority exists: holder accounts could be frozen, blocking burns' };
  if (info.extensions.some((e) => e.type === EXT.ConfidentialMintBurn)) return { code: 'unsupported_mint_extension', detail: 'Token-2022 confidential mint/burn: some burns would be invisible' };
  const unknown = info.extensions.find((e) => !KNOWN_EXTENSIONS.has(e.type));
  if (unknown) return { code: 'unsupported_mint_extension', detail: `unknown Token-2022 extension ${unknown.type}` };
  if (p.expect.decimals !== null && info.decimals !== p.expect.decimals) return { code: 'decimals_mismatch', detail: `the mint has ${info.decimals} decimals, ${p.expect.decimals} expected` };
  if (p.expect.tokenProgram !== null && info.tokenProgram !== p.expect.tokenProgram) return { code: 'token_program_mismatch', detail: `owned by ${info.tokenProgram}, ${p.expect.tokenProgram} expected` };
  if (info.supplyRaw === 0n) return { code: 'supply_zero', detail: 'the supply is 0' };
  return null;
}

export type SupplyVerdict = { readonly blocked: Blocked } | { readonly blocked: null; readonly initialSupplyRaw: bigint | null; readonly warnings: string[] };

/** The supply against the mint's own history: supply now = created − burned must hold exactly, and the total created must be what the operator expects. */
export function assessSupply(p: PendingProject, info: MintInfo, history: MintHistory): SupplyVerdict {
  let expectedRaw: bigint | null = null;
  if (p.expect.supply !== null) {
    try { expectedRaw = parseUiAmount(p.expect.supply, info.decimals); } catch { return { blocked: { code: 'supply_mismatch', detail: 'the expected supply does not fit the real decimals' } }; }
  }
  if (history.complete) {
    if (history.createdRaw - history.burnedRaw !== info.supplyRaw) {
      return { blocked: { code: 'supply_history_mismatch', detail: `the supply (${info.supplyRaw}) is not created (${history.createdRaw}) minus burned (${history.burnedRaw}) in the history` } };
    }
    if (expectedRaw !== null && history.createdRaw !== expectedRaw) return { blocked: { code: 'supply_mismatch', detail: `${history.createdRaw} raw units were created, ${expectedRaw} expected` } };
    return { blocked: null, initialSupplyRaw: history.createdRaw, warnings: [] };
  }
  // history too long (or unreadable): the creation supply cannot be derived. The supply can still never exceed what is expected.
  if (expectedRaw !== null && info.supplyRaw > expectedRaw) return { blocked: { code: 'supply_mismatch', detail: `the supply (${info.supplyRaw}) exceeds the expected ${expectedRaw}` } };
  return { blocked: null, initialSupplyRaw: null, warnings: ['initial_supply_unknown'] };
}

export interface WatcherSnapshot {
  readonly id: string;
  readonly mint: string;
  readonly lifecycle: Lifecycle;
  /** Public code when blocked, otherwise null. */
  readonly code: BlockCode | null;
  readonly checks: number;
  readonly lastCheckAt: string | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  readonly warnings: readonly string[];
}

export interface WatcherOptions {
  readonly pending: PendingProject;
  readonly rpc: Pick<SolanaRpc, 'getAccountOwner' | 'getMintInfo' | 'getSignaturesForAddress' | 'getTransaction'>;
  readonly log: Logger;
  /** Normal check interval while the mint does not exist. */
  readonly pollIntervalMs: number;
  /** Re-check interval once blocked (an authority can be revoked later; nothing else changes). */
  readonly blockedRetryMs: number;
  readonly backoff: { readonly baseMs: number; readonly maxMs: number };
  readonly maxHistorySignatures: number;
  /** Registers the project in the store and starts its runner. Throws -> retried (or blocked on a config mismatch). */
  readonly activate: (project: ProjectConfig) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly random?: () => number;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
const TOKEN_OWNER_NAMES = new Map<string, TokenProgram>(Object.entries(TOKEN_PROGRAMS).map(([n, id]) => [id, n as TokenProgram]));

export class MintWatcher {
  readonly #o: WatcherOptions;
  #lifecycle: Lifecycle = 'awaiting_mint';
  #code: BlockCode | null = null;
  #checks = 0;
  #lastCheckAt: string | null = null;
  #failures = 0;
  #lastError: string | null = null;
  #warnings: string[] = [];
  #lastReported = '';

  constructor(o: WatcherOptions) { this.#o = o; }

  snapshot(): WatcherSnapshot {
    const p = this.#o.pending;
    return { id: p.id, mint: p.mint, lifecycle: this.#lifecycle, code: this.#code, checks: this.#checks, lastCheckAt: this.#lastCheckAt, consecutiveFailures: this.#failures, lastError: this.#lastError, warnings: this.#warnings };
  }

  async run(signal: AbortSignal): Promise<void> {
    const { log, pending: p } = this.#o;
    log.info('mint_watch_started', { project: p.id, mint: p.mint });
    while (!signal.aborted && this.#lifecycle !== 'active') {
      try {
        const next = await this.#check(signal);
        this.#failures = 0;
        this.#lastError = null;
        if (next === 'active') break;
        await this.#wait(next === 'blocked' ? this.#o.blockedRetryMs : this.#o.pollIntervalMs);
      } catch (e) {
        if (e instanceof ShutdownError || signal.aborted) break;
        this.#failures++;
        this.#lastError = describe(e);
        if (this.#lifecycle === 'validating' || this.#lifecycle === 'activating') this.#lifecycle = 'awaiting_mint'; // nothing was activated: back to watching
        const { baseMs, maxMs } = this.#o.backoff;
        const delay = Math.round(Math.min(maxMs, baseMs * 2 ** (this.#failures - 1)) * (0.5 + (this.#o.random ?? Math.random)() / 2));
        log.warn('mint_watch_failed', { project: p.id, error: this.#lastError, consecutiveFailures: this.#failures, retryInMs: delay });
        await this.#wait(delay);
      }
    }
  }

  async #check(signal: AbortSignal): Promise<'waiting' | 'blocked' | 'active'> {
    const { rpc, pending: p, log } = this.#o;
    this.#checks++;
    this.#lastCheckAt = (this.#o.now ?? (() => new Date()))().toISOString();
    const owner = await rpc.getAccountOwner(p.mint, 'finalized'); // finalized only: a mint that could still vanish is not a mint
    if (signal.aborted) throw new ShutdownError();
    if (owner === null) { this.#set('awaiting_mint', null); return 'waiting'; }

    this.#lifecycle = 'validating';
    const program = TOKEN_OWNER_NAMES.get(owner);
    if (!program) return this.#block({ code: 'not_a_token_mint', detail: `the account is owned by ${owner}, not by a token program` });
    let info: MintInfo;
    try {
      info = await rpc.getMintInfo(p.mint, 'finalized');
    } catch (e) {
      if (e instanceof RpcError && /not a readable token mint/.test(e.message)) return this.#block({ code: 'not_a_token_mint', detail: 'the account is not a readable token mint' });
      throw e; // transient
    }
    const first = assessMint(p, info);
    if (first) return this.#block(first);

    const history = await readMintHistory(rpc, p.mint, this.#o.maxHistorySignatures);
    if (signal.aborted) throw new ShutdownError();
    const supply = assessSupply(p, info, history);
    if (supply.blocked) return this.#block(supply.blocked);

    let project: ProjectConfig;
    try {
      project = activateProject(p, { decimals: info.decimals, tokenProgram: info.tokenProgram, initialSupply: supply.initialSupplyRaw === null ? null : formatUiAmount(supply.initialSupplyRaw, info.decimals) });
    } catch (e) {
      if (e instanceof ConfigError) return this.#block({ code: 'levels_incompatible', detail: e.issues.join('; ') });
      throw e;
    }
    this.#lifecycle = 'activating';
    this.#warnings = supply.warnings;
    try {
      await this.#o.activate(project);
    } catch (e) {
      if (e instanceof Error && e.name === 'ConfigMismatchError') return this.#block({ code: 'stored_project_mismatch', detail: 'the database already holds this project with different immutable settings' });
      throw e;
    }
    this.#set('active', null);
    log.info('mint_activated', { project: p.id, mint: p.mint, tokenProgram: info.tokenProgram, decimals: info.decimals, supplyRaw: info.supplyRaw.toString(), initialSupplyRaw: supply.initialSupplyRaw?.toString() ?? null, warnings: supply.warnings });
    return 'active';
  }

  #block(b: Blocked): 'blocked' {
    this.#set('blocked', b.code);
    const key = `${b.code}:${b.detail}`;
    if (key !== this.#lastReported) { this.#lastReported = key; this.#o.log.error('mint_blocked', { project: this.#o.pending.id, mint: this.#o.pending.mint, code: b.code, detail: b.detail }); }
    return 'blocked';
  }

  #set(l: Lifecycle, code: BlockCode | null): void {
    this.#lifecycle = l;
    this.#code = code;
  }

  async #wait(ms: number): Promise<void> {
    try { await this.#o.sleep(ms); } catch (e) { if (!(e instanceof ShutdownError)) throw e; }
  }
}
