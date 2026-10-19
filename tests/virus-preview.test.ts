/* The isolated VIRUS.EXE preview (scripts/virus-preview): demo data only, nothing real. Includes a Chromium run on an iPhone-sized viewport:
 * the 7 mutations through the demo controls, and the BURN window with the demo wallet and the mock RPC. Skipped (reported as skipped) without Playwright. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createWebServer } from '../scripts/wallet-test/server.ts';
import { DEMO_MINT, FORBIDDEN_ENV, startPreview, type Preview } from '../scripts/virus-preview/server.ts';

declare const window: any; // evaluated inside the browser page
declare const document: any;

const ROOT = resolve('web');
const PW = process.env.PLAYWRIGHT_MODULE ?? '/opt/node-tools/node_modules/playwright/index.js';
const opts = { skip: existsSync(PW) && existsSync('/opt/pw-browsers') ? false : 'Playwright / Chromium not available' };
const start = (over: Record<string, unknown> = {}) => startPreview({ port: 0, host: '127.0.0.1', root: ROOT, env: {}, timing: { confirmMs: 150, finalizeMs: 500 }, ...over } as any);
const post = (p: Preview, path: string) => fetch(`${p.url}${path}`, { method: 'POST' });
const status = async (p: Preview) => (await (await fetch(`${p.url}/api/v1/projects/virus/status`)).json()) as any;

test('[virus-preview] refuses to start next to the real engine\'s secrets (database URL, Helius key, RPC URLs): it can never touch production', async () => {
  for (const k of FORBIDDEN_ENV) await assert.rejects(() => start({ env: { [k]: 'x' } }), new RegExp(`${k} is set`));
  await assert.rejects(() => start({ env: { DATABASE_URL: 'x', HELIUS_API_KEY: 'y' } }), /DATABASE_URL, HELIUS_API_KEY/);
  const p = await start({ env: { DEPLOY_NETWORK: 'mainnet', SOLANA_CLUSTER: 'mainnet-beta', PROJECTS_CONFIG: 'deploy/projects.mainnet.json' } }); // the shared .replit [env] is not a secret
  await p.close();
});

test('[virus-preview] demo features exist ONLY in the preview: the production web server serves neither the demo script nor demo controls, and the real index has no demo tag', async () => {
  const prod = createWebServer({ upstreamRpc: 'http://127.0.0.1:9', engineUrl: 'http://127.0.0.1:9' });
  await new Promise<void>((r) => prod.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(prod.address() as { port: number }).port}`;
  try {
    for (const path of ['/virus-demo/demo.js', '/demo/api/state', '/virus-preview/demo.js']) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    assert.equal((await fetch(`${base}/demo/api/burn?tokens=5`, { method: 'POST' })).status, 405);
    const html = await (await fetch(`${base}/virus/`)).text();
    assert.doesNotMatch(html, /demo/i);
    assert.doesNotMatch(readFileSync('web/virus/index.html', 'utf8'), /virus-demo|demo\.js|__DEMO__/);
    assert.doesNotMatch(readFileSync('web/virus/js/project.js', 'utf8') + readFileSync('web/virus/js/engine-bridge.js', 'utf8') + readFileSync('web/virus/js/burn-ui.js', 'utf8'), /__DEMO__|virus-demo/);
  } finally { await new Promise<void>((r) => { prod.closeAllConnections(); prod.close(() => r()); }); }
});

test('[virus-preview] the preview serves the real site with the demo layer injected, the real API contract, and a clearly fake project', async () => {
  const p = await start();
  try {
    const html = await (await fetch(`${p.url}/virus/`)).text();
    assert.match(html, /<script src="\/virus-demo\/demo\.js"><\/script>\s*<\/body>/);
    assert.match(html, /js\/engine-bridge\.js/);
    const js = await fetch(`${p.url}/virus-demo/demo.js`);
    assert.equal(js.status, 200);
    assert.match(await js.text(), /DEMO — simulated data/);
    const list = (await (await fetch(`${p.url}/api/v1/projects`)).json()) as any;
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].name, 'VIRUS.EXE (DEMO)');
    assert.equal(list.data[0].mint, DEMO_MINT);
    assert.deepEqual(list.data[0].levels.map((l: any) => l.id), ['dormant', 'seed', 'bug', 'parasite', 'worm', 'overmind', 'god']);
    assert.deepEqual(list.data[0].levels.map((l: any) => l.threshold), ['0', '10000', '50000', '150000', '400000', '1000000', '2500000']);
    const st = await status(p);
    assert.equal(st.totals.finalizedRaw, '0');
    assert.equal(st.totals.burnCount, 0);
    assert.equal(st.data.history.complete, false, 'the demo never claims a proven history');
  } finally { await p.close(); }
});

test('[virus-preview] demo controls go through the engine event log: burns, level crossings (one mutation per level), exact jumps, reset, input validation', async () => {
  const p = await start();
  try {
    assert.equal((await post(p, '/demo/api/burn?tokens=1000')).status, 200);
    assert.equal((await status(p)).totals.finalized, '1000');
    assert.equal((await post(p, '/demo/api/burn?tokens=0')).status, 400);
    assert.equal((await post(p, '/demo/api/burn?tokens=abc')).status, 400);
    assert.equal((await post(p, '/demo/api/burn?tokens=1.5')).status, 400);
    assert.equal((await post(p, '/demo/api/level?index=9')).status, 400);
    assert.equal((await fetch(`${p.url}/demo/api/burn?tokens=5`)).status, 405);
    assert.equal((await post(p, '/demo/api/level?index=6')).status, 200); // straight to System God: lands exactly on 2,500,000
    const st = await status(p);
    assert.equal(st.totals.finalized, '2500000');
    assert.equal(st.progression.level.id, 'god');
    const ev = ((await (await fetch(`${p.url}/api/v1/projects/virus/events?after=0&limit=100`)).json()) as any).data;
    assert.deepEqual(ev.filter((e: any) => e.type === 'mutation').map((e: any) => e.mutation.levelId), ['seed', 'bug', 'parasite', 'worm', 'overmind', 'god'], 'each level once, in order');
    assert.equal((await post(p, '/demo/api/level?index=3')).status, 200); // below the current total: nothing happens
    assert.equal((await status(p)).totals.finalized, '2500000');
    assert.equal((await post(p, '/demo/api/reset')).status, 200);
    assert.equal((await status(p)).totals.finalizedRaw, '0');
  } finally { await p.close(); }
});

test('[virus-preview] the mock RPC only knows the demo token and refuses anything that is not a burn; /rpc keeps its allowlist', async () => {
  const p = await start();
  try {
    const rpc = (method: string, params: unknown[] = []) => fetch(`${p.url}/rpc`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    assert.equal(((await (await rpc('getGenesisHash')).json()) as any).result, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
    assert.equal((await rpc('getProgramAccounts')).status, 403);
    const unknown = ((await (await rpc('getAccountInfo', ['11111111111111111111111111111111'])).json()) as any).result.value;
    assert.equal(unknown, null);
    const bad = await (await rpc('sendTransaction', [Buffer.from(new Uint8Array(70)).toString('base64')])).json();
    assert.ok((bad as any).error || (bad as any).result === undefined);
    assert.equal(p.rpc.sent.length, 0);
  } finally { await p.close(); }
});

/* ------------------------------------------- Chromium ------------------------------------------- */

async function browser(p: Preview, viewport = { width: 390, height: 844 }) {
  if (!existsSync('web/dist/wallet/index.js')) execFileSync('npm', ['run', 'web:build'], { stdio: 'ignore' });
  const pw: any = await import(PW);
  const b = await (pw.chromium ?? pw.default.chromium).launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route: any) => route.abort());
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: any) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource|ERR_/i.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d: any) => void d.accept());
  await page.goto(`${p.url}/virus/`);
  await page.waitForFunction(() => window.VX?.store?.state?.hasData === true, null, { timeout: 20_000 });
  return { page, errors, close: () => b.close() };
}

test('[virus-preview][chromium] the 7 forms through the demo controls: one mutation per form, right names, banner always visible, no overflow on iPhone width', opts, async () => {
  const p = await start();
  const b = await browser(p);
  try {
    const NAMES = ['Dormant File', 'Glitch Seed', 'Bug Form', 'Parasite Form', 'Worm Form', 'Overmind', 'System God'];
    assert.match(await b.page.locator('#demo-banner').innerText(), /DEMO — simulated data/);
    const stage = () => b.page.evaluate(() => ({ name: document.querySelector('[data-bind="stageName"]')?.textContent, idx: window.VX.store.state.stageIndex }));
    const mutations = await b.page.evaluate(() => { const m: any[] = []; window.VX.store.on('mutation', (x: any) => m.push(x)); window.__mut = m; return 0; });
    void mutations;
    assert.deepEqual(await stage(), { name: 'Dormant File', idx: 0 });
    await b.page.locator('#demo-banner button').click();
    for (let i = 1; i < 7; i++) {
      await b.page.getByRole('button', { name: 'Next form ▶' }).click();
      await b.page.waitForFunction((n: number) => window.VX.store.state.stageIndex === n, i, { timeout: 10_000 });
      assert.equal((await stage()).name, NAMES[i], `form ${i + 1}`);
    }
    assert.deepEqual(await b.page.evaluate(() => JSON.parse(JSON.stringify(window.__mut))), [0, 1, 2, 3, 4, 5].map((i) => ({ from: i, to: i + 1 })), 'exactly one mutation per form');
    // a visitor arriving now sees System God at once, with the whole history intact
    await b.page.reload();
    await b.page.waitForFunction(() => window.VX?.store?.state?.hasData === true, null, { timeout: 20_000 });
    assert.equal((await stage()).name, 'System God');
    const over = await b.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 1, `horizontal overflow ${over}px`);
    assert.deepEqual(b.errors, []);
  } finally { await b.close(); await p.close(); }
});

test('[virus-preview][chromium] BURN window with the demo wallet: free amount, MAX, explicit confirmation, simulated chain phases, counter moves only when the engine lists the burn', opts, async () => {
  const p = await start({ timing: { confirmMs: 700, finalizeMs: 1800 } });
  const b = await browser(p);
  try {
    await b.page.locator('.btn-feed').first().click();
    await b.page.waitForSelector('[data-burn]');
    await b.page.getByRole('button', { name: /Connect Demo Wallet/ }).click();
    await b.page.waitForFunction(() => document.querySelector('[data-b="balance"]')?.textContent === '1000000', null, { timeout: 15_000 });
    const amount = b.page.locator('[data-b="amount"]');
    await amount.fill('1000001');
    assert.equal(await b.page.locator('[data-b="preview"]').isDisabled(), true, 'above the demo balance');
    await b.page.locator('[data-b="max"]').click();
    assert.equal(await amount.inputValue(), '1000000');
    await amount.fill('12.5');
    await b.page.locator('[data-b="preview"]').click();
    await b.page.waitForSelector('[data-b="recap"]:not([hidden])');
    assert.match(await b.page.locator('[data-b="recapKv"]').innerText(), /12\.5 \$VIRUS \(12500000 raw\)/);
    assert.equal(await b.page.locator('[data-b="confirm"]').isDisabled(), true);
    await b.page.locator('[data-b="ack"]').check();
    await b.page.locator('[data-b="confirm"]').click(); // the demo wallet asks for its (simulated) approval: accepted by the dialog handler
    await b.page.waitForFunction(() => /CONFIRMED on chain/.test(document.querySelector('[data-b="txPhase"]')?.textContent ?? ''), null, { timeout: 15_000 });
    assert.equal((await status(p)).totals.finalizedRaw, '0', 'confirmed on the (simulated) chain is not counted by the engine');
    assert.equal(await b.page.evaluate(() => window.VX.store.state.totalBurned), 0);
    await b.page.waitForFunction(() => /COUNTED by the engine/.test(document.querySelector('[data-b="enginePhase"]')?.textContent ?? ''), null, { timeout: 15_000 });
    await b.page.waitForFunction(() => window.VX.store.state.totalBurned === 12.5, null, { timeout: 10_000 });
    assert.equal((await status(p)).totals.finalizedRaw, '12500000');
    assert.equal(p.rpc.sent.length, 1);
    const href = await b.page.locator('[data-b="sig"] a').getAttribute('href');
    assert.match(href ?? '', /^#demo-simulated-transaction-/, 'simulated transactions never link to a real explorer');
    assert.deepEqual(b.errors, []);
  } finally { await b.close(); await p.close(); }
});

test('[virus-preview] the production supervisor never starts the preview and the preview is not part of the production build entry', () => {
  const sup = readFileSync('scripts/replit/supervisor.ts', 'utf8');
  assert.doesNotMatch(sup, /virus-preview|startPreview/);
  const replit = readFileSync('.replit', 'utf8');
  assert.doesNotMatch(replit, /virus-preview|virus:preview/);
});
