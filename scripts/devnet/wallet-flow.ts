/* `npm run devnet:wallet-flow` — REAL Devnet end-to-end of the wallet module (src/wallet):
 *
 *  - a fresh, isolated "user" key (not the funding wallet) holds the tokens; its key lives only inside a
 *    Wallet-Standard-shaped test wallet (tests/wallet-helpers.ts MockWallet) that signs — the module never sees it;
 *  - the funding wallet (.devnet/wallet.json) only creates the tokens and pays the user's SOL;
 *  - one SPL Token and one Token-2022 token are created on Devnet; the user burns through BurnController:
 *    real balances, real blockhash, real fee (getFeeForMessage), real simulation, real send, real finalization;
 *  - the real engine (Helius Devnet, PostgreSQL, REST) must then list the burn: only then it is "counted".
 *
 * NOT covered: the real Phantom/Solflare browser extensions (a script cannot drive them). */
import { createPool, loadDbConfig } from '../../src/db/config.ts';
import { parseBurns } from '../../src/chain/burn-parser.ts';
import { createBurnController } from '../../src/wallet/controller.ts';
import { createEngineClient } from '../../src/wallet/engine-client.ts';
import { createJsonRpc } from '../../src/wallet/rpc.ts';
import { createWalletRegistry } from '../../src/wallet/wallet-standard.ts';
import { fakeWindow, MockWallet } from '../../tests/wallet-helpers.ts';
import { buildTransaction, ix, Keypair, loadOrCreateKeypair, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type Instruction } from './chain.ts';
import { Report } from './check.ts';
import { boot, newRun, projectJson } from './harness.ts';
import { getJson } from './http.ts';
import { assertDevnet, getBalance, latestBlockhash, RPC_URL, rentExempt, rpc, sendAndFinalize, shortSig } from './rpc.ts';
import { REQUIRED_LAMPORTS, WALLET_PATH } from './wallet.ts';

const UI = 1_000_000n;
const LEVELS = [{ id: 'l0', name: 'Dormant', threshold: '0' }, { id: 'l1', name: 'Awake', threshold: '5' }, { id: 'l2', name: 'Mutated', threshold: '50' }];
const r = new Report();
await assertDevnet();
const payer = loadOrCreateKeypair(WALLET_PATH).keypair;
if ((await getBalance(payer.address)) < REQUIRED_LAMPORTS) {
  console.log(`Not enough Devnet SOL on the funding wallet ${payer.address} (fund the PUBLIC address via https://faucet.solana.com).`);
  process.exit(2);
}
const user = Keypair.generate();
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return [...b]; };
const transfer = (from: string, to: string, lamports: bigint): Instruction => ({
  programId: '11111111111111111111111111111111',
  keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }],
  data: Uint8Array.from([2, 0, 0, 0, ...u64(lamports)]),
});
const send = async (ixs: Instruction[], extra: Keypair[] = []) => sendAndFinalize(buildTransaction(payer, extra, ixs, await latestBlockhash()));

r.fact('funding wallet (public)', payer.address);
r.fact('isolated user wallet (public, key held only by the test wallet)', user.address);
await send([transfer(payer.address, user.address, 50_000_000n)]);
r.check('user wallet funded with 0.05 SOL by the funding wallet', (await getBalance(user.address)) === 50_000_000n);

interface Tok { id: string; name: 'spl-token' | 'token-2022'; program: string; mint: Keypair; account: Keypair }
async function createToken(id: string, name: Tok['name'], program: string): Promise<Tok> {
  const mint = Keypair.generate();
  const account = Keypair.generate();
  const sent = await send([
    ix.createAccount(payer.address, mint.address, await rentExempt(82), 82n, program),
    ix.initializeMint2(program, mint.address, 6, payer.address, null),
    ix.createAccount(payer.address, account.address, await rentExempt(165), 165n, program),
    ix.initializeAccount3(program, account.address, mint.address, user.address), // the USER owns the token account
    ix.mintTo(program, mint.address, account.address, payer.address, 1_000_000n * UI),
    ix.revokeAuthority(program, mint.address, payer.address, 0),
  ], [mint, account]);
  r.fact(`${id}: created`, `${name} mint ${mint.address} tx ${sent.signature} slot ${sent.slot} FINALIZED`);
  return { id, name, program, mint, account };
}
const tokens = [await createToken('wf-spl', 'spl-token', TOKEN_PROGRAM), await createToken('wf-t22', 'token-2022', TOKEN_2022_PROGRAM)];

const run = await newRun();
const pool = createPool(loadDbConfig({ DATABASE_URL: run.databaseUrl, PG_POOL_MAX: '2' }));
const booted = await boot(run, { projects: tokens.map((t) => projectJson({ id: t.id, mint: t.mint.address, decimals: 6, tokenProgram: t.name, levels: LEVELS, initialSupply: '1000000' })), pollMs: 1500 });
const results: { id: string; signature: string; slot: number; amountRaw: bigint }[] = [];
try {
  for (const t of tokens) {
    const wallet = new MockWallet('TestWallet', [user], { chains: ['solana:devnet'] });
    const win = fakeWindow();
    win.registerWallet(wallet);
    const c = createBurnController({
      project: { id: t.id, mint: t.mint.address, cluster: 'devnet', tokenProgram: t.name, decimals: 6 }, registry: createWalletRegistry(win),
      rpc: createJsonRpc({ url: RPC_URL }), engine: createEngineClient({ baseUrl: booted.url, projectId: t.id }),
      pollMs: 1000, engineTimeoutMs: 120_000, txTimeoutMs: 120_000,
    });
    await c.connect('TestWallet');
    let s = c.getState();
    r.check(`${t.id}: wallet connected on Devnet, token and real balance read (${t.name})`, s.status === 'ready' && s.holding?.availableRaw === 1_000_000n * UI && s.token?.tokenProgram === t.name, `balance ${s.holding?.balance}`);
    r.check(`${t.id}: counter starts at 0 from the engine`, (await getJson(`${booted.url}/api/v1/projects/${t.id}/status`)).json.totals.finalizedRaw === '0');
    c.setAmount('7.25');
    const p = await c.prepare();
    r.check(`${t.id}: preview with real fee and real Devnet simulation`, !!p && p.simulation.ok && p.feeLamports > 0n && p.amountRaw === 7_250_000n, p ? `fee ${p.feeLamports} lamports (${p.feeExact ? 'getFeeForMessage' : 'estimate'}), ${p.simulation.unitsConsumed} CU` : JSON.stringify(c.getState().error));
    if (!p) continue;
    r.check(`${t.id}: nothing signed before the explicit confirmation`, wallet.signed.length === 0);
    await c.confirm(p.id);
    s = c.getState();
    r.fact(`${t.id}: burn`, `${s.tx.signature} phase ${s.tx.phase} slot ${s.tx.slot} engine ${s.engine.phase}`);
    r.check(`${t.id}: signed by the wallet only, message verified, finalized on Devnet`, wallet.signed.length === 1 && s.tx.messageVerified && s.tx.phase === 'finalized' && s.tx.signature !== null);
    r.check(`${t.id}: counted ONLY once the engine listed it`, s.engine.phase === 'counted', s.engine.phase);
    const sig = s.tx.signature!;
    const onChain = await rpc<any>('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
    const parsed = parseBurns(onChain, { mint: t.mint.address, expectedSignature: sig, tokenProgram: t.name, decimals: 6 });
    const own = parsed.status === 'ok' ? parsed.burns[0] : undefined;
    const row = (await pool.query('SELECT amount_raw::text AS a, slot::text AS s, commitment, owner FROM burns WHERE project_id = $1 AND signature = $2', [t.id, sig])).rows;
    r.check(`${t.id} ${shortSig(sig)}: Devnet finalized = PostgreSQL row (1, finalized) = exact amount 7250000 raw, owner = user wallet`, !!own && own.amountRaw === 7_250_000n && row.length === 1 && row[0].a === '7250000' && row[0].commitment === 'finalized' && row[0].owner === user.address && Number(row[0].s) === onChain.slot);
    r.check(`${t.id}: counter from the engine API = 7250000 and equals the burn`, s.counter.engine?.finalizedRaw === 7_250_000n && (await getJson(`${booted.url}/api/v1/projects/${t.id}/status`)).json.totals.finalizedRaw === '7250000');
    r.check(`${t.id}: remaining on-chain balance read again`, c.getState().holding?.balanceRaw === 1_000_000n * UI - 7_250_000n);
    const supply = BigInt((await rpc<any>('getTokenSupply', [t.mint.address, { commitment: 'finalized' }])).value.amount);
    r.check(`${t.id}: on-chain supply dropped by exactly the burn`, 1_000_000n * UI - supply === 7_250_000n);
    results.push({ id: t.id, signature: sig, slot: onChain.slot, amountRaw: 7_250_000n });
    c.dispose();
  }
  const dup = (await pool.query('SELECT count(*)::int AS n FROM (SELECT project_id, signature, instruction_path FROM burns GROUP BY 1,2,3 HAVING count(*) > 1) d')).rows[0].n;
  r.check('no duplicate burn row', dup === 0);
  console.log('\n=== TRANSACTIONS (Devnet, finalized) ===');
  for (const x of results) console.log(`${x.id}  ${x.amountRaw} raw  slot ${x.slot}  ${x.signature}`);
} finally {
  await booted.stop().catch(() => {});
  await pool.end().catch(() => {});
  await run.dispose();
}
r.finish(`wallet-flow-${Date.now()}.json`);
