/* Consumption watch against the provider's monthly credit quota (e.g. 10 000 000 on the user's Helius plan).
 *
 * HONEST SCOPE: the input is the local RpcMeter ESTIMATE since this process started — not the provider's billing, and it
 * restarts from zero with the process. Two signals:
 *  - projection: credits/elapsed extrapolated to 30 days (needs `minElapsedMs` of data to mean anything);
 *  - consumed: share of the quota used since start.
 * Alerts are emitted on LEVEL CHANGES only (ok -> warn -> critical), never every check. Always confirm with the provider
 * dashboard; the meter cannot see other consumers of the same key. */

import type { Logger } from './logger.ts';
import type { RpcMeter } from './meter.ts';

export type QuotaLevel = 'ok' | 'warn' | 'critical';
const MONTH_MS = 30 * 24 * 3_600_000;

export interface QuotaSnapshot {
  readonly monthlyCredits: number;
  readonly estimatedCreditsSinceStart: number;
  readonly consumedShare: number;
  readonly projectedMonthlyCredits: number | null;
  readonly projectedShare: number | null;
  readonly level: QuotaLevel;
  readonly note: string;
}

export interface QuotaOptions {
  readonly monthlyCredits: number;
  /** Shares of the quota that trigger `warn` and `critical` (defaults 0.8 and 1.0). */
  readonly warnAt?: number;
  readonly criticalAt?: number;
  readonly minElapsedMs?: number;
  readonly meter: Pick<RpcMeter, 'snapshot'>;
  readonly log: Logger;
  readonly now?: () => number;
}

export class QuotaMonitor {
  readonly #o: QuotaOptions;
  readonly #startedAt: number;
  #level: QuotaLevel = 'ok';

  constructor(o: QuotaOptions) {
    if (!(o.monthlyCredits > 0)) throw new RangeError('monthlyCredits must be > 0');
    this.#o = o;
    this.#startedAt = (o.now ?? Date.now)();
  }

  snapshot(): QuotaSnapshot {
    const { monthlyCredits: quota, meter } = this.#o;
    const used = meter.snapshot().total.estimatedCredits;
    const elapsed = (this.#o.now ?? Date.now)() - this.#startedAt;
    const projected = elapsed >= (this.#o.minElapsedMs ?? 600_000) ? (used / elapsed) * MONTH_MS : null;
    const consumedShare = used / quota;
    const projectedShare = projected === null ? null : projected / quota;
    const warn = this.#o.warnAt ?? 0.8;
    const crit = this.#o.criticalAt ?? 1;
    const worst = Math.max(consumedShare, projectedShare ?? 0);
    return {
      monthlyCredits: quota, estimatedCreditsSinceStart: used, consumedShare, projectedMonthlyCredits: projected === null ? null : Math.round(projected), projectedShare,
      level: worst >= crit ? 'critical' : worst >= warn ? 'warn' : 'ok',
      note: 'Local estimate since process start; NOT the provider billing. Check the provider dashboard.',
    };
  }

  /** Evaluates and logs only when the level changed. Returns the snapshot. */
  check(): QuotaSnapshot {
    const s = this.snapshot();
    if (s.level !== this.#level) {
      const fields = {
        level: s.level, quotaCredits: s.monthlyCredits, estimatedCreditsSinceStart: s.estimatedCreditsSinceStart, consumedPercent: Math.round(s.consumedShare * 1000) / 10,
        projectedMonthlyCredits: s.projectedMonthlyCredits, projectedPercent: s.projectedShare === null ? null : Math.round(s.projectedShare * 1000) / 10,
        hint: 'reduce POLL_INTERVAL_MS / the number of projects, enable RPC_BATCH_FETCH, or raise the plan',
      };
      if (s.level === 'critical') this.#o.log.error('rpc_quota', fields);
      else if (s.level === 'warn') this.#o.log.warn('rpc_quota', fields);
      else this.#o.log.info('rpc_quota_recovered', fields);
      this.#level = s.level;
    }
    return s;
  }
}
