import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, parseProjectConfig } from '../src/config/schema.ts';
import { ProjectRegistry } from '../src/config/registry.ts';
import { MINT_A, MINT_B, projectInput } from './helpers.ts';

const issuesOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return [...e.issues];
    throw e;
  }
  assert.fail('expected ConfigError');
};

test('valid config parses thresholds to raw bigint', () => {
  const p = parseProjectConfig(projectInput());
  assert.deepEqual(p.levels.map((l) => l.thresholdRaw), [0n, 1_000_000_000n, 5_000_500_000n, 10_000_000_000n]);
  assert.equal(p.startSlot, 0);
});

test('config rejects bad fields and reports every issue', () => {
  const issues = issuesOf(() =>
    parseProjectConfig(projectInput({ id: 'Bad Id', mint: 'nope', decimals: 6.5, cluster: 'testnet', tokenProgram: 'x' })),
  );
  assert.ok(issues.length >= 5, issues.join('\n'));
});

test('levels: first at 0, strictly increasing, unique ids, precision bounded by decimals', () => {
  const lv = (...t: string[]) => t.map((threshold, i) => ({ id: `l${i}`, name: `L${i}`, threshold }));
  assert.match(issuesOf(() => parseProjectConfig(projectInput({ levels: lv('1', '2') })))[0]!, /start at 0/);
  assert.match(issuesOf(() => parseProjectConfig(projectInput({ levels: lv('0', '5', '5') })))[0]!, /strictly increasing/);
  assert.match(issuesOf(() => parseProjectConfig(projectInput({ levels: lv('0', '5', '4') })))[0]!, /strictly increasing/);
  assert.match(issuesOf(() => parseProjectConfig(projectInput({ decimals: 2, levels: lv('0', '0.001') })))[0]!, /fractional/);
  assert.match(issuesOf(() => parseProjectConfig(projectInput({ levels: [] })))[0]!, /non-empty/);
  const dup = [{ id: 'a', name: 'A', threshold: '0' }, { id: 'a', name: 'B', threshold: '1' }];
  assert.match(issuesOf(() => parseProjectConfig(projectInput({ levels: dup })))[0]!, /duplicate level/);
});

test('parsed config is deeply immutable', () => {
  const p = parseProjectConfig(projectInput());
  assert.throws(() => ((p as { mint: string }).mint = MINT_B), TypeError);
  assert.throws(() => (p.levels as unknown[]).push({}), TypeError);
  assert.throws(() => ((p.levels[1] as { thresholdRaw: bigint }).thresholdRaw = 0n), TypeError);
});

test('registry isolates projects: unique ids and unique mint per cluster', () => {
  const reg = new ProjectRegistry([projectInput(), projectInput({ id: 'beta', mint: MINT_B })]);
  assert.equal(reg.list().length, 2);
  assert.equal(reg.byMint('devnet', MINT_B)?.id, 'beta');
  assert.equal(reg.byMint('mainnet-beta', MINT_B), undefined);

  assert.match(issuesOf(() => new ProjectRegistry([projectInput(), projectInput({ mint: MINT_B })]))[0]!, /duplicate project id/);
  assert.match(issuesOf(() => new ProjectRegistry([projectInput(), projectInput({ id: 'beta' })]))[0]!, /already used/);
  // Same mint on a different cluster is a different token.
  assert.doesNotThrow(() => new ProjectRegistry([projectInput(), projectInput({ id: 'beta', cluster: 'mainnet-beta' })]));
});

test('registry loads the example file', async () => {
  const reg = await ProjectRegistry.fromFile(new URL('../config/projects.example.json', import.meta.url).pathname);
  const virus = reg.require('virus');
  assert.equal(virus.levels.length, 7);
  assert.equal(virus.levels[6]!.thresholdRaw, 250_000_000_000_000n);
});

test('initialSupply is optional, converted exactly, and validated', () => {
  assert.equal(parseProjectConfig(projectInput()).initialSupplyRaw, null);
  assert.equal(parseProjectConfig(projectInput({ initialSupply: '1000000000' })).initialSupplyRaw, 1_000_000_000_000_000n);
  assert.match(issuesOf(() => parseProjectConfig(projectInput({ initialSupply: '0' })))[0]!, /greater than 0/);
  assert.match(issuesOf(() => parseProjectConfig(projectInput({ initialSupply: '1.0000001' })))[0]!, /fractional/);
});
