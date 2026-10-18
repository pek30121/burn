import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectConfig } from '../src/config/schema.ts';
import { BurnLedger, burnKey } from '../src/core/ledger.ts';
import { burn, MINT_B, projectInput, randomSignature } from './helpers.ts';

const alpha = parseProjectConfig(projectInput());
const beta = parseProjectConfig(projectInput({ id: 'beta', mint: MINT_B }));
const T1 = 1_000_000_000n;
const eventIds = (r: ReturnType<BurnLedger['record']>) => (r.status === 'rejected' ? null : r.events.map((e) => e.level.id));

test('the same instruction is never counted twice', () => {
  const l = new BurnLedger(alpha);
  const b = burn({ amountRaw: 500n });
  assert.equal(l.record(b).status, 'inserted');
  assert.equal(l.record(b).status, 'duplicate');
  assert.equal(l.record({ ...b }).status, 'duplicate');
  assert.equal(l.finalizedRaw, 500n);
  assert.equal(l.count, 1);
});

test('two burn instructions in one transaction are two burns', () => {
  const l = new BurnLedger(alpha);
  const signature = randomSignature();
  l.record(burn({ signature, instructionPath: '0', amountRaw: 1n }));
  l.record(burn({ signature, instructionPath: '2.1', amountRaw: 2n }));
  assert.equal(l.finalizedRaw, 3n);
  assert.equal(l.count, 2);
});

test('a replay with different data is rejected, not merged', () => {
  const l = new BurnLedger(alpha);
  const b = burn({ amountRaw: 500n });
  l.record(b);
  assert.deepEqual(l.record({ ...b, amountRaw: 9_999n }), { status: 'rejected', reason: 'conflicts with an already recorded burn' });
  assert.equal(l.finalizedRaw, 500n);
});

test('projects are isolated: a ledger refuses another mint', () => {
  const a = new BurnLedger(alpha);
  const b = new BurnLedger(beta);
  assert.equal(a.record(burn({ mint: MINT_B })).status, 'rejected');
  assert.equal(b.record(burn({ mint: MINT_B, amountRaw: 7n })).status, 'inserted');
  assert.equal(a.finalizedRaw, 0n);
  assert.equal(b.finalizedRaw, 7n);
});

test('input validation', () => {
  const l = new BurnLedger(parseProjectConfig(projectInput({ startSlot: 50 })));
  const reasons = [
    burn({ slot: 49 }),
    burn({ amountRaw: 0n }),
    burn({ amountRaw: -1n }),
    burn({ amountRaw: 2n ** 64n }),
    burn({ signature: 'abc' }),
    burn({ instructionPath: '1.2.3' }),
    burn({ instructionPath: '01' }),
    burn({ owner: 'x' }),
    burn({ slot: 1.5 }),
  ].map((b) => l.record(b).status);
  assert.deepEqual(new Set(reasons), new Set(['rejected']));
  assert.equal(l.record(burn({ slot: 50 })).status, 'inserted');
});

test('confirmed burns count only toward the optimistic total until finalized', () => {
  const l = new BurnLedger(alpha);
  const b = burn({ amountRaw: T1, commitment: 'confirmed' });
  const r1 = l.record(b);
  assert.equal(r1.status, 'inserted');
  assert.deepEqual(eventIds(r1), []);
  assert.equal(l.finalizedRaw, 0n);
  assert.equal(l.confirmedRaw, T1);
  assert.equal(l.progress('confirmed').level.id, 'l1');
  assert.equal(l.progress('finalized').level.id, 'l0');

  const r2 = l.record({ ...b, commitment: 'finalized' });
  assert.equal(r2.status, 'promoted');
  assert.deepEqual(eventIds(r2), ['l1']);
  assert.equal(l.finalizedRaw, T1);
  assert.equal(l.confirmedRaw, T1);
  // A late "confirmed" copy of a finalized burn never downgrades it.
  assert.equal(l.record(b).status, 'duplicate');
  assert.equal(l.finalizedRaw, T1);
});

test('a dropped confirmed burn is removed; finalized burns cannot be dropped', () => {
  const l = new BurnLedger(alpha);
  const c = burn({ amountRaw: 10n, commitment: 'confirmed' });
  const f = burn({ amountRaw: 5n });
  l.record(c);
  l.record(f);
  assert.equal(l.drop(burnKey(f.signature, f.instructionPath)), false);
  assert.equal(l.drop(burnKey(c.signature, c.instructionPath)), true);
  assert.equal(l.drop(burnKey(c.signature, c.instructionPath)), false);
  assert.equal(l.confirmedRaw, 5n);
  assert.equal(l.finalizedRaw, 5n);
});

test('level events fire exactly once, including multi-level jumps', () => {
  const l = new BurnLedger(alpha);
  const ids = eventIds;
  assert.deepEqual(ids(l.record(burn({ amountRaw: T1 - 1n }))), []);
  const crossing = burn({ amountRaw: 1n });
  const r = l.record(crossing);
  assert.deepEqual(ids(r), ['l1']);
  assert.equal(r.status !== 'rejected' && r.events[0]!.triggeredBy, burnKey(crossing.signature, '0'));
  assert.deepEqual(ids(l.record(crossing)), []); // replay: no second event
  assert.deepEqual(ids(l.record(burn({ amountRaw: 100_000_000_000n }))), ['l2', 'l3']);
  assert.deepEqual(ids(l.record(burn({ amountRaw: 1n }))), []);
});

test('totals are order-independent', () => {
  const burns = Array.from({ length: 50 }, (_, i) => burn({ amountRaw: BigInt(i + 1) * 123_456_789n, slot: 100 + i }));
  const fwd = new BurnLedger(alpha);
  const rev = new BurnLedger(alpha);
  burns.forEach((b) => fwd.record(b));
  [...burns].reverse().forEach((b) => rev.record(b));
  burns.forEach((b) => rev.record(b)); // replay everything once more
  assert.equal(fwd.finalizedRaw, rev.finalizedRaw);
  assert.equal(fwd.finalizedRaw, 123_456_789n * ((50n * 51n) / 2n));
  assert.equal(fwd.history()[0]!.slot, 149);
});
