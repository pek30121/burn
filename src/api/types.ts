/* Read-side contract of the public API. PgStore implements it; tests use an in-memory twin.
 * Everything returned here is already durable and finalized. */

import type { IndexState, Totals } from '../indexer/store.ts';

/** A finalized burn as stored. */
export interface StoredBurn {
  readonly signature: string;
  readonly instructionPath: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly owner: string;
  readonly amountRaw: bigint;
  readonly finalizedAt: Date;
}

export interface StoredMutation {
  readonly levelId: string;
  readonly levelIndex: number;
  readonly totalRaw: bigint;
  readonly triggeredBy: string;
}

/** One entry of the per-project event log. `id` is the stable, strictly increasing sequence number. */
export type StoredEvent =
  | { readonly id: number; readonly type: 'burn'; readonly createdAt: Date; readonly burn: StoredBurn }
  | { readonly id: number; readonly type: 'mutation'; readonly createdAt: Date; readonly mutation: StoredMutation };

export interface StoredBurnRow {
  readonly id: number;
  readonly burn: StoredBurn;
}

export interface ReachedLevel {
  readonly levelId: string;
  readonly at: Date;
  readonly triggeredBy: string;
}

export interface ApiSource {
  /** Highest event id of the project (0 when none). */
  latestEventId(projectId: string): Promise<number>;
  /** Events with id > after, ascending, at most `limit`. */
  eventsAfter(projectId: string, after: number, limit: number): Promise<StoredEvent[]>;
  /** Finalized burns, newest first, with id < before (or from the newest when null). */
  burnsPage(projectId: string, before: number | null, limit: number): Promise<StoredBurnRow[]>;
  reachedLevels(projectId: string): Promise<ReachedLevel[]>;
  peekState(projectId: string): Promise<IndexState>;
  totals(projectId: string): Promise<Totals>;
  /** Throws when the database cannot be reached. */
  ping(): Promise<void>;
}
