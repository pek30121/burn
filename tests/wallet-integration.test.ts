/* Wallet module against REAL components of this repo: the real public HTTP API (read-only, in-memory source) through
 * the real engine client, and the real JSON-RPC client against a stubbed `fetch`. No network. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '../scripts/devnet/chain.ts';
import { GENESIS_HASHES } from '../src/chain/rpc.ts';
import { encodeBase58 } from '../src/core/base58.ts';
import { TOKEN_PROGRAMS } from '../src/config/schema.ts';
import { createBurnController } from '../src/wallet/controller.ts';
import { createEngineClient, EngineApiError } from '../src/wallet/engine-client.ts';
import { createJsonRpc, WalletRpcError } from '../src/wallet/rpc.ts';
import { createWalletRegistry } from '../src/wallet/wallet-standard.ts';
import { alphaCfg, MemoryApiSource, startTestApi } from './api-helpers.ts';
import { FakeRpc, fakeWindow, mintBytes, MockWallet, tokenAccountBytes } from './wallet-helpers.ts';
import { randomPubkey, randomSignature } from './helpers.ts';

test('[wallet-api] the engine client reads the real public API; amounts stay exact strings and only burn events are returned', async () => {
  const source = new MemoryApiSource(['alpha', 'beta']);
  const t = await startTestApi(source);
  try {
    const client = createEngineClient({ baseUrl: t.url, projectId: 'alpha' });
    assert.equal((await client.getStatus()).finalizedRaw, 0n);
    source.addBurn('alpha', 123_456_789_012_345_678n);
    source.addMutation('alpha', 'l1', 1);
    source.addBurn('alpha', 5n);
    const st = await client.getStatus();
    assert.equal(st.finalizedRaw, 123_456_789_012_345_683n);
    assert.equal(st.latestEventId, '3');
    const page = await client.eventsAfter('0');
    assert.deepEqual(page.burns.map((b) => b.amountRaw), [123_456_789_012_345_678n, 5n]);
    assert.deepEqual(page.burns.map((b) => b.eventId), ['1', '3']); // the mutation event (id 2) is not a burn
    assert.equal((await client.eventsAfter('3')).burns.length, 0);
    await assert.rejects(() => createEngineClient({ baseUrl: t.url, projectId: 'nope' }).getStatus(), EngineApiError);
    await assert.rejects(() => client.eventsAfter('x'), EngineApiError);
  } finally {
    await t.close();
  }
});

test('[wallet-api] end to end with the real API: counted ONLY when the engine journal lists the signature; the counter then comes from the API', async () => {
  const user = Keypair.generate();
  const MINT = alphaCfg.mint;
  const source = new MemoryApiSource(['alpha', 'beta']);
  const t = await startTestApi(source);
  try {
    const rpc = new FakeRpc(GENESIS_HASHES.devnet);
    rpc.accounts.set(MINT, { owner: TOKEN_PROGRAMS['spl-token'], lamports: 1n, data: mintBytes({ decimals: 6, supply: 10n ** 12n }) });
    rpc.tokenAccounts = [{ address: randomPubkey(), account: { owner: TOKEN_PROGRAMS['spl-token'], lamports: 1n, data: tokenAccountBytes({ mint: MINT, owner: user.address, amount: 80_000_000n }) } }];
    rpc.balances.set(user.address, 1_000_000_000n);
    const win = fakeWindow();
    win.registerWallet(new MockWallet('Solflare', [user]));
    let sentSignature = '';
    rpc.onSend = (b64) => { sentSignature = encodeBase58(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).slice(1, 65)); };
    const c = createBurnController({
      project: { id: 'alpha', mint: MINT, cluster: 'devnet', tokenProgram: 'spl-token', decimals: 6 }, registry: createWalletRegistry(win), rpc,
      engine: createEngineClient({ baseUrl: t.url, projectId: 'alpha' }), pollMs: 5, engineTimeoutMs: 5_000, txTimeoutMs: 5_000,
    });
    await c.connect('Solflare');
    c.setAmount('20');
    const preview = (await c.prepare())!;
    // The "engine" counts the burn a little later, exactly like the real indexer after finalization: it writes the journal.
    const counting = new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (!sentSignature) return;
        clearInterval(iv);
        setTimeout(() => {
          const seq = source.addBurn('alpha', 20_000_000n);
          const burn = (source.events.get('alpha')![seq - 1] as any).burn;
          burn.signature = sentSignature; // the journal row for OUR transaction
          resolve();
        }, 40);
      }, 2);
    });
    await c.confirm(preview.id);
    await counting;
    const s = c.getState();
    assert.equal(s.tx.phase, 'finalized');
    assert.equal(s.engine.phase, 'counted');
    assert.equal(s.counter.engine?.finalizedRaw, 20_000_000n);
  } finally {
    await t.close();
  }
});

test('[wallet-rpc] the JSON-RPC client decodes accounts exactly, never puts the URL in an error, and fails closed on malformed replies', async () => {
  const URL_WITH_KEY = 'https://rpc.example/?api-key=SECRET-KEY-123';
  const data = tokenAccountBytes({ mint: randomPubkey(), owner: randomPubkey(), amount: 5n });
  const reply = (result: unknown, status = 200) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status });
  const routes: Record<string, (params: any[]) => Response> = {
    getBalance: () => reply({ value: 123456789012345678 }),
    getAccountInfo: () => reply({ value: { owner: TOKEN_PROGRAMS['spl-token'], lamports: 7, data: [Buffer.from(data).toString('base64'), 'base64'] } }),
    getLatestBlockhash: () => reply({ value: { blockhash: 'abc', lastValidBlockHeight: 99 } }),
    getFeeForMessage: () => reply({ value: 5000 }),
    simulateTransaction: () => reply({ value: { err: { InstructionError: [0, { Custom: 1 }] }, logs: ['a'], unitsConsumed: 12 } }),
    getSignatureStatuses: () => reply({ value: [{ slot: 3, err: null, confirmationStatus: 'finalized' }] }),
    getTokenAccountsByOwner: () => reply({ value: [{ pubkey: 'P', account: { owner: TOKEN_PROGRAMS['spl-token'], lamports: 1, data: [Buffer.from(data).toString('base64'), 'base64'] } }] }),
    sendTransaction: () => reply('SIG'),
    getBlockHeight: () => reply(1234),
    getGenesisHash: () => reply('hash'),
  };
  const calls: any[] = [];
  const fetchStub = (async (_u: string, init: RequestInit) => { const b = JSON.parse(String(init.body)); calls.push(b); return routes[b.method]!(b.params); }) as typeof fetch;
  const rpc = createJsonRpc({ url: URL_WITH_KEY, fetch: fetchStub });
  assert.equal((await rpc.getAccountInfo('x'))?.data.length, 165);
  assert.equal((await rpc.getAccountInfo('x'))?.lamports, 7n);
  assert.deepEqual(await rpc.getLatestBlockhash('confirmed'), { blockhash: 'abc', lastValidBlockHeight: 99 });
  assert.equal(await rpc.getFeeForMessage('m'), 5000n);
  assert.deepEqual((await rpc.simulateTransaction('t')).err, { InstructionError: [0, { Custom: 1 }] });
  assert.equal((await rpc.getSignatureStatus('s'))?.confirmationStatus, 'finalized');
  assert.equal((await rpc.getTokenAccountsByOwner('o', TOKEN_PROGRAMS['spl-token']))[0]!.address, 'P');
  assert.equal(await rpc.sendTransaction('t'), 'SIG');
  assert.equal(await rpc.getBlockHeight('confirmed'), 1234);
  assert.equal(calls.find((c) => c.method === 'sendTransaction').params[1].skipPreflight, false, 'preflight stays on');
  assert.equal(calls.find((c) => c.method === 'simulateTransaction').params[1].sigVerify, false);

  for (const failing of [
    (async () => { throw new Error(`connect ECONNREFUSED ${URL_WITH_KEY}`); }) as unknown as typeof fetch,
    (async () => new Response('x', { status: 503 })) as unknown as typeof fetch,
    (async () => new Response(JSON.stringify({ error: { code: -32002, message: `bad ${URL_WITH_KEY}` } }))) as unknown as typeof fetch,
    (async () => new Response('not json')) as unknown as typeof fetch,
    (async () => new Response(JSON.stringify({ jsonrpc: '2.0' }))) as unknown as typeof fetch,
  ]) {
    await assert.rejects(() => createJsonRpc({ url: URL_WITH_KEY, fetch: failing }).getBalance('a'), (e) => {
      assert.ok(e instanceof WalletRpcError);
      assert.doesNotMatch(String(e.message) + JSON.stringify(e.data ?? ''), /SECRET-KEY|rpc\.example/);
      return true;
    });
  }
  const bad = createJsonRpc({ url: URL_WITH_KEY, fetch: (async () => reply({ value: { owner: 5, data: 'x' } })) as unknown as typeof fetch });
  await assert.rejects(() => bad.getAccountInfo('x'), WalletRpcError);
  void randomSignature;
});
