/* Level progression. Pure functions over (levels, total burned), all bigint. */

import type { Level } from '../config/schema.ts';

export interface Progress {
  readonly totalRaw: bigint;
  readonly levelIndex: number;
  readonly level: Level;
  readonly nextLevel: Level | null;
  /** Raw amount still needed to reach nextLevel (0n at max level). */
  readonly remainingRaw: bigint;
  /** Progress through the current level in basis points, integer 0..10000 (floored). */
  readonly levelProgressBps: number;
  readonly maxed: boolean;
}

export function levelIndexFor(levels: readonly Level[], totalRaw: bigint): number {
  // Binary search for the last level whose threshold <= total.
  let lo = 0;
  let hi = levels.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (levels[mid]!.thresholdRaw <= totalRaw) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function computeProgress(levels: readonly Level[], totalRaw: bigint): Progress {
  if (levels.length === 0) throw new Error('levels must not be empty');
  if (totalRaw < 0n) throw new Error('total burned cannot be negative');
  const levelIndex = levelIndexFor(levels, totalRaw);
  const level = levels[levelIndex]!;
  const nextLevel = levels[levelIndex + 1] ?? null;
  if (!nextLevel) {
    return { totalRaw, levelIndex, level, nextLevel, remainingRaw: 0n, levelProgressBps: 10_000, maxed: true };
  }
  const span = nextLevel.thresholdRaw - level.thresholdRaw;
  const done = totalRaw - level.thresholdRaw;
  return {
    totalRaw,
    levelIndex,
    level,
    nextLevel,
    remainingRaw: nextLevel.thresholdRaw - totalRaw,
    levelProgressBps: Number((done * 10_000n) / span),
    maxed: false,
  };
}

/** Levels newly reached when the total moves from prevRaw to nextRaw (ascending; empty if it did not rise). */
export function crossedLevels(levels: readonly Level[], prevRaw: bigint, nextRaw: bigint): Level[] {
  if (nextRaw <= prevRaw) return [];
  const from = levelIndexFor(levels, prevRaw);
  const to = levelIndexFor(levels, nextRaw);
  return levels.slice(from + 1, to + 1);
}
