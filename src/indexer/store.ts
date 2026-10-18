/* Storage contract for the indexer. Everything is keyed by project id.
 *
 * Crash-safety rule the indexer relies on: `recordBurn` is idempotent and the
 * cursor in IndexState only advances AFTER the burns it covers were recorded,
 * so no multi-write transaction is needed; replaying after a crash is a no-op.
 * Events produced by recordBurn go to an outbox that survives restarts and is
 * delivered at least once (consumers dedupe on project id + level id). */

import type { BurnInput, BurnRecord, LevelReachedEvent, RecordResult } from '../core/ledger.ts';

export type BackfillState =
  | 'pending' // not started
  | 'running'
  | 'done_start_slot' // reached a signature older than the project's startSlot
  | 'done_exhausted'; // the node has no older signatures (true creation NOT proven)

export type IssueCode =
  | 'malformed'
  | 'incomplete_parse'
  | 'unsupported_version'
  | 'tx_unavailable'
  | 'burn_rejected'
  | 'history_inconsistent'
  | 'tail_gap_too_large';

export interface IndexIssue {
  readonly code: IssueCode;
  readonly signature?: string;
  readonly detail: string;
}

/** Only `verified` means the indexed total is proven to match the chain. Amounts are decimal strings. */
export type Verification =
  | { readonly status: 'unverified'; readonly reason: string }
  | { readonly status: 'verified'; readonly burnedRaw: string }
  | { readonly status: 'mismatch'; readonly expectedBurnedRaw: string; readonly indexedBurnedRaw: string };

export interface IndexState {
  /** Newest finalized signature such that everything older (down to the backfill range) is processed. */
  finalizedHead: string | null;
  finalizedHeadSlot: number | null;
  /** Backfill continues strictly older than this signature. */
  backfillBefore: string | null;
  backfill: BackfillState;
  issues: IndexIssue[];
  verification: Verification;
}

export const emptyState = (): IndexState => ({
  finalizedHead: null,
  finalizedHeadSlot: null,
  backfillBefore: null,
  backfill: 'pending',
  issues: [],
  verification: { status: 'unverified', reason: 'history not read yet' },
});

export interface Totals {
  readonly finalizedRaw: bigint;
  readonly confirmedRaw: bigint;
  readonly count: number;
}

export interface IndexerStore {
  loadState(projectId: string): Promise<IndexState>;
  saveState(projectId: string, state: IndexState): Promise<void>;
  recordBurn(projectId: string, burn: BurnInput): Promise<RecordResult>;
  /** Removes a burn that was only confirmed (its block was abandoned). Finalized burns are never removed. */
  dropConfirmed(projectId: string, key: string): Promise<boolean>;
  pendingConfirmed(projectId: string): Promise<BurnRecord[]>;
  totals(projectId: string): Promise<Totals>;
  pendingEvents(projectId: string): Promise<LevelReachedEvent[]>;
  ackEvent(projectId: string, levelId: string): Promise<void>;
}
