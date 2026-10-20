/* First-visit UX layer (tests/… on the preview, Chromium): the headline, the 4 steps and the three primary actions are present, readable
 * on an iPhone without zooming, reachable on the first screen, and wired to what already exists. No logic is tested here (the engine,
 * wallet, burn and mutation behaviour have their own tests); the windows' geometry is frozen by virus-geometry.test.ts. Chromium only. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { startPreview } from '../scripts/virus-preview/server.ts';

declare const window: any;
declare const document: any;
declare function getComputedStyle(el: any, pseudo?: string): any;

const PW = process.env.PLAYWRIGHT_MODULE ?? '/opt/node-tools/node_modules/playwright/index.js';
const opts = { skip: existsSync(PW) && existsSync('/opt/pw-browsers') ? false : 'Playwright / Chromium not available' };

test('[virus-ux] the static page carries the headline, the supporting line, the 4 steps and the three actions; ux.css loads last; nothing is a placeholder link', () => {
  const html = readFileSync('web/virus/index.html', 'utf8');
  assert.match(html, /<h1 class="mission-title">BURN <b>\$VIRUS<\/b> TO EVOLVE THE VIRUS<\/h1>/);
  assert.match(html, /Each burn feeds the virus\. Unlock all 7 mutations\./);
  for (const step of ['BUY', 'CONNECT', 'BURN', 'EVOLVE']) assert.match(html, new RegExp(`<li><b>\\d</b><span>${step}</span></li>`));
  for (const label of ['CONNECT WALLET', 'OPEN IN PHANTOM', 'BUY \\$VIRUS']) assert.match(html, new RegExp(label));
  assert.ok(html.indexOf('css/ux.css') > html.indexOf('css/win98.css'), 'ux.css is the last stylesheet');
  assert.match(html, /<script src="js\/ux\.js"><\/script>/);
  assert.doesNotMatch(html, /id="ctaBuy" href="https?:/, 'BUY has no hard-coded URL: it follows config.js (null = COMING SOON)');
  const cfg = readFileSync('web/virus/js/config.js', 'utf8');
  assert.match(cfg, /id: 'buy'[^}]*url: null/, 'no invented BUY url');
});

test('[virus-ux] ux.css never styles the geometry of windows or popups, and the BURN window keeps its layout (paint only there)', () => {
  const css = readFileSync('web/virus/css/ux.css', 'utf8');
  assert.doesNotMatch(css, /(^|[\s,}])\.(win|popup|win-layer|popup-layer|win-body|popup-body|win-title)\b[^{]*\{[^}]*\b(width|height|left|top|right|bottom|margin|padding|z-index|display)\s*:/m);
  const burnRules = [...css.matchAll(/(^|\n)([^{}@/]*\.burn[^{]*)\{([^}]*)\}/g)];
  for (const m of burnRules) assert.doesNotMatch(m[3]!, /\b(width|height|margin|padding|display|position|font|line-height)\b/, `.burn rule is paint only: ${m[2]!.trim()}`);
});

test('[virus-ux][chromium] iPhone 390 and desktop 1280: first screen is readable, actions are on screen and big enough, wired correctly, no overflow', opts, async () => {
  const p = await startPreview({ port: 0, host: '127.0.0.1', root: resolve('web'), env: {}, timing: { confirmMs: 150, finalizeMs: 500 } });
  const pw: any = await import(PW);
  const b = await (pw.chromium ?? pw.default.chromium).launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const [w, h] of [[390, 844], [430, 932], [1280, 800]] as const) {
      const mobile = w <= 430;
      const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile, userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' : undefined });
      await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route: any) => route.abort());
      const page = await ctx.newPage();
      await page.goto(`${p.url}/virus/`);
      await page.waitForFunction(() => window.VX?.store?.state?.hasData === true, null, { timeout: 20_000 });
      await page.evaluate(() => { document.getElementById('demo-banner')?.remove(); document.body.style.paddingTop = '0'; document.getElementById('boot')?.remove(); window.VX.popups.ambient = () => {}; window.VX.popups.closeAll(); });
      await page.waitForTimeout(500);
      const r = await page.evaluate(() => {
        const vis = (el: any) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, b: b.bottom, r: b.right }; };
        const fs = (sel: string) => parseFloat(getComputedStyle(document.querySelector(sel)).fontSize);
        const h1 = document.querySelector('h1.mission-title');
        const cta = (s: string) => document.querySelector(s);
        return {
          h1: h1?.textContent, h1box: vis(h1), sub: vis(document.querySelector('.mission-sub')), steps: [...document.querySelectorAll('.steps li')].map((x: any) => x.textContent.replace(/\s+/g, '')),
          fonts: { title: fs('.mission-title'), sub: fs('.mission-sub'), connect: fs('.cta-connect'), phantom: fs('.cta-phantom'), buy: fs('.cta-buy'), hudStage: fs('.hud-stage strong'), icon: fs('.icon') },
          connect: vis(cta('.cta-connect')), phantom: vis(cta('.cta-phantom')), buy: vis(cta('.cta-buy')), hud: vis(document.querySelector('#hud')),
          buyDisabled: cta('#ctaBuy').getAttribute('aria-disabled'), buySoon: cta('#ctaBuy').textContent.replace(/\s+/g, ' ').trim(),
          phantomHref: cta('#ctaPhantom').href, note: getComputedStyle(cta('.wallet-note'), '::before').content,
          overflow: document.documentElement.scrollWidth - window.innerWidth, next: document.querySelector('.hud-next p')?.textContent,
          vw: window.innerWidth, vh: window.innerHeight,
        };
      });
      const vp = `${w}x${h}`;
      assert.equal(r.h1, 'BURN $VIRUS TO EVOLVE THE VIRUS', `${vp}: ${r.h1}`);
      assert.deepEqual(r.steps, ['1BUY', '2CONNECT', '3BURN', '4EVOLVE'], `${vp}: ${r.steps}`);
      assert.ok(r.h1box.y >= 0 && r.h1box.r <= r.vw && r.sub.r <= r.vw, `${vp}: headline inside the screen`);
      // readable without zooming
      assert.ok(r.fonts.title >= (mobile ? 13 : 16), `${vp}: title ${r.fonts.title}px`);
      assert.ok(r.fonts.sub >= 18, `${vp}: supporting line ${r.fonts.sub}px`);
      assert.ok(r.fonts.connect >= 14 && r.fonts.phantom >= 14 && r.fonts.buy >= 15, `${vp}: button text ${JSON.stringify(r.fonts)}`);
      assert.ok(r.fonts.hudStage >= 14 && r.fonts.icon >= 12, `${vp}: HUD / icon labels ${JSON.stringify(r.fonts)}`);
      // the three actions are on the first screen, touch-sized, and the HUD is on screen
      for (const k of ['connect', 'phantom', 'buy'] as const) {
        assert.ok(r[k].b <= r.vh && r[k].y >= 0, `${vp}: ${k} is on the first screen`);
        assert.ok(r[k].h >= (mobile ? 44 : 40), `${vp}: ${k} is ${r[k].h}px tall`);
      }
      assert.ok(r.hud.b <= r.vh, `${vp}: the HUD is entirely on the first screen`);
      // wiring: BUY is visibly "coming soon" without a URL, Phantom uses the deep link format of the BURN window
      assert.equal(r.buyDisabled, 'true', `${vp}: aria-disabled ${r.buyDisabled}`);
      assert.match(r.buySoon, /BUY \$VIRUS\s*COMING SOON/, `${vp}: ${r.buySoon}`);
      assert.match(r.phantomHref, /^https:\/\/phantom\.app\/ul\/browse\/.+\?ref=/, `${vp}: ${r.phantomHref}`);
      assert.match(r.note, /No wallet connected yet/i, `${vp}: note ${r.note}`);
      assert.match(r.next, /NEXT: .*Glitch Seed/, `${vp}: ${r.next}`);
      assert.ok(r.overflow <= 0, `${vp}: horizontal overflow ${r.overflow}`);

      // CONNECT WALLET opens the BURN window (the existing action); BUY does nothing without a URL
      await page.click('.cta-connect');
      await page.waitForSelector('.win[data-win="burn"], .win.burn, [data-burn]', { timeout: 5000 });
      assert.ok(await page.evaluate(() => !!document.querySelector('[data-burn]')), `${vp}: BURN window opened`);
      const before = page.url();
      await page.evaluate(() => document.querySelector('#ctaBuy').click());
      assert.equal(page.url(), before, `${vp}: BUY without a URL goes nowhere`);
      await ctx.close();
    }
  } finally { await b.close(); await p.close(); }
});
