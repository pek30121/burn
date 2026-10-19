/* Reads what was created and burned of a mint from its finalized history (MintTo / MintToChecked / Burn / BurnChecked decoded from
 * the raw instruction bytes, outer and inner, of every successful transaction). Used once, at activation, to derive the supply
 * right after creation from the chain itself instead of trusting a configured number. Bounded: a history longer than the bound
 * is reported as incomplete, never guessed. */

import { decodeBase58 } from '../core/base58.ts';
import { TOKEN_PROGRAMS } from '../config/schema.ts';
import type { SolanaRpc } from './rpc.ts';

const PROGRAMS = new Set<string>(Object.values(TOKEN_PROGRAMS));

export interface MintHistory {
  /** False when the history is longer than the bound or a transaction could not be read: the totals below are then NOT a proof. */
  readonly complete: boolean;
  readonly createdRaw: bigint;
  readonly burnedRaw: bigint;
  readonly mintOps: number;
  readonly signatures: number;
}

export async function readMintHistory(rpc: Pick<SolanaRpc, 'getSignaturesForAddress' | 'getTransaction'>, mint: string, maxSignatures: number): Promise<MintHistory> {
  const sigs: { signature: string; err: unknown }[] = [];
  let before: string | undefined;
  let exhausted = false;
  while (sigs.length < maxSignatures) {
    const page = await rpc.getSignaturesForAddress(mint, { commitment: 'finalized', limit: 1000, ...(before ? { before } : {}) });
    sigs.push(...page);
    if (page.length < 1000) { exhausted = true; break; }
    before = page.at(-1)!.signature;
  }
  if (!exhausted) return { complete: false, createdRaw: 0n, burnedRaw: 0n, mintOps: 0, signatures: sigs.length };

  let created = 0n;
  let burned = 0n;
  let mintOps = 0;
  let unavailable = 0;
  for (const s of sigs) {
    if (s.err !== null) continue;
    const tx = (await rpc.getTransaction(s.signature, 'finalized')) as any;
    if (!tx?.transaction?.message) { unavailable++; continue; }
    const msg = tx.transaction.message;
    const keys: string[] = [...msg.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
    const visit = (ix: any): void => {
      if (!PROGRAMS.has(keys[ix.programIdIndex]!)) return;
      const d = decodeBase58(ix.data);
      if (!d || d.length < 9 || ![7, 14, 8, 15].includes(d[0]!)) return;
      const isMint = d[0] === 7 || d[0] === 14;
      if (keys[ix.accounts[isMint ? 0 : 1]!] !== mint) return;
      const amount = new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(1, true);
      if (isMint) { created += amount; mintOps++; } else burned += amount;
    };
    msg.instructions.forEach(visit);
    for (const g of tx.meta?.innerInstructions ?? []) g.instructions.forEach(visit);
  }
  return { complete: unavailable === 0, createdRaw: created, burnedRaw: burned, mintOps, signatures: sigs.length };
}
