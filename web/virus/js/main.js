/* Boot sequence + wiring data events to visual reactions. */
(function () {
  'use strict';
  const VX = window.VX;
  const { $, wait, rand, pick, esc } = VX.util;
  const cfg = VX.config;
  const stages = cfg.stages;

  VX.theme = { accent: stages[0].theme.accent, accent2: stages[0].theme.accent2 };

  let desk;
  let deskVisible = true;
  let queue = Promise.resolve();
  let pending = 0;
  let booted = false;
  let errorPopup = null;

  /* ---------- stage theme ---------- */

  function hexA(hex, a) {
    const h = hex.replace('#', '');
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  }

  function applyStageTheme(i) {
    const th = stages[i].theme;
    const r = document.documentElement.style;
    r.setProperty('--accent', th.accent);
    r.setProperty('--accent-2', th.accent2);
    r.setProperty('--accent-glow', hexA(th.accent, 0.55));
    r.setProperty('--desk', th.desk);
    r.setProperty('--desk-2', th.desk2);
    r.setProperty('--title-a', th.titleA);
    r.setProperty('--title-b', th.titleB);
    VX.theme.accent = th.accent;
    VX.theme.accent2 = th.accent2;
    const art = VX.sprite.artFor(i);
    document.body.dataset.stage = art;
    VX.corruption.setAccent(th.accent);
    $('#startLabel').textContent = i === stages.length - 1 ? 'VIRUS' : 'Start';
    updateFavicon(art);
  }

  function updateFavicon(art) {
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 64;
    VX.sprite.render(cv.getContext('2d'), art, { t: 0.4, look: { x: 0, y: 0.2 } });
    const link = $('#favicon');
    if (link) link.href = cv.toDataURL();
  }

  /* ---------- reaction queue ---------- */

  function enqueue(fn) {
    pending++;
    queue = queue
      .then(fn)
      .catch((e) => console.error('[VX]', e))
      .finally(() => pending--);
  }

  const canAnimate = () => booted && deskVisible && !document.hidden;

  function onBurn(b) {
    VX.virus.wake();
    if (!canAnimate() || pending > 2) {
      VX.sound.play('burn');
      return;
    }
    enqueue(() => VX.virus.feed(b.amount));
  }

  function onMutation({ to }) {
    if (!canAnimate()) {
      VX.virus.setStage(to);
      applyStageTheme(to);
      VX.desktop.toast(`The virus mutated into ${stages[to].name}.`, 'MUTATION UNLOCKED');
      return;
    }
    enqueue(() => mutationSequence(to));
  }

  async function mutationSequence(to) {
    const s = stages[to];
    const red = VX.util.reduced();
    desk.classList.add('mutating');
    VX.fx.shake(red ? 0 : 2400);
    const done = VX.virus.mutate(to);
    setTimeout(() => {
      applyStageTheme(to);
      VX.fx.flash(s.theme.accent);
      VX.fx.tear();
    }, red ? 500 : 2150);
    await done;
    desk.classList.remove('mutating');
    const art = VX.sprite.artFor(to);
    VX.popups.spawn({
      title: 'MUTATION UNLOCKED',
      kind: 'mutation',
      center: true,
      width: 340,
      html: `<div class="mut-pop"><canvas class="px" width="64" height="64" data-mut="${to}" aria-hidden="true"></canvas>
        <div><small>FORM ${String(to + 1).padStart(2, '0')} / ${String(stages.length).padStart(2, '0')}</small>
        <strong>${esc(s.name)}</strong><p>${esc(s.blurb)}</p></div></div>`,
      onMount: (el) => VX.components.addSpriteView(el.querySelector('canvas'), () => to),
      buttons: [
        { label: 'Inspect form', action: () => openLabAt(to) },
        { label: 'Let it grow' },
      ],
    });
    if (art >= 4 && !red) setTimeout(() => VX.popups.storm(art >= 6 ? 14 : 7, { silent: false }), 900);
    if (art >= 6) VX.virus.dominate(15000);
  }

  function openLabAt(i) {
    const el = VX.wm.open('lab');
    const root = el && el.querySelector('[data-lab]');
    if (root) VX.components.selectLab(root, i);
  }

  /* ---------- status ---------- */

  function onStatus(st) {
    document.body.classList.toggle('is-loading', st.status === 'loading');
    document.body.classList.toggle('is-error', st.status === 'error');
    document.body.classList.toggle('is-live', !!st.source.live);
    document.body.classList.toggle('is-waiting', !st.source.live);
    if (st.status === 'error' && booted) showErrorPopup(st.error);
    if (st.status !== 'error' && errorPopup) {
      VX.popups.close(errorPopup);
      errorPopup = null;
    }
  }

  function showErrorPopup(msg) {
    if (errorPopup && errorPopup.isConnected) return;
    errorPopup = VX.popups.spawn({
      title: 'Engine link failed',
      kind: 'error',
      center: true,
      focus: true,
      text: `Could not reach the infection feed.\n${msg || ''}\n\nThe last known data stays on screen.`,
      buttons: [
        { label: 'Retry', action: () => VX.source.reconnect() },
        { label: 'Continue offline' },
      ],
    });
  }

  /* ---------- boot ---------- */

  async function boot() {
    const el = $('#boot');
    const out = $('#bootLines');
    const bar = $('#bootBar');
    const red = VX.util.reduced();
    let skipped = false;
    const skip = () => (skipped = true);
    el.addEventListener('click', skip);
    window.addEventListener('keydown', skip, { once: true });
    const lines = [
      'VIRUS BIOS v6.66  (C) 1999 Unknown Origin',
      'CPU: Pentium(R) II 266MHz ........ OK',
      'Memory test: 65536K .............. OK',
      'Detecting drives ...... A: C: D:',
      'Loading C:\\WINDOWS\\explorer.exe ... OK',
      'Loading C:\\VIRUS\\virus.exe ....... ??',
      'Connecting to engine feed ........',
    ];
    for (let i = 0; i < lines.length; i++) {
      if (skipped) break;
      out.textContent += lines[i] + '\n';
      bar.style.width = ((i + 1) / (lines.length + 1)) * 100 + '%';
      await wait(red ? 20 : rand(110, 210));
    }
    if (skipped) out.textContent = lines.join('\n') + '\n';
    const t0 = performance.now();
    while (!skipped && VX.store.state.status === 'loading' && performance.now() - t0 < 3000) await wait(80);
    const st = VX.store.state;
    out.textContent += st.status === 'error' ? '>> LINK FAILED — entering offline mode\n' : st.status === 'loading' ? '>> still connecting…\n' : `>> [${st.source.label}] linked\n`;
    out.textContent += 'WARNING: unknown process detected.';
    bar.style.width = '100%';
    await wait(skipped || red ? 60 : 650);
    el.classList.add('done');
    document.body.classList.remove('booting');
    window.removeEventListener('keydown', skip);
    setTimeout(() => el.remove(), 500);
    booted = true;
    VX.virus.measure();
    VX.sound.play('boot');
    afterBoot();
  }

  function afterBoot() {
    const st = VX.store.state;
    if (st.status === 'error') {
      showErrorPopup(st.error);
      return;
    }
    setTimeout(() => {
      VX.popups.spawn({
        title: 'Security Alert',
        kind: 'warn',
        width: 360,
        x: VX.util.mobile() ? undefined : desk.clientWidth - 360 - (desk.clientWidth > 900 ? 320 : 24),
        y: VX.util.mobile() ? 8 : desk.clientHeight * 0.5,
        html: `<p><b>VIRUS.EXE detected on this desktop.</b></p>
          <p>Burned ${esc(cfg.token.ticker)} tokens feed it. Feed it enough and it mutates. Every mutation infects more of the system.</p>`,
        buttons: [
          { label: 'How to feed it', action: () => VX.desktop.feedAction() },
          { label: 'Inspect forms', action: () => VX.wm.open('lab') },
          { label: 'Let it spread' },
        ],
      });
      VX.virus.say(pick(['…hello?', 'is someone there?', 'i smell tokens']), 2600);
    }, 700);
  }

  /* ---------- init ---------- */

  function init() {
    desk = $('#desktop');
    VX.icons.hydrate(document);
    VX.wm.init(desk);
    VX.popups.init(desk);
    VX.fx.init($('#fx'), desk);
    VX.corruption.init($('#corruption'), desk);
    VX.desktop.init(desk);
    VX.virus.init(desk);
    VX.components.init();
    applyStageTheme(0);

    new IntersectionObserver((e) => (deskVisible = e[0].isIntersecting), { threshold: 0.25 }).observe(desk);

    VX.store.on('status', onStatus);
    VX.store.on('snapshot', (v) => {
      VX.virus.setStage(v.stageIndex);
      applyStageTheme(v.stageIndex);
      VX.corruption.setLevel(v.infection);
      VX.virus.wake();
    });
    VX.store.on('change', () => {
      const v = VX.store.view();
      if (VX.store.state.hasData) VX.corruption.setLevel(v.infection);
      document.title = VX.store.state.hasData ? `VIRUS.EXE — ${v.stage.name} · ${Math.floor(v.infection)}% infected` : 'VIRUS.EXE — burn. mutate. infect.';
    });
    VX.store.on('burn', onBurn);
    VX.store.on('mutation', onMutation);
    VX.store.on('phase', ({ phase, pct }) => {
      VX.sound.play('phase');
      VX.desktop.toast(`${pct}% of the system is compromised.`, `INFECTION PHASE ${phase}`);
    });
    VX.settings.on((k) => {
      if (k === 'motion' || k === 'chaos') VX.virus.measure();
    });

    VX.source.connect();
    boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
