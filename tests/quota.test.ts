import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuotaMonitor } from '../src/engine/quota.ts';
import { createLogger } from '../src/engine/logger.ts';

function rig(quota = 10_000_000, minElapsedMs = 600_000) {
  const lines: any[] = [];
  const t = { now: 1_000_000, used: 0 };
  const m = new QuotaMonitor({
    monthlyCredits: quota, minElapsedMs, now: () => t.now, log: createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l)) }),
    meter: { snapshot: () => ({ total: { estimatedCredits: t.used } }) as any },
  });
  return { m, t, lines };
}
const HOUR = 3_600_000;

test('[quota] no projection before enough data; low usage stays ok and silent', () => {
  const { m, t, lines } = rig();
  t.now += 60_000; t.used = 5_000;
  const s = m.check();
  assert.equal(s.projectedMonthlyCredits, null);
  assert.equal(s.level, 'ok');
  assert.equal(lines.length, 0);
});

test('[quota] projection: 10 000 credits/hour = 7.2 M/month on a 10 M quota is ok; 12 000/hour (8.64 M = 86 %) warns once; 14 000/hour (10.08 M) is critical', () => {
  const a = rig(); a.t.now += HOUR; a.t.used = 10_000;
  assert.equal(a.m.check().level, 'ok');
  assert.equal(a.m.snapshot().projectedMonthlyCredits, 7_200_000);
  const b = rig(); b.t.now += HOUR; b.t.used = 12_000;
  assert.equal(b.m.check().level, 'warn');
  b.m.check(); b.m.check();
  assert.equal(b.lines.filter((l) => l.event === 'rpc_quota').length, 1, 'alert on the level change only');
  assert.equal(b.lines[0].level, 'warn');
  const c = rig(); c.t.now += HOUR; c.t.used = 14_000;
  assert.equal(c.m.check().level, 'critical');
  assert.equal(c.lines[0].level, 'error');
  assert.equal(c.lines[0].projectedPercent, 100.8);
  assert.ok(!JSON.stringify(c.lines).includes('api-key'));
});

test('[quota] consumed share alerts even before a projection exists; recovery is reported', () => {
  const { m, t, lines } = rig(1_000);
  t.now += 1_000; t.used = 850;
  assert.equal(m.check().level, 'warn');
  t.used = 1_000;
  assert.equal(m.check().level, 'critical');
  assert.deepEqual(lines.map((l) => l.event), ['rpc_quota', 'rpc_quota']);
  t.now += 100 * HOUR; t.used = 10; // (counter reset scenario: new low usage)
  assert.equal(m.check().level, 'ok');
  assert.equal(lines.at(-1).event, 'rpc_quota_recovered');
  assert.match(m.snapshot().note, /NOT the provider billing/);
});

test('[quota] an invalid quota is refused', () => {
  assert.throws(() => rig(0));
});
