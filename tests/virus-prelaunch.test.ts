import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProjectRegistry } from '../src/config/registry.ts';
import { decodeBase58, isPublicKey } from '../src/core/base58.ts';

const CA = 'EuhDQM4c9TsyytKDDj5PkAxoL2n9zUh9bcE8tdDkpump';
const IDS = ['dormant', 'seed', 'bug', 'parasite', 'worm', 'overmind', 'god'];
const TH = ['0', '10000', '50000', '150000', '400000', '1000000', '2500000'];

test('[virus-prelaunch] the planned mint is a valid 32-byte address', () => {
  assert.ok(isPublicKey(CA));
  assert.equal(decodeBase58(CA)?.length, 32);
});

test('[virus-prelaunch] the Mainnet engine config holds ONLY VIRUS, pending (awaitMint), with the 7 contractual levels and no value read from the chain', async () => {
  const raw = JSON.parse(readFileSync('deploy/projects.mainnet.json', 'utf8'));
  assert.equal(raw.projects.length, 1);
  const e = raw.projects[0];
  for (const k of ['decimals', 'tokenProgram', 'initialSupply']) assert.equal(k in e, false, `${k} must come from the chain`);
  assert.equal(e.awaitMint, true);
  const reg = await ProjectRegistry.fromFile('deploy/projects.mainnet.json');
  assert.equal(reg.list().length, 0, 'nothing is active before the mint exists');
  const p = reg.getPending('virus')!;
  assert.equal(p.mint, CA);
  assert.equal(p.cluster, 'mainnet-beta');
  assert.equal(p.startSlot, 0);
  assert.deepEqual((p.template.levels as { id: string; threshold: string }[]).map((l) => l.id), IDS);
  assert.deepEqual((p.template.levels as { id: string; threshold: string }[]).map((l) => l.threshold), TH);
  assert.doesNotMatch(readFileSync('deploy/projects.mainnet.json', 'utf8'), /GB5RZ|FMmNZ/i);
});

test('[virus-prelaunch] the example entry carries the same 7 levels and the site copy has the same ids', async () => {
  const ex = (await ProjectRegistry.fromFile('config/projects.example.json')).require('virus');
  assert.deepEqual(ex.levels.map((l) => l.id), IDS);
  const site = readFileSync('web/virus/js/config.js', 'utf8');
  for (const id of IDS) assert.match(site, new RegExp(`id:\\s*'${id}'`));
});

test('[virus-prelaunch] the site is pointed at the planned mint (cross-check) while no contract / BUY / CHART link is announced', () => {
  assert.match(readFileSync('web/virus/js/project.js', 'utf8'), new RegExp(`mint: '${CA}'`));
  const cfg = readFileSync('web/virus/js/config.js', 'utf8');
  assert.match(cfg, /contract:\s*null/);
  assert.doesNotMatch(cfg, /FMmNZ|GB5RZ/);
});
