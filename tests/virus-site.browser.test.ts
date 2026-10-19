/* VIRUS.EXE site in a real Chromium (iPhone-sized viewport), served by the REAL web server (same origin as /rpc and /api) in front of the REAL
 * public API (in-memory twin of the read side). The wallet is a Wallet-Standard MOCK that signs in Node and the RPC is a local JSON-RPC mock:
 * no network, no key, no Mainnet, no transaction. Skipped (and reported as skipped, never as passed) when Playwright/Chromium is absent. */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { compileMessage, Keypair, type Instruction } from '../scripts/devnet/chain.ts';
import { createWebServer } from '../scripts/wallet-test/server.ts';
import { GENESIS_HASHES } from '../src/chain/rpc.ts';
import { encodeBase58 } from '../src/core/base58.ts';
import { parseProjectConfig, TOKEN_PROGRAMS } from '../src/config/schema.ts';
import { COMPUTE_BUDGET_PROGRAM, LIGHTHOUSE_PROGRAM, parseMessage, splitTransaction, toBase64, fromBase64 } from '../src/wallet/tx.ts';
import { MemoryApiSource, startTestApi } from './api-helpers.ts';
import { mintBytes, tokenAccountBytes } from './wallet-helpers.ts';
import { projectInput, randomPubkey } from './helpers.ts';

/* eslint-disable no-var */
declare const window: any; // evaluated inside the browser page
declare const document: any;

const PW = process.env.PLAYWRIGHT_MODULE ?? '/opt/node-tools/node_modules/playwright/index.js';
const havePlaywright = existsSync(PW) && existsSync('/opt/pw-browsers');
const opts = { skip: havePlaywright ? false : 'Playwright / Chromium not available' };

const STAGE_IDS = ['dormant', 'seed', 'bug', 'parasite', 'worm', 'overmind', 'god'];
const THRESHOLDS = ['0', '10000', '50000', '150000', '400000', '1000000', '2500000'];
const MINT = randomPubkey(); // a throw-away fixture: this is NOT the VIRUS token (which does not exist yet)
const TOKEN_ACCOUNT = randomPubkey();
const virusCfg = parseProjectConfig(projectInput({
  id: 'virus', name: 'VIRUS.EXE', ticker: 'VIRUS', cluster: 'mainnet-beta', mint: MINT, tokenProgram: 'token-2022',
  levels: STAGE_IDS.map((id, i) => ({ id, name: id, threshold: THRESHOLDS[i] })),
}));

/** Local JSON-RPC node: just enough for the wallet flow; chain progress is driven by the test. */
async function mockRpc(user: string, balanceRaw: bigint) {
  const st = { sent: [] as string[], phase: 'none' as 'none' | 'confirmed' | 'finalized', simulateOk: true, methods: [] as string[] };
  const acct = (owner: string, bytes: Uint8Array) => ({ owner, lamports: 2_000_000, data: [toBase64(bytes), 'base64'], executable: false, rentEpoch: 0 });
  const srv: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      st.methods.push(method);
      const ok = (result: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result })); };
      switch (method) {
        case 'getGenesisHash': return ok(GENESIS_HASHES['mainnet-beta']);
        case 'getLatestBlockhash': return ok({ context: { slot: 1 }, value: { blockhash: encodeBase58(new Uint8Array(32).fill(7)), lastValidBlockHeight: 10_000 } });
        case 'getBlockHeight': return ok(500);
        case 'getBalance': return ok({ context: { slot: 1 }, value: 1_000_000_000 });
        case 'getAccountInfo': {
          const addr = params[0];
          if (addr === MINT) return ok({ context: { slot: 1 }, value: acct(TOKEN_PROGRAMS['token-2022'], mintBytes({ decimals: 6, supply: 1_000_000_000_000_000n, mintAuthority: null })) });
          if (addr === TOKEN_ACCOUNT) return ok({ context: { slot: 1 }, value: acct(TOKEN_PROGRAMS['token-2022'], tokenAccountBytes({ mint: MINT, owner: user, amount: balanceRaw })) });
          return ok({ context: { slot: 1 }, value: null });
        }
        case 'getTokenAccountsByOwner': return ok({ context: { slot: 1 }, value: [{ pubkey: TOKEN_ACCOUNT, account: acct(TOKEN_PROGRAMS['token-2022'], tokenAccountBytes({ mint: MINT, owner: user, amount: balanceRaw })) }] });
        case 'getFeeForMessage': return ok({ context: { slot: 1 }, value: 5000 });
        case 'simulateTransaction': return ok({ context: { slot: 1 }, value: { err: st.simulateOk ? null : { InstructionError: [0, 'Custom'] }, logs: [], unitsConsumed: 1950 } });
        case 'sendTransaction': {
          st.sent.push(params[0]);
          return ok(encodeBase58(splitTransaction(fromBase64(params[0])).signatures[0]!));
        }
        case 'getSignatureStatuses': return ok({ context: { slot: 1 }, value: [st.phase === 'none' ? null : { slot: 600, err: null, confirmationStatus: st.phase }] });
        default: res.writeHead(200); res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } }));
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { st, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

async function bootSite(o: { withProject: boolean; balanceRaw?: bigint }) {
  if (!existsSync('web/dist/wallet/index.js')) execFileSync('npm', ['run', 'web:build'], { stdio: 'ignore' }); // generated browser build of the wallet module
  const user = Keypair.generate();
  const source = new MemoryApiSource([o.withProject ? 'virus' : 'other']);
  const projects = [o.withProject ? virusCfg : parseProjectConfig(projectInput({ id: 'other' }))];
  const api = await startTestApi(source, { projects });
  const rpc = await mockRpc(user.address, o.balanceRaw ?? 10_000_000n); // 10 tokens
  const web = createWebServer({ upstreamRpc: rpc.url, engineUrl: api.url, ratePerMinute: 100_000 });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
  const pw: any = await import(PW);
  const browser = await (pw.chromium ?? pw.default.chromium).launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: any) => { if (m.type() === 'error' && !/fonts\.g|ERR_(INTERNET|NAME|CONNECTION|TUNNEL|PROXY)|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
  // fonts come from Google: block them so the test needs no internet
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route: any) => route.abort());

  const flags = { phantomLike: false, signed: 0 };
  await page.exposeFunction('__nodeSign', (txB64: string) => {
    flags.signed++;
    let { message } = splitTransaction(fromBase64(txB64));
    if (flags.phantomLike) { // what Phantom does: ComputeBudget + Lighthouse assertions on the user's own account around the burn
      const asked = parseMessage(message);
      const original: Instruction[] = asked.instructions.map((i) => ({ programId: asked.keys[i.programIdIndex]!, keys: i.accounts.map((a) => ({ pubkey: asked.keys[a]!, isSigner: a < asked.numRequiredSignatures, isWritable: a < asked.numRequiredSignatures || a === 1 })), data: i.data }));
      const budget = (data: number[]): Instruction => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Uint8Array.from(data) });
      const assertion: Instruction = { programId: LIGHTHOUSE_PROGRAM, keys: [{ pubkey: user.address, isSigner: true, isWritable: false }], data: Uint8Array.from([6, 1, 2, 3]) };
      message = compileMessage(user.address, [budget([2, 0x30, 0x75, 0, 0]), budget([3, 0xe8, 0x03, 0, 0, 0, 0, 0, 0]), assertion, ...original, assertion], asked.recentBlockhash).message;
    }
    return toBase64(Uint8Array.from([1, ...user.sign(message), ...message]));
  });
  await page.addInitScript((cfg: { address: string; publicKey: number[] }) => {
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const w: any = { name: 'TestPhantom', version: '1.0.0', icon: 'data:image/svg+xml;base64,PHN2Zy8+', chains: ['solana:mainnet'], accounts: [], features: {}, _l: new Set(), _reject: false };
    const account = () => ({ address: cfg.address, publicKey: Uint8Array.from(cfg.publicKey), chains: ['solana:mainnet'], features: ['solana:signTransaction'] });
    w.features['standard:connect'] = { version: '1.0.0', connect: async () => { w.accounts = [account()]; return { accounts: w.accounts }; } };
    w.features['standard:disconnect'] = { version: '1.0.0', disconnect: async () => { w.accounts = []; } };
    w.features['standard:events'] = { version: '1.0.0', on: (_e: string, l: any) => { w._l.add(l); return () => w._l.delete(l); } };
    w.features['solana:signTransaction'] = {
      version: '1.0.0', supportedTransactionVersions: ['legacy'],
      signTransaction: async (...inputs: any[]) => {
        if (w._reject) { w._reject = false; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
        return [{ signedTransaction: unb64(await (window as any).__nodeSign(b64(inputs[0].transaction))) }];
      },
    };
    (window as any).__wallet = w;
    const cb = (api: { register: (w: unknown) => void }) => api.register(w);
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: cb }));
    window.addEventListener('wallet-standard:app-ready', (e: any) => cb((e as CustomEvent).detail));
  }, { address: user.address, publicKey: [...user.publicKey] });

  return {
    page, base, source, api, rpc, flags, errors, user,
    storeState: () => page.evaluate(() => { const s = (window as any).VX.store.state; return { status: s.status, hasData: s.hasData, total: s.totalBurned, burnCount: s.burnCount, stage: s.stageIndex, label: s.source.label }; }),
    close: async () => { await browser.close(); await new Promise<void>((r) => { web.closeAllConnections(); web.close(() => r()); }); await rpc.close(); await api.close(); },
  };
}

test('[virus-site][chromium] no token yet: the page loads, says so, BURN / BUY / CHART are unavailable, nothing is invented', opts, async () => {
  const s = await bootSite({ withProject: false });
  try {
    await s.page.goto(`${s.base}/virus/`);
    await s.page.waitForFunction(() => (window as any).VX?.store?.state?.source?.label === 'NO TOKEN YET', null, { timeout: 15_000 });
    const st = await s.storeState();
    assert.equal(st.hasData, false);
    assert.equal(st.total, 0);
    // the burn window is explicit and has no usable control
    await s.page.locator('.btn-feed').first().click();
    await s.page.waitForSelector('[data-burn]');
    assert.match(await s.page.locator('[data-b="state"]').innerText(), /not launched/i);
    assert.equal(await s.page.locator('[data-b="preview"]').isDisabled(), true);
    assert.equal(await s.page.locator('[data-b="amount"]').isDisabled(), true);
    assert.equal(await s.page.locator('[data-b="confirm"]').isDisabled(), true);
    // BUY / CHART do not point anywhere, and the provisional address of the zip is gone
    const html = await s.page.content();
    assert.doesNotMatch(html, /FMmNZJAzmx9VAuBF6kmR7FM51B8TMcGfhbGXoMtypump/);
    assert.deepEqual(await s.page.evaluate(() => (window as any).VX.config.links.filter((l: any) => l.url).map((l: any) => l.id)), []);
    assert.equal(await s.page.evaluate(() => (window as any).VX.config.token.contract), null);
    assert.deepEqual(s.errors, []);
    assert.equal(s.rpc.st.methods.length, 0, 'no RPC call is made without a token');
  } finally { await s.close(); }
});

test('[virus-site][chromium] free-amount burn end to end with a mock wallet: validation, explicit confirmation, signature, chain vs engine counting, explorer link', opts, async () => {
  const s = await bootSite({ withProject: true });
  try {
    s.source.states.get('virus')!.verification = { status: 'verified', at: '2026-01-01T00:00:00.000Z' } as any;
    await s.page.goto(`${s.base}/virus/`);
    await s.page.waitForFunction(() => (window as any).VX?.store?.state?.hasData === true, null, { timeout: 20_000 });
    assert.deepEqual(await s.storeState(), { status: 'ready', hasData: true, total: 0, burnCount: 0, stage: 0, label: 'LIVE' });

    await s.page.locator('.btn-feed').first().click();
    await s.page.waitForSelector('[data-burn]');
    await s.page.getByRole('button', { name: /Connect TestPhantom/ }).click();
    await s.page.waitForFunction(() => document.querySelector('[data-b="balance"]')?.textContent === '10', null, { timeout: 15_000 });
    assert.match(await s.page.locator('[data-b="account"]').innerText(), new RegExp(s.user.address));

    // invalid amounts never reach the preview
    const amount = s.page.locator('[data-b="amount"]');
    const preview = s.page.locator('[data-b="preview"]');
    for (const bad of ['0', '-1', 'abc', '1e3', '1.0000001', '10.000001', '11', '999999999999999999999']) {
      await amount.fill(bad);
      assert.equal(await preview.isDisabled(), true, `"${bad}" must not be previewable`);
    }
    await amount.fill('abc');
    assert.match(await s.page.locator('[data-b="amountErr"]').innerText(), /invalid|positive/i);
    await amount.fill('11');
    assert.match(await s.page.locator('[data-b="amountErr"]').innerText(), /higher than your available balance/i);

    // MAX is exactly the balance, in raw units too
    await s.page.locator('[data-b="max"]').click();
    assert.equal(await amount.inputValue(), '10');
    await amount.fill('2.5');
    assert.equal(await preview.isDisabled(), false);

    // preview: recap + irreversibility; confirmation needs an explicit tick; nothing is signed before that
    await preview.click();
    await s.page.waitForSelector('[data-b="recap"]:not([hidden])');
    assert.match(await s.page.locator('[data-b="recapKv"]').innerText(), /2\.5 \$VIRUS \(2500000 raw\)/);
    assert.match(await s.page.locator('[data-burn]').innerText(), /PERMANENT/);
    if (process.env.VIRUS_SHOTS_DIR) await s.page.screenshot({ path: `${process.env.VIRUS_SHOTS_DIR}/burn-recap-iphone.png` });
    const confirm = s.page.locator('[data-b="confirm"]');
    assert.equal(await confirm.isDisabled(), true, 'disabled until the user ticks the acknowledgement');
    assert.equal(s.flags.signed, 0);
    await s.page.locator('[data-b="ack"]').check();
    assert.equal(await confirm.isDisabled(), false);
    await confirm.click();

    // the wallet signed ONCE, the transaction was sent, the chain says "pending": the counter has NOT moved
    await s.page.waitForFunction(() => /SENT|PROCESSED/.test(document.querySelector('[data-b="txPhase"]')?.textContent ?? ''), null, { timeout: 15_000 });
    assert.equal(s.flags.signed, 1);
    assert.equal(s.rpc.st.sent.length, 1);
    assert.equal((await s.storeState()).total, 0, 'a signature / a sent transaction never moves the counter');
    const sig = encodeBase58(splitTransaction(fromBase64(s.rpc.st.sent[0]!)).signatures[0]!);
    assert.equal(await s.page.locator('[data-b="sig"] a').getAttribute('href'), `https://solscan.io/tx/${sig}`);

    s.rpc.st.phase = 'confirmed';
    await s.page.waitForFunction(() => /CONFIRMED on chain/.test(document.querySelector('[data-b="txPhase"]')?.textContent ?? ''), null, { timeout: 15_000 });
    assert.equal((await s.storeState()).total, 0, 'chain confirmation is not engine counting');
    s.rpc.st.phase = 'finalized';
    await s.page.waitForFunction(() => /FINALIZED on chain/.test(document.querySelector('[data-b="txPhase"]')?.textContent ?? ''), null, { timeout: 15_000 });
    assert.match(await s.page.locator('[data-b="enginePhase"]').innerText(), /waiting for the engine/);
    assert.equal((await s.storeState()).total, 0, 'finalized on chain, still not counted until the ENGINE lists it');

    // the engine lists the burn (journal): only now do the counter and the burn window move
    const seq = s.source.events.get('virus')!.length + 1;
    s.source.events.get('virus')!.push({ id: seq, type: 'burn', createdAt: new Date(), burn: { signature: sig, instructionPath: '0', slot: 600, blockTime: 1_700_000_000, owner: s.user.address, amountRaw: 2_500_000n, finalizedAt: new Date() } });
    s.source.finalized.set('virus', 2_500_000n);
    await s.page.waitForFunction(() => (window as any).VX.store.state.totalBurned === 2.5, null, { timeout: 15_000 });
    await s.page.waitForFunction(() => /COUNTED by the engine/.test(document.querySelector('[data-b="enginePhase"]')?.textContent ?? ''), null, { timeout: 15_000 });
    if (process.env.VIRUS_SHOTS_DIR) await s.page.screenshot({ path: `${process.env.VIRUS_SHOTS_DIR}/burn-counted-iphone.png` });
    assert.deepEqual(await s.storeState(), { status: 'ready', hasData: true, total: 2.5, burnCount: 1, stage: 0, label: 'LIVE' });
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('[virus-site][chromium] wallet refusal, failed simulation, and a Phantom-like transaction (ComputeBudget + Lighthouse on the signer) are all handled; nothing is sent when refused', opts, async () => {
  const s = await bootSite({ withProject: true });
  try {
    await s.page.goto(`${s.base}/virus/`);
    await s.page.waitForFunction(() => (window as any).VX?.store?.state?.hasData === true, null, { timeout: 20_000 });
    await s.page.locator('.btn-feed').first().click();
    await s.page.getByRole('button', { name: /Connect TestPhantom/ }).click();
    await s.page.waitForFunction(() => document.querySelector('[data-b="balance"]')?.textContent === '10', null, { timeout: 15_000 });
    const preview = async (amount: string) => {
      await s.page.locator('[data-b="amount"]').fill(amount);
      await s.page.locator('[data-b="preview"]').click();
      await s.page.waitForSelector('[data-b="recap"]:not([hidden])');
      await s.page.locator('[data-b="ack"]').check();
    };

    // simulation failure: the confirm button stays disabled, nothing is signed or sent
    s.rpc.st.simulateOk = false;
    await preview('1');
    assert.match(await s.page.locator('[data-b="recapKv"]').innerText(), /FAILED/);
    assert.equal(await s.page.locator('[data-b="confirm"]').isDisabled(), true);
    s.rpc.st.simulateOk = true;

    // the user refuses in the wallet: explicit message, nothing sent
    await s.page.locator('[data-b="preview"]').click();
    await s.page.locator('[data-b="ack"]').check();
    await s.page.evaluate(() => { (window as any).__wallet._reject = true; });
    await s.page.locator('[data-b="confirm"]').click();
    await s.page.waitForFunction(() => /rejected the request/.test(document.querySelector('[data-b="error"]')?.textContent ?? ''), null, { timeout: 15_000 });
    assert.equal(s.rpc.st.sent.length, 0);
    assert.equal((await s.storeState()).total, 0);

    // Phantom-like additions: accepted, verified, sent once
    s.flags.phantomLike = true;
    await preview('1');
    await s.page.locator('[data-b="confirm"]').click();
    await s.page.waitForFunction(() => /wallet safety checks verified/.test(document.querySelector('[data-b="txPhase"]')?.textContent ?? ''), null, { timeout: 15_000 });
    assert.equal(s.rpc.st.sent.length, 1);
    assert.equal((await s.storeState()).total, 0);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('[virus-site][chromium] iPhone and desktop layout: no horizontal overflow, 7 sprites untouched, the site is served from /virus/ and "/" is still the test page', opts, async () => {
  const s = await bootSite({ withProject: true });
  try {
    // a visitor arrives after several mutations: 160,000 tokens burned and finalized (Parasite: 150K .. 400K)
    s.source.addBurn('virus', 60_000_000_000n); s.source.addMutation('virus', 'seed', 1); s.source.addMutation('virus', 'bug', 2);
    s.source.addBurn('virus', 100_000_000_000n); s.source.addMutation('virus', 'parasite', 3);
    await s.page.goto(`${s.base}/virus/`);
    await s.page.waitForFunction(() => (window as any).VX?.store?.state?.hasData === true, null, { timeout: 20_000 });
    const dom = await s.page.evaluate(() => ({
      stage: document.querySelector('[data-bind="stageName"]')?.textContent, toNext: document.querySelector('[data-bind="toNext"]')?.textContent,
      progress: document.querySelector('[data-bar="stage"]')?.style.getPropertyValue('--p'), infection: document.querySelector('[data-bar="infection"]')?.style.getPropertyValue('--p'),
      burned: document.querySelector('[data-bind="burned"]')?.textContent, stageIndex: (window as any).VX.store.state.stageIndex,
    }));
    assert.equal(dom.stageIndex, 3);
    assert.equal(dom.stage, 'Parasite Form', 'right form immediately, no replayed mutation');
    assert.equal(dom.toNext, '240K $VIRUS to Worm Form');
    assert.equal(Number(dom.progress), 4, '(160K-150K)/(400K-150K)');
    assert.equal(Number(dom.infection), 50.67, '(3 + 0.04) / 6');
    assert.equal(dom.burned, '160,000');
    if (process.env.VIRUS_SHOTS_DIR) await s.page.screenshot({ path: `${process.env.VIRUS_SHOTS_DIR}/home-iphone.png` });
    for (const [w, h] of [[390, 844], [1280, 800]] as const) {
      await s.page.setViewportSize({ width: w, height: h });
      await s.page.waitForTimeout(200);
      const over = await s.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 1, `horizontal overflow of ${over}px at ${w}px`);
    }
    assert.equal(await s.page.evaluate(() => (window as any).VX.config.stages.length), 7);
    assert.equal((await fetch(`${s.base}/virus`, { redirect: 'manual' })).status, 302);
    assert.match(await (await fetch(`${s.base}/`)).text(), /Burn — page wallet/);
    assert.equal((await fetch(`${s.base}/virus/js/engine-bridge.js`)).status, 200);
    assert.equal((await fetch(`${s.base}/virus/assets/token/virus-logo-512.png`)).headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${s.base}/virus/../package.json`)).status, 404);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});
