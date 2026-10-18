/* `npm run devnet:wallet` — creates (once) the Devnet-only test wallet and reports its PUBLIC address
 * and balance. The private key lives in .devnet/wallet.json (0600, git-ignored) and is never printed. */
import { loadOrCreateKeypair } from './chain.ts';
import { assertDevnet, getBalance, LAMPORTS_PER_SOL, requestAirdrop, sleep } from './rpc.ts';

export const WALLET_PATH = new URL('../../.devnet/wallet.json', import.meta.url).pathname;
export const REQUIRED_LAMPORTS = 100_000_000n; // 0.1 SOL; the full scenario spends about 0.015 SOL (rent of 3 mints + 3 token accounts, ~25 fees)

export async function ensureWallet(): Promise<{ address: string; balance: bigint; created: boolean }> {
  await assertDevnet();
  const { keypair, created } = loadOrCreateKeypair(WALLET_PATH);
  return { address: keypair.address, balance: await getBalance(keypair.address), created };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const w = await ensureWallet();
  console.log(`devnet wallet ${w.created ? '(created) ' : ''}address: ${w.address}`);
  console.log(`balance: ${Number(w.balance) / Number(LAMPORTS_PER_SOL)} SOL (devnet)`);
  if (w.balance < REQUIRED_LAMPORTS) {
    console.log('balance is below the amount needed; trying the Devnet faucet through the RPC...');
    try {
      const sig = await requestAirdrop(w.address, 1n * LAMPORTS_PER_SOL);
      await sleep(8000);
      console.log(`airdrop requested (${sig.slice(0, 8)}…), new balance: ${Number(await getBalance(w.address)) / Number(LAMPORTS_PER_SOL)} SOL`);
    } catch (e) {
      console.log(`faucet unavailable (${(e as Error).message}).`);
      console.log(`ACTION NEEDED: fund this PUBLIC address with at least ${Number(REQUIRED_LAMPORTS) / Number(LAMPORTS_PER_SOL)} SOL on Devnet (1 SOL is plenty): https://faucet.solana.com`);
      console.log(`address: ${w.address}`);
      process.exitCode = 2;
    }
  }
}
