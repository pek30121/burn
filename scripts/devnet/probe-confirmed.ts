/* `npm run devnet:probe` — focused real-Devnet experiment: does the engine (trackConfirmed) show a burn as
 * "pending finalization" during the ~13 s between `confirmed` and `finalized`? Creates one token, sends ONE burn,
 * and samples the status API every 300 ms next to the real commitment of the transaction. Needs funds. */
import { buildTransaction, ix, Keypair, loadOrCreateKeypair, TOKEN_PROGRAM } from './chain.ts';
import { boot, newRun, projectJson } from './harness.ts';
import { getJson, waitUntil } from './http.ts';
import { assertDevnet, latestBlockhash, rentExempt, rpc, sendAndFinalize, sleep } from './rpc.ts';
import { WALLET_PATH } from './wallet.ts';

await assertDevnet();
const payer = loadOrCreateKeypair(WALLET_PATH).keypair;
const mint = Keypair.generate();
const acct = Keypair.generate();
const send = async (i: any[], extra: Keypair[] = []) => sendAndFinalize(buildTransaction(payer, extra, i, await latestBlockhash()));
await send([
  ix.createAccount(payer.address, mint.address, await rentExempt(82), 82n, TOKEN_PROGRAM), ix.initializeMint2(TOKEN_PROGRAM, mint.address, 6, payer.address, null),
  ix.createAccount(payer.address, acct.address, await rentExempt(165), 165n, TOKEN_PROGRAM), ix.initializeAccount3(TOKEN_PROGRAM, acct.address, mint.address, payer.address),
  ix.mintTo(TOKEN_PROGRAM, mint.address, acct.address, payer.address, 1_000_000_000_000n), ix.revokeAuthority(TOKEN_PROGRAM, mint.address, payer.address, 0),
], [mint, acct]);

const run = await newRun();
const interesting = new Set(['warning', 'sync_failed', 'burns_indexed', 'incident', 'recovered']);
const booted = await boot(run, {
  projects: [projectJson({ id: 'probe', mint: mint.address, decimals: 6, levels: [{ id: 'l0', name: 'Zero', threshold: '0' }, { id: 'l1', name: 'One', threshold: '1' }] })],
  trackConfirmed: true, pollMs: 1500, echo: (l) => interesting.has(l.event) && console.log('  engine:', JSON.stringify(l).slice(0, 300)),
});
try {
  await waitUntil(async () => (await getJson(`${booted.url}/api/v1/projects/probe/status`)).json?.data?.history?.backfill !== 'pending', 'engine ready', 90_000);
  const wire = buildTransaction(payer, [], [ix.burn(TOKEN_PROGRAM, acct.address, mint.address, payer.address, 5_000_000n)], await latestBlockhash());
  const t0 = Date.now();
  const sig = await rpc<string>('sendTransaction', [Buffer.from(wire).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  console.log('burn sent:', sig);
  let lastLine = '';
  for (let i = 0; i < 300; i++) {
    const st = (await rpc<any>('getSignatureStatuses', [[sig], { searchTransactionHistory: true }])).value[0];
    const api = (await getJson(`${booted.url}/api/v1/projects/probe/status`)).json;
    const line = `chain=${st?.confirmationStatus ?? 'unseen'} | engine finalized=${api.totals.finalizedRaw} pending=${api.totals.pendingFinalizationRaw} events=${api.latestEventId}`;
    if (line !== lastLine) console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${line}`);
    lastLine = line;
    if (st?.confirmationStatus === 'finalized' && api.totals.finalizedRaw === '5000000') break;
    await sleep(300);
  }
} finally {
  await booted.stop();
  await run.dispose();
}
