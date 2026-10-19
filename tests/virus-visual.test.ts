/* VIRUS.EXE Windows 98 finish (web/virus/css/win98.css): the graphic refit is really applied, it is paint-only, and the seven forms, the
 * mutations and their popups, the BURN window and the Start menu still work at 375/390/430/768/1280/1440 px. The geometry of windows and popups
 * is guarded separately by tests/virus-geometry.test.ts (golden capture). Chromium only; skipped (reported as skipped) without Playwright. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { startPreview, type Preview } from '../scripts/virus-preview/server.ts';

declare const window: any; // evaluated inside the browser page
declare const document: any;
declare const getComputedStyle: any;
declare const MutationObserver: any;

const PW = process.env.PLAYWRIGHT_MODULE ?? '/opt/node-tools/node_modules/playwright/index.js';
const opts = { skip: existsSync(PW) && existsSync('/opt/pw-browsers') ? false : 'Playwright / Chromium not available' };
const VIEWPORTS: [number, number][] = [[375, 812], [390, 844], [430, 932], [768, 1024], [1280, 800], [1440, 900]];
const NAMES = ['Dormant File', 'Glitch Seed', 'Bug Form', 'Parasite Form', 'Worm Form', 'Overmind', 'System God'];
const CSS = readFileSync('web/virus/css/win98.css', 'utf8');

async function open(p: Preview, w: number, h: number) {
  const pw: any = await import(PW);
  const b = await (pw.chromium ?? pw.default.chromium).launch({ headless: true, args: ['--no-sandbox'] });
  const mobile = w <= 430;
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile, userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' : undefined });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route: any) => route.abort());
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: any) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource|ERR_/i.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d: any) => void d.accept());
  await page.goto(`${p.url}/virus/`);
  await page.waitForFunction(() => window.VX?.store?.state?.hasData === true, null, { timeout: 20_000 });
  await page.locator('#boot').click({ position: { x: 5, y: 5 } }).catch(() => {}); // skip the BIOS the way a visitor does, so the animations are enabled
  await page.waitForFunction(() => { const el = document.getElementById('boot'); return !el || el.classList.contains('done') || getComputedStyle(el).opacity === '0'; }, null, { timeout: 10_000 });
  await page.evaluate(() => { document.getElementById('demo-banner')?.remove(); document.body.style.paddingTop = '0'; });
  await page.waitForTimeout(600);
  return { page, errors, close: () => b.close() };
}

test('[virus-visual] the finish is paint-only: win98.css declares no layout property except a short reviewed list (none on windows, popups or their content)', () => {
  const body = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const FORBIDDEN = /^(width|height|min-width|min-height|max-width|max-height|margin(-[a-z]+)?|padding(-[a-z]+)?|top|left|right|bottom|position|display|flex(-[a-z]+)?|grid(-[a-z]+)?|gap|line-height|font(-[a-z]+)?|transform|inset|overflow(-[a-z]+)?|z-index|border(-[a-z]+)*|align-[a-z]+|justify-[a-z]+)$/;
  // reviewed exceptions: [selector pattern, properties]. None of these selects a window, a popup or something inside them,
  // except the icon <img> boxes (box-sizing + padding keep the box and only snap the drawn pixels to an integer scale).
  const ALLOWED: [RegExp, string[]][] = [
    [/^\.start-btn$/, ['position']],
    [/^\.start-btn::after$/, ['position', 'right', 'top', 'bottom', 'width']],
    [/^\.lab-grid > li$/, ['display']],
    [/^\.lab-card$/, ['flex', 'align-content']],
    [/^\.lab-card\.current \.lc-state$/, ['padding']],
    [/^\.sm-item$/, ['padding-top', 'padding-bottom']],
    [/^\.sm-item img$/, ['width', 'height']],
    [/^\.wc::before, \.wc::after$/, ['display']],
    [/::-webkit-scrollbar/, ['width', 'height', 'display']],
    [/\bimg\b|\.popup-icon|\.q-head img|\.food img|\.how img/, ['box-sizing', 'padding']],
  ];
  const offenders: string[] = [];
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.trim().replace(/^@media[^{]*\{?\s*/, '').replace(/^\s+|\s+$/g, '');
    if (!sel || sel.startsWith('@')) continue;
    for (const d of m[2]!.split(';')) {
      const prop = d.split(':')[0]!.trim();
      if (!prop || !FORBIDDEN.test(prop)) continue;
      const ok = ALLOWED.some(([re, props]) => re.test(sel) && props.includes(prop));
      if (!ok) offenders.push(`${sel} { ${prop} }`);
    }
  }
  assert.deepEqual(offenders, [], 'layout declarations outside the reviewed list');
  assert.doesNotMatch(body, /@keyframes|animation\s*:/, 'no new animation');
  assert.doesNotMatch(body, /(^|[\s,}])\.(win|popup|win-layer|popup-layer|win-body|popup-body)\s*\{[^}]*\b(width|height|left|top|margin|padding|z-index)\s*:/, 'no window / popup box rule');
});

test('[virus-visual][chromium] the refit is applied at all six widths: integer-scale icons, crisp window controls, pressed taskbar button, legible gauges, equal Lab cards, cursors', opts, async () => {
  const p = await startPreview({ port: 0, host: '127.0.0.1', root: resolve('web'), env: {} });
  try {
    for (const [w, h] of VIEWPORTS) {
      const b = await open(p, w, h);
      try {
        await b.page.evaluate(() => { for (const id of ['explorer', 'lab', 'sysmon']) window.VX.wm.open(id); });
        await b.page.waitForTimeout(700);
        const r = await b.page.evaluate(() => {
          const out: any = {};
          // 1. every pixel icon is drawn at 16 / 32 / 48 / 64 px (content box), never at a fractional scale
          const bad: string[] = [];
          for (const img of document.querySelectorAll('img.px[src^="data:image/png"]')) {
            const cs = getComputedStyle(img);
            if (!img.offsetWidth) continue;
            const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
            const content = img.offsetWidth - pad - parseFloat(cs.borderLeftWidth || '0') * 2;
            if (![16, 32, 48, 64, 96].includes(Math.round(content))) bad.push(`${img.className || img.parentElement?.className}: ${content}`);
          }
          out.badIcons = bad;
          // 2. window controls: crisp glyph images, no old rotated pseudo-elements
          const wc = document.querySelector('.win .wc-close');
          out.closeGlyph = getComputedStyle(wc).backgroundImage.startsWith('url("data:image/svg+xml');
          out.closeBefore = getComputedStyle(wc, '::before').display;
          // 3. the top window is the pressed dithered task button
          const pressed = document.querySelector('.task[aria-pressed="true"]');
          out.pressedDither = !!pressed && /conic-gradient/.test(getComputedStyle(pressed).backgroundImage);
          // 4. gauge text has a hard white outline
          const meter = document.querySelector('.meter > span');
          out.meterOutline = /rgb\(255, 255, 255\)/.test(getComputedStyle(meter).textShadow);
          // 5. Mutation Lab cards of a row have the same height
          const rows = new Map<number, number[]>();
          for (const c of document.querySelectorAll('.win .lab-card')) { const t = Math.round(c.getBoundingClientRect().top); rows.set(t, [...(rows.get(t) ?? []), c.getBoundingClientRect().height]); }
          out.labRowsEqual = [...rows.values()].every((hs) => hs.every((x) => Math.abs(x - hs[0]!) < 0.5));
          out.labRows = rows.size;
          // 6. classic cursors on pointing devices
          out.cursor = getComputedStyle(document.documentElement).cursor.startsWith('url(');
          out.handCursor = getComputedStyle(document.querySelector('.icon') ?? document.body).cursor.startsWith('url(');
          // 7. Windows 98 scrollbars inside windows
          out.scrollbar = getComputedStyle(document.querySelector('.win-body'), '::-webkit-scrollbar').width;
          // 8. real greys
          out.face = getComputedStyle(document.documentElement).getPropertyValue('--ui-face').trim();
          // 9. no horizontal overflow of the page
          out.overflow = document.documentElement.scrollWidth - window.innerWidth;
          return out;
        });
        const vp = `${w}x${h}`;
        assert.deepEqual(r.badIcons, [], `${vp}: icons at fractional scale`);
        assert.equal(r.closeGlyph, true, vp);
        assert.equal(r.closeBefore, 'none', vp);
        assert.equal(r.pressedDither, true, `${vp}: active window button`);
        assert.equal(r.meterOutline, true, vp);
        assert.equal(r.labRowsEqual, true, `${vp}: Mutation Lab card heights (${r.labRows} rows)`);
        assert.equal(r.scrollbar, '16px', vp);
        assert.equal(r.face, '#c0c0c0', vp);
        assert.ok(r.overflow <= 1, `${vp}: horizontal overflow ${r.overflow}px`);
        if (w >= 1280 || w === 768) { assert.equal(r.cursor, true, `${vp}: arrow cursor`); assert.equal(r.handCursor, true, `${vp}: hand cursor`); }
        assert.deepEqual(b.errors, [], vp);
      } finally { await b.close(); }
    }
  } finally { await p.close(); }
});

test('[virus-visual][chromium] the seven forms, their mutations and the mutation popups work after the refit (iPhone 390 and desktop 1280); the preview says DEMO, never LIVE', opts, async () => {
  const p = await startPreview({ port: 0, host: '127.0.0.1', root: resolve('web'), env: {} });
  try {
    for (const [w, h] of [[390, 844], [1280, 800]] as const) {
      const b = await open(p, w, h);
      try {
        await fetch(`${p.url}/demo/api/reset`, { method: 'POST' });
        await b.page.waitForFunction(() => window.VX.store.state.totalBurned === 0, null, { timeout: 10_000 });
        assert.equal(await b.page.evaluate(() => window.VX.store.state.source.label), 'DEMO');
        assert.match(await b.page.locator('[data-bind="source"]').first().innerText(), /^DEMO$/);
        assert.doesNotMatch(await b.page.content(), />LIVE[ (<]/);
        await b.page.evaluate(() => {
          window.__mut = [];
          window.VX.store.on('mutation', (m: any) => window.__mut.push(m));
          window.__seen = [];
          new MutationObserver(() => { for (const el of document.querySelectorAll('.popup-mutation')) { const f = /FORM \d+/.exec(el.textContent)?.[0]; if (f && !window.__seen.includes(f)) window.__seen.push(f); } }).observe(document.getElementById('popupLayer'), { childList: true, subtree: true });
        });
        for (let i = 1; i < 7; i++) {
          await fetch(`${p.url}/demo/api/level?index=${i}`, { method: 'POST' });
          await b.page.waitForFunction((n: number) => window.VX.store.state.stageIndex === n, i, { timeout: 10_000 });
          assert.equal(await b.page.evaluate(() => document.querySelector('[data-bind="stageName"]')?.textContent), NAMES[i], `${w}px form ${i + 1}`);
        }
        // every form got its "MUTATION UNLOCKED" popup, in order (the popups are part of the show: observed, never constrained; storms may
        // evict old ones, so the page records each one when it appears)
        await b.page.waitForFunction(() => window.__seen.includes('FORM 07'), null, { timeout: 90_000 });
        assert.deepEqual(await b.page.evaluate(() => [...new Set(window.__seen)]), [2, 3, 4, 5, 6, 7].map((n) => `FORM 0${n}`), `${w}px mutation popups, in order`);
        assert.deepEqual(await b.page.evaluate(() => JSON.parse(JSON.stringify(window.__mut))), [0, 1, 2, 3, 4, 5].map((i) => ({ from: i, to: i + 1 })), 'one mutation per form');
        assert.ok(await b.page.evaluate(() => window.VX.popups.count) >= 1);
        // Start menu and BURN window still open
        await b.page.locator('.start-btn').click();
        assert.equal(await b.page.locator('#startMenu').isVisible(), true);
        assert.ok((await b.page.locator('.sm-item').count()) >= 11);
        await b.page.locator('.start-btn').click();
        await b.page.evaluate(() => window.VX.wm.open('burn'));
        await b.page.waitForSelector('[data-burn]');
        await b.page.getByRole('button', { name: /Connect Demo Wallet/ }).waitFor({ state: 'visible', timeout: 15_000 });
        assert.deepEqual(b.errors, [], `${w}px`);
      } finally { await b.close(); }
    }
  } finally { await p.close(); }
});

test('[virus-visual] production keeps the real engine labels: the DEMO relabelling exists only in the preview layer', () => {
  const demo = readFileSync('web/virus-preview/demo.js', 'utf8');
  assert.match(demo, /label: 'DEMO'/);
  for (const f of ['engine-bridge.js', 'burn-ui.js', 'project.js', 'config.js']) assert.doesNotMatch(readFileSync(`web/virus/js/${f}`, 'utf8'), /'DEMO'|"DEMO"/);
  assert.match(readFileSync('web/virus/js/engine-bridge.js', 'utf8'), /'LIVE \(UNVERIFIED\)'/);
});
