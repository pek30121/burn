/* Exact token amounts. Every on-chain amount is a u64 count of base units
 * ("raw"); the engine keeps it as bigint end to end and never goes through a
 * JS number, so no float rounding can creep into totals or thresholds. */

export const U64_MAX = (1n << 64n) - 1n;
export const MAX_DECIMALS = 18;

export class AmountError extends Error {
  override name = 'AmountError';
}

const UI_AMOUNT = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

export function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new AmountError(`decimals must be an integer in [0, ${MAX_DECIMALS}], got ${decimals}`);
  }
}

export function assertRaw(raw: bigint): void {
  if (raw < 0n || raw > U64_MAX) throw new AmountError(`raw amount out of u64 range: ${raw}`);
}

/** "1234.5" with 6 decimals -> 1234500000n. Rejects more fractional digits than the mint has. */
export function parseUiAmount(input: string | number, decimals: number): bigint {
  assertDecimals(decimals);
  let text: string;
  if (typeof input === 'number') {
    // Only safe integers: 0.1 + 0.2 style values must be given as strings.
    if (!Number.isSafeInteger(input)) {
      throw new AmountError(`numeric amounts must be safe integers, pass "${input}" as a string`);
    }
    text = String(input);
  } else {
    text = input.trim().replaceAll('_', '');
  }
  const m = UI_AMOUNT.exec(text);
  if (!m) throw new AmountError(`invalid amount: "${input}"`);
  const whole = m[1] as string;
  const frac = m[2] ?? '';
  if (frac.length > decimals) {
    throw new AmountError(`"${input}" has more than ${decimals} fractional digits`);
  }
  const raw = BigInt(whole + frac.padEnd(decimals, '0'));
  assertRaw(raw);
  return raw;
}

/** Strict parse of a raw base-unit string as returned by RPC (`tokenAmount.amount`). */
export function parseRawAmount(input: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(input)) throw new AmountError(`invalid raw amount: "${input}"`);
  const raw = BigInt(input);
  assertRaw(raw);
  return raw;
}

/** 1234500000n with 6 decimals -> "1234.5" (trailing zeros trimmed). */
export function formatUiAmount(raw: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (raw < 0n) return '-' + formatUiAmount(-raw, decimals);
  if (decimals === 0) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
