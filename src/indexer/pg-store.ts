/* PostgreSQL implementation of IndexerStore (same contract and behaviour as MemoryStore).
 *
 * Atomicity: recordBurn / dropConfirmed run in ONE transaction that touches the burn
 * row, the project counters, the level-reached rows (= outbox) together; a failure rolls
 * all of it back. Writers of one project are serialised by a row lock on its counters.
 * Idempotency: the primary key (project_id, signature, instruction_path).
 * Cursor: saveState is a separate call made AFTER the burns it covers (the indexer's
 * existing rule), so a cut between the two is repaired by replay, which is a no-op.
 * It uses an optimistic version so a stale writer fails instead of moving a cursor wrongly.
 *
 * Validation rules are NOT re-implemented: a scratch BurnLedger judges each input. */

import type { Pool, PoolClient } from 'pg';
import { BurnLedger, type BurnInput, type BurnRecord, type Commitment, type LevelReachedEvent, type RecordResult } from '../core/ledger.ts';
import { crossedLevels } from '../core/progression.ts';
import type { Level, ProjectConfig } from '../config/schema.ts';
import type { ApiSource, ReachedLevel, StoredBurnRow, StoredEvent } from '../api/types.ts';
import { ConfigMismatchError, StaleStateError, StoreError, toStoreError } from '../db/errors.ts';
import { emptyState, type IndexIssue, type IndexState, type IndexerStore, type Totals, type Verification } from './store.ts';

type Q = Pick<PoolClient, 'query'>;
const big = (v: unknown): bigint => BigInt(v as string);
const num = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new StoreError('value out of safe integer range');
  return n;
};

export class PgStore implements IndexerStore, ApiSource {
  readonly #pool: Pool;
  readonly #projects = new Map<string, ProjectConfig>();
  readonly #versions = new Map<string, number>();
  readonly #locks = new Map<string, PoolClient>();

  constructor(pool: Pool, projects: readonly ProjectConfig[]) {
    this.#pool = pool;
    for (const p of projects) this.#projects.set(p.id, p);
  }

  /** Creates the store and registers the configured projects (idempotent). Migrations must have run. */
  static async create(pool: Pool, projects: readonly ProjectConfig[]): Promise<PgStore> {
    const store = new PgStore(pool, projects);
    for (const p of projects) await store.#syncProject(p);
    return store;
  }

  /* ------------------------- project registration ------------------------- */

  async #syncProject(p: ProjectConfig): Promise<void> {
    await this.#tx(async (c) => {
      await c.query(
        `INSERT INTO projects (id, name, ticker, cluster, mint, decimals, token_program, initial_supply_raw, start_slot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name, p.ticker, p.cluster, p.mint, p.decimals, p.tokenProgram, p.initialSupplyRaw?.toString() ?? null, p.startSlot],
      );
      const row = (await c.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [p.id])).rows[0];
      const mismatched = (
        [
          ['cluster', row.cluster !== p.cluster],
          ['mint', row.mint !== p.mint],
          ['decimals', row.decimals !== p.decimals],
          ['tokenProgram', row.token_program !== p.tokenProgram],
          ['startSlot', num(row.start_slot) !== p.startSlot],
        ] as const
      ).filter(([, bad]) => bad).map(([k]) => k);
      if (mismatched.length) {
        throw new ConfigMismatchError(`project "${p.id}" already exists with different immutable settings: ${mismatched.join(', ')}`);
      }
      await c.query('UPDATE projects SET name=$2, ticker=$3, initial_supply_raw=$4, updated_at=now() WHERE id=$1', [p.id, p.name, p.ticker, p.initialSupplyRaw?.toString() ?? null]);

      // Levels: snapshot of the config. A level that already fired an event cannot be removed (FK).
      await c.query('DELETE FROM levels WHERE project_id = $1 AND level_id <> ALL($2::text[])', [p.id, p.levels.map((l) => l.id)]);
      // Positions are unique per project: park them out of the way before re-assigning.
      await c.query('UPDATE levels SET position = position + 1000000 WHERE project_id = $1', [p.id]);
      for (const [i, l] of p.levels.entries()) {
        await c.query(
          `INSERT INTO levels (project_id, position, level_id, name, threshold_raw) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (project_id, level_id) DO UPDATE SET position = EXCLUDED.position, name = EXCLUDED.name, threshold_raw = EXCLUDED.threshold_raw`,
          [p.id, i, l.id, l.name, l.thresholdRaw.toString()],
        );
      }
      await c.query('INSERT INTO project_counters (project_id) VALUES ($1) ON CONFLICT DO NOTHING', [p.id]);
      const s = emptyState();
      await c.query(
        'INSERT INTO index_state (project_id, backfill, verification) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',
        [p.id, s.backfill, JSON.stringify(s.verification)],
      );
    });
  }

  /* ------------------------------ burns ----------------------------------- */

  async recordBurn(projectId: string, burn: BurnInput): Promise<RecordResult> {
    const p = this.#project(projectId);
    const scratch = new BurnLedger(p).record(burn); // same validation rules as the reference ledger
    if (scratch.status === 'rejected') return scratch;
    const key = `${burn.signature}#${burn.instructionPath}`;

    return this.#tx(async (c): Promise<RecordResult> => {
      const cnt = (await c.query('SELECT finalized_raw, confirmed_only_raw, event_seq FROM project_counters WHERE project_id = $1 FOR UPDATE', [projectId])).rows[0];
      const finalized0 = big(cnt.finalized_raw);
      const seq0 = num(cnt.event_seq);
      const confirmedOnly0 = big(cnt.confirmed_only_raw);

      const ex = (await c.query(
        'SELECT slot, block_time, owner, amount_raw, commitment FROM burns WHERE project_id=$1 AND signature=$2 AND instruction_path=$3',
        [projectId, burn.signature, burn.instructionPath],
      )).rows[0];

      if (ex) {
        const existing: BurnRecord = {
          ...burn, projectId, key, slot: num(ex.slot), blockTime: ex.block_time === null ? null : num(ex.block_time),
          owner: ex.owner, amountRaw: big(ex.amount_raw), commitment: ex.commitment as Commitment,
        };
        if (existing.amountRaw !== burn.amountRaw || existing.owner !== burn.owner || existing.slot !== burn.slot) {
          return { status: 'rejected', reason: 'conflicts with an already recorded burn' };
        }
        if (existing.commitment === 'confirmed' && burn.commitment === 'finalized') {
          await c.query(
            "UPDATE burns SET commitment='finalized', finalized_at=now() WHERE project_id=$1 AND signature=$2 AND instruction_path=$3",
            [projectId, burn.signature, burn.instructionPath],
          );
          const finalized1 = finalized0 + burn.amountRaw;
          const { events, seq } = await this.#finalizedEvents(c, p, seq0, finalized0, finalized1, burn, key);
          await c.query('UPDATE project_counters SET finalized_raw=$2, confirmed_only_raw=$3, event_seq=$4, updated_at=now() WHERE project_id=$1', [projectId, finalized1.toString(), (confirmedOnly0 - burn.amountRaw).toString(), seq]);
          return { status: 'promoted', record: { ...existing, commitment: 'finalized' }, events };
        }
        return { status: 'duplicate', record: existing, events: [] };
      }

      await c.query(
        `INSERT INTO burns (project_id, signature, instruction_path, slot, block_time, owner, amount_raw, commitment, finalized_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $8 = 'finalized' THEN now() END)`,
        [projectId, burn.signature, burn.instructionPath, burn.slot, burn.blockTime, burn.owner, burn.amountRaw.toString(), burn.commitment],
      );
      const record: BurnRecord = { ...burn, projectId, key };
      if (burn.commitment === 'finalized') {
        const finalized1 = finalized0 + burn.amountRaw;
        const { events, seq } = await this.#finalizedEvents(c, p, seq0, finalized0, finalized1, burn, key);
        await c.query('UPDATE project_counters SET finalized_raw=$2, burn_count=burn_count+1, event_seq=$3, updated_at=now() WHERE project_id=$1', [projectId, finalized1.toString(), seq]);
        return { status: 'inserted', record, events };
      }
      await c.query('UPDATE project_counters SET confirmed_only_raw=$2, burn_count=burn_count+1, updated_at=now() WHERE project_id=$1', [projectId, (confirmedOnly0 + burn.amountRaw).toString()]);
      return { status: 'inserted', record, events: [] };
    });
  }

  /**
   * A burn just became finalized: append its event, then the level events it caused, to the
   * durable log. Ids are allocated under the counters row lock held by the caller, which is what
   * makes commit order equal id order.
   */
  async #finalizedEvents(c: Q, p: ProjectConfig, seq0: number, prev: bigint, next: bigint, burn: BurnInput, key: string): Promise<{ events: LevelReachedEvent[]; seq: number }> {
    let seq = seq0 + 1;
    await c.query(
      "INSERT INTO project_events (project_id, seq, kind, signature, instruction_path) VALUES ($1,$2,'burn',$3,$4)",
      [p.id, seq, burn.signature, burn.instructionPath],
    );
    const events = await this.#levelEvents(c, p, prev, next, key);
    for (const e of events) {
      await c.query("INSERT INTO project_events (project_id, seq, kind, level_id) VALUES ($1,$2,'mutation',$3)", [p.id, ++seq, e.level.id]);
    }
    return { events, seq };
  }

  /** Level-reached rows double as the outbox; the primary key makes each level fire at most once. */
  async #levelEvents(c: Q, p: ProjectConfig, prev: bigint, next: bigint, triggeredBy: string): Promise<LevelReachedEvent[]> {
    const events: LevelReachedEvent[] = [];
    for (const level of crossedLevels(p.levels, prev, next)) {
      const levelIndex = p.levels.indexOf(level);
      const ins = await c.query(
        `INSERT INTO level_events (project_id, level_id, level_index, total_raw, triggered_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (project_id, level_id) DO NOTHING RETURNING level_id`,
        [p.id, level.id, levelIndex, next.toString(), triggeredBy],
      );
      if (ins.rowCount) events.push({ type: 'level_reached', projectId: p.id, level, levelIndex, totalRaw: next, triggeredBy });
    }
    return events;
  }

  async dropConfirmed(projectId: string, key: string): Promise<boolean> {
    this.#project(projectId);
    const i = key.lastIndexOf('#');
    if (i < 1) return false;
    const signature = key.slice(0, i);
    const path = key.slice(i + 1);
    return this.#tx(async (c) => {
      const cnt = (await c.query('SELECT confirmed_only_raw FROM project_counters WHERE project_id = $1 FOR UPDATE', [projectId])).rows[0];
      const del = await c.query(
        "DELETE FROM burns WHERE project_id=$1 AND signature=$2 AND instruction_path=$3 AND commitment='confirmed' RETURNING amount_raw",
        [projectId, signature, path],
      );
      if (!del.rowCount) return false;
      await c.query('UPDATE project_counters SET confirmed_only_raw=$2, burn_count=burn_count-1, updated_at=now() WHERE project_id=$1', [projectId, (big(cnt.confirmed_only_raw) - big(del.rows[0].amount_raw)).toString()]);
      return true;
    });
  }

  async pendingConfirmed(projectId: string): Promise<BurnRecord[]> {
    const p = this.#project(projectId);
    const rows = (await this.#query(
      `SELECT signature, instruction_path, slot, block_time, owner, amount_raw FROM burns
       WHERE project_id=$1 AND commitment='confirmed'
       ORDER BY slot DESC, (signature || '#' || instruction_path) COLLATE "C"`,
      [projectId],
    )).rows;
    return rows.map((r) => ({
      mint: p.mint, signature: r.signature, instructionPath: r.instruction_path, slot: num(r.slot),
      blockTime: r.block_time === null ? null : num(r.block_time), owner: r.owner, amountRaw: big(r.amount_raw),
      commitment: 'confirmed' as Commitment, projectId, key: `${r.signature}#${r.instruction_path}`,
    }));
  }

  async totals(projectId: string): Promise<Totals> {
    this.#project(projectId);
    const r = (await this.#query('SELECT finalized_raw, confirmed_only_raw, burn_count FROM project_counters WHERE project_id = $1', [projectId])).rows[0];
    return { finalizedRaw: big(r.finalized_raw), confirmedRaw: big(r.finalized_raw) + big(r.confirmed_only_raw), count: num(r.burn_count) };
  }

  /* ------------------------------ outbox ---------------------------------- */

  async pendingEvents(projectId: string): Promise<LevelReachedEvent[]> {
    const p = this.#project(projectId);
    const rows = (await this.#query(
      'SELECT level_id, level_index, total_raw, triggered_by FROM level_events WHERE project_id=$1 AND delivered_at IS NULL ORDER BY seq',
      [projectId],
    )).rows;
    return rows.map((r) => {
      const level: Level | undefined = p.levels.find((l) => l.id === r.level_id);
      if (!level) throw new StoreError(`stored event refers to unknown level "${r.level_id}"`);
      return { type: 'level_reached' as const, projectId, level, levelIndex: num(r.level_index), totalRaw: big(r.total_raw), triggeredBy: r.triggered_by };
    });
  }

  async ackEvent(projectId: string, levelId: string): Promise<void> {
    this.#project(projectId);
    await this.#query('UPDATE level_events SET delivered_at = now() WHERE project_id=$1 AND level_id=$2 AND delivered_at IS NULL', [projectId, levelId]);
  }

  /* ------------------------------ cursor ---------------------------------- */

  async loadState(projectId: string): Promise<IndexState> {
    const { state, version } = await this.#readState(projectId);
    // Never move the known version backwards: a read that raced with our own save may be older.
    this.#versions.set(projectId, Math.max(this.#versions.get(projectId) ?? 0, version));
    return state;
  }

  /** Read-only view of the index state for the public API: does not touch the writer's version tracking. */
  async peekState(projectId: string): Promise<IndexState> {
    return (await this.#readState(projectId)).state;
  }

  async #readState(projectId: string): Promise<{ state: IndexState; version: number }> {
    this.#project(projectId);
    const [st, issues] = await Promise.all([
      this.#query('SELECT * FROM index_state WHERE project_id = $1', [projectId]),
      this.#query('SELECT code, signature, detail FROM index_issues WHERE project_id = $1 ORDER BY seq', [projectId]),
    ]);
    const r = st.rows[0];
    if (!r) throw new StoreError(`no index state for project "${projectId}" (was the store created with it?)`);
    return {
      version: num(r.version),
      state: {
        finalizedHead: r.finalized_head,
        finalizedHeadSlot: r.finalized_head_slot === null ? null : num(r.finalized_head_slot),
        backfillBefore: r.backfill_before,
        backfill: r.backfill,
        issues: issues.rows.map((i): IndexIssue => ({ code: i.code, detail: i.detail, ...(i.signature ? { signature: i.signature } : {}) })),
        verification: r.verification as Verification,
      },
    };
  }

  async saveState(projectId: string, state: IndexState): Promise<void> {
    this.#project(projectId);
    const version = this.#versions.get(projectId);
    if (version === undefined) throw new StoreError('saveState called before loadState');
    await this.#tx(async (c) => {
      const up = await c.query(
        `UPDATE index_state SET finalized_head=$2, finalized_head_slot=$3, backfill_before=$4, backfill=$5,
           verification=$6::jsonb, version=version+1, updated_at=now()
         WHERE project_id=$1 AND version=$7 RETURNING version`,
        [projectId, state.finalizedHead, state.finalizedHeadSlot, state.backfillBefore, state.backfill, JSON.stringify(state.verification), version],
      );
      if (!up.rowCount) throw new StaleStateError(`index state of "${projectId}" was changed by another writer; reload and retry`);
      const codes = state.issues.map((i) => i.code);
      const sigs = state.issues.map((i) => i.signature ?? '');
      await c.query(
        'DELETE FROM index_issues WHERE project_id=$1 AND (code, signature) NOT IN (SELECT * FROM unnest($2::text[], $3::text[]))',
        [projectId, codes, sigs],
      );
      if (codes.length) {
        await c.query(
          `INSERT INTO index_issues (project_id, code, signature, detail)
           SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[]) ON CONFLICT (project_id, code, signature) DO NOTHING`,
          [projectId, codes, sigs, state.issues.map((i) => i.detail)],
        );
      }
      this.#versions.set(projectId, num(up.rows[0].version));
    });
  }

  /* ---------------------- read side (public API / SSE) ---------------------- */

  async ping(): Promise<void> {
    await this.#query('SELECT 1', []);
  }

  async latestEventId(projectId: string): Promise<number> {
    this.#project(projectId);
    const r = await this.#query('SELECT event_seq FROM project_counters WHERE project_id = $1', [projectId]);
    return r.rows[0] ? num(r.rows[0].event_seq) : 0;
  }

  async eventsAfter(projectId: string, after: number, limit: number): Promise<StoredEvent[]> {
    this.#project(projectId);
    const rows = (await this.#query(
      `SELECT e.seq, e.kind, e.created_at,
              b.signature, b.instruction_path, b.slot, b.block_time, b.owner, b.amount_raw, b.finalized_at,
              l.level_id, l.level_index, l.total_raw, l.triggered_by
       FROM project_events e
       LEFT JOIN burns b ON e.kind = 'burn' AND b.project_id = e.project_id AND b.signature = e.signature AND b.instruction_path = e.instruction_path
       LEFT JOIN level_events l ON e.kind = 'mutation' AND l.project_id = e.project_id AND l.level_id = e.level_id
       WHERE e.project_id = $1 AND e.seq > $2 ORDER BY e.seq LIMIT $3`,
      [projectId, after, limit],
    )).rows;
    return rows.map((r): StoredEvent => {
      const id = num(r.seq);
      if (r.kind === 'burn') return { id, type: 'burn', createdAt: r.created_at, burn: this.#burnOf(r) };
      return { id, type: 'mutation', createdAt: r.created_at, mutation: { levelId: r.level_id, levelIndex: num(r.level_index), totalRaw: big(r.total_raw), triggeredBy: r.triggered_by } };
    });
  }

  async burnsPage(projectId: string, before: number | null, limit: number): Promise<StoredBurnRow[]> {
    this.#project(projectId);
    const rows = (await this.#query(
      `SELECT e.seq, b.signature, b.instruction_path, b.slot, b.block_time, b.owner, b.amount_raw, b.finalized_at
       FROM project_events e
       JOIN burns b ON b.project_id = e.project_id AND b.signature = e.signature AND b.instruction_path = e.instruction_path
       WHERE e.project_id = $1 AND e.kind = 'burn' AND ($2::bigint IS NULL OR e.seq < $2)
       ORDER BY e.seq DESC LIMIT $3`,
      [projectId, before, limit],
    )).rows;
    return rows.map((r) => ({ id: num(r.seq), burn: this.#burnOf(r) }));
  }

  async reachedLevels(projectId: string): Promise<ReachedLevel[]> {
    this.#project(projectId);
    const rows = (await this.#query('SELECT level_id, created_at, triggered_by FROM level_events WHERE project_id = $1 ORDER BY seq', [projectId])).rows;
    return rows.map((r) => ({ levelId: r.level_id, at: r.created_at, triggeredBy: r.triggered_by }));
  }

  #burnOf(r: any): StoredBurnRow['burn'] {
    return {
      signature: r.signature, instructionPath: r.instruction_path, slot: num(r.slot), blockTime: r.block_time === null ? null : num(r.block_time),
      owner: r.owner, amountRaw: big(r.amount_raw), finalizedAt: r.finalized_at,
    };
  }

  /* --------------------- single-writer lease per project ------------------- */

  /** Session-level advisory lock: only one process should index a project at a time. Held until released or the connection dies. */
  async tryLockProject(projectId: string): Promise<boolean> {
    this.#project(projectId);
    if (this.#locks.has(projectId)) return true;
    const c = await this.#connect();
    try {
      const r = await c.query("SELECT pg_try_advisory_lock(hashtext(current_schema() || ':project'), hashtext($1)) AS ok", [projectId]);
      if (r.rows[0].ok) {
        this.#locks.set(projectId, c);
        return true;
      }
    } catch (e) {
      c.release(true);
      throw toStoreError(e);
    }
    c.release();
    return false;
  }

  async releaseProject(projectId: string): Promise<void> {
    const c = this.#locks.get(projectId);
    if (!c) return;
    this.#locks.delete(projectId);
    try {
      await c.query("SELECT pg_advisory_unlock(hashtext(current_schema() || ':project'), hashtext($1))", [projectId]);
      c.release();
    } catch {
      c.release(true); // drop the connection: closing the session frees the lock anyway
    }
  }

  /** Releases every lease. The pool itself belongs to the caller. */
  async close(): Promise<void> {
    for (const id of [...this.#locks.keys()]) await this.releaseProject(id);
  }

  /* ------------------------------ plumbing -------------------------------- */

  #project(id: string): ProjectConfig {
    const p = this.#projects.get(id);
    if (!p) throw new Error(`unknown project "${id}"`);
    return p;
  }

  async #connect(): Promise<PoolClient> {
    try {
      return await this.#pool.connect();
    } catch (e) {
      throw toStoreError(e);
    }
  }

  async #query(text: string, params: unknown[]) {
    try {
      return await this.#pool.query(text, params);
    } catch (e) {
      throw toStoreError(e);
    }
  }

  async #tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.#connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw toStoreError(e);
    } finally {
      c.release();
    }
  }
}
