/* `npm run web:setup` — prepares the Devnet fixtures for the wallet test page (Devnet only, nothing on Mainnet).
 *
 *   USER_ADDRESS=<your Devnet wallet address> npm run web:setup
 *
 * - creates (once, state in .wallet-test/state.json) one SPL Token and one Token-2022 test token; the FUNDING wallet
 *   (.devnet/wallet.json, see `npm run devnet:wallet`) keeps their mint authority, so it can mint more for you;
 * - funds USER_ADDRESS with Devnet SOL (fees) and test tokens (a token account owned by YOUR address);
 * - writes .wallet-test/projects.json (for the engine: PROJECTS_CONFIG) and web/wallet-test/config.json (public data
 *   for the page). Neither contains a secret. Re-running only tops up balances. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isPublicKey } from '../../src/core/base58.ts';
import { loadOrCreateKeypair, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../devnet/chain.ts';
import { assertDevnet, getBalance, rpc, shortSig } from '../devnet/rpc.ts';
import { createTestMint, giveTokens, makeSend, mintMore, transferSol } from './fixtures.ts';
import { WALLET_PATH } from '../devnet/wallet.ts';

const UI = 1_000_000n;
const TOKENS = [
  { id: 'wt-spl', name: 'Test SPL', ticker: 'TSPL', tokenProgram: 'spl-token' as const, program: TOKEN_PROGRAM },
  { id: 'wt-t22', name: 'Test Token-2022', ticker: 'TT22', tokenProgram: 'token-2022' as const, program: TOKEN_2022_PROGRAM },
];
const LEVELS = [{ id: 'l0', name: 'Dormant', threshold: '0' }, { id: 'l1', name: 'Awake', threshold: '5' }, { id: 'l2', name: 'Mutated', threshold: '50' }, { id: 'l3', name: 'Evolved', threshold: '500' }];
const DIR = new URL('../../.wallet-test/', import.meta.url).pathname;
const STATE = `${DIR}state.json`;

await assertDevnet();
const payer = loadOrCreateKeypair(WALLET_PATH).keypair;
const user = process.env.USER_ADDRESS;
if (user !== undefined && !isPublicKey(user)) throw new Error('USER_ADDRESS is not a valid Solana address');
const send = makeSend(payer);
mkdirSync(DIR, { recursive: true });
const state: { tokens: Record<string, { mint: string; createTx: string }> } = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { tokens: {} };

for (const t of TOKENS) {
  if (state.tokens[t.id]) continue;
  const created = await createTestMint(send, payer, t.program);
  state.tokens[t.id] = { mint: created.mint, createTx: created.signature };
  console.log(`created ${t.id} ${t.tokenProgram}: mint ${created.mint} (tx ${shortSig(created.signature)})`);
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}

if (user) {
  const lamports = (await getBalance(user)) ;
  if (lamports < 100_000_000n) {
    await send([transferSol(payer.address, user, 200_000_000n)]);
    console.log(`sent 0.2 SOL (Devnet) to ${user}`);
  }
  for (const t of TOKENS) {
    const mint = state.tokens[t.id]!.mint;
    const existing = (await rpc<any>('getTokenAccountsByOwner', [user, { mint }, { encoding: 'jsonParsed', commitment: 'finalized' }])).value as { pubkey: string }[];
    if (existing.length > 0) {
      await mintMore(send, payer, t.program, mint, existing[0]!.pubkey, 1_000n * UI);
      console.log(`${t.id}: +1000 tokens to your existing token account ${existing[0]!.pubkey}`);
    } else {
      const account = await giveTokens(send, payer, t.program, mint, user, 1_000n * UI); // the account belongs to YOU
      console.log(`${t.id}: token account ${account} created for you with 1000 tokens`);
    }
  }
} else console.log('USER_ADDRESS not set: tokens created, nothing funded. Re-run with USER_ADDRESS=<your Devnet address>.');

writeFileSync(`${DIR}projects.json`, JSON.stringify({ projects: TOKENS.map((t) => ({ id: t.id, name: t.name, ticker: t.ticker, cluster: 'devnet', mint: state.tokens[t.id]!.mint, decimals: 6, tokenProgram: t.tokenProgram, levels: LEVELS })) }, null, 2));
writeFileSync(new URL('../../web/wallet-test/config.json', import.meta.url).pathname, JSON.stringify({ cluster: 'devnet', rpcUrl: '/rpc', engineBase: '', projects: TOKENS.map((t) => ({ id: t.id, name: t.name, mint: state.tokens[t.id]!.mint, tokenProgram: t.tokenProgram, decimals: 6 })) }, null, 2));
console.log(`\nwritten: .wallet-test/projects.json (engine) and web/wallet-test/config.json (page). Funding wallet balance: ${Number(await getBalance(payer.address)) / 1e9} SOL`);
