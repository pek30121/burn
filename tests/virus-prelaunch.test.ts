import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProjectRegistry } from '../src/config/registry.ts';
import { decodeBase58, isPublicKey } from '../src/core/base58.ts';
import { EXT, type MintInfo } from '../src/wallet/token-info.ts';
import { assessMint, REFERENCE_SUPPLY_RAW } from '../scripts/mainnet/prelaunch-check.ts';

const pending = JSON.parse(readFileSync('deploy/virus.prelaunch.json', 'utf8'));
const CA = 'EuhDQM4c9TsyytKDDj5PkAxoL2n9zUh9bcE8tdDkpump';
const ok: MintInfo = { tokenProgram: 'spl-token', supplyRaw: REFERENCE_SUPPLY_RAW, decimals: 6, mintAuthority: null, freezeAuthority: null, extensions: [] };

test('[virus-prelaunch] the planned mint is a valid 32-byte address and the pending record carries no invented chain data', () => {
  assert.equal(pending.mint, CA);
  assert.ok(isPublicKey(CA));
  assert.equal(decodeBase58(CA)?.length, 32);
  for (const k of ['decimals', 'tokenProgram', 'initialSupply', 'startSlot']) assert.equal(k in pending, false, `${k} must come from the chain, not from this file`);
});

test('[virus-prelaunch] the pending levels are the 7 contractual ones, equal to the example entry and to the site copy', async () => {
  const ids = ['dormant', 'seed', 'bug', 'parasite', 'worm', 'overmind', 'god'];
  const th = ['0', '10000', '50000', '150000', '400000', '1000000', '2500000'];
  assert.deepEqual(pending.levels.map((l: any) => l.id), ids);
  assert.deepEqual(pending.levels.map((l: any) => l.threshold), th);
  const ex = (await ProjectRegistry.fromFile('config/projects.example.json')).require('virus');
  assert.deepEqual(ex.levels.map((l) => l.id), ids);
  const site = readFileSync('web/virus/js/config.js', 'utf8');
  for (const id of ids) assert.match(site, new RegExp(`id:\\s*'${id}'`));
});

test('[virus-prelaunch] the engine configuration is not touched before the mint exists: FLAPY alone, or virus with exactly the planned mint', async () => {
  const reg = await ProjectRegistry.fromFile('deploy/projects.mainnet.json');
  const flapy = reg.require('flapy');
  assert.equal(flapy.mint, 'GB5RZm2EgoY6MAdepyZaGhqewhP4tmutt5vYdeCLpump');
  assert.equal(flapy.tokenProgram, 'token-2022');
  const v = reg.list().find((p) => p.id === 'virus');
  if (v) { assert.equal(v.mint, CA); assert.equal(v.cluster, 'mainnet-beta'); }
  assert.equal(reg.list().some((p) => p.mint === CA && p.id !== 'virus'), false);
  assert.equal(reg.list().some((p) => p.id === 'virus' && p.mint === flapy.mint), false);
});

test('[virus-prelaunch] the site is pointed at the planned mint (cross-check) while no contract / BUY / CHART link is announced', () => {
  assert.match(readFileSync('web/virus/js/project.js', 'utf8'), new RegExp(`mint: '${CA}'`));
  const cfg = readFileSync('web/virus/js/config.js', 'utf8');
  assert.match(cfg, /contract:\s*null/);
  assert.doesNotMatch(cfg, /FMmNZ|GB5RZ/);
});

test('[virus-prelaunch] assessMint: a Pump.fun-like mint is clean; active authority, confidential mint/burn and wrapped SOL block; differences from the reference are reported', () => {
  const clean = assessMint(CA, ok);
  assert.deepEqual(clean.blockers, []);
  assert.equal(clean.matchesReference, true);
  assert.equal(assessMint(CA, { ...ok, mintAuthority: CA }).blockers.length, 1);
  assert.equal(assessMint(CA, { ...ok, tokenProgram: 'token-2022', extensions: [{ type: EXT.ConfidentialMintBurn, name: 'ConfidentialMintBurn', data: new Uint8Array() }] as any }).blockers.length, 1);
  assert.equal(assessMint('So11111111111111111111111111111111111111112', ok).blockers.length, 1);
  const other = assessMint(CA, { ...ok, decimals: 9, supplyRaw: 5n });
  assert.equal(other.matchesReference, false);
  assert.ok(other.warnings.some((w) => /re-decide the thresholds/.test(w)));
  assert.ok(assessMint(CA, { ...ok, freezeAuthority: CA }).warnings.some((w) => /freeze/.test(w)));
});
