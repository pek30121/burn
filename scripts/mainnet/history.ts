/* Shared by `mainnet:reconcile` and `mainnet:onboard` (READ-ONLY): read a mint's whole signature history (bounded) and
 * sum what was created (MintTo / MintToChecked) and burned (Burn / BurnChecked), decoded from the raw instruction bytes
 * (outer and inner) of every successful transaction. */
import { decodeBase58 } from '../../src/core/base58.ts';
import { TOKEN_PROGRAMS } from '../../src/config/schema.ts';
import type { SolanaRpc } from '../../src/chain/rpc.ts';

const PROGRAMS = new Set<string>(Object.values(TOKEN_PROGRAMS));

export async function listHistory(rpc: SolanaRpc, mint: string, maxSignatures: number): Promise<{ sigs: { signature: string; err: unknown }[]; exhausted: boolean }> {
  const sigs: { signature: string; err: unknown }[] = [];
  let before: string | undefined;
  while (sigs.length < maxSignatures) {
    const page = await rpc.getSignaturesForAddress(mint, { commitment: 'finalized', limit: 1000, ...(before ? { before } : {}) });
    sigs.push(...page);
    if (page.length < 1000) return { sigs, exhausted: true };
    before = page.at(-1)!.signature;
  }
  return { sigs, exhausted: false };
}

export interface Totals { minted: bigint; burned: bigint; mintOps: number; burnOps: number; transactions: number; unavailable: number }

export async function sumHistory(rpc: SolanaRpc, mint: string, sigs: readonly { signature: string; err: unknown }[]): Promise<Totals> {
  const t: Totals = { minted: 0n, burned: 0n, mintOps: 0, burnOps: 0, transactions: 0, unavailable: 0 };
  for (const s of sigs) {
    if (s.err !== null) continue;
    const tx = (await rpc.getTransaction(s.signature, 'finalized')) as any;
    if (!tx) { t.unavailable++; continue; }
    t.transactions++;
    const msg = tx.transaction.message;
    const keys: string[] = [...msg.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
    const visit = (ix: any) => {
      if (!PROGRAMS.has(keys[ix.programIdIndex]!)) return;
      const d = decodeBase58(ix.data);
      if (!d || ![7, 14, 8, 15].includes(d[0]!) || d.length < 9 || keys[ix.accounts[d[0] === 7 || d[0] === 14 ? 0 : 1]!] !== mint) return;
      const amount = new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(1, true);
      if (d[0] === 7 || d[0] === 14) { t.minted += amount; t.mintOps++; }
      else { t.burned += amount; t.burnOps++; }
    };
    msg.instructions.forEach(visit);
    for (const g of tx.meta?.innerInstructions ?? []) g.instructions.forEach(visit);
  }
  return t;
}
