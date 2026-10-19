/* Guard for a page that may burn ONE fixed amount only (e.g. the first Mainnet test: exactly 1 token). Pure: the page calls it
 * right before confirm, on the controller's own preview, so a wrong amount can never reach the wallet. */
import { parseUiAmount } from '../core/amount.ts';

export interface FixedBurnPreview {
  readonly amountRaw: bigint;
}

/** Returns null when the preview is exactly `fixedUi` tokens, otherwise a stable reason code. */
export function checkFixedBurn(preview: FixedBurnPreview | null, decimals: number, fixedUi: string): 'no_preview' | 'amount_not_fixed' | null {
  if (!preview) return 'no_preview';
  return preview.amountRaw === parseUiAmount(fixedUi, decimals) ? null : 'amount_not_fixed';
}
