/* Human-readable errors for the burn flow. Every failure surfaces as `{ code, message }`: the code is stable
 * (for the integrator's own translations), the message is a default in French that can be overridden.
 * Messages never include URLs, keys or raw provider text. */

export type BurnErrorCode =
  | 'no_wallet' | 'wallet_not_connected' | 'user_rejected' | 'wallet_error' | 'wrong_network' | 'rpc_wrong_network' | 'rpc_unavailable'
  | 'token_not_found' | 'token_program_mismatch' | 'token_blocked' | 'no_token_account' | 'account_frozen' | 'insufficient_token_balance'
  | 'amount_invalid' | 'amount_too_many_decimals' | 'amount_zero' | 'amount_too_large' | 'insufficient_sol'
  | 'preview_missing' | 'preview_stale' | 'preview_expired' | 'account_changed' | 'simulation_failed' | 'signed_message_mismatch'
  | 'send_failed' | 'blockhash_expired' | 'transaction_failed' | 'busy' | 'engine_unavailable';

export const DEFAULT_MESSAGES: Readonly<Record<BurnErrorCode, string>> = {
  no_wallet: 'Aucun portefeuille Solana compatible n’a été détecté. Installez Phantom ou Solflare, puis rechargez la page.',
  wallet_not_connected: 'Connectez d’abord votre portefeuille.',
  user_rejected: 'Vous avez refusé la demande dans votre portefeuille. Rien n’a été envoyé.',
  wallet_error: 'Le portefeuille a signalé une erreur. Rien n’a été envoyé.',
  wrong_network: 'Votre portefeuille n’est pas sur le bon réseau Solana. Changez de réseau dans le portefeuille puis réessayez.',
  rpc_wrong_network: 'Le nœud RPC configuré ne correspond pas au réseau attendu. Le burn est bloqué par sécurité.',
  rpc_unavailable: 'Le réseau Solana est momentanément injoignable. Réessayez dans un instant.',
  token_not_found: 'Ce token est introuvable sur le réseau choisi.',
  token_program_mismatch: 'Le programme du token on-chain ne correspond pas à la configuration du projet.',
  token_blocked: 'Ce token ne peut pas être brûlé depuis cette interface (extension Token-2022 incompatible).',
  no_token_account: 'Votre portefeuille ne détient aucun compte pour ce token.',
  account_frozen: 'Votre compte de ce token est gelé : il ne peut pas être brûlé.',
  insufficient_token_balance: 'Montant supérieur au solde disponible de ce token.',
  amount_invalid: 'Montant invalide. Saisissez un nombre positif, par exemple 12.5.',
  amount_too_many_decimals: 'Trop de décimales pour ce token.',
  amount_zero: 'Le montant à brûler doit être supérieur à zéro.',
  amount_too_large: 'Montant trop grand.',
  insufficient_sol: 'Solde SOL insuffisant pour payer les frais de réseau.',
  preview_missing: 'Prévisualisez d’abord le burn avant de le confirmer.',
  preview_stale: 'Le montant ou le compte a changé depuis la prévisualisation. Prévisualisez à nouveau.',
  preview_expired: 'La prévisualisation a expiré. Prévisualisez à nouveau pour obtenir des frais et un bloc à jour.',
  account_changed: 'Le compte du portefeuille a changé. Vérifiez le nouveau compte et recommencez.',
  simulation_failed: 'La simulation du burn a échoué : la transaction serait refusée. Rien n’a été envoyé.',
  signed_message_mismatch: 'Le portefeuille a renvoyé une transaction différente de celle prévisualisée. Elle n’a pas été envoyée.',
  send_failed: 'L’envoi de la transaction a échoué. Vérifiez votre connexion ; si elle a été envoyée, elle apparaîtra dans votre portefeuille.',
  blockhash_expired: 'La transaction a expiré avant d’être confirmée et n’a pas été exécutée. Aucun token n’a été brûlé ; vous pouvez réessayer.',
  transaction_failed: 'La transaction a été rejetée par le réseau. Aucun token n’a été brûlé.',
  busy: 'Une opération est déjà en cours.',
  engine_unavailable: 'Le compteur est momentanément indisponible. Votre burn reste valable on-chain.',
};

export class BurnFlowError extends Error {
  override name = 'BurnFlowError';
  readonly code: BurnErrorCode;
  readonly detail: string | undefined;
  constructor(code: BurnErrorCode, detail?: string) {
    super(DEFAULT_MESSAGES[code]);
    this.code = code;
    this.detail = detail;
  }
}

/** SPL Token program errors (`InstructionError: Custom n`), as shown to the user. */
export const TOKEN_PROGRAM_ERRORS: Readonly<Record<number, string>> = {
  1: 'Solde insuffisant sur le compte de token.',
  3: 'Le compte de token ne correspond pas à ce token.',
  4: 'Vous n’êtes pas propriétaire de ce compte de token.',
  10: 'Les tokens SOL natifs (wSOL) ne peuvent pas être brûlés.',
  17: 'Le compte de token est gelé.',
  18: 'Les décimales du token ne correspondent pas à celles attendues.',
};

/** Message for an on-chain/simulated `err` value. Unknown errors get a generic text (never raw provider output). */
export function describeTxError(err: unknown): string {
  const ie = (err as { InstructionError?: unknown })?.InstructionError;
  if (Array.isArray(ie) && typeof ie[1] === 'object' && ie[1] !== null && 'Custom' in (ie[1] as object)) {
    const n = Number((ie[1] as { Custom: unknown }).Custom);
    return TOKEN_PROGRAM_ERRORS[n] ?? DEFAULT_MESSAGES.transaction_failed;
  }
  if (err === 'InsufficientFundsForFee' || err === 'InsufficientFundsForRent') return DEFAULT_MESSAGES.insufficient_sol;
  if (err === 'BlockhashNotFound') return DEFAULT_MESSAGES.blockhash_expired;
  return DEFAULT_MESSAGES.transaction_failed;
}

/** Wallets report a refusal in different ways (EIP-1193-style code 4001, error names, messages). */
export function isUserRejection(e: unknown): boolean {
  const o = e as { code?: unknown; name?: unknown; message?: unknown } | null;
  if (!o || typeof o !== 'object') return false;
  if (o.code === 4001 || o.code === 'ACTION_REJECTED') return true;
  return /reject|denied|declin|cancel/i.test(`${String(o.name ?? '')} ${String(o.message ?? '')}`);
}
