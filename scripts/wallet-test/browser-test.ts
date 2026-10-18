/* `npm run web:browser-test` — the wallet test page in a REAL Chromium (Playwright) against REAL Devnet transactions and the
 * REAL engine (Helius Devnet, PostgreSQL, public API), through the real proxy server.
 *
 * What is real: the browser engine, the page, the built wallet module, the proxy (`/rpc`, `/api`), Devnet, the engine.
 * What is NOT real: the wallets. Phantom/Solflare are not installed here (a browser extension cannot be installed or driven
 * from this sandbox), so two Wallet-Standard-shaped wallets are injected into the page using the REAL registration protocol;
 * their keys stay in this Node process (the page only receives signed bytes). This validates the page and module in a browser,
 * NOT the vendors' extensions: that remains a manual test (docs/WALLET-TEST.md).
 *
 * Needs: HELIUS_API_KEY (or DEVNET_RPC_URL), TEST_DATABASE_URL, a funded Devnet wallet (`npm run devnet:wallet`). */
import { execFileSync } from 'node:child_process';
import { createPool, loadDbConfig } from '../../src/db/config.ts';
import { encodeBase58 } from '../../src/core/base58.ts';
import { COMPUTE_BUDGET_PROGRAM, parseMessage, splitTransaction, toBase64, fromBase64 } from '../../src/wallet/tx.ts';
import { compileMessage, compactU16, Keypair, loadOrCreateKeypair, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type Instruction } from '../devnet/chain.ts';
import { Report } from '../devnet/check.ts';
import { boot, newRun, projectJson } from '../devnet/harness.ts';
import { assertDevnet, getBalance, RPC_URL, rpc } from '../devnet/rpc.ts';
import { WALLET_PATH } from '../devnet/wallet.ts';
import { createTestMint, giveTokens, makeSend, transferSol } from './fixtures.ts';
import { createWebServer } from './server.ts';

declare const window: any; // browser-side callbacks below are serialized by Playwright and run in Chromium, never in Node

const UI = 1_000_000n;
const r = new Report();
await assertDevnet();
execFileSync('npx', ['tsc', '-p', 'tsconfig.web.json'], { stdio: 'inherit', cwd: new URL('../../', import.meta.url).pathname });

/* ------------------------- Devnet fixtures: tokens and three users ------------------------- */
const payer = loadOrCreateKeypair(WALLET_PATH).keypair;
const send = makeSend(payer);
const users = { A: Keypair.generate(), B: Keypair.generate(), C: Keypair.generate() };
// REUSE_DEPLOY_TOKENS=1 reuses the mints of deploy/wallet-test-config.json (the funding wallet keeps their mint authority): saves rent when the funding wallet is low.
const reuse = process.env.REUSE_DEPLOY_TOKENS === '1' ? JSON.parse((await import('node:fs')).readFileSync(new URL('../../deploy/wallet-test-config.json', import.meta.url), 'utf8')).projects : null;
const spl = reuse ? { mint: reuse[0].mint as string } : await createTestMint(send, payer, TOKEN_PROGRAM);
const t22 = reuse ? { mint: reuse[1].mint as string } : await createTestMint(send, payer, TOKEN_2022_PROGRAM);
const SOL_A = BigInt(process.env.SOL_A ?? 10_000_000);
const SOL_B = BigInt(process.env.SOL_B ?? 3_000_000);
r.fact('test tokens (Devnet)', { spl: spl.mint, token2022: t22.mint });
await send([transferSol(payer.address, users.A.address, SOL_A), transferSol(payer.address, users.B.address, SOL_B)]); // C gets NO SOL on purpose
await giveTokens(send, payer, TOKEN_PROGRAM, spl.mint, users.A.address, 100n * UI);
await giveTokens(send, payer, TOKEN_2022_PROGRAM, t22.mint, users.A.address, 100n * UI);
await giveTokens(send, payer, TOKEN_PROGRAM, spl.mint, users.B.address, 7n * UI);
await giveTokens(send, payer, TOKEN_PROGRAM, spl.mint, users.C.address, 5n * UI);
r.fact('users (public)', { A: users.A.address, B: users.B.address, C: `${users.C.address} (no SOL)` });

/* ------------------------- real engine + real proxy server ------------------------- */
const LEVELS = [{ id: 'l0', name: 'Dormant', threshold: '0' }, { id: 'l1', name: 'Awake', threshold: '5' }, { id: 'l2', name: 'Mutated', threshold: '50' }];
const projects = [
  projectJson({ id: 'wt-spl', mint: spl.mint, decimals: 6, tokenProgram: 'spl-token', levels: LEVELS }),
  projectJson({ id: 'wt-t22', mint: t22.mint, decimals: 6, tokenProgram: 'token-2022', levels: LEVELS }),
];
const run = await newRun();
const pool = createPool(loadDbConfig({ DATABASE_URL: run.databaseUrl, PG_POOL_MAX: '2' }));
const engine = await boot(run, { projects, pollMs: 1500 });
const pageConfig = { cluster: 'devnet', rpcUrl: '/rpc', engineBase: '', projects: [
  { id: 'wt-spl', name: 'Test SPL', mint: spl.mint, tokenProgram: 'spl-token', decimals: 6 },
  { id: 'wt-t22', name: 'Test Token-2022', mint: t22.mint, tokenProgram: 'token-2022', decimals: 6 },
] };
const web = createWebServer({ upstreamRpc: RPC_URL, engineUrl: engine.url, config: pageConfig, ratePerMinute: 100_000 });
await new Promise<void>((res) => web.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
r.fact('page', base);

/* ------------------------- browser ------------------------- */
const pwPath = process.env.PLAYWRIGHT_MODULE ?? '/opt/node-tools/node_modules/playwright/index.js';
const pwFallback = 'playwright';
const pw: any = await import(pwPath).catch(() => import(pwFallback));
const chromium = (pw.chromium ?? pw.default?.chromium);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
const page = await ctx.newPage();
const requests: string[] = [];
const responses: { url: string; text: () => Promise<string> }[] = [];
page.on('request', (rq: any) => requests.push(`${rq.method()} ${rq.url()}`));
page.on('response', (rs: any) => responses.push({ url: rs.url(), text: () => rs.text().catch(() => '') }));
const consoleErrors: string[] = [];
page.on('pageerror', (e: Error) => consoleErrors.push(e.message));

const byAddress = new Map<string, Keypair>(Object.values(users).map((k) => [k.address, k]));
let walletAddsBudget = false; // when set, the wallet behaves like Phantom does: it adds instructions around ours before signing
const signB64 = (address: string, txB64: string): Uint8Array => {
  const kp = byAddress.get(address);
  if (!kp) throw new Error('unknown account');
  let { message } = splitTransaction(fromBase64(txB64));
  if (walletAddsBudget) {
    const asked = parseMessage(message);
    const original: Instruction[] = asked.instructions.map((i) => ({ programId: asked.keys[i.programIdIndex]!, keys: i.accounts.map((a) => ({ pubkey: asked.keys[a]!, isSigner: a < asked.numRequiredSignatures, isWritable: a < asked.numRequiredSignatures - asked.numReadonlySigned || (a >= asked.numRequiredSignatures && a < asked.keys.length - asked.numReadonlyUnsigned) })), data: i.data }));
    const budget = (data: number[]): Instruction => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Uint8Array.from(data) });
    message = compileMessage(address, [budget([2, 0x30, 0x75, 0, 0]), budget([3, 0xe8, 0x03, 0, 0, 0, 0, 0, 0]), ...original], asked.recentBlockhash).message; // limit 30 000 units, price 1 000 micro-lamports
  }
  void compactU16;
  return Uint8Array.from([1, ...kp.sign(message), ...message]);
};
let nodeSigned = 0;
await page.exposeFunction('__nodeSign', (address: string, txB64: string) => { nodeSigned++; return toBase64(signB64(address, txB64)); });
await page.exposeFunction('__nodeSignAndSend', async (address: string, txB64: string) => {
  nodeSigned++;
  const signed = signB64(address, txB64);
  await rpc<string>('sendTransaction', [toBase64(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  return toBase64(signed.slice(1, 65));
});

await page.addInitScript((cfg: { accounts: { address: string; publicKey: number[] }[] }) => {
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const make = (name: string, mode: 'sign' | 'send') => {
    const w: any = { name, version: '1.0.0', icon: 'data:image/svg+xml;base64,PHN2Zy8+', chains: ['solana:devnet', 'solana:mainnet'], accounts: [], features: {}, _l: new Set(), _cur: 0, _chains: ['solana:devnet'], _reject: false };
    const acct = (i: number) => ({ address: cfg.accounts[i]!.address, publicKey: Uint8Array.from(cfg.accounts[i]!.publicKey), chains: w._chains, features: ['solana:signTransaction'] });
    w._acct = acct;
    w.features['standard:connect'] = { version: '1.0.0', connect: async () => { w.accounts = [acct(w._cur)]; return { accounts: w.accounts }; } };
    w.features['standard:disconnect'] = { version: '1.0.0', disconnect: async () => { w.accounts = []; } };
    w.features['standard:events'] = { version: '1.0.0', on: (_e: string, l: any) => { w._l.add(l); return () => w._l.delete(l); } };
    const maybeReject = () => { if (w._reject) { w._reject = false; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); } };
    if (mode === 'sign') {
      w.features['solana:signTransaction'] = { version: '1.0.0', supportedTransactionVersions: ['legacy'], signTransaction: async (...inputs: any[]) => { maybeReject(); const i = inputs[0]; return [{ signedTransaction: unb64(await (window as any).__nodeSign(i.account.address, b64(i.transaction))) }]; } };
    } else {
      w.features['solana:signAndSendTransaction'] = { version: '1.0.0', supportedTransactionVersions: ['legacy'], signAndSendTransaction: async (...inputs: any[]) => { maybeReject(); const i = inputs[0]; return [{ signature: unb64(await (window as any).__nodeSignAndSend(i.account.address, b64(i.transaction))) }]; } };
    }
    w._emit = (p: any) => w._l.forEach((l: any) => l(p));
    return w;
  };
  const wallets = { phantom: make('TestPhantom', 'sign'), solflare: make('TestSolflare', 'send') };
  (window as any).__wallets = wallets;
  (window as any).__ctl = {
    switchTo: (i: number) => { for (const w of Object.values(wallets) as any[]) { w._cur = i; if (w.accounts.length) { w.accounts = [w._acct(i)]; w._emit({ accounts: w.accounts }); } } },
    setNetwork: (chains: string[]) => { for (const w of Object.values(wallets) as any[]) { w._chains = chains; if (w.accounts.length) { w.accounts = [w._acct(w._cur)]; w._emit({ accounts: w.accounts, chains }); } } },
    walletDisconnect: () => { for (const w of Object.values(wallets) as any[]) { if (w.accounts.length) { w.accounts = []; w._emit({ accounts: [] }); } } },
    reject: (which: 'phantom' | 'solflare') => { (wallets as any)[which]._reject = true; },
  };
  // The real Wallet Standard registration protocol (what an extension does at injection time).
  for (const w of Object.values(wallets)) {
    const cb = (api: { register: (w: unknown) => void }) => api.register(w);
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: cb }));
    window.addEventListener('wallet-standard:app-ready', (e: any) => cb((e as CustomEvent).detail));
  }
}, { accounts: [users.A, users.B, users.C].map((k) => ({ address: k.address, publicKey: [...k.publicKey] })) });

const state = () => page.evaluate(() => { const s = (window as any).__burn.controller.getState(); return { status: s.status, account: s.account, err: s.error?.code ?? null, tx: s.tx.phase, sig: s.tx.signature, eng: s.engine.phase, avail: s.holding?.available ?? null, amountRaw: s.amountRaw?.toString() ?? null, preview: !!s.preview, counter: s.counter.engine?.finalizedRaw?.toString() ?? null, synced: s.counter.engine?.synced ?? false }; });
const until = (fn: (s: any) => boolean, what: string, ms = 90_000) => page.waitForFunction((src: string) => { const s = (window as any).__burn.controller.getState(); const st = { status: s.status, account: s.account, err: s.error?.code ?? null, tx: s.tx.phase, eng: s.engine.phase, avail: s.holding?.available ?? null, preview: !!s.preview, counter: s.counter.engine?.finalizedRaw?.toString() ?? null, synced: s.counter.engine?.synced ?? false }; return (0, eval)(`(${src})`)(st); }, fn.toString(), { timeout: ms, polling: 100 }).catch(async (e: Error) => { throw new Error(`timed out waiting for ${what}; state=${JSON.stringify(await state())}`); });
const track = () => page.evaluate(() => { const w = window as any; w.__hist = []; w.__burn.controller.subscribe((s: any) => w.__hist.push({ tx: s.tx.phase, eng: s.engine.phase, ctr: s.counter.engine?.finalizedRaw?.toString() ?? null })); });
const text = (sel: string) => page.locator(sel).innerText();
const restTotal = async (id: string) => BigInt((await (await fetch(`${engine.url}/api/v1/projects/${id}/status`)).json() as any).totals.finalizedRaw);
const burnRow = async (id: string, sig: string) => (await pool.query('SELECT amount_raw::text AS a, owner, commitment FROM burns WHERE project_id = $1 AND signature = $2', [id, sig])).rows;

try {
  /* 1. detection */
  await page.goto(`${base}/`);
  await page.waitForFunction(() => !!(window as any).__burn?.controller, null, { timeout: 15_000 });
  const walletButtons = await page.locator('#wallets button').allInnerTexts();
  r.check('wallets detected through the Wallet Standard registration protocol (two wallets)', walletButtons.length === 2 && walletButtons.some((b: string) => b.includes('TestPhantom')) && walletButtons.some((b: string) => b.includes('TestSolflare')), walletButtons.join(' | '));
  r.check('page shows the Devnet badge and the proxy RPC (no key)', (await text('#net')).includes('devnet') && !(await text('#cfgKv')).includes('helius'));

  /* 2. SPL burn with the signTransaction wallet */
  await page.getByRole('button', { name: 'Connecter TestPhantom' }).click();
  await until((s) => s.status === 'ready' && s.account !== null, 'SPL ready');
  r.check('connect: account, SOL balance and token balance shown', (await text('#account')) === users.A.address && (await text('#balance')) === '100' && (await text('#available')).startsWith('100') && (await text("#sol")).includes((Number(SOL_A) / 1e9).toFixed(6)));
  await until((s) => s.counter !== null && s.synced, 'engine counter (history indexed)', 120_000);
  const before = BigInt((await state()).counter!);
  await track();
  await page.fill('#amount', '12.5');
  r.check('amount typed: preview button enabled, confirm still disabled', !(await page.locator('#preview').isDisabled()) && (await page.locator('#confirm').isDisabled()));
  await page.click('#preview');
  await until((s) => s.status === 'preview_ready', 'preview');
  const previewText = await text('#previewKv');
  r.check('preview shows the real fee, the simulation result and the amount', /5000 lamports/.test(previewText) && /Simulation\s+OK/.test(previewText) && previewText.includes('12.5'), previewText.replace(/\s+/g, ' ').slice(0, 160));
  r.check('nothing signed before the explicit confirmation', nodeSigned === 0);
  await page.click('#confirm');
  await until((s) => s.eng === 'counted', 'SPL burn counted by the engine', 150_000);
  await page.waitForFunction((b: string) => (window as any).__burn.controller.getState().counter.engine?.finalizedRaw?.toString() !== b, before.toString(), { timeout: 20_000 }); // the controller refreshes the counter right after "counted"
  const st = await state();
  const hist: { tx: string; eng: string; ctr: string | null }[] = await page.evaluate(() => (window as any).__hist);
  // The page also polls the engine API itself, so the counter may legitimately rise a moment before the controller's own wait
  // loop sees the event. What must NEVER happen: the counter moving while the transaction is merely sent / processed / confirmed.
  r.check('counter NEVER moved while the burn was only sent / processed / confirmed (every state recorded in the browser)', hist.filter((h) => h.tx !== 'finalized').every((h) => BigInt(h.ctr ?? before.toString()) === before), `${hist.length} states: ${[...new Set(hist.map((h) => h.tx))].join('>')}`);
  r.check('counter rose by exactly the burned amount after the engine confirmed', BigInt(st.counter!) === before + 12_500_000n && (await restTotal('wt-spl')) === before + 12_500_000n, `${before} -> ${st.counter}`);
  r.check('UI: finalized + "COMPTÉ par le moteur" + explorer link', (await text('#enginePhase')).includes('COMPTÉ') && (await text('#txPhase')).startsWith('finalized') && (await page.locator('#sig a').getAttribute('href'))!.includes(st.sig!));
  const row = await burnRow('wt-spl', st.sig!);
  r.fact('SPL burn', `${st.sig} (12.5 tokens, finalized, counted)`);
  r.check('PostgreSQL row = exact amount, owner = wallet account, finalized', row.length === 1 && row[0].a === '12500000' && row[0].owner === users.A.address && row[0].commitment === 'finalized');
  await until((s) => s.avail === '87.5', 'balance refreshed');
  r.check('balance refreshed after the burn (87.5)', (await text('#balance')) === '87.5');

  /* 3. refusal in the wallet */
  await page.click('#reset');
  await page.fill('#amount', '1');
  await page.click('#preview');
  await until((s) => s.status === 'preview_ready', 'preview 2');
  const totalBefore = await restTotal('wt-spl');
  await page.evaluate(() => (window as any).__ctl.reject('phantom'));
  await page.click('#confirm');
  await until((s) => s.err === 'user_rejected', 'refusal reported');
  r.check('wallet refusal: clear message, nothing sent, flow usable', (await text('#err')).includes('refusé') && (await state()).status === 'ready' && (await state()).sig === null);
  await new Promise((res) => setTimeout(res, 3_000));
  r.check('wallet refusal: counter unchanged', (await restTotal('wt-spl')) === totalBefore);

  /* 4. invalid amounts */
  await page.fill('#amount', '1000');
  await until((s) => s.err === 'insufficient_token_balance', 'insufficient token balance');
  r.check('amount above the balance: explicit error, preview disabled', (await text('#err')).includes('supérieur au solde') && (await page.locator('#preview').isDisabled()));
  await page.fill('#amount', '1.1234567');
  await until((s) => s.err === 'amount_too_many_decimals', 'decimals');
  await page.fill('#amount', 'abc');
  await until((s) => s.err === 'amount_invalid', 'invalid');
  r.check('too many decimals / garbage: explicit errors', true);

  /* 5. account change */
  await page.fill('#amount', '2');
  await page.click('#preview');
  await until((s) => s.status === 'preview_ready', 'preview before account switch');
  await page.evaluate(() => (window as any).__ctl.switchTo(1));
  await until((s) => s.account !== null && s.avail === '7', 'account B loaded');
  r.check('account switched in the wallet: new account and balance shown, preview and amount discarded', (await text('#account')) === users.B.address && (await text('#balance')) === '7' && !(await state()).preview && (await state()).amountRaw === null);

  /* 6. wrong network */
  await page.fill('#amount', '1');
  await page.evaluate(() => (window as any).__ctl.setNetwork(['solana:mainnet']));
  await until((s) => s.err === 'wrong_network', 'wrong network');
  r.check('wallet on the wrong network: explicit error and signing blocked', (await text('#err')).includes('bon réseau') && (await page.locator('#confirm').isDisabled()));
  await page.evaluate(() => (window as any).__ctl.setNetwork(['solana:devnet']));
  await until((s) => s.err !== 'wrong_network', 'network back');

  /* 7. no SOL for the fee (account C has tokens but 0 SOL) */
  await page.evaluate(() => (window as any).__ctl.switchTo(2));
  await until((s) => s.account !== null && s.avail === '5', 'account C loaded');
  await page.fill('#amount', '1');
  await page.click('#preview');
  await until((s) => s.err === 'insufficient_sol', 'insufficient SOL');
  r.check('no SOL for the fee: explicit error before anything is signed', (await text('#err')).includes('SOL insuffisant') && nodeSigned === 1 /* the SPL burn only */);

  /* 8. Token-2022 with the signAndSend-only wallet */
  await page.evaluate(() => (window as any).__ctl.switchTo(0));
  await until((s) => s.account !== null, 'back to A');
  await page.click('#disconnect');
  await until((s) => s.status === 'disconnected', 'disconnected');
  r.check('disconnect button: state reset (no account, no balance)', (await text('#account')) === '—' && (await text('#balance')) === '—' && (await page.locator('#disconnect').isDisabled()));
  await page.selectOption('#project', 'wt-t22');
  await page.getByRole('button', { name: 'Connecter TestSolflare' }).click();
  await until((s) => s.status === 'ready' && s.avail === '100', 'Token-2022 ready');
  r.check('Token-2022: programme and balance shown', (await text('#program')).startsWith('token-2022') && (await text('#balance')) === '100');
  await until((s) => s.counter !== null && s.synced, 'T22 counter (history indexed)', 120_000);
  const before22 = BigInt((await state()).counter!);
  await track();
  await page.fill('#amount', '3');
  await page.click('#preview');
  await until((s) => s.status === 'preview_ready', 'T22 preview');
  await page.click('#confirm');
  await until((s) => s.eng === 'counted', 'Token-2022 burn counted by the engine', 150_000);
  await page.waitForFunction((b: string) => (window as any).__burn.controller.getState().counter.engine?.finalizedRaw?.toString() !== b, before22.toString(), { timeout: 20_000 });
  const st22 = await state();
  const hist22: { tx: string; eng: string; ctr: string | null }[] = await page.evaluate(() => (window as any).__hist);
  r.check('Token-2022 via signAndSend wallet: counter +3 exactly, and unchanged while only sent / processed / confirmed', BigInt(st22.counter!) === before22 + 3_000_000n && hist22.filter((h: any) => h.tx !== 'finalized').every((h: any) => BigInt(h.ctr ?? before22.toString()) === before22), `${st22.counter} vs ${before22}`);
  const phaseText = await text('#txPhase');
  r.check('signAndSend path is reported as not pre-verifiable in the UI', phaseText.includes('non vérifiable'), phaseText);
  const row22 = await burnRow('wt-t22', st22.sig!);
  r.fact('Token-2022 burn', `${st22.sig} (3 tokens, via signAndSend wallet)`);
  r.check('Token-2022 PostgreSQL row = exact amount and owner', row22.length === 1 && row22[0].a === '3000000' && row22[0].owner === users.A.address);

  /* 8b. a wallet that adds instructions around ours (what Phantom documents it may do): real Devnet transaction */
  await page.click('#disconnect');
  await until((s) => s.status === 'disconnected', 'disconnected again');
  await page.selectOption('#project', 'wt-spl');
  await page.getByRole('button', { name: 'Connecter TestPhantom' }).click();
  await until((s) => s.status === 'ready' && s.avail === '87.5', 'SPL ready again');
  walletAddsBudget = true;
  const beforeAdd = BigInt((await state()).counter ?? '0');
  await page.fill('#amount', '1');
  await page.click('#preview');
  await until((s) => s.status === 'preview_ready', 'preview (wallet adds instructions)');
  await page.click('#confirm');
  await until((s) => s.eng === 'counted', 'burn with wallet-added instructions counted', 150_000);
  walletAddsBudget = false;
  const stAdd = await state();
  const onChain = await rpc<any>('getTransaction', [stAdd.sig!, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
  const addText = await text('#txPhase');
  r.fact('burn with wallet-added instructions', `${stAdd.sig} (1 token, ${onChain.transaction.message.instructions.length} instructions on-chain)`);
  r.check('wallet-added ComputeBudget instructions: accepted, finalized on Devnet with 3 instructions, reported on screen', onChain.transaction.message.instructions.length === 3 && stAdd.tx === 'finalized' && addText.includes('a ajouté'), addText);
  const rowAdd = await burnRow('wt-spl', stAdd.sig!);
  const burnEv = (await (await fetch(`${engine.url}/api/v1/projects/wt-spl/events?limit=100`)).json() as any).data.find((e: any) => e.type === 'burn' && e.burn.signature === stAdd.sig);
  r.check('the engine counted it at its real position (instruction path 2, not 0), exact amount, PostgreSQL row', rowAdd.length === 1 && rowAdd[0].a === '1000000' && burnEv?.burn.instructionPath === '2', `path ${burnEv?.burn.instructionPath}`);
  await new Promise((res) => setTimeout(res, 1500));
  r.check('counter +1 exactly after the engine counted it', BigInt((await state()).counter ?? '0') === beforeAdd + 1_000_000n, `${beforeAdd} -> ${(await state()).counter}`);

  /* 9. wallet-side disconnect */
  await page.evaluate(() => (window as any).__ctl.walletDisconnect());
  await until((s) => s.status === 'disconnected', 'wallet-side disconnect');
  r.check('disconnect from the wallet UI: page returns to disconnected with an explicit message', (await text('#err')).includes('Connectez'));

  /* 10. the server key never reaches the browser */
  const key = process.env.HELIUS_API_KEY ?? '';
  const outside = requests.filter((u) => !u.includes(`127.0.0.1:${(web.address() as { port: number }).port}`) && !u.startsWith('GET data:'));
  r.check('every browser request goes to the same origin only (no direct call to a provider)', outside.length === 0, outside.slice(0, 3).join(' | '));
  let leaked = false;
  for (const rs of responses) { const body = await rs.text(); if ((key && (body.includes(key) || rs.url.includes(key))) || /helius-rpc|api-key=[A-Za-z0-9-]{8,}/i.test(body)) leaked = true; }
  r.check('no response, script or config served to the browser contains the Helius key or host', !leaked && !requests.some((u) => key && u.includes(key)));
  const denied = await page.evaluate(async () => (await fetch('/rpc', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [] }) })).status);
  const batch = await page.evaluate(async () => (await fetch('/rpc', { method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'getSlot' }]) })).status);
  const post = await page.evaluate(async () => (await fetch('/api/v1/projects/wt-spl/status', { method: 'POST' })).status);
  r.check('the /rpc proxy refuses non-allowlisted methods and batches; the engine API proxy is GET only', denied === 403 && batch === 400 && post === 405, `${denied}/${batch}/${post}`);
  r.check('no JavaScript error in the page', consoleErrors.length === 0, consoleErrors.join(' | '));
  if (process.env.SHOW_PAGE_LOG) console.log(await text('#log'));
} finally {
  await browser.close().catch(() => {});
  web.close();
  await engine.stop().catch(() => {});
  await pool.end().catch(() => {});
  await run.dispose();
}
r.finish(`wallet-browser-${Date.now()}.json`);
void getBalance; void encodeBase58;
