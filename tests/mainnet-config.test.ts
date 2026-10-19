import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectRegistry } from '../src/config/registry.ts';

test('[mainnet-config] deploy/projects.mainnet.json loads through the real registry: VIRUS only, pending until its mint exists, Mainnet only, counted from creation', async () => {
  const reg = await ProjectRegistry.fromFile('deploy/projects.mainnet.json');
  assert.deepEqual(reg.list(), [], 'no project is active before its mint exists on-chain');
  const pending = reg.pending();
  assert.deepEqual(pending.map((p) => p.id), ['virus']);
  const v = pending[0]!;
  assert.equal(v.cluster, 'mainnet-beta');
  assert.equal(v.startSlot, 0);
  assert.equal(v.mint, 'EuhDQM4c9TsyytKDDj5PkAxoL2n9zUh9bcE8tdDkpump');
});
