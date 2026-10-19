/* Public JSON shapes. Rules: every token amount is a decimal STRING (raw base units, plus a
 * human-readable decimal string); event ids are strings; nothing internal (RPC, SQL, error
 * texts, signatures of incidents) is ever included. */

import { formatUiAmount } from '../core/amount.ts';
import { computeProgress } from '../core/progression.ts';
import type { Level, ProjectConfig } from '../config/schema.ts';
import type { IndexState } from '../indexer/store.ts';
import type { RunnerSnapshot } from '../engine/runner.ts';
import type { ReachedLevel, StoredBurn, StoredEvent } from './types.ts';

const amounts = (raw: bigint, decimals: number) => ({ raw: raw.toString(), ui: formatUiAmount(raw, decimals) });

export function publicLevel(p: ProjectConfig, l: Level, index: number) {
  return { id: l.id, name: l.name, index, thresholdRaw: l.thresholdRaw.toString(), threshold: formatUiAmount(l.thresholdRaw, p.decimals) };
}

export function publicProject(p: ProjectConfig) {
  const base = `/api/v1/projects/${p.id}`;
  return {
    id: p.id, name: p.name, ticker: p.ticker, cluster: p.cluster, mint: p.mint, decimals: p.decimals, tokenProgram: p.tokenProgram,
    levels: p.levels.map((l, i) => publicLevel(p, l, i)),
    links: { status: `${base}/status`, burns: `${base}/burns`, progression: `${base}/progression`, events: `${base}/events`, stream: `${base}/stream` },
  };
}

/** A project still waiting for its token (or blocked): only the stable lifecycle and public code, nothing internal. */
export interface PublicPending { id: string; name: string; ticker: string; cluster: string; mint: string; lifecycle: string; code: string | null }

export function publicBurn(p: ProjectConfig, b: StoredBurn) {
  return {
    signature: b.signature, instructionPath: b.instructionPath, slot: b.slot, blockTime: b.blockTime, owner: b.owner,
    amountRaw: b.amountRaw.toString(), amount: formatUiAmount(b.amountRaw, p.decimals), finalizedAt: b.finalizedAt.toISOString(),
  };
}

export function publicEvent(p: ProjectConfig, e: StoredEvent) {
  const base = { id: String(e.id), projectId: p.id, createdAt: e.createdAt.toISOString() };
  if (e.type === 'burn') return { ...base, type: 'burn' as const, burn: publicBurn(p, e.burn) };
  const level = p.levels.find((l) => l.id === e.mutation.levelId);
  return {
    ...base, type: 'mutation' as const,
    mutation: {
      levelId: e.mutation.levelId, levelName: level?.name ?? e.mutation.levelId, levelIndex: e.mutation.levelIndex,
      totalRaw: e.mutation.totalRaw.toString(), total: formatUiAmount(e.mutation.totalRaw, p.decimals), triggeredBy: e.mutation.triggeredBy,
    },
  };
}
export type PublicEvent = ReturnType<typeof publicEvent>;

export function publicProgression(p: ProjectConfig, totalRaw: bigint, reached: readonly ReachedLevel[]) {
  const pr = computeProgress(p.levels, totalRaw);
  const at = new Map(reached.map((r) => [r.levelId, r]));
  const lvl = (l: Level) => publicLevel(p, l, p.levels.indexOf(l));
  return {
    total: { raw: totalRaw.toString(), ui: formatUiAmount(totalRaw, p.decimals) },
    level: lvl(pr.level),
    nextLevel: pr.nextLevel ? lvl(pr.nextLevel) : null,
    remaining: amounts(pr.remainingRaw, p.decimals),
    levelProgressBps: pr.levelProgressBps,
    maxed: pr.maxed,
    levels: p.levels.map((l, i) => ({
      ...publicLevel(p, l, i),
      reached: i <= pr.levelIndex,
      reachedAt: at.get(l.id)?.at.toISOString() ?? null,
    })),
  };
}

export type DataReason = 'not_started' | 'backfill_running' | 'sync_failing' | 'open_issues' | 'verification_mismatch' | 'standby';

/**
 * synced     = caught up with the finalized chain and healthy (it does NOT mean "proven complete":
 *              see data.history.verification);
 * incomplete = still catching up, failing, or carrying open incidents;
 * (unavailable is not a state of a response: it is the 503 `data_unavailable` error.)
 */
export function dataState(state: IndexState, runner: RunnerSnapshot | null) {
  const reasons: DataReason[] = [];
  if (state.finalizedHead === null && state.backfill === 'pending') reasons.push('not_started');
  else if (state.backfill === 'running') reasons.push('backfill_running');
  if (runner && runner.consecutiveFailures > 0) reasons.push('sync_failing');
  if (state.issues.length > 0) reasons.push('open_issues');
  if (state.verification.status === 'mismatch') reasons.push('verification_mismatch');
  if (runner?.state === 'waiting_lease') reasons.push('standby'); // another process indexes this project; informational
  const blocking = reasons.filter((r) => r !== 'standby');
  const codes: Record<string, number> = {};
  for (const i of state.issues) codes[i.code] = (codes[i.code] ?? 0) + 1;
  return {
    state: blocking.length ? ('incomplete' as const) : ('synced' as const),
    reasons,
    history: {
      backfill: state.backfill,
      verification: state.verification.status,
      complete: state.verification.status === 'verified',
      // Public, stable code explaining a non-proven state (never the internal free-text reason); null when proven.
      reason: state.verification.status === 'verified' ? null : state.verification.status === 'mismatch' ? 'supply_mismatch' : (state.verification.code ?? 'history_not_read'),
      // When the proof (or the mismatch) was last computed; null if never.
      verifiedAt: state.verification.status === 'unverified' ? null : (state.verification.at ?? null),
    },
    issues: { count: state.issues.length, codes },
    lastFinalizedSlot: state.finalizedHeadSlot,
    lastSyncAt: runner?.lastSyncAt ?? null,
    indexer: runner?.state ?? null,
  };
}
