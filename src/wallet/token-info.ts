/* Decoding of SPL Token / Token-2022 mint and token-account data, and the decision "can this be burned from
 * a browser wallet with a plain BurnChecked?". Pure functions on raw account bytes (no RPC `jsonParsed`: like the
 * parser in src/chain, the result must not depend on a provider's decoder).
 *
 * Fail-closed policy for Token-2022 extensions: an extension that is not in the explicit lists below blocks the
 * burn ("unknown extension") instead of being assumed harmless. The engine only counts `Burn` / `BurnChecked`
 * (D6), so anything that would burn through another instruction is refused rather than silently not counted. */

import { encodeBase58 } from '../core/base58.ts';
import { TOKEN_PROGRAMS, type TokenProgram } from '../config/schema.ts';

export const MINT_BASE_LEN = 82;
export const ACCOUNT_BASE_LEN = 165;
const ACCOUNT_TYPE_OFFSET = 165;
const TLV_OFFSET = 166;

export const ACCOUNT_TYPE = { mint: 1, account: 2 } as const;

/** spl-token-2022 `ExtensionType` identifiers (by number). */
export const EXT = {
  TransferFeeConfig: 1, TransferFeeAmount: 2, MintCloseAuthority: 3, ConfidentialTransferMint: 4, ConfidentialTransferAccount: 5,
  DefaultAccountState: 6, ImmutableOwner: 7, MemoTransfer: 8, NonTransferable: 9, InterestBearingConfig: 10, CpiGuard: 11,
  PermanentDelegate: 12, NonTransferableAccount: 13, TransferHook: 14, TransferHookAccount: 15, ConfidentialTransferFeeConfig: 16,
  ConfidentialTransferFeeAmount: 17, MetadataPointer: 18, TokenMetadata: 19, GroupPointer: 20, TokenGroup: 21, GroupMemberPointer: 22,
  TokenGroupMember: 23, ConfidentialMintBurn: 24, ScaledUiAmountConfig: 25, PausableConfig: 26, PausableAccount: 27,
} as const;
const EXT_NAME = new Map<number, string>(Object.entries(EXT).map(([n, id]) => [id, n]));
export const extensionName = (type: number): string => EXT_NAME.get(type) ?? `Unknown(${type})`;

/** Extensions that do not affect burning with BurnChecked. */
const HARMLESS_MINT = new Set<number>([EXT.TransferFeeConfig, EXT.MintCloseAuthority, EXT.DefaultAccountState, EXT.NonTransferable, EXT.InterestBearingConfig, EXT.PermanentDelegate, EXT.TransferHook, EXT.MetadataPointer, EXT.TokenMetadata, EXT.GroupPointer, EXT.TokenGroup, EXT.GroupMemberPointer, EXT.TokenGroupMember]);
/** Burn still works, but the user must be told something. */
const WARN_MINT = new Map<number, string>([
  [EXT.ConfidentialTransferMint, 'confidential_balance_not_burnable'],
  [EXT.ConfidentialTransferFeeConfig, 'confidential_balance_not_burnable'],
  [EXT.ScaledUiAmountConfig, 'ui_amount_scaled'],
]);
const HARMLESS_ACCOUNT = new Set<number>([EXT.TransferFeeAmount, EXT.ImmutableOwner, EXT.MemoTransfer, EXT.CpiGuard, EXT.NonTransferableAccount, EXT.TransferHookAccount, EXT.ConfidentialTransferFeeAmount, EXT.PausableAccount]);

export interface Extension {
  readonly type: number;
  readonly name: string;
  readonly data: Uint8Array;
}

export interface MintInfo {
  readonly tokenProgram: TokenProgram;
  readonly supplyRaw: bigint;
  readonly decimals: number;
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
  readonly extensions: readonly Extension[];
}

export interface TokenAccountInfo {
  readonly address: string;
  readonly tokenProgram: TokenProgram;
  readonly mint: string;
  readonly owner: string;
  readonly amountRaw: bigint;
  readonly delegate: string | null;
  readonly state: 'initialized' | 'frozen';
  readonly isNative: boolean;
  readonly extensions: readonly Extension[];
}

export class TokenDataError extends Error {
  override name = 'TokenDataError';
}

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const optKey = (d: Uint8Array, flagAt: number, keyAt: number): string | null =>
  view(d).getUint32(flagAt, true) === 1 ? encodeBase58(d.slice(keyAt, keyAt + 32)) : null;

export function programFromOwner(owner: string): TokenProgram | null {
  for (const [name, id] of Object.entries(TOKEN_PROGRAMS)) if (id === owner) return name as TokenProgram;
  return null;
}

function readExtensions(data: Uint8Array, expectedType: number, base: number): Extension[] {
  if (data.length === base) return [];
  if (data.length <= ACCOUNT_TYPE_OFFSET) throw new TokenDataError('account data has an unexpected length');
  if (data[ACCOUNT_TYPE_OFFSET] !== expectedType) throw new TokenDataError('account type does not match');
  const out: Extension[] = [];
  let pos = TLV_OFFSET;
  while (pos + 4 <= data.length) {
    const type = data[pos]! | (data[pos + 1]! << 8);
    const len = data[pos + 2]! | (data[pos + 3]! << 8);
    if (type === 0) break; // uninitialized: end of the extension area
    if (pos + 4 + len > data.length) throw new TokenDataError('extension data is truncated');
    out.push({ type, name: extensionName(type), data: data.slice(pos + 4, pos + 4 + len) });
    pos += 4 + len;
  }
  return out;
}

export function parseMint(owner: string, data: Uint8Array): MintInfo {
  const tokenProgram = programFromOwner(owner);
  if (!tokenProgram) throw new TokenDataError('the account is not owned by a token program');
  if (data.length < MINT_BASE_LEN) throw new TokenDataError('mint data is too short');
  if (data[45] !== 1) throw new TokenDataError('the mint is not initialized');
  if (tokenProgram === 'spl-token' && data.length !== MINT_BASE_LEN) throw new TokenDataError('mint data has an unexpected length');
  return {
    tokenProgram,
    supplyRaw: view(data).getBigUint64(36, true),
    decimals: data[44]!,
    mintAuthority: optKey(data, 0, 4),
    freezeAuthority: optKey(data, 46, 50),
    extensions: tokenProgram === 'token-2022' ? readExtensions(data, ACCOUNT_TYPE.mint, MINT_BASE_LEN) : [],
  };
}

export function parseTokenAccount(address: string, owner: string, data: Uint8Array): TokenAccountInfo {
  const tokenProgram = programFromOwner(owner);
  if (!tokenProgram) throw new TokenDataError('the account is not owned by a token program');
  if (data.length < ACCOUNT_BASE_LEN) throw new TokenDataError('token account data is too short');
  if (tokenProgram === 'spl-token' && data.length !== ACCOUNT_BASE_LEN) throw new TokenDataError('token account data has an unexpected length');
  const state = data[108];
  if (state !== 1 && state !== 2) throw new TokenDataError('the token account is not initialized');
  return {
    address,
    tokenProgram,
    mint: encodeBase58(data.slice(0, 32)),
    owner: encodeBase58(data.slice(32, 64)),
    amountRaw: view(data).getBigUint64(64, true),
    delegate: optKey(data, 72, 76),
    state: state === 2 ? 'frozen' : 'initialized',
    isNative: view(data).getUint32(109, true) === 1,
    extensions: tokenProgram === 'token-2022' ? readExtensions(data, ACCOUNT_TYPE.account, ACCOUNT_BASE_LEN) : [],
  };
}

export type BurnBlock =
  | 'unknown_extension' | 'confidential_mint_burn' | 'mint_paused' | 'malformed_extension'
  | 'account_frozen' | 'native_account' | 'wrong_mint' | 'wrong_owner' | 'wrong_program';
export type BurnWarning = 'confidential_balance_not_burnable' | 'ui_amount_scaled' | 'delegate_present' | 'permanent_delegate';

export interface BurnEligibility {
  readonly canBurn: boolean;
  readonly blocks: readonly { code: BurnBlock; detail?: string }[];
  readonly warnings: readonly BurnWarning[];
  /** What the user can actually burn from this account right now: 0 when it cannot be burned at all. */
  readonly availableRaw: bigint;
}

export function assessBurn(mintAddress: string, mint: MintInfo, account: TokenAccountInfo, owner: string): BurnEligibility {
  const blocks: { code: BurnBlock; detail?: string }[] = [];
  const warnings = new Set<BurnWarning>();
  if (account.mint !== mintAddress) blocks.push({ code: 'wrong_mint' });
  if (account.owner !== owner) blocks.push({ code: 'wrong_owner' });
  if (account.tokenProgram !== mint.tokenProgram) blocks.push({ code: 'wrong_program' });
  if (account.state === 'frozen') blocks.push({ code: 'account_frozen' });
  if (account.isNative) blocks.push({ code: 'native_account' });
  for (const e of mint.extensions) {
    if (e.type === EXT.ConfidentialMintBurn) blocks.push({ code: 'confidential_mint_burn', detail: e.name });
    else if (e.type === EXT.PausableConfig) {
      // PausableConfig: authority (32 bytes) then a `paused` flag.
      if (e.data.length !== 33) blocks.push({ code: 'malformed_extension', detail: e.name });
      else if (e.data[32] !== 0) blocks.push({ code: 'mint_paused' });
    } else if (WARN_MINT.has(e.type)) warnings.add(WARN_MINT.get(e.type) as BurnWarning);
    else if (!HARMLESS_MINT.has(e.type)) blocks.push({ code: 'unknown_extension', detail: e.name });
    if (e.type === EXT.PermanentDelegate) warnings.add('permanent_delegate');
  }
  for (const e of account.extensions) {
    if (e.type === EXT.ConfidentialTransferAccount) warnings.add('confidential_balance_not_burnable');
    else if (!HARMLESS_ACCOUNT.has(e.type)) blocks.push({ code: 'unknown_extension', detail: e.name });
  }
  if (account.delegate !== null) warnings.add('delegate_present');
  const canBurn = blocks.length === 0;
  return { canBurn, blocks, warnings: [...warnings], availableRaw: canBurn ? account.amountRaw : 0n };
}
