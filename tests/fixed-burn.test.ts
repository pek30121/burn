import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFixedBurn } from '../src/wallet/fixed-burn.ts';
import { ProjectRegistry } from '../src/config/registry.ts';
import { readFileSync } from 'node:fs';

test('[fixed-burn] only exactly the fixed amount passes (raw, bigint, decimals-aware)', () => {
  assert.equal(checkFixedBurn({ amountRaw: 1_000_000n }, 6, '1'), null);
  for (const raw of [1n, 999_999n, 1_000_001n, 2_000_000n, 1_000_000_000_000n, 0n]) assert.equal(checkFixedBurn({ amountRaw: raw }, 6, '1'), 'amount_not_fixed', String(raw));
  assert.equal(checkFixedBurn(null, 6, '1'), 'no_preview');
  assert.equal(checkFixedBurn({ amountRaw: 1_000_000_000n }, 9, '1'), null);
});

test('[fixed-burn] the Mainnet page config matches the engine project file (mint, program, decimals) and fixes exactly 1 token', async () => {
  const page = JSON.parse(readFileSync('deploy/wallet-config.mainnet.json', 'utf8'));
  const reg = await ProjectRegistry.fromFile('deploy/projects.mainnet.json');
  assert.equal(page.cluster, 'mainnet-beta');
  assert.equal(page.fixedAmountUi, '1');
  for (const p of page.projects) {
    const e = reg.get(p.id)!;
    assert.ok(e, p.id);
    assert.deepEqual([p.mint, p.tokenProgram, p.decimals, 'mainnet-beta'], [e.mint, e.tokenProgram, e.decimals, e.cluster]);
  }
});
