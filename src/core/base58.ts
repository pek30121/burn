/* Minimal base58 (Bitcoin alphabet) decoder, enough to validate Solana
 * addresses and signatures without pulling in @solana/web3.js at this layer. */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function decodeBase58(input: string): Uint8Array | null {
  if (input.length === 0) return null;
  let n = 0n;
  for (const c of input) {
    const v = INDEX.get(c);
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of input) {
    if (c !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/** A Solana public key is exactly 32 bytes once decoded. */
export function isPublicKey(input: string): boolean {
  return input.length >= 32 && input.length <= 44 && decodeBase58(input)?.length === 32;
}

/** A transaction signature is exactly 64 bytes once decoded. */
export function isSignature(input: string): boolean {
  return input.length >= 64 && input.length <= 88 && decodeBase58(input)?.length === 64;
}

export function encodeBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}
