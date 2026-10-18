/* Supervises ONE project: holds its single-writer lease, runs indexer syncs on a poll
 * interval, and backs off exponentially after failures (no tight loop on an outage).
 * It never throws out of run(): a failing project only slows itself down, so other
 * projects keep running. Sleeping goes through an injected sleep that rejects with
 * ShutdownError, which is how stop wakes every waiting runner immediately. */

import type { Indexer, IndexerStatus } from '../indexer/indexer.ts';
import type { Logger } from './logger.ts';
import { ShutdownError } from './limiter.ts';

export type RunnerState = 'starting' | 'syncing' | 'idle' | 'backoff' | 'waiting_lease' | 'stopped';

export interface RunnerStore {
  tryLockProject?(projectId: string): Promise<boolean>;
  releaseProject?(projectId: string): Promise<void>;
}

export interface RunnerOptions {
  readonly projectId: string;
  readonly indexer: Pick<Indexer, 'syncOnce' | 'status'>;
  readonly store: RunnerStore;
  readonly log: Logger;
  readonly pollIntervalMs: number;
  readonly backoff: { readonly baseMs: number; readonly maxMs: number };
  readonly leaseRetryMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => Date;
}

export interface RunnerSnapshot {
  state: RunnerState;
  consecutiveFailures: number;
  lastSyncAt: string | null;
  lastError: string | null;
  holdsLease: boolean;
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ProjectRunner {
  readonly #o: RunnerOptions;
  #state: RunnerState = 'starting';
  #failures = 0;
  #lastSyncAt: string | null = null;
  #lastError: string | null = null;
  #held = false;
  #seenIssues: Set<string> | null = null;

  constructor(o: RunnerOptions) {
    this.#o = o;
  }

  snapshot(): RunnerSnapshot {
    return { state: this.#state, consecutiveFailures: this.#failures, lastSyncAt: this.#lastSyncAt, lastError: this.#lastError, holdsLease: this.#held };
  }

  async run(signal: AbortSignal): Promise<void> {
    const { log, store, projectId } = this.#o;
    try {
      while (!signal.aborted) {
        try {
          if (!this.#held && store.tryLockProject) {
            if (!(await store.tryLockProject(projectId))) {
              if (this.#state !== 'waiting_lease') log.warn('lease_held_elsewhere', { retryInMs: this.#o.leaseRetryMs });
              this.#state = 'waiting_lease';
              await this.#wait(this.#o.leaseRetryMs);
              continue;
            }
            this.#held = true;
            log.info('lease_acquired');
          }
          this.#state = 'syncing';
          const res = await this.#o.indexer.syncOnce();
          if (signal.aborted) break;
          if (res.error) {
            await this.#fail(res.error);
            continue;
          }
          await this.#succeeded(res);
          if (res.moreWork) await new Promise<void>((r) => setImmediate(r)); // the shared limiter paces the requests
          else {
            this.#state = 'idle';
            await this.#wait(this.#o.pollIntervalMs);
          }
        } catch (e) {
          if (e instanceof ShutdownError || signal.aborted) break;
          await this.#fail(describe(e));
        }
      }
    } finally {
      if (this.#held && store.releaseProject) {
        await store.releaseProject(projectId).catch(() => {});
        this.#held = false;
      }
      this.#state = 'stopped';
      log.info('project_stopped');
    }
  }

  async #succeeded(res: Awaited<ReturnType<Indexer['syncOnce']>>): Promise<void> {
    const { log } = this.#o;
    if (this.#failures > 0) log.info('recovered', { afterFailures: this.#failures });
    this.#failures = 0;
    this.#lastError = null;
    this.#lastSyncAt = (this.#o.now ?? (() => new Date()))().toISOString();
    for (const w of res.warnings) log.warn('warning', { message: w });

    const changed = res.burnsRecorded + res.burnsPromoted + res.burnsDropped > 0;
    let status: IndexerStatus | null = null;
    try {
      status = await this.#o.indexer.status();
    } catch (e) {
      log.warn('status_unavailable', { error: describe(e) });
    }
    if (status) this.#logIncidents(status);
    if (changed) {
      log.info('burns_indexed', {
        recorded: res.burnsRecorded, finalized: res.burnsPromoted, dropped: res.burnsDropped,
        totalFinalizedRaw: status?.totals.finalizedRaw.toString(), totalCount: status?.totals.count, level: status?.progress.level.id,
      });
    }
  }

  #logIncidents(status: IndexerStatus): void {
    const key = (i: { code: string; signature?: string }) => `${i.code}:${i.signature ?? ''}`;
    if (this.#seenIssues === null) {
      this.#seenIssues = new Set(status.issues.map(key)); // known before this run: reported at project start
      return;
    }
    for (const i of status.issues) {
      if (this.#seenIssues.has(key(i))) continue;
      this.#seenIssues.add(key(i));
      this.#o.log.error('incident', { code: i.code, signature: i.signature, detail: i.detail });
    }
  }

  async #fail(error: string): Promise<void> {
    const { baseMs, maxMs } = this.#o.backoff;
    this.#failures++;
    this.#lastError = error;
    this.#state = 'backoff';
    const delay = Math.round(Math.min(maxMs, baseMs * 2 ** (this.#failures - 1)) * (0.5 + (this.#o.random ?? Math.random)() / 2));
    this.#o.log.warn('sync_failed', { error, consecutiveFailures: this.#failures, retryInMs: delay });
    await this.#wait(delay);
  }

  async #wait(ms: number): Promise<void> {
    try {
      await this.#o.sleep(ms);
    } catch (e) {
      if (!(e instanceof ShutdownError)) throw e; // stop: the loop condition ends the run
    }
  }
}
