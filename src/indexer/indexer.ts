/* Indexer for ONE project (run one instance per project; they share nothing).
 *
 * Sources of truth: `getSignaturesForAddress(mint)` for discovery and
 * `getTransaction` + parseBurns for content. Passes per sync:
 *   1. init/tail  (finalized): everything newer than the stored head;
 *   2. backfill   (finalized): older history, a bounded number of pages per sync;
 *   3. confirmed  (optional): not-yet-finalized burns for live display; they never
 *      produce level events, and are dropped if their block is abandoned.
 *
 * Cursor rule: the stored head/backfill cursor only moves past signatures that
 * were fully processed, and only after their burns were recorded (idempotent),
 * so an interruption at any point is repaired by simply syncing again.
 *
 * Completeness is never assumed: `status().complete` is true only after a
 * successful supply reconciliation (see reconcile()). */

import { parseBurns, toBurnInput } from '../chain/burn-parser.ts';
import { RpcError, RpcUnsupportedVersionError, type SignatureInfo, type SolanaRpc } from '../chain/rpc.ts';
import type { ProjectConfig } from '../config/schema.ts';
import type { Commitment, LevelReachedEvent } from '../core/ledger.ts';
import { computeProgress, type Progress } from '../core/progression.ts';
import type { IndexIssue, IndexState, IndexerStore, IssueCode, Totals, Verification } from './store.ts';

export type ChainRpc = Pick<SolanaRpc, 'getSignaturesForAddress' | 'getTransaction' | 'getTokenSupply'> & Partial<Pick<SolanaRpc, 'getTransactionsForAddress'>>;

export interface IndexerOptions {
  readonly project: ProjectConfig;
  readonly rpc: ChainRpc;
  readonly store: IndexerStore;
  /** Also track confirmed (not yet finalized) burns. Costs extra RPC calls; off by default. */
  readonly trackConfirmed?: boolean;
  readonly pageSize?: number;
  /** Fetch the transactions of a finalized page in bulk (Helius `getTransactionsForAddress`, ~10x fewer credits than one
   * `getTransaction` each). Discovery is unchanged (`getSignaturesForAddress`); anything the bulk call does not return,
   * returns malformed or incomplete is fetched individually exactly as before. Off by default. */
  readonly batchFetch?: boolean;
  /** Below this many transactions a bulk request (10 credits minimum) costs more than fetching them one by one. */
  readonly batchMinTransactions?: number;
  /** Max signature pages collected in one tail pass before the gap is declared too large. */
  readonly maxTailPages?: number;
  readonly backfillPagesPerSync?: number;
  readonly checkpointEvery?: number;
  /** Failed attempts on one signature (across syncs) before it is quarantined as an issue. */
  readonly maxSignatureAttempts?: number;
  /** Level events, delivered at least once, only for finalized totals. */
  readonly onEvent?: (e: LevelReachedEvent) => void | Promise<void>;
  readonly log?: (msg: string) => void;
}

export interface SyncResult {
  burnsRecorded: number;
  burnsPromoted: number;
  burnsDropped: number;
  eventsDelivered: number;
  /** True when the backfill still has pages to read. */
  moreWork: boolean;
  /** Set when the sync stopped early; the cursor is still consistent and the next sync resumes. */
  error: string | null;
  warnings: string[];
}

export interface IndexerStatus {
  projectId: string;
  backfill: IndexState['backfill'];
  finalizedHead: string | null;
  totals: Totals;
  progress: Progress;
  issues: readonly IndexIssue[];
  verification: Verification;
  /** True only when the indexed total is proven equal to the on-chain supply drop. */
  complete: boolean;
}

class HaltSync extends Error {}

/** What the transport did, to measure the saving (counts are requests, not credits). */
export interface FetchStats {
  readonly bulkRequests: number;
  readonly bulkTransactions: number;
  readonly singleRequests: number;
  /** Transactions of a bulk-covered page that had to be fetched individually. */
  readonly fallbacks: number;
  readonly bulkDisabled: boolean;
}

const BULK_CHUNK = 1000;

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Indexer {
  readonly project: ProjectConfig;
  readonly #rpc: ChainRpc;
  readonly #store: IndexerStore;
  readonly #trackConfirmed: boolean;
  readonly #pageSize: number;
  readonly #maxTailPages: number;
  readonly #backfillPages: number;
  readonly #checkpointEvery: number;
  readonly #maxAttempts: number;
  readonly #onEvent: ((e: LevelReachedEvent) => void | Promise<void>) | undefined;
  readonly #log: (msg: string) => void;
  readonly #attempts = new Map<string, number>();
  readonly #seenConfirmed = new Map<string, number>(); // signature -> slot
  readonly #bulk = new Map<string, unknown>(); // signature -> getTransaction-shaped response, for the chunk being ingested
  readonly #batchWanted: boolean;
  readonly #batchMin: number;
  #bulkDisabled = false;
  #stats = { bulkRequests: 0, bulkTransactions: 0, singleRequests: 0, fallbacks: 0 };
  #state!: IndexState;
  #running = false;

  constructor(o: IndexerOptions) {
    this.project = o.project;
    this.#rpc = o.rpc;
    this.#store = o.store;
    this.#trackConfirmed = o.trackConfirmed ?? false;
    this.#pageSize = o.pageSize ?? 1000;
    this.#batchWanted = (o.batchFetch ?? false) && typeof o.rpc.getTransactionsForAddress === 'function';
    this.#batchMin = o.batchMinTransactions ?? 10;
    this.#maxTailPages = o.maxTailPages ?? 100;
    this.#backfillPages = o.backfillPagesPerSync ?? 1;
    this.#checkpointEvery = o.checkpointEvery ?? 50;
    this.#maxAttempts = o.maxSignatureAttempts ?? 5;
    this.#onEvent = o.onEvent;
    this.#log = o.log ?? (() => {});
  }

  fetchStats(): FetchStats {
    return { ...this.#stats, bulkDisabled: this.#bulkDisabled };
  }

  async syncOnce(): Promise<SyncResult> {
    if (this.#running) throw new Error('sync already running');
    this.#running = true;
    const r: SyncResult = { burnsRecorded: 0, burnsPromoted: 0, burnsDropped: 0, eventsDelivered: 0, moreWork: false, error: null, warnings: [] };
    try {
      this.#state = await this.#store.loadState(this.project.id);
      await this.#flushEvents(r); // redelivery after a restart
      try {
        if (this.#state.finalizedHead === null) await this.#init(r);
        else await this.#tail(r);
        if (this.#state.finalizedHead !== null) await this.#backfill(r);
        if (this.#trackConfirmed && this.#state.finalizedHead !== null) await this.#confirmedPass(r);
      } catch (e) {
        r.error = describe(e);
        this.#log(`sync stopped: ${r.error}`);
      }
      if ((r.burnsRecorded > 0 || r.burnsPromoted > 0 || r.burnsDropped > 0) && this.#state.verification.status !== 'unverified') {
        this.#state.verification = { status: 'unverified', reason: 'indexed burns changed since the last reconciliation' };
        await this.#save();
      }
      await this.#flushEvents(r);
      r.moreWork = this.#state.backfill === 'running';
      return r;
    } finally {
      this.#running = false;
    }
  }

  /** Polls until aborted. Keeps going immediately while backfill has work; waits `intervalMs` otherwise or after an error. */
  async run(signal: AbortSignal, intervalMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
    while (!signal.aborted) {
      let wait = true;
      try {
        const res = await this.syncOnce();
        wait = res.error !== null || !res.moreWork;
      } catch (e) {
        this.#log(`sync failed: ${describe(e)}`);
      }
      if (wait && !signal.aborted) await sleep(intervalMs);
    }
  }

  async status(): Promise<IndexerStatus> {
    const [state, totals] = await Promise.all([this.#store.loadState(this.project.id), this.#store.totals(this.project.id)]);
    return {
      projectId: this.project.id,
      backfill: state.backfill,
      finalizedHead: state.finalizedHead,
      totals,
      progress: computeProgress(this.project.levels, totals.finalizedRaw),
      issues: state.issues,
      verification: state.verification,
      complete: state.verification.status === 'verified',
    };
  }

  /**
   * The only completeness proof available: with minting disabled,
   * initialSupply − currentSupply must equal the finalized burns indexed.
   * Supply is read BEFORE a catch-up sync; if that sync still finds new burns the
   * supply reading is stale and the check is retried. Never trust a mismatch-free
   * run that was not able to compare (those return `unverified` with a reason).
   */
  async reconcile(): Promise<Verification> {
    const p = this.project;
    const set = async (v: Verification): Promise<Verification> => {
      this.#state = await this.#store.loadState(p.id);
      this.#state.verification = v;
      await this.#save();
      return v;
    };
    if (p.initialSupplyRaw === null) return set({ status: 'unverified', reason: 'initialSupply is not configured for this project' });
    if (p.startSlot !== 0) return set({ status: 'unverified', reason: 'reconciliation needs startSlot 0 (counting from creation)' });

    for (let attempt = 0; attempt < 3; attempt++) {
      const supply = await this.#rpc.getTokenSupply(p.mint, 'finalized');
      if (supply.decimals !== p.decimals) {
        return set({ status: 'unverified', reason: `on-chain decimals ${supply.decimals} differ from configured ${p.decimals}` });
      }
      const res = await this.syncOnce();
      if (res.error !== null) return set({ status: 'unverified', reason: `sync failed: ${res.error}` });
      const state = await this.#store.loadState(p.id);
      if (state.backfill !== 'done_exhausted' && state.backfill !== 'done_start_slot') {
        return set({ status: 'unverified', reason: 'history is still being read' });
      }
      if (res.burnsRecorded > 0 || res.burnsPromoted > 0) continue; // chain moved after the supply reading
      const indexed = (await this.#store.totals(p.id)).finalizedRaw;
      const expected = p.initialSupplyRaw - supply.amountRaw;
      return set(
        expected === indexed
          ? { status: 'verified', burnedRaw: indexed.toString() }
          : { status: 'mismatch', expectedBurnedRaw: expected.toString(), indexedBurnedRaw: indexed.toString() },
      );
    }
    return set({ status: 'unverified', reason: 'new burns kept arriving during the check; retry' });
  }

  /* ------------------------------------------------------------------ */

  async #init(r: SyncResult): Promise<void> {
    const page = await this.#fetchPage({ commitment: 'finalized' });
    if (page.length === 0) {
      this.#state.verification = { status: 'unverified', reason: 'the node returned no signatures for this mint' };
      await this.#save();
      return;
    }
    const oldestFirst = [...page].reverse();
    for (const [i, info] of oldestFirst.entries()) {
      await this.#warm(oldestFirst, i);
      await this.#ingest(info, 'finalized', r);
    }
    const oldest = page[page.length - 1]!;
    this.#state.finalizedHead = page[0]!.signature;
    this.#state.finalizedHeadSlot = page[0]!.slot;
    this.#state.backfillBefore = oldest.signature;
    this.#state.backfill = this.#backfillAfter(page, oldest);
    await this.#save();
  }

  async #tail(r: SyncResult): Promise<void> {
    const head = this.#state.finalizedHead!;
    let list: SignatureInfo[];
    try {
      list = await this.#collect('finalized', head);
    } catch (e) {
      if (e instanceof HaltSync) {
        await this.#addIssue({ code: e.message.startsWith('gap') ? 'tail_gap_too_large' : 'history_inconsistent', detail: e.message });
      }
      throw e;
    }
    let lastOk: SignatureInfo | null = null;
    let sinceCheckpoint = 0;
    try {
      const oldestFirst = list.reverse();
      for (const [i, info] of oldestFirst.entries()) {
        await this.#warm(oldestFirst, i);
        await this.#ingest(info, 'finalized', r);
        lastOk = info;
        if (++sinceCheckpoint >= this.#checkpointEvery) {
          await this.#moveHead(lastOk);
          sinceCheckpoint = 0;
        }
      }
    } finally {
      if (lastOk) await this.#moveHead(lastOk);
    }
  }

  async #backfill(r: SyncResult): Promise<void> {
    for (let i = 0; i < this.#backfillPages && this.#state.backfill === 'running'; i++) {
      const page = await this.#fetchPage({ commitment: 'finalized', before: this.#state.backfillBefore! });
      if (page.length === 0) {
        this.#state.backfill = 'done_exhausted';
        await this.#save();
        return;
      }
      let lastOk: SignatureInfo | null = null;
      let sinceCheckpoint = 0;
      try {
        for (const [i, info] of page.entries()) {
          await this.#warm(page, i);
          await this.#ingest(info, 'finalized', r);
          lastOk = info;
          if (++sinceCheckpoint >= this.#checkpointEvery) {
            this.#state.backfillBefore = lastOk.signature;
            await this.#save();
            sinceCheckpoint = 0;
          }
        }
      } finally {
        if (lastOk) {
          this.#state.backfillBefore = lastOk.signature;
          await this.#save();
        }
      }
      const oldest = page[page.length - 1]!;
      this.#state.backfill = this.#backfillAfter(page, oldest);
      await this.#save();
      await this.#flushEvents(r);
    }
  }

  #backfillAfter(page: SignatureInfo[], oldest: SignatureInfo): IndexState['backfill'] {
    if (oldest.slot < this.project.startSlot) return 'done_start_slot';
    return page.length < this.#pageSize ? 'done_exhausted' : 'running';
  }

  async #confirmedPass(r: SyncResult): Promise<void> {
    try {
      const head = this.#state.finalizedHead!;
      const list = (await this.#collect('confirmed', head)).reverse();
      for (const info of list) {
        if (this.#seenConfirmed.has(info.signature)) continue;
        if (await this.#ingest(info, 'confirmed', r)) this.#seenConfirmed.set(info.signature, info.slot);
      }
    } catch (e) {
      r.warnings.push(`confirmed pass: ${describe(e)}`); // finalized pass stays authoritative
    }
    // Confirmed burns at or below the finalized frontier that never finalized sit on an abandoned fork.
    const frontier = this.#state.finalizedHeadSlot;
    if (frontier !== null) {
      for (const b of await this.#store.pendingConfirmed(this.project.id)) {
        if (b.slot <= frontier && (await this.#store.dropConfirmed(this.project.id, b.key))) r.burnsDropped++;
      }
      for (const [sig, slot] of this.#seenConfirmed) if (slot <= frontier) this.#seenConfirmed.delete(sig);
    }
  }

  /** Collects signatures newer than `until`, newest first, checking the node's ordering. */
  async #collect(commitment: Commitment, until: string): Promise<SignatureInfo[]> {
    const out: SignatureInfo[] = [];
    let before: string | undefined;
    for (let pages = 0; ; pages++) {
      if (pages >= this.#maxTailPages) {
        throw new HaltSync(`gap too large: more than ${this.#maxTailPages * this.#pageSize} signatures newer than the stored head; backfill-style catch-up needed`);
      }
      const page = await this.#fetchPage({ commitment, until, ...(before ? { before } : {}) }, out[out.length - 1]);
      out.push(...page);
      if (page.length < this.#pageSize) return out;
      before = page[page.length - 1]!.signature;
    }
  }

  async #fetchPage(q: { commitment: Commitment; before?: string; until?: string }, prev?: SignatureInfo): Promise<SignatureInfo[]> {
    const page = await this.#rpc.getSignaturesForAddress(this.project.mint, { limit: this.#pageSize, ...q });
    let last = prev;
    const seen = new Set<string>();
    for (const info of page) {
      if ((last && info.slot > last.slot) || seen.has(info.signature)) {
        const msg = `history inconsistent near ${info.signature} (slot ${info.slot} after ${last?.slot})`;
        await this.#addIssue({ code: 'history_inconsistent', signature: info.signature, detail: msg });
        throw new HaltSync(msg);
      }
      seen.add(info.signature);
      last = info;
    }
    return page;
  }

  /** Processes one signature. Throws to stop the sync (cursor stays before it); returns false only on the confirmed pass. */
  async #ingest(info: SignatureInfo, commitment: Commitment, r: SyncResult): Promise<boolean> {
    const final = commitment === 'finalized';
    if (info.err !== null || info.slot < this.project.startSlot) return true; // failed on-chain / before the counting window
    const sig = info.signature;

    const opts = { mint: this.project.mint, tokenProgram: this.project.tokenProgram, decimals: this.project.decimals, expectedSignature: sig };
    const bulk = final ? this.#bulk.get(sig) : undefined;
    this.#bulk.delete(sig);
    let parsed: ReturnType<typeof parseBurns> | null = bulk === undefined ? null : parseBurns(bulk, opts);
    // A bulk entry is only trusted when it parses cleanly and completely (the listing said it succeeded, so "failed" is suspect too); anything else is re-read the usual way.
    if (parsed !== null && (parsed.status !== 'ok' || !parsed.complete)) {
      this.#stats.fallbacks++;
      parsed = null;
    }
    if (parsed === null) {
      let tx: unknown;
      try {
        this.#stats.singleRequests++;
        tx = await this.#rpc.getTransaction(sig, commitment);
      } catch (e) {
        if (e instanceof RpcUnsupportedVersionError && final) {
          await this.#addIssue({ code: 'unsupported_version', signature: sig, detail: 'transaction version newer than supported' });
          return true;
        }
        throw e;
      }
      if (tx === null) return this.#failed(final, 'tx_unavailable', sig, 'the node returned no transaction');
      parsed = parseBurns(tx, opts);
    }
    if (parsed.status === 'malformed') return this.#failed(final, 'malformed', sig, parsed.reason);
    if (parsed.status === 'failed') return true;
    if (!parsed.complete && final) {
      await this.#addIssue({ code: 'incomplete_parse', signature: sig, detail: 'inner instructions unavailable; CPI burns cannot be ruled out' });
    }
    for (const burn of parsed.burns) {
      const res = await this.#store.recordBurn(this.project.id, toBurnInput(burn, commitment));
      if (res.status === 'inserted') r.burnsRecorded++;
      else if (res.status === 'promoted') r.burnsPromoted++;
      else if (res.status === 'rejected' && final) {
        await this.#addIssue({ code: 'burn_rejected', signature: sig, detail: `${burn.instructionPath}: ${res.reason}` });
      }
    }
    this.#attempts.delete(sig);
    return true;
  }

  /** At each chunk boundary of a finalized page, bulk-fetch the next chunk's transactions (memory stays bounded). */
  async #warm(order: readonly SignatureInfo[], index: number): Promise<void> {
    if (!this.#batchWanted || this.#bulkDisabled || index % BULK_CHUNK !== 0) return;
    this.#bulk.clear();
    const chunk = order.slice(index, index + BULK_CHUNK).filter((i) => i.err === null && i.slot >= this.project.startSlot);
    if (chunk.length < this.#batchMin) return;
    const want = new Set(chunk.map((i) => i.signature));
    const slotGte = Math.min(...chunk.map((i) => i.slot));
    const slotLte = Math.max(...chunk.map((i) => i.slot));
    let token: string | undefined;
    try {
      for (let pages = 0; pages < Math.ceil(chunk.length / BULK_CHUNK) + 3; pages++) {
        const res = await this.#rpc.getTransactionsForAddress!(this.project.mint, { slotGte, slotLte, limit: BULK_CHUNK, ...(token ? { paginationToken: token } : {}) });
        this.#stats.bulkRequests++;
        this.#stats.bulkTransactions += res.returned;
        for (const t of res.transactions) if (want.has(t.signature)) this.#bulk.set(t.signature, t.response);
        if (res.paginationToken === null || this.#bulk.size >= want.size) break;
        token = res.paginationToken;
      }
    } catch (e) {
      // Never fatal: the individual path below fetches whatever is missing. A refusal that cannot succeed later
      // (method or plan not available) switches the bulk path off for good; a transient failure only skips this chunk.
      if (e instanceof RpcError && !e.retryable) {
        this.#bulkDisabled = true;
        this.#log(`bulk transaction fetch disabled: ${e.message}`);
      } else this.#log(`bulk transaction fetch skipped for this chunk: ${describe(e)}`);
    }
    this.#stats.fallbacks += want.size - this.#bulk.size;
  }

  async #failed(final: boolean, code: IssueCode, sig: string, detail: string): Promise<boolean> {
    if (!final) return false;
    const n = (this.#attempts.get(sig) ?? 0) + 1;
    if (n < this.#maxAttempts) {
      this.#attempts.set(sig, n);
      throw new HaltSync(`${code} for ${sig} (attempt ${n}/${this.#maxAttempts}): ${detail}`);
    }
    this.#attempts.delete(sig);
    await this.#addIssue({ code, signature: sig, detail }); // skipped, but exposed: the history can no longer be called complete
    return true;
  }

  async #moveHead(info: SignatureInfo): Promise<void> {
    this.#state.finalizedHead = info.signature;
    this.#state.finalizedHeadSlot = info.slot;
    await this.#save();
  }

  async #addIssue(issue: IndexIssue): Promise<void> {
    const dup = this.#state.issues.some((i) => i.code === issue.code && i.signature === issue.signature);
    if (dup) return;
    this.#state.issues.push(issue);
    if (this.#state.issues.length > 1000) this.#state.issues.shift();
    await this.#save();
  }

  async #save(): Promise<void> {
    await this.#store.saveState(this.project.id, this.#state);
  }

  async #flushEvents(r: SyncResult): Promise<void> {
    if (!this.#onEvent) return;
    for (const e of await this.#store.pendingEvents(this.project.id)) {
      try {
        await this.#onEvent(e);
      } catch (err) {
        r.warnings.push(`event delivery failed for level ${e.level.id}: ${describe(err)}`);
        return; // keep order; the event stays in the outbox
      }
      await this.#store.ackEvent(this.project.id, e.level.id);
      r.eventsDelivered++;
    }
  }
}
