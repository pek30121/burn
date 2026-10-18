import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectRegistry } from '../src/config/registry.ts';

test('[mainnet-config] deploy/projects.mainnet.json loads through the real registry (FLAPY, Token-2022, proof-ready, Mainnet only)', async () => {
  const reg = await ProjectRegistry.fromFile('deploy/projects.mainnet.json');
  const all = reg.list();
  assert.ok(all.length >= 1);
  for (const p of all) {
    assert.equal(p.cluster, 'mainnet-beta');
    assert.equal(p.startSlot, 0);
  }
  const f = all.find((p) => p.id === 'flapy')!;
  assert.equal(f.mint, 'GB5RZm2EgoY6MAdepyZaGhqewhP4tmutt5vYdeCLpump');
  assert.equal(f.tokenProgram, 'token-2022');
  assert.equal(f.decimals, 6);
  assert.equal(f.initialSupplyRaw, 1_000_000_000_000_000n);
});
