/* `npm run mainnet:onboard -- <mint> [id] [name] [ticker]` — READ-ONLY pre-flight for adding a token to the engine's
 * configuration. Nothing is written, nothing is sent; Mainnet reads only (whitelisted methods).
 *
 * It answers: (1) which token program owns the mint (H2: `tokenProgram` must match), (2) can the supply proof (D8) ever
 * apply to this token — mint authority revoked, no Token-2022 confidential mint/burn, not wrapped SOL — and (3) what
 * `initialSupply` to configure: the total ever created, summed from the mint's whole history (MintTo / MintToChecked),
 * cross-checked against the on-chain supply (supply = created − burned must hold exactly). It prints a project entry ready
 * to paste into PROJECTS_CONFIG (adjust the levels). History reading costs about 1 request per signature (bounded by AUDIT_MAX_SIGS). */
import { formatUiAmount } from '../../src/core/amount.ts';
import { EXT } from '../../src/wallet/token-info.ts';
import { assertMainnet, describeMainnetRpc, engineRpc, stats } from './rpc.ts';
import { listHistory, sumHistory } from './history.ts';

const [mint, id = 'my-token', name = 'My Token', ticker = 'TOKEN'] = process.argv.slice(2);
if (!mint) { console.log('usage: npm run mainnet:onboard -- <mint address> [id] [name] [ticker]'); process.exit(2); }
const MAX_SIGS = Number(process.env.AUDIT_MAX_SIGS ?? 3000);
const NATIVE = new Set(['So11111111111111111111111111111111111111112', '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP']);

console.log(`INFO  provider: ${describeMainnetRpc()}`);
await assertMainnet();
const rpc = engineRpc();
const info = await rpc.getMintInfo(mint, 'finalized').catch((e: Error) => { console.log(`STOP  ${mint} is not a readable token mint on Mainnet (${e.message})`); process.exit(1); });
console.log(`mint            ${mint}`);
console.log(`token program   ${info.tokenProgram}   <- set tokenProgram to this (the engine refuses to start otherwise)`);
console.log(`decimals        ${info.decimals}`);
console.log(`supply now      ${info.supplyRaw} raw (${formatUiAmount(info.supplyRaw, info.decimals)})`);
console.log(`mint authority  ${info.mintAuthority ?? 'revoked'}   | freeze authority ${info.freezeAuthority ?? 'none'}`);
console.log(`extensions      ${info.extensions.map((e) => e.name).join(', ') || 'none'}`);

const blockers: string[] = [];
if (NATIVE.has(mint)) blockers.push('wrapped SOL: its supply moves with wrapping, never with mint/burn instructions');
if (info.mintAuthority !== null) blockers.push('the mint authority is still active: the supply can grow, so "initialSupply − supply" proves nothing (code mint_authority_active)');
if (info.extensions.some((e) => e.type === EXT.ConfidentialMintBurn)) blockers.push('Token-2022 ConfidentialMintBurn: some burns are invisible to this engine (code unsupported_mint_extension)');
const unknownBlocking = info.extensions.filter((e) => e.type === EXT.PausableConfig && e.data[32] !== 0);
if (unknownBlocking.length) console.log('NOTE  the mint is currently paused (Pausable): burns will fail until it is unpaused');

if (blockers.length) {
  console.log('\nVERDICT  the engine will index and count burns, but this token can NEVER show "proven complete":');
  for (const b of blockers) console.log(`  - ${b}`);
  console.log('Trust state it will show: indexed, not proven (history.reason = the code above). Do not set initialSupply.');
} else {
  const { sigs, exhausted } = await listHistory(rpc, mint, MAX_SIGS);
  console.log(`history         ${sigs.length}${exhausted ? '' : '+'} signatures${exhausted ? '' : ` (more than AUDIT_MAX_SIGS=${MAX_SIGS}: not read)`}`);
  let initial: bigint | null = null;
  if (exhausted) {
    const t = await sumHistory(rpc, mint, sigs);
    console.log(`created         ${t.minted} raw in ${t.mintOps} MintTo   | burned so far ${t.burned} raw in ${t.burnOps} burn instruction(s)   | ${t.unavailable} transaction(s) unavailable`);
    const holds = info.supplyRaw === t.minted - t.burned;
    console.log(`identity        supply (${info.supplyRaw}) = created − burned (${t.minted - t.burned}) : ${holds ? 'HOLDS' : 'DOES NOT HOLD'}`);
    if (holds && t.unavailable === 0) initial = t.minted;
    else console.log('STOP  the history does not add up to the on-chain supply: do NOT configure initialSupply from it; investigate first.');
    if (t.minted === 10n ** 15n && info.decimals === 6) console.log('note            exactly 10^9 tokens with 6 decimals: the standard Pump.fun supply');
  } else {
    console.log('STOP  history too large to sum here. For a Pump.fun token use initialSupply "1000000000" (10^9 tokens, 6 decimals: measured exactly 10^15 raw on real mints) ONLY after checking the identity above on a bounded run, or raise AUDIT_MAX_SIGS.');
  }
  console.log(`\nVERDICT  ${initial === null ? 'the proof cannot be prepared automatically (see above)' : 'the supply proof can apply: with the entry below the engine will show "proven" a few minutes after its history is read'}`);
  if (initial !== null) {
    console.log(JSON.stringify({ id, name, ticker, cluster: 'mainnet-beta', mint, decimals: info.decimals, tokenProgram: info.tokenProgram, initialSupply: formatUiAmount(initial, info.decimals), levels: [{ id: 'l0', name: 'Start', threshold: '0' }, { id: 'l1', name: 'Level 1', threshold: '1000000' }] }, null, 2));
    console.log('(startSlot must stay 0 for the proof; adjust the levels to your design)');
  }
}
console.log('\nINFO  RPC requests (local estimate, NOT billing):', JSON.stringify(stats));
