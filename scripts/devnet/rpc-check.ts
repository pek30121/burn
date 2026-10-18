/* `npm run devnet:rpc-check` — real requests against the configured Devnet RPC (Helius when HELIUS_API_KEY is set),
 * to prove the connection before running the engine: right network, version, health, history lookups, decoding of a
 * real recorded burn, latency, and whether the provider throttles. Read-only; the endpoint/key is never printed. */
import { readFileSync } from 'node:fs';
import { parseBurns } from '../../src/chain/burn-parser.ts';
import { GENESIS_HASHES } from '../../src/chain/rpc.ts';
import { Report } from './check.ts';
import { describeRpc, rpc, RpcFailure } from './rpc.ts';

const r = new Report();
r.fact('provider', describeRpc());
const fx = JSON.parse(readFileSync(new URL('../../tests/fixtures/devnet-direct-burn.json', import.meta.url), 'utf8'));
const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  return [await fn(), Math.round(performance.now() - t0)];
};

try {
  const [genesis, ms0] = await timed(() => rpc<string>('getGenesisHash'));
  r.check('the endpoint serves Solana DEVNET (genesis hash)', genesis === GENESIS_HASHES.devnet, `${ms0} ms`);
  const [ver] = await timed(() => rpc<{ 'solana-core': string }>('getVersion'));
  r.fact('node version', ver['solana-core']);
  r.check('node is healthy', (await rpc<string>('getHealth')) === 'ok');
  const slot = await rpc<number>('getSlot', [{ commitment: 'finalized' }]);
  r.check('finalized slot readable', slot > fx.response.slot, `slot ${slot}`);

  const sigs = await rpc<any[]>('getSignaturesForAddress', [fx.mint, { limit: 5, commitment: 'finalized' }]);
  r.check('getSignaturesForAddress works on a real mint', Array.isArray(sigs) && sigs.length > 0, `${sigs.length} signatures`);
  const tx = await rpc<any>('getTransaction', [fx.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
  const parsed = parseBurns(tx, { mint: fx.mint, expectedSignature: fx.signature });
  const burn = parsed.status === 'ok' ? parsed.burns.find((b) => b.instructionPath === fx.path) : undefined;
  const recorded = parseBurns(fx.response, { mint: fx.mint, expectedSignature: fx.signature });
  const expected = recorded.status === 'ok' ? recorded.burns.find((b) => b.instructionPath === fx.path)?.amountRaw : undefined;
  r.check('a real burn is fetched and decoded to the same exact amount as our recorded reference', !!burn && burn.amountRaw === expected, burn ? `${burn.amountRaw} raw` : 'not decoded');
  const supply = await rpc<any>('getTokenSupply', [fx.mint, { commitment: 'finalized' }]);
  r.check('getTokenSupply works', typeof supply.value.amount === 'string');

  const lat: number[] = [];
  let throttled = 0;
  for (let i = 0; i < 30; i++) {
    try {
      lat.push((await timed(() => rpc('getSlot', [{ commitment: 'confirmed' }])))[1]);
    } catch (e) {
      if (e instanceof RpcFailure) throttled++;
    }
  }
  lat.sort((a, b) => a - b);
  r.fact('latency of 30 sequential getSlot (ms)', { median: lat[Math.floor(lat.length / 2)], p90: lat[Math.floor(lat.length * 0.9)], failures: throttled });
  r.check('no throttling or failure on 30 sequential requests', throttled === 0 && lat.length === 30);
} catch (e) {
  const code = e instanceof RpcFailure ? e.message : 'request failed';
  r.check('RPC reachable and authenticated', false, `${code}${/40[13]|Unauthorized/.test(code) ? ' — the provider refused the credentials: check the API key' : ''}`);
}
r.finish(`rpc-check-${Date.now()}.json`);
