/* `npm run virus:prelaunch` — READ-ONLY dry run of what the engine will decide for the pending VIRUS project
 * (deploy/projects.mainnet.json). It runs the engine's OWN activation code (src/engine/activation.ts) against Mainnet reads
 * (whitelisted methods, nothing written, no transaction) and prints the verdict and the project the engine would start.
 * The engine does this by itself, without a restart, as soon as the mint exists: this script only lets you look first.
 * Exit codes: 0 = would activate; 3 = mint not created / not finalized yet; 1 = would be BLOCKED (explicit code); 2 = bad config. */
import { ProjectRegistry } from '../../src/config/registry.ts';
import { activateProject } from '../../src/config/schema.ts';
import { formatUiAmount } from '../../src/core/amount.ts';
import { assessMint, assessSupply } from '../../src/engine/activation.ts';
import { readMintHistory } from '../../src/chain/mint-history.ts';
import { assertMainnet, describeMainnetRpc, engineRpc, stats } from './rpc.ts';

const file = process.argv[2] ?? 'deploy/projects.mainnet.json';
const id = process.argv[3] ?? 'virus';
const pending = (await ProjectRegistry.fromFile(file)).getPending(id);
if (!pending) { console.log(`STOP  ${file} has no pending project "${id}" (declared with "awaitMint": true)`); process.exit(2); }
console.log(`INFO  provider: ${describeMainnetRpc()}`);
console.log(`CONFIG  ${pending.id}: mint ${pending.mint} (valid address), ${pending.template.levels ? (pending.template.levels as unknown[]).length : 0} levels, expectations ${JSON.stringify(pending.expect)}`);
await assertMainnet();
const rpc = engineRpc();
function done(code: number): never {
  console.log('INFO  RPC requests (local estimate, NOT billing):', JSON.stringify(stats));
  process.exit(code);
}

if ((await rpc.getAccountOwner(pending.mint, 'finalized')) === null) {
  const seen = (await rpc.getAccountOwner(pending.mint, 'confirmed')) !== null;
  console.log(seen ? 'STATE  the account exists at confirmed but is NOT finalized yet: the engine waits for finalization.' : 'STATE  NOT CREATED on Mainnet yet (no account at finalized nor confirmed). The engine keeps watching and starts by itself.');
  done(3);
}
const info = await rpc.getMintInfo(pending.mint, 'finalized');
console.log(`STATE  exists (finalized). token program ${info.tokenProgram} | decimals ${info.decimals} | supply ${info.supplyRaw} raw (${formatUiAmount(info.supplyRaw, info.decimals)}) | mint authority ${info.mintAuthority ?? 'revoked'} | freeze authority ${info.freezeAuthority ?? 'none'} | extensions ${info.extensions.map((e) => e.name).join(', ') || 'none'}`);
const first = assessMint(pending, info);
if (first) { console.log(`VERDICT  the engine would BLOCK this project: ${first.code} — ${first.detail}`); done(1); }
const history = await readMintHistory(rpc, pending.mint, Number(process.env.PENDING_MAX_HISTORY_SIGNATURES ?? 1500));
console.log(`HISTORY  ${history.signatures} signatures, ${history.complete ? `created ${history.createdRaw} raw, burned so far ${history.burnedRaw} raw` : 'too long or unreadable: the creation supply cannot be derived'}`);
const supply = assessSupply(pending, info, history);
if (supply.blocked) { console.log(`VERDICT  the engine would BLOCK this project: ${supply.blocked.code} — ${supply.blocked.detail}`); done(1); }
const project = activateProject(pending, { decimals: info.decimals, tokenProgram: info.tokenProgram, initialSupply: supply.initialSupplyRaw === null ? null : formatUiAmount(supply.initialSupplyRaw, info.decimals) });
console.log(`VERDICT  the engine would ACTIVATE: token program ${project.tokenProgram}, decimals ${project.decimals}, initial supply ${supply.initialSupplyRaw === null ? 'unknown (supply proof unavailable)' : formatUiAmount(supply.initialSupplyRaw, info.decimals)}, levels ${project.levels.map((l) => `${l.id}@${l.thresholdRaw}`).join(' ')}`);
for (const w of supply.warnings) console.log(`WARN  ${w}`);
done(0);
