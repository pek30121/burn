/* GOLDEN GEOMETRY of the VIRUS.EXE windows and popups. The behaviour and the size/position of every window and popup are part of the
 * show (the virus's chaos), so no graphic change may move or resize them. This test opens every window and a set of popups (placement
 * driven by a seeded random generator, ambient popups frozen) at six viewport widths and compares each rectangle (and the title bar,
 * the window controls, the body and the buttons) with `tests/fixtures/virus-geometry.json`, captured BEFORE the graphic refit.
 * The golden was captured with the refit stylesheet disabled: VIRUS_GEOMETRY_NO_REFIT=1 UPDATE_VIRUS_GEOMETRY=1 node --test tests/virus-geometry.test.ts
 * (VIRUS_GEOMETRY_NO_REFIT=1 serves an empty css/win98.css). Re-capture only for a reviewed change.
 * Chromium only; skipped (and reported as skipped) without Playwright. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { startPreview } from '../scripts/virus-preview/server.ts';

declare const window: any; // evaluated inside the browser page
declare const document: any;

const PW = process.env.PLAYWRIGHT_MODULE ?? '/opt/node-tools/node_modules/playwright/index.js';
const opts = { skip: existsSync(PW) && existsSync('/opt/pw-browsers') ? false : 'Playwright / Chromium not available' };
const FIXTURE = resolve('tests/fixtures/virus-geometry.json');
const VIEWPORTS: [number, number][] = [[375, 812], [390, 844], [430, 932], [768, 1024], [1280, 800], [1440, 900]];

const PROBE = `(async () => {
  const VX = window.VX;
  VX.popups.ambient = () => {}; // the random ambient popups are timers: frozen, the geometry of the ones we spawn is what we compare
  VX.popups.closeAll();
  for (const el of document.querySelectorAll('.win')) el.remove();
  const seeded = (seed, fn) => {
    let a = seed;
    window.__rand = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    try { return fn(); } finally { window.__rand = null; }
  };
  const box = (el) => el ? [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight] : null;
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.x * 100) / 100, Math.round(b.y * 100) / 100, Math.round(b.width * 100) / 100, Math.round(b.height * 100) / 100]; };
  const describe = (el) => ({
    box: box(el), rect: r(el), title: r(el.querySelector('.win-title')), body: r(el.querySelector('.win-body')),
    controls: [...el.querySelectorAll('.wc')].map(r), buttons: [...el.querySelectorAll('.popup-btns .btn')].map(r), z: el.style.zIndex || null,
  });
  const out = { windows: {}, popups: [] };
  const ids = ['explorer', 'sysmon', 'lab', 'log', 'readme', 'token', 'quarantine', 'control', 'photo', 'burn'];
  for (const id of ids) seeded(7, () => VX.wm.open(id));
  await new Promise((r) => setTimeout(r, 1200));
  const variants = [
    { title: 'System Warning', text: 'Your files look delicious.', kind: 'warn', buttons: [{ label: 'OK' }, { label: 'Also OK' }] },
    { title: 'Error', text: 'Error 0x0BADF00D: antivirus.exe was eaten.', kind: 'error' },
    { title: 'virus.exe', text: 'Are you sure you want to NOT burn?', kind: 'info', buttons: [{ label: 'Yes' }, { label: 'No' }] },
    { title: 'Fatal Exception', text: 'A fatal exception 0E has occurred at 0028:C0011E36. It was delicious.', kind: 'error', buttons: [{ label: 'Close' }] },
    { title: 'MUTATION UNLOCKED', kind: 'mutation', center: true, width: 340,
      html: '<div class="mut-pop"><canvas class="px" width="64" height="64" aria-hidden="true"></canvas><div><small>FORM 02 / 07</small><strong>Glitch Seed</strong><p>The first burns woke it up. One eye, unstable pixels, a lot of curiosity.</p></div></div>',
      buttons: [{ label: 'Inspect form' }, { label: 'Let it grow' }] },
    { title: 'Security Alert', text: 'VIRUS.EXE detected on this desktop.', kind: 'warn', center: true, buttons: [{ label: 'How to feed it' }, { label: 'Inspect forms' }, { label: 'Let it spread' }] },
    { title: 'Positioned', text: 'explicit x / y', kind: 'info', x: 40, y: 90 },
  ];
  const popupEls = variants.map((v, i) => seeded(100 + i, () => VX.popups.spawn(v)));
  // measure only once every opening animation has ended (a rectangle read mid-animation includes the scale transform: timing, not geometry)
  for (let t = 0; t < 100 && document.querySelector('.win.opening'); t++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200));
  for (const id of ids) out.windows[id] = describe(VX.wm.get(id));
  popupEls.forEach((el) => out.popups.push(describe(el)));
  const desk = document.getElementById('desktop');
  out.desk = r(desk);
  out.layers = { win: r(document.getElementById('winLayer')), popup: r(document.getElementById('popupLayer')) };
  return out;
})()`;

async function capture(): Promise<Record<string, unknown>> {
  const p = await startPreview({ port: 0, host: '127.0.0.1', root: resolve('web'), env: {}, timing: { confirmMs: 150, finalizeMs: 500 } });
  const pw: any = await import(PW);
  const b = await (pw.chromium ?? pw.default.chromium).launch({ headless: true, args: ['--no-sandbox'] });
  const result: Record<string, unknown> = {};
  try {
    for (const [w, h] of VIEWPORTS) {
      const mobile = w <= 430;
      const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile, userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' : undefined });
      await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route: any) => route.abort());
      if (process.env.VIRUS_GEOMETRY_NO_REFIT === '1') await ctx.route(/css\/win98\.css/, (route: any) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
      await ctx.addInitScript(() => { const orig = Math.random; Math.random = () => (window.__rand ? window.__rand() : orig()); });
      const page = await ctx.newPage();
      await page.goto(`${p.url}/virus/`);
      await page.waitForFunction(() => window.VX?.store?.state?.hasData === true, null, { timeout: 20_000 });
      await page.evaluate(() => { document.getElementById('demo-banner')?.remove(); document.body.style.paddingTop = '0'; document.getElementById('boot')?.remove(); });
      await page.waitForTimeout(400);
      result[`${w}x${h}`] = await page.evaluate(PROBE);
      await ctx.close();
    }
  } finally { await b.close(); await p.close(); }
  return result;
}

test('[virus-geometry] windows and popups keep exactly the same size, position, stacking and inner metrics at 375/390/430/768/1280/1440 px', opts, async () => {
  const now = await capture();
  if (process.env.UPDATE_VIRUS_GEOMETRY === '1' || !existsSync(FIXTURE)) {
    writeFileSync(FIXTURE, JSON.stringify(now, null, 1) + '\n');
    return;
  }
  const golden = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  for (const vp of Object.keys(golden)) {
    const a = JSON.parse(JSON.stringify(now[vp]));
    const g = golden[vp];
    for (const id of Object.keys(g.windows)) assert.deepEqual(a.windows[id], g.windows[id], `${vp}: window "${id}" geometry changed`);
    g.popups.forEach((popup: unknown, i: number) => assert.deepEqual(a.popups[i], popup, `${vp}: popup #${i} geometry changed`));
    assert.deepEqual(a.desk, g.desk, `${vp}: desktop box changed`);
    assert.deepEqual(a.layers, g.layers, `${vp}: window/popup layers changed`);
  }
});
