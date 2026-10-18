import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEngineConfig, EngineConfigError } from '../src/engine/config.ts';
import { EngineStartError, startEngine } from '../src/engine/engine.ts';
import { createLogger } from '../src/engine/logger.ts';
import { redact } from '../src/db/errors.ts';
import { GENESIS_HASHES } from '../src/chain/rpc.ts';
import { projectInput } from './helpers.ts';

const KEY = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const DB_PW = 'DbPassw0rdXyz';

async function env(over: Record<string, string | undefined> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rpcep-'));
  const file = join(dir, 'projects.json');
  await writeFile(file, JSON.stringify({ projects: [projectInput({ id: 'alpha' })] }));
  return { SOLANA_CLUSTER: 'devnet', DATABASE_URL: `postgres://u:${DB_PW}@127.0.0.1:1/x`, PG_CONNECTION_TIMEOUT_MS: '300', PROJECTS_CONFIG: file, ...over } as Record<string, string | undefined>;
}
const issuesOf = async (e: Record<string, string | undefined>) => {
  try {
    await loadEngineConfig(e);
  } catch (err) {
    assert.ok(err instanceof EngineConfigError);
    return err.issues.join('\n');
  }
  assert.fail('expected EngineConfigError');
};

test('HELIUS_API_KEY alone is enough: the host follows SOLANA_CLUSTER (devnet -> devnet host)', async () => {
  const dev = await loadEngineConfig(await env({ HELIUS_API_KEY: KEY }));
  assert.equal(dev.rpc.url, `https://devnet.helius-rpc.com/?api-key=${KEY}`);
});

test('the Helius host is derived from the cluster only (pure configuration, no request is made)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rpcep-'));
  const file = join(dir, 'projects.json');
  await writeFile(file, JSON.stringify({ projects: [projectInput({ id: 'alpha', cluster: 'mainnet-beta' })] }));
  const main = await loadEngineConfig({ ...(await env({ HELIUS_API_KEY: KEY })), SOLANA_CLUSTER: 'mainnet-beta', PROJECTS_CONFIG: file });
  assert.equal(main.rpc.url, `https://mainnet.helius-rpc.com/?api-key=${KEY}`);
  // a Devnet project on a Mainnet-configured engine is refused, never silently served by the wrong host
  assert.match(await issuesOf({ ...(await env({ HELIUS_API_KEY: KEY })), SOLANA_CLUSTER: 'mainnet-beta' }), /not on SOLANA_CLUSTER=mainnet-beta/);
});

test('conflicting or malformed endpoint settings are refused, and no message ever contains the key', async () => {
  const both = await issuesOf(await env({ HELIUS_API_KEY: KEY, SOLANA_RPC_URL: `https://devnet.helius-rpc.com/?api-key=${KEY}` }));
  assert.match(both, /both set/);
  assert.doesNotMatch(both, new RegExp(KEY));
  for (const bad of ['short', 'has space in it ok', 'weird/../chars?x=1&y', 'a'.repeat(200)]) {
    const t = await issuesOf(await env({ HELIUS_API_KEY: bad }));
    assert.match(t, /HELIUS_API_KEY: unexpected format/, bad);
    assert.doesNotMatch(t, new RegExp(bad.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), 'the value is not echoed');
  }
  assert.match(await issuesOf(await env()), /SOLANA_RPC_URL: is not set \(or set HELIUS_API_KEY\)/);
});

test('once configured, the key and the URL are masked in every log line and error', async () => {
  await loadEngineConfig(await env({ HELIUS_API_KEY: KEY }));
  assert.doesNotMatch(redact(`GET https://devnet.helius-rpc.com/?api-key=${KEY} failed; key ${KEY}`), new RegExp(KEY));
  const lines: string[] = [];
  createLogger({ write: (l) => lines.push(l) }).error('x', { error: `url=https://devnet.helius-rpc.com/?api-key=${KEY}`, other: KEY });
  assert.doesNotMatch(lines[0]!, new RegExp(KEY));
});

/* ----------------- startup guard: the endpoint must serve the configured cluster ----------------- */

const log = createLogger({ write: () => {} });
const answer = (genesis: string): typeof fetch => (async (_u: unknown, init?: RequestInit) => {
  const { id, method } = JSON.parse(init!.body as string);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: method === 'getGenesisHash' ? genesis : null }), { status: 200 });
}) as typeof fetch;

test('guard: an endpoint on another cluster (e.g. Mainnet) is refused before anything else is touched', async () => {
  const cfg = await loadEngineConfig(await env({ HELIUS_API_KEY: KEY }));
  const err = await startEngine(cfg, { log, fetch: answer(GENESIS_HASHES['mainnet-beta']) }).catch((e) => e);
  assert.ok(err instanceof EngineStartError);
  assert.match(err.message, /does not serve devnet \(genesis hash mismatch\)/);
  assert.doesNotMatch(err.message + err.stack, new RegExp(`${KEY}|helius-rpc|${DB_PW}`));
});

test('guard: refused credentials give an explicit hint and leak nothing', async () => {
  const cfg = await loadEngineConfig(await env({ HELIUS_API_KEY: KEY }));
  const unauthorized = (async () => new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch;
  const err = await startEngine(cfg, { log, fetch: unauthorized }).catch((e) => e);
  assert.ok(err instanceof EngineStartError);
  assert.match(err.message, /HTTP 401/);
  assert.match(err.message, /check the API key/);
  assert.doesNotMatch(err.message + err.stack, new RegExp(`${KEY}|helius-rpc`));
});

test('guard: a network failure is reported without the URL', async () => {
  const cfg = await loadEngineConfig(await env({ HELIUS_API_KEY: KEY }));
  const down = (async () => { throw new TypeError(`fetch failed for https://devnet.helius-rpc.com/?api-key=${KEY}`); }) as unknown as typeof fetch;
  const err = await startEngine(cfg, { log, fetch: down }).catch((e) => e);
  assert.ok(err instanceof EngineStartError && /cannot verify the RPC endpoint/.test(err.message));
  assert.doesNotMatch(err.message + err.stack, new RegExp(`${KEY}|helius-rpc`));
});

test('guard: the right cluster passes (the next failure is the database, which proves the guard came first and succeeded)', async () => {
  const cfg = await loadEngineConfig(await env({ HELIUS_API_KEY: KEY }));
  const err = await startEngine(cfg, { log, fetch: answer(GENESIS_HASHES.devnet) }).catch((e) => e);
  assert.ok(err instanceof EngineStartError && /database is not reachable/.test(err.message), String(err?.message));
  assert.doesNotMatch(err.message + err.stack, new RegExp(`${KEY}|${DB_PW}`));
});
