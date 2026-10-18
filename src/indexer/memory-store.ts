import { BurnLedger, type BurnInput, type BurnRecord, type LevelReachedEvent, type RecordResult } from '../core/ledger.ts';
import type { ProjectConfig } from '../config/schema.ts';
import { emptyState, type IndexState, type IndexerStore, type Totals } from './store.ts';

/** Reference store: one BurnLedger per project. Tests use it to simulate restarts by reusing the instance. */
export class MemoryStore implements IndexerStore {
  readonly #ledgers = new Map<string, BurnLedger>();
  readonly #states = new Map<string, IndexState>();
  readonly #outbox = new Map<string, LevelReachedEvent[]>();

  constructor(projects: readonly ProjectConfig[]) {
    for (const p of projects) {
      this.#ledgers.set(p.id, new BurnLedger(p));
      this.#states.set(p.id, emptyState());
      this.#outbox.set(p.id, []);
    }
  }

  #ledger(projectId: string): BurnLedger {
    const l = this.#ledgers.get(projectId);
    if (!l) throw new Error(`unknown project "${projectId}"`);
    return l;
  }

  async loadState(projectId: string): Promise<IndexState> {
    this.#ledger(projectId);
    return structuredClone(this.#states.get(projectId)!);
  }

  async saveState(projectId: string, state: IndexState): Promise<void> {
    this.#ledger(projectId);
    this.#states.set(projectId, structuredClone(state));
  }

  async recordBurn(projectId: string, burn: BurnInput): Promise<RecordResult> {
    const r = this.#ledger(projectId).record(burn);
    if (r.status !== 'rejected') this.#outbox.get(projectId)!.push(...r.events);
    return r;
  }

  async dropConfirmed(projectId: string, key: string): Promise<boolean> {
    return this.#ledger(projectId).drop(key);
  }

  async pendingConfirmed(projectId: string): Promise<BurnRecord[]> {
    return this.#ledger(projectId).history().filter((b) => b.commitment === 'confirmed');
  }

  async totals(projectId: string): Promise<Totals> {
    const l = this.#ledger(projectId);
    return { finalizedRaw: l.finalizedRaw, confirmedRaw: l.confirmedRaw, count: l.count };
  }

  async pendingEvents(projectId: string): Promise<LevelReachedEvent[]> {
    this.#ledger(projectId);
    return [...this.#outbox.get(projectId)!];
  }

  async ackEvent(projectId: string, levelId: string): Promise<void> {
    this.#ledger(projectId);
    const box = this.#outbox.get(projectId)!;
    this.#outbox.set(projectId, box.filter((e) => e.level.id !== levelId));
  }
}
