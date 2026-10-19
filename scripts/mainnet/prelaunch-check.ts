/* Pure assessment of a mint read from the chain, for the VIRUS.EXE pre-launch check (no I/O). Nothing is assumed about the token:
 * decimals, token program and supply come from `info`; the 1,000,000,000 / 6-decimals reference behind the level thresholds is only
 * COMPARED with them (a difference is reported, never silently accepted). */
import { EXT, type MintInfo } from '../../src/wallet/token-info.ts';

export const REFERENCE_SUPPLY_RAW = 10n ** 15n;
export const REFERENCE_DECIMALS = 6;
const NATIVE = new Set(['So11111111111111111111111111111111111111112', '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP']);

export interface Assessment { blockers: string[]; warnings: string[]; matchesReference: boolean }

export function assessMint(mint: string, info: MintInfo): Assessment {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (NATIVE.has(mint)) blockers.push('wrapped SOL: never a burnable project token');
  if (info.mintAuthority !== null) blockers.push('the mint authority is still ACTIVE: supply can grow, the supply proof can never apply (mint_authority_active); do not onboard before it is revoked');
  if (info.extensions.some((e) => e.type === EXT.ConfidentialMintBurn)) blockers.push('Token-2022 ConfidentialMintBurn: some burns would be invisible to the engine');
  if (info.freezeAuthority !== null) warnings.push('a freeze authority exists: the creator could freeze holder accounts and block their burns');
  if (info.extensions.length > 0) warnings.push(`extensions present: ${info.extensions.map((e) => e.name).join(', ')} (review each; unknown Token-2022 extensions are blocked by the wallet module)`);
  const matchesReference = info.decimals === REFERENCE_DECIMALS && info.supplyRaw === REFERENCE_SUPPLY_RAW;
  if (!matchesReference) warnings.push(`decimals ${info.decimals} / supply ${info.supplyRaw} raw differ from the reference (6 decimals, 10^15 raw = 10^9 tokens): the level percentages no longer hold, re-decide the thresholds before onboarding (never change them silently)`);
  return { blockers, warnings, matchesReference };
}
