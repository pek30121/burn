import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUiAmount, parseRawAmount, parseUiAmount, U64_MAX } from '../src/core/amount.ts';
import { decodeBase58, encodeBase58, isPublicKey, isSignature } from '../src/core/base58.ts';
import { MINT_A, randomSignature } from './helpers.ts';

test('parseUiAmount is exact with decimals', () => {
  assert.equal(parseUiAmount('1234.5', 6), 1_234_500_000n);
  assert.equal(parseUiAmount('0.000001', 6), 1n);
  assert.equal(parseUiAmount('1_000_000', 6), 1_000_000_000_000n);
  assert.equal(parseUiAmount(42, 0), 42n);
  assert.equal(parseUiAmount('0.3', 1), 3n); // the classic 0.1 + 0.2 trap never reaches a float
});

test('parseUiAmount rejects lossy or malformed input', () => {
  assert.throws(() => parseUiAmount('0.0000001', 6), /fractional digits/);
  assert.throws(() => parseUiAmount(1.5, 6), /safe integers/);
  assert.throws(() => parseUiAmount(2 ** 53, 6), /safe integers/);
  for (const bad of ['', '-1', '1e6', '01', '1.', '.5', 'abc', ' 1 2 ']) {
    assert.throws(() => parseUiAmount(bad, 6), /invalid amount/, bad);
  }
  assert.throws(() => parseUiAmount('18446744073709551616', 0), /u64/);
  assert.throws(() => parseUiAmount('1', 19), /decimals/);
});

test('u64 boundary and raw parsing', () => {
  assert.equal(parseRawAmount(U64_MAX.toString()), U64_MAX);
  assert.throws(() => parseRawAmount((U64_MAX + 1n).toString()), /u64/);
  assert.throws(() => parseRawAmount('1.0'), /invalid raw/);
});

test('formatUiAmount round-trips', () => {
  assert.equal(formatUiAmount(1_234_500_000n, 6), '1234.5');
  assert.equal(formatUiAmount(1n, 6), '0.000001');
  assert.equal(formatUiAmount(0n, 6), '0');
  assert.equal(formatUiAmount(U64_MAX, 9), '18446744073.709551615');
  for (const s of ['0', '1', '0.000001', '999999999.999999']) assert.equal(formatUiAmount(parseUiAmount(s, 6), 6), s);
});

test('base58 validation of addresses and signatures', () => {
  assert.ok(isPublicKey(MINT_A));
  assert.ok(isPublicKey('11111111111111111111111111111111'));
  assert.ok(!isPublicKey('0OIl' + MINT_A.slice(4)));
  assert.ok(!isPublicKey(MINT_A.slice(0, 30)));
  const sig = randomSignature();
  assert.ok(isSignature(sig));
  assert.ok(!isSignature(MINT_A));
  assert.equal(encodeBase58(decodeBase58(MINT_A)!), MINT_A);
});
