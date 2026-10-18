import { randomBytes } from 'node:crypto';
import { encodeBase58 } from '../src/core/base58.ts';
import type { BurnInput } from '../src/core/ledger.ts';

export const randomPubkey = () => encodeBase58(randomBytes(32));
export const randomSignature = () => encodeBase58(randomBytes(64));

export const MINT_A = 'FMmNZJAzmx9VAuBF6kmR7FM51B8TMcGfhbGXoMtypump';
export const MINT_B = 'So11111111111111111111111111111111111111112';

export function projectInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alpha',
    name: 'Alpha',
    ticker: 'ALPHA',
    cluster: 'devnet',
    mint: MINT_A,
    decimals: 6,
    tokenProgram: 'spl-token',
    levels: [
      { id: 'l0', name: 'Zero', threshold: '0' },
      { id: 'l1', name: 'One', threshold: '1000' },
      { id: 'l2', name: 'Two', threshold: '5000.5' },
      { id: 'l3', name: 'Three', threshold: '10000' },
    ],
    ...overrides,
  };
}

export function burn(overrides: Partial<BurnInput> = {}): BurnInput {
  return {
    mint: MINT_A,
    signature: randomSignature(),
    instructionPath: '0',
    slot: 100,
    blockTime: 1_700_000_000,
    owner: randomPubkey(),
    amountRaw: 1_000_000n,
    commitment: 'finalized',
    ...overrides,
  };
}
