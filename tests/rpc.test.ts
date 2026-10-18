import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcError, RpcUnsupportedVersionError, SolanaRpc } from '../src/chain/rpc.ts';
import { MINT_A, randomSignature } from './helpers.ts';

const URL_WITH_KEY = 'https://rpc.example/?api-key=SECRET-KEY-123';
type Step = Response | Error | (() => Response);
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
const ok = (result: unknown) => json({ jsonrpc: '2.0', id: 1, result });
const rpcErr = (code: number) => json({ jsonrpc: '2.0', id: 1, error: { code, message: `boom ${URL_WITH_KEY}` } });

function setup(steps: Step[]) {
  const calls: { url: string; body: any }[] = [];
  const sleeps: number[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    const s = steps.shift();
    if (s === undefined) throw new Error('unexpected extra request');
    if (s instanceof Error) throw s;
    return typeof s === 'function' ? s() : s;
  }) as unknown as typeof fetch;
  const rpc = new SolanaRpc({ url: URL_WITH_KEY, fetch: f, sleep: async (ms) => void sleeps.push(ms), random: () => 1 });
  return { rpc, calls, sleeps };
}

test('getTransaction asks for json encoding and max version 1 at the given commitment', async () => {
  const { rpc, calls } = setup([ok({ slot: 1 })]);
  const sig = randomSignature();
  assert.deepEqual(await rpc.getTransaction(sig, 'finalized'), { slot: 1 });
  assert.equal(calls[0]!.url, URL_WITH_KEY);
  assert.equal(calls[0]!.body.method, 'getTransaction');
  assert.deepEqual(calls[0]!.body.params, [sig, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
});

test('getTransaction returns null when the node does not have the transaction', async () => {
  const { rpc } = setup([ok(null)]);
  assert.equal(await rpc.getTransaction(randomSignature(), 'confirmed'), null);
});

test('getSignaturesForAddress sends paging params and validates every entry', async () => {
  const a = randomSignature();
  const b = randomSignature();
  const { rpc, calls } = setup([ok([{ signature: a, slot: 10, err: null, blockTime: 5 }, { signature: b, slot: 9, err: { InstructionError: [0, 'x'] }, blockTime: null }])]);
  const before = randomSignature();
  const until = randomSignature();
  const res = await rpc.getSignaturesForAddress(MINT_A, { limit: 50, before, until, commitment: 'finalized' });
  assert.deepEqual(calls[0]!.body.params, [MINT_A, { limit: 50, commitment: 'finalized', before, until }]);
  assert.deepEqual(res.map((r) => [r.signature, r.slot, r.err === null, r.blockTime]), [[a, 10, true, 5], [b, 9, false, null]]);
});

test('getSignaturesForAddress rejects malformed entries and bad limits', async () => {
  for (const bad of [[{ signature: 'x', slot: 1, err: null }], [{ signature: randomSignature(), slot: -1, err: null }], [{ signature: randomSignature(), slot: 1 }], 'nope']) {
    const { rpc } = setup([ok(bad)]);
    await assert.rejects(rpc.getSignaturesForAddress(MINT_A, { commitment: 'finalized' }), RpcError);
  }
  const { rpc } = setup([]);
  await assert.rejects(rpc.getSignaturesForAddress(MINT_A, { limit: 1001, commitment: 'finalized' }), RangeError);
  await assert.rejects(rpc.getSignaturesForAddress(MINT_A, { limit: 0, commitment: 'finalized' }), RangeError);
});

test('getTokenSupply returns an exact bigint', async () => {
  const { rpc } = setup([ok({ context: { slot: 1 }, value: { amount: '18446744073709551615', decimals: 6, uiAmount: 1, uiAmountString: '1' } })]);
  assert.deepEqual(await rpc.getTokenSupply(MINT_A, 'finalized'), { amountRaw: 18446744073709551615n, decimals: 6 });
  for (const bad of [{ value: { amount: '1.5', decimals: 6 } }, { value: { amount: 5, decimals: 6 } }, { value: { amount: '1' } }, null]) {
    await assert.rejects(setup([ok(bad)]).rpc.getTokenSupply(MINT_A, 'finalized'), /malformed/);
  }
});

test('transient failures are retried with growing, capped delays', async () => {
  const { rpc, calls, sleeps } = setup([
    new Response('', { status: 429 }), new Response('', { status: 503 }), new TypeError('fetch failed'), rpcErr(-32005), ok('fine'),
  ]);
  assert.equal(await rpc.getTransaction(randomSignature(), 'finalized'), 'fine');
  assert.equal(calls.length, 5);
  assert.deepEqual(sleeps, [500, 1000, 2000, 4000]); // random()=1 -> full backoff
});

test('Retry-After is honoured (capped at 30s)', async () => {
  const { rpc, sleeps } = setup([new Response('', { status: 429, headers: { 'retry-after': '3' } }), new Response('', { status: 429, headers: { 'retry-after': '999' } }), ok(1)]);
  await rpc.getTransaction(randomSignature(), 'finalized');
  assert.deepEqual(sleeps, [3000, 30_000]);
});

test('gives up after maxRetries and the error never contains the URL or API key', async () => {
  const steps: Step[] = Array.from({ length: 5 }, () => new TypeError(`fetch failed for ${URL_WITH_KEY}`));
  const { rpc, calls } = setup(steps);
  const err = await rpc.getTransaction(randomSignature(), 'finalized').catch((e) => e);
  assert.ok(err instanceof RpcError && err.retryable);
  assert.equal(calls.length, 5); // 1 try + 4 retries
  assert.doesNotMatch(String(err.message) + String(err.stack), /SECRET-KEY|api-key/);
});

test('non-retryable RPC errors fail at once; their message does not echo the node text', async () => {
  const { rpc, calls } = setup([rpcErr(-32602)]);
  const err = await rpc.getTransaction(randomSignature(), 'finalized').catch((e) => e);
  assert.ok(err instanceof RpcError);
  assert.equal(err.code, -32602);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(err.message, /SECRET-KEY/);
});

test('-32015 (newer transaction version) is its own error and is never retried', async () => {
  const { rpc, calls } = setup([rpcErr(-32015)]);
  const err = await rpc.getTransaction(randomSignature(), 'finalized').catch((e) => e);
  assert.ok(err instanceof RpcUnsupportedVersionError);
  assert.equal(calls.length, 1);
});

test('non-JSON bodies are retried; 4xx other than 429 are not; missing result is an error', async () => {
  const a = setup([new Response('<html>', { status: 200 }), ok('x')]);
  assert.equal(await a.rpc.getTransaction(randomSignature(), 'finalized'), 'x');
  const b = setup([new Response('', { status: 401 })]);
  await assert.rejects(b.rpc.getTransaction(randomSignature(), 'finalized'), /HTTP 401/);
  assert.equal(b.calls.length, 1);
  await assert.rejects(setup([json({ jsonrpc: '2.0', id: 1 })]).rpc.getTransaction(randomSignature(), 'finalized'), /neither result nor error/);
});
