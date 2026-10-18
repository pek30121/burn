/* In-memory burn ledger for ONE project. It is the reference model for the
 * PostgreSQL store (same keys, same rules) and is what the tests pin down:
 *  - a burn is identified by (signature, instruction path): replays are no-ops;
 *  - burns of another mint or before startSlot are rejected;
 *  - confirmed burns may be dropped (fork) or promoted to finalized;
 *  - level events fire only from the FINALIZED total, exactly once per level. */

import { assertRaw } from './amount.ts';
import { isPublicKey, isSignature } from './base58.ts';
import { crossedLevels, computeProgress, type Progress } from './progression.ts';
import type { Level, ProjectConfig } from '../config/schema.ts';

export type Commitment = 'confirmed' | 'finalized';

export interface BurnInput {
  readonly mint: string;
  readonly signature: string;
  /** Outer instruction index, plus inner index for CPI burns: "3" or "3.1". */
  readonly instructionPath: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly owner: string;
  readonly amountRaw: bigint;
  readonly commitment: Commitment;
}

export interface BurnRecord extends BurnInput {
  readonly projectId: string;
  readonly key: string;
}

export interface LevelReachedEvent {
  readonly type: 'level_reached';
  readonly projectId: string;
  readonly level: Level;
  readonly levelIndex: number;
  readonly totalRaw: bigint;
  /** The finalized burn that pushed the total over the threshold. */
  readonly triggeredBy: string;
}

export type RecordResult =
  | { status: 'inserted' | 'promoted' | 'duplicate'; record: BurnRecord; events: LevelReachedEvent[] }
  | { status: 'rejected'; reason: string };

const PATH = /^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2}))?$/;

export const burnKey = (signature: string, instructionPath: string) => `${signature}#${instructionPath}`;

export class BurnLedger {
  readonly #burns = new Map<string, BurnRecord>();
  readonly #reached = new Set<string>();
  #finalizedRaw = 0n;
  #confirmedOnlyRaw = 0n;

  readonly project: ProjectConfig;

  constructor(project: ProjectConfig) {
    this.project = project;
    // The base level (threshold 0) is reached by definition.
    this.#reached.add(project.levels[0]!.id);
  }

  record(input: BurnInput): RecordResult {
    const p = this.project;
    if (input.mint !== p.mint) return { status: 'rejected', reason: 'mint does not belong to this project' };
    if (!isSignature(input.signature)) return { status: 'rejected', reason: 'invalid signature' };
    if (!PATH.test(input.instructionPath)) return { status: 'rejected', reason: 'invalid instruction path' };
    if (!isPublicKey(input.owner)) return { status: 'rejected', reason: 'invalid owner' };
    if (!Number.isSafeInteger(input.slot) || input.slot < 0) return { status: 'rejected', reason: 'invalid slot' };
    if (input.slot < p.startSlot) return { status: 'rejected', reason: 'before project start slot' };
    try {
      assertRaw(input.amountRaw);
    } catch {
      return { status: 'rejected', reason: 'amount out of u64 range' };
    }
    if (input.amountRaw === 0n) return { status: 'rejected', reason: 'zero amount' };

    const key = burnKey(input.signature, input.instructionPath);
    const existing = this.#burns.get(key);
    if (existing) {
      if (existing.amountRaw !== input.amountRaw || existing.owner !== input.owner || existing.slot !== input.slot) {
        // The chain does not change a landed instruction; a mismatch means a parser bug or bad source.
        return { status: 'rejected', reason: 'conflicts with an already recorded burn' };
      }
      if (existing.commitment === 'confirmed' && input.commitment === 'finalized') {
        const promoted: BurnRecord = { ...existing, commitment: 'finalized' };
        this.#burns.set(key, promoted);
        this.#confirmedOnlyRaw -= existing.amountRaw;
        return { status: 'promoted', record: promoted, events: this.#addFinalized(promoted) };
      }
      return { status: 'duplicate', record: existing, events: [] };
    }

    const record: BurnRecord = { ...input, projectId: p.id, key };
    this.#burns.set(key, record);
    if (record.commitment === 'finalized') return { status: 'inserted', record, events: this.#addFinalized(record) };
    this.#confirmedOnlyRaw += record.amountRaw;
    return { status: 'inserted', record, events: [] };
  }

  /** A confirmed-only burn whose block was abandoned. Finalized burns can never be dropped. */
  drop(key: string): boolean {
    const r = this.#burns.get(key);
    if (!r || r.commitment !== 'confirmed') return false;
    this.#burns.delete(key);
    this.#confirmedOnlyRaw -= r.amountRaw;
    return true;
  }

  #addFinalized(r: BurnRecord): LevelReachedEvent[] {
    const prev = this.#finalizedRaw;
    this.#finalizedRaw += r.amountRaw;
    const events: LevelReachedEvent[] = [];
    for (const level of crossedLevels(this.project.levels, prev, this.#finalizedRaw)) {
      if (this.#reached.has(level.id)) continue;
      this.#reached.add(level.id);
      events.push({
        type: 'level_reached',
        projectId: this.project.id,
        level,
        levelIndex: this.project.levels.indexOf(level),
        totalRaw: this.#finalizedRaw,
        triggeredBy: r.key,
      });
    }
    return events;
  }

  get finalizedRaw(): bigint {
    return this.#finalizedRaw;
  }

  /** Finalized + confirmed-not-yet-finalized: the optimistic figure for live display. */
  get confirmedRaw(): bigint {
    return this.#finalizedRaw + this.#confirmedOnlyRaw;
  }

  get count(): number {
    return this.#burns.size;
  }

  progress(commitment: Commitment = 'finalized'): Progress {
    return computeProgress(this.project.levels, commitment === 'finalized' ? this.finalizedRaw : this.confirmedRaw);
  }

  history(): BurnRecord[] {
    return [...this.#burns.values()].sort((a, b) => b.slot - a.slot || (a.key < b.key ? -1 : 1));
  }
}
