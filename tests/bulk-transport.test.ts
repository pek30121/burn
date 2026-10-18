import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RpcError, SolanaRpc } from '../src/chain/rpc.ts';
import { loadEngineConfig, EngineConfigError } from '../src/engine/config.ts';
import { meteredFetch, RpcMeter } from '../src/engine/meter.ts';
import { RequestLimiter } from '../src/engine/limiter.ts';
import { randomSignature, projectInput } from './helpers.ts';

const sig = randomSignature();
const entry = (s: string) => ({ slot: 5, transactionIndex: 1, blockTime: 9, version: 0, transaction: { signatures: [s], message: {} }, meta: { err: null } });
const answer = (result: unknown, seen: any[] = []): typeof fetch => (async (_u: unknown, init?: RequestInit) => {
  const b = JSON.parse(String(init!.body));
  seen.push(b);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result }));
}) as typeof fetch;

test('[bulk] request shape: full + json + succeeded only + slot range + finalized + newest first; answer mapped to getTransaction-shaped entries', async () => {
  const seen: any[] = [];
  const other = randomSignature();
  const rpc = new SolanaRpc({ url: 'http://x', fetch: answer({ data: [entry(sig), { nope: true }, entry(other), { transaction: { signatures: ['not-a-signature'] } }], paginationToken: '5:3' }, seen) });
  const page = await rpc.getTransactionsForAddress('MINT', { slotGte: 10, slotLte: 20, limit: 500, paginationToken: '9:9' });
  const [addr, cfg] = seen[0].params;
  assert.equal(addr, 'MINT');
  assert.deepEqual(cfg, {
    transactionDetails: 'full', encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'finalized', sortOrder: 'desc', limit: 500, paginationToken: '9:9',
    filters: { status: 'succeeded', slot: { gte: 10, lte: 20 } },
  });
  assert.deepEqual(page.transactions.map((t) => t.signature), [sig, other], 'entries that are not transactions are dropped, not guessed');
  assert.equal(page.returned, 4, 'billing counts what the node returned');
  assert.equal(page.paginationToken, '5:3');
  assert.equal((await new SolanaRpc({ url: 'http://x', fetch: answer({ data: [], paginationToken: null }) }).getTransactionsForAddress('M', { slotGte: 1, slotLte: 2 })).paginationToken, null);
});

test('[bulk] malformed answers and plan/method refusals are RpcErrors (never an empty "no transactions")', async () => {
  for (const bad of [null, {}, { data: 'x' }, { data: [], paginationToken: 5 }]) {
    await assert.rejects(() => new SolanaRpc({ url: 'http://x', fetch: answer(bad), maxRetries: 0 }).getTransactionsForAddress('M', { slotGte: 1, slotLte: 2 }), /malformed/);
  }
  const forbidden = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
  const e = await new SolanaRpc({ url: 'http://x', fetch: forbidden, maxRetries: 0 }).getTransactionsForAddress('M', { slotGte: 1, slotLte: 2 }).catch((x) => x);
  assert.ok(e instanceof RpcError);
  assert.equal(e.httpStatus, 403);
  assert.equal(e.retryable, false);
  const unavailable = (async () => new Response('x', { status: 503 })) as unknown as typeof fetch;
  const e2 = await new SolanaRpc({ url: 'http://x', fetch: unavailable, maxRetries: 0 }).getTransactionsForAddress('M', { slotGte: 1, slotLte: 2 }).catch((x) => x);
  assert.equal(e2.retryable, true);
  const noMethod = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }))) as unknown as typeof fetch;
  const e3 = await new SolanaRpc({ url: 'http://x', fetch: noMethod, maxRetries: 0 }).getTransactionsForAddress('M', { slotGte: 1, slotLte: 2 }).catch((x) => x);
  assert.ok(e3 instanceof RpcError && e3.code === -32601 && !e3.retryable);
});

test('[bulk] the meter estimates Helius billing for the bulk call: 10 credits per 100 transactions returned, 10 minimum, failures free; other methods unchanged', async () => {
  const meter = new RpcMeter({ getTransaction: 1, getTransactionsForAddress: 10 });
  const limiter = new RequestLimiter({ maxConcurrent: 4, minIntervalMs: 0 });
  const respond = (method: string, n: number): typeof fetch => (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: method === 'getTransactionsForAddress' ? { data: new Array(n).fill({}), paginationToken: null } : {} }))) as unknown as typeof fetch;
  const call = async (method: string, n = 0) => {
    const f = meteredFetch({ base: respond(method, n), project: 'p', meter, limiter });
    const res = await f('http://x', { method: 'POST', body: JSON.stringify({ method }) });
    assert.ok((await res.json()) !== undefined, 'the caller can still read the body');
  };
  await call('getTransactionsForAddress', 1000); // 100
  await call('getTransactionsForAddress', 101); // 20
  await call('getTransactionsForAddress', 3); // 10 (minimum)
  await call('getTransactionsForAddress', 0); // 10 (minimum)
  await call('getTransaction'); // 1
  const snap = meter.snapshot();
  assert.equal(snap.projects.p!.estimatedCredits, 100 + 20 + 10 + 10 + 1);
  assert.equal(snap.projects.p!.byMethod.getTransactionsForAddress!.requests, 4);
  const failing = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } }))) as unknown as typeof fetch;
  const m2 = new RpcMeter({ getTransactionsForAddress: 10 });
  await meteredFetch({ base: failing, project: 'q', meter: m2, limiter })('http://x', { method: 'POST', body: JSON.stringify({ method: 'getTransactionsForAddress' }) });
  assert.equal(m2.snapshot().projects.q!.estimatedCredits, 0, 'failed responses are not billed');
});

test('[bulk] RPC_BATCH_FETCH: auto = on only for a Helius endpoint; on / off force it; anything else is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bulkcfg-'));
  const file = join(dir, 'projects.json');
  await writeFile(file, JSON.stringify({ projects: [projectInput({ id: 'alpha' })] }));
  const base = { SOLANA_CLUSTER: 'devnet', DATABASE_URL: 'postgres://u:Pw1xyzAbc@127.0.0.1:1/x', PROJECTS_CONFIG: file };
  const flag = async (extra: Record<string, string>) => (await loadEngineConfig({ ...base, ...extra })).indexer.batchFetch;
  assert.equal(await flag({ HELIUS_API_KEY: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }), true);
  assert.equal(await flag({ SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=a1b2c3d4-e5f6' }), true);
  assert.equal(await flag({ SOLANA_RPC_URL: 'https://api.devnet.solana.com' }), false);
  assert.equal(await flag({ SOLANA_RPC_URL: 'https://api.devnet.solana.com', RPC_BATCH_FETCH: 'on' }), true);
  assert.equal(await flag({ HELIUS_API_KEY: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', RPC_BATCH_FETCH: 'off' }), false);
  await assert.rejects(() => flag({ SOLANA_RPC_URL: 'https://x.example', RPC_BATCH_FETCH: 'maybe' }), (e) => e instanceof EngineConfigError && /RPC_BATCH_FETCH/.test(e.issues.join()));
});
