/* `npm run virus:prelaunch` — READ-ONLY pre-launch check of the VIRUS.EXE mint (deploy/virus.prelaunch.json). Mainnet reads only
 * (whitelisted methods), nothing is written, no transaction. Exit codes: 0 = mint exists, finalized and clean; 3 = not created (yet) or
 * not finalized yet: do NOT add the project to the engine configuration (the engine refuses to start when a configured mint does not
 * exist, which would stop every project); 1 = the mint exists but is not acceptable; 2 = bad record. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { decodeBase58, isPublicKey } from '../../src/core/base58.ts';
import { formatUiAmount } from '../../src/core/amount.ts';
import { assertMainnet, describeMainnetRpc, engineRpc, stats } from './rpc.ts';
import { assessMint } from './prelaunch-check.ts';

const rec = JSON.parse(readFileSync(new URL('../../deploy/virus.prelaunch.json', import.meta.url), 'utf8')) as { id: string; name: string; ticker: string; mint: string };
console.log(`INFO  provider: ${describeMainnetRpc()}`);
if (!isPublicKey(rec.mint) || decodeBase58(rec.mint)?.length !== 32) { console.log(`STOP  ${rec.mint} is not a valid Solana address`); process.exit(2); }
console.log(`FORMAT  ${rec.mint}: valid base58, 32 bytes${rec.mint.endsWith('pump') ? ', Pump.fun vanity suffix' : ''}`);
await assertMainnet();
const rpc = engineRpc();
const finalized = await rpc.getAccountOwner(rec.mint, 'finalized');
if (finalized === null) {
  const confirmed = await rpc.getAccountOwner(rec.mint, 'confirmed');
  console.log(confirmed === null
    ? 'STATE  NOT CREATED on Mainnet yet (no account at finalized nor confirmed). Expected before the first buy. Do not add the project to the engine yet.'
    : 'STATE  the account exists at confirmed but is NOT finalized yet: wait a minute and run again. Do not add the project to the engine yet.');
  console.log('INFO  RPC requests (local estimate, NOT billing):', JSON.stringify(stats));
  process.exit(3);
}
const info = await rpc.getMintInfo(rec.mint, 'finalized');
console.log(`STATE  exists (finalized). token program ${info.tokenProgram} | decimals ${info.decimals} | supply ${info.supplyRaw} raw (${formatUiAmount(info.supplyRaw, info.decimals)}) | mint authority ${info.mintAuthority ?? 'revoked'} | freeze authority ${info.freezeAuthority ?? 'none'}`);
const a = assessMint(rec.mint, info);
for (const w of a.warnings) console.log(`WARN  ${w}`);
for (const b of a.blockers) console.log(`BLOCK  ${b}`);
if (a.blockers.length) { console.log('VERDICT  not acceptable as it is.'); process.exit(1); }
console.log(`VERDICT  clean${a.matchesReference ? ', identical to the reference (6 decimals, 10^9 tokens)' : ' but DIFFERENT from the reference: read the warnings'}. Entry derived from the chain (initialSupply checked against the mint history):\n`);
const r = spawnSync(process.execPath, ['scripts/mainnet/onboard.ts', rec.mint, rec.id, rec.name, rec.ticker], { stdio: 'inherit', env: process.env });
console.log('\nNEXT  replace the two placeholder levels of the printed entry with the 7 levels of deploy/virus.prelaunch.json, add it to deploy/projects.mainnet.json (FLAPY untouched), then follow docs/VIRUS-INTEGRATION.md.');
process.exit(r.status ?? 1);
