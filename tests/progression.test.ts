import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectConfig } from '../src/config/schema.ts';
import { computeProgress, crossedLevels, levelIndexFor } from '../src/core/progression.ts';
import { projectInput } from './helpers.ts';

const { levels } = parseProjectConfig(projectInput()); // 0, 1000, 5000.5, 10000 (6 decimals)
const T1 = 1_000_000_000n;
const T2 = 5_000_500_000n;
const T3 = 10_000_000_000n;

test('level boundaries are inclusive at exactly the threshold', () => {
  assert.equal(levelIndexFor(levels, 0n), 0);
  assert.equal(levelIndexFor(levels, T1 - 1n), 0);
  assert.equal(levelIndexFor(levels, T1), 1);
  assert.equal(levelIndexFor(levels, T2 - 1n), 1);
  assert.equal(levelIndexFor(levels, T2), 2);
  assert.equal(levelIndexFor(levels, T3), 3);
  assert.equal(levelIndexFor(levels, 2n ** 64n - 1n), 3);
});

test('computeProgress: remaining and integer basis points', () => {
  const p = computeProgress(levels, T1 + (T2 - T1) / 2n);
  assert.equal(p.level.id, 'l1');
  assert.equal(p.nextLevel?.id, 'l2');
  assert.equal(p.remainingRaw, T2 - p.totalRaw);
  assert.equal(p.levelProgressBps, 5000);
  assert.equal(computeProgress(levels, T2 - 1n).levelProgressBps, 9999); // floored, never rounds up to "done"
  const max = computeProgress(levels, T3 + 1n);
  assert.ok(max.maxed);
  assert.equal(max.remainingRaw, 0n);
  assert.equal(max.levelProgressBps, 10_000);
  assert.throws(() => computeProgress(levels, -1n));
});

test('crossedLevels: one jump can cross several levels; no event when total does not rise', () => {
  assert.deepEqual(crossedLevels(levels, 0n, T3).map((l) => l.id), ['l1', 'l2', 'l3']);
  assert.deepEqual(crossedLevels(levels, T1 - 1n, T1).map((l) => l.id), ['l1']);
  assert.deepEqual(crossedLevels(levels, T1, T1 + 1n), []);
  assert.deepEqual(crossedLevels(levels, T2, T1), []);
});

test('single-level project', () => {
  const p = parseProjectConfig(projectInput({ levels: [{ id: 'only', name: 'Only', threshold: '0' }] }));
  assert.ok(computeProgress(p.levels, 123n).maxed);
});
