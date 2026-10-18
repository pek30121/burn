/* Devnet fixtures shared by `web:setup` and `web:browser-test`: test tokens whose mint authority stays with the FUNDING
 * wallet (so it can mint test balances), token accounts owned by a given address, and SOL for fees. Devnet only. */
import { buildTransaction, ix, Keypair, type Instruction } from '../devnet/chain.ts';
import { latestBlockhash, rentExempt, sendAndFinalize, type Sent } from '../devnet/rpc.ts';

export type Send = (ixs: Instruction[], extra?: Keypair[]) => Promise<Sent>;
export const makeSend = (payer: Keypair): Send => async (ixs, extra = []) => sendAndFinalize(buildTransaction(payer, extra, ixs, await latestBlockhash()));

const u64 = (n: bigint): number[] => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return [...b]; };

export const transferSol = (from: string, to: string, lamports: bigint): Instruction => ({
  programId: '11111111111111111111111111111111',
  keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }],
  data: Uint8Array.from([2, 0, 0, 0, ...u64(lamports)]),
});

export async function createTestMint(send: Send, payer: Keypair, program: string): Promise<{ mint: string; signature: string }> {
  const mint = Keypair.generate();
  const sent = await send([ix.createAccount(payer.address, mint.address, await rentExempt(82), 82n, program), ix.initializeMint2(program, mint.address, 6, payer.address, null)], [mint]);
  return { mint: mint.address, signature: sent.signature };
}

/** A new token account owned by `owner` holding `amountRaw` (the funding wallet pays and mints). */
export async function giveTokens(send: Send, payer: Keypair, program: string, mint: string, owner: string, amountRaw: bigint): Promise<string> {
  const account = Keypair.generate();
  await send([
    ix.createAccount(payer.address, account.address, await rentExempt(165), 165n, program),
    ix.initializeAccount3(program, account.address, mint, owner),
    ix.mintTo(program, mint, account.address, payer.address, amountRaw),
  ], [account]);
  return account.address;
}

export const mintMore = (send: Send, payer: Keypair, program: string, mint: string, account: string, amountRaw: bigint) =>
  send([ix.mintTo(program, mint, account, payer.address, amountRaw)]);
