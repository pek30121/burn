/* Data-bound UI pieces shared by the page sections and desktop windows.
 * Any element can opt in with data attributes, then mount() wires it. */
(function () {
  'use strict';
  const VX = window.VX;
  const { $$, fmt, fmtShort, timeStr, esc, hash } = VX.util;
  const cfg = VX.config;
  const view = () => VX.store.view();

  let shownBurned = 0;
  let tweenRaf = 0;
  const spriteViews = [];
  const graphs = [];
  const activity = new Array(64).fill(8);
  let spike = 0;
  const io = new IntersectionObserver((entries) => entries.forEach((e) => (e.target._vis = e.isIntersecting)));

  const TAG = { burn: 'BURN', mutation: 'MUTATE', phase: 'PHASE', corrupt: 'CORRUPT', storm: 'STORM', system: 'SYS', error: 'ERR' };

  const loadingText = () => (VX.store.state.hasData ? null : VX.store.state.status === 'error' ? 'ERR' : '…');

  const BIND = {
    stageName: (v) => loadingText() || v.stage.name,
    stageNum: (v) => (loadingText() ? '-' : String(v.stageIndex + 1)),
    stageTotal: () => String(cfg.stages.length),
    stageBlurb: (v) => v.stage.blurb,
    infection: (v) => loadingText() || v.infection.toFixed(1) + '%',
    infectionInt: (v) => loadingText() || Math.floor(v.infection) + '%',
    stageProgress: (v) => loadingText() || (v.next ? Math.floor(v.stageProgress) + '%' : 'MAX'),
    nextName: (v) => (v.next ? v.next.name : 'Final form reached'),
    toNext: (v) => loadingText() || (v.next ? `${fmtShort(v.toNext)} ${cfg.token.ticker} to ${v.next.name}` : 'FULL TAKEOVER — final form'),
    burnCount: (v) => loadingText() || fmt(v.burnCount),
    mood: (v) => (v.status === 'error' ? 'OFFLINE' : (v.mood || 'dormant').toUpperCase()),
    source: (v) => v.source.label,
    sourceDesc: (v) => v.source.description || '',
    status: (v) => ({ loading: 'CONNECTING…', ready: 'LINK OK', error: 'LINK LOST' })[v.status] || v.status,
    ticker: () => cfg.token.ticker,
    threats: () => String(VX.desktop ? VX.desktop.infectedCount() : 0),
  };

  /* ---------- binds ---------- */

  function updateBinds(root) {
    const v = view();
    $$('[data-bind]', root || document).forEach((el) => {
      const f = BIND[el.dataset.bind];
      if (!f) return;
      const s = f(v);
      if (el.textContent !== s) el.textContent = s;
    });
    $$('[data-bar]', root || document).forEach((el) => {
      const p = !VX.store.state.hasData ? 0 : el.dataset.bar === 'infection' ? v.infection : v.stageProgress;
      el.style.setProperty('--p', p.toFixed(2));
      el.setAttribute('role', 'progressbar');
      el.setAttribute('aria-valuemin', '0');
      el.setAttribute('aria-valuemax', '100');
      el.setAttribute('aria-valuenow', Math.round(p));
    });
    paintBurned();
  }

  function paintBurned() {
    const lt = loadingText();
    $$('[data-bind="burned"]').forEach((el) => (el.textContent = lt || fmt(shownBurned)));
    $$('[data-bind="burnedShort"]').forEach((el) => (el.textContent = lt || fmtShort(shownBurned)));
  }

  function tweenBurned(to, instant) {
    cancelAnimationFrame(tweenRaf);
    const from = shownBurned;
    if (instant || VX.util.reduced() || from === to) {
      shownBurned = to;
      paintBurned();
      return;
    }
    const t0 = performance.now();
    const dur = 1100;
    const step = (ts) => {
      const p = Math.min(1, (ts - t0) / dur);
      shownBurned = from + (to - from) * (1 - Math.pow(1 - p, 3));
      paintBurned();
      if (p < 1) tweenRaf = requestAnimationFrame(step);
    };
    tweenRaf = requestAnimationFrame(step);
  }

  /* ---------- event feeds ---------- */

  function txLink(tx) {
    return cfg.explorerTxUrl.replace('{tx}', encodeURIComponent(tx));
  }

  function renderFeed(list) {
    const st = VX.store.state;
    const limit = +list.dataset.limit || 40;
    const filter = list.dataset.filter || 'all';
    const evs = st.events
      .filter((e) => filter === 'all' || (filter === 'system' ? !['burn', 'mutation'].includes(e.type) : e.type === filter))
      .slice(0, limit);
    const lastTop = +list.dataset.top || 0;
    let html = '';
    if (st.status === 'error') {
      html += `<li class="ev ev-error-banner"><span class="msg">ENGINE LINK LOST — showing last known data.</span><button type="button" class="btn btn-sm" data-action="retry">Retry</button></li>`;
    }
    if (!st.hasData && st.status === 'loading') {
      html += `<li class="ev-empty">Connecting to engine feed<span class="dots" aria-hidden="true"></span></li>`;
    } else if (!evs.length && filter !== 'all' && filter !== 'burn') {
      html += '<li class="ev-empty">No events of this type yet.</li>';
    }
    const noBurns = st.hasData && !st.events.some((e) => e.type === 'burn');
    if (noBurns && (filter === 'all' || filter === 'burn')) {
      html += '<li class="ev-empty">No burns yet. The virus is waiting to be fed.</li>';
    }
    for (const e of evs) {
      const isNew = lastTop && e.id > lastTop;
      html += `<li class="ev ev-${e.type}${isNew ? ' new' : ''}">
        <time datetime="${new Date(e.time).toISOString()}">${timeStr(e.time)}</time>
        <span class="tag">${TAG[e.type] || 'SYS'}</span>
        <span class="msg">${esc(e.msg)}</span>
        ${e.tx ? `<a class="tx" href="${esc(txLink(e.tx))}" target="_blank" rel="noopener noreferrer">tx ↗</a>` : ''}
      </li>`;
    }
    list.innerHTML = html;
    list.dataset.top = evs[0] ? evs[0].id : lastTop;
    list.setAttribute('aria-busy', !st.hasData && st.status === 'loading' ? 'true' : 'false');
  }

  function renderFeeds() {
    $$('[data-feed]').forEach(renderFeed);
  }

  /* ---------- sprite canvases ---------- */

  function addSpriteView(canvas, stageFn, silFn) {
    canvas._vis = false;
    io.observe(canvas);
    spriteViews.push({ canvas, ctx: canvas.getContext('2d'), stageFn, silFn: silFn || (() => false), seed: Math.random() * 10, dirty: true });
    tickSprites();
  }

  function tickSprites() {
    const t = performance.now() / 1000;
    for (let i = spriteViews.length - 1; i >= 0; i--) {
      const v = spriteViews[i];
      if (!v.canvas.isConnected) {
        io.unobserve(v.canvas);
        spriteViews.splice(i, 1);
        continue;
      }
      if (!v.canvas._vis && !v.dirty) continue;
      v.dirty = false;
      const stage = v.stageFn();
      const art = VX.sprite.artFor(stage);
      const tt = t + v.seed;
      VX.sprite.render(v.ctx, art, {
        t: tt,
        look: { x: Math.sin(tt * 0.7) * 0.7, y: Math.cos(tt * 0.9) * 0.35 },
        blink: tt % 4 < 0.14,
        sleep: art === 0,
        silhouette: v.silFn(),
        mouth: art >= 4 ? Math.max(0, Math.sin(tt * 1.3)) * 0.4 : 0,
      });
    }
  }

  /* ---------- mutation lab ---------- */

  function buildLab(root) {
    if (root.dataset.built) return;
    root.dataset.built = '1';
    const grid = root.querySelector('.lab-grid');
    grid.innerHTML = cfg.stages
      .map(
        (s, i) => `<li><button type="button" class="lab-card" data-action="lab-select" data-stage="${i}">
          <canvas class="px" width="64" height="64" aria-hidden="true"></canvas>
          <span class="lc-num">${String(i + 1).padStart(2, '0')}</span>
          <span class="lc-name">${esc(s.name)}</span>
          <span class="lc-state"></span>
        </button></li>`
      )
      .join('');
    $$('.lab-card', grid).forEach((b) => {
      const i = +b.dataset.stage;
      addSpriteView(b.querySelector('canvas'), () => i, () => VX.store.state.hasData ? i > view().stageIndex : true);
    });
    const big = root.querySelector('.lab-big');
    addSpriteView(big, () => +root.dataset.sel || 0, () => (+root.dataset.sel || 0) > view().stageIndex || !VX.store.state.hasData);
    updateLab(root);
  }

  function selectLab(root, i) {
    root.dataset.sel = i;
    root.dataset.userSel = '1';
    updateLab(root);
  }

  function redact(s) {
    return s.replace(/[^\s]/g, '▓');
  }

  function updateLab(root) {
    const v = view();
    const has = VX.store.state.hasData;
    const cur = has ? v.stageIndex : -1;
    if (!root.dataset.userSel) root.dataset.sel = Math.max(0, cur);
    const sel = +root.dataset.sel;
    $$('.lab-card', root).forEach((b) => {
      const i = +b.dataset.stage;
      const s = cfg.stages[i];
      const state = i < cur ? 'UNLOCKED' : i === cur ? 'CURRENT' : 'LOCKED';
      b.classList.toggle('locked', i > cur);
      b.classList.toggle('current', i === cur);
      b.classList.toggle('sel', i === sel);
      b.setAttribute('aria-pressed', i === sel ? 'true' : 'false');
      b.setAttribute('aria-label', `Form ${i + 1}: ${s.name} — ${state.toLowerCase()}`);
      b.querySelector('.lc-state').textContent = state;
    });
    const s = cfg.stages[sel];
    const locked = sel > cur;
    const q = (k) => root.querySelector(`[data-li="${k}"]`);
    q('num').textContent = `FORM ${String(sel + 1).padStart(2, '0')} / ${String(cfg.stages.length).padStart(2, '0')}`;
    q('name').textContent = s.name;
    q('status').textContent = !has ? 'SCANNING…' : locked ? 'LOCKED' : sel === cur ? 'CURRENT FORM' : 'UNLOCKED';
    q('status').className = 'lab-status ' + (!has ? '' : locked ? 'is-locked' : sel === cur ? 'is-current' : 'is-unlocked');
    q('blurb').textContent = locked && sel > cur + 1 ? redact(s.blurb) : s.blurb;
    q('traits').innerHTML = s.traits.map((t) => `<li>${esc(locked ? redact(t) : t)}</li>`).join('');
    let req;
    if (sel === 0) req = 'Starting form.';
    else if (!locked) req = `Unlocked at ${fmt(s.threshold)} ${cfg.token.ticker} burned ✓`;
    else req = `Unlocks at ${fmt(s.threshold)} ${cfg.token.ticker} burned — ${fmtShort(Math.max(0, s.threshold - v.totalBurned))} to go.`;
    q('req').textContent = req;
  }

  /* ---------- corruption map (defrag style) ---------- */

  function buildDefrag(el) {
    if (el._cells) return;
    const n = +el.dataset.cells || 240;
    el.innerHTML = '<i></i>'.repeat(n);
    el._cells = Array.from(el.children);
    el._h = el._cells.map((_, i) => ({ v: hash(i + 1), free: hash(i + 999) < 0.07 }));
    updateDefrag(el);
  }

  function updateDefrag(el) {
    const inf = VX.store.state.hasData ? view().infection / 100 : 0;
    el._cells.forEach((c, i) => {
      const h = el._h[i];
      const cls = h.free ? 'f' : h.v < inf * 0.4 ? 'x' : h.v < inf ? 'i' : 'c';
      if (c.dataset.s !== cls) {
        const was = c.dataset.s;
        c.dataset.s = cls;
        c.className = cls + (was && was !== cls ? ' n' : '');
      }
    });
  }

  /* ---------- activity graph ---------- */

  function tickGraphs() {
    const inf = VX.store.state.hasData ? view().infection : 0;
    spike *= 0.82;
    const v = Math.min(100, 6 + inf * 0.55 + spike + Math.random() * 10);
    activity.push(v);
    activity.shift();
    for (let i = graphs.length - 1; i >= 0; i--) {
      const cv = graphs[i];
      if (!cv.isConnected) {
        graphs.splice(i, 1);
        continue;
      }
      const g = cv.getContext('2d');
      const w = cv.width;
      const h = cv.height;
      g.fillStyle = '#020a04';
      g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(57,255,20,.12)';
      for (let x = 0; x < w; x += 12) g.fillRect(x, 0, 1, h);
      for (let y = 0; y < h; y += 12) g.fillRect(0, y, w, 1);
      g.fillStyle = VX.theme.accent;
      const bw = w / activity.length;
      activity.forEach((a, k) => {
        const bh = Math.max(2, Math.round((a / 100) * (h - 4)));
        g.fillRect(Math.floor(k * bw), h - bh, Math.ceil(bw) - 1, 2);
        g.globalAlpha = 0.25;
        g.fillRect(Math.floor(k * bw), h - bh + 2, Math.ceil(bw) - 1, bh - 2);
        g.globalAlpha = 1;
      });
    }
  }

  /* ---------- token info ---------- */

  function renderToken(el) {
    const t = cfg.token;
    const ca = t.contract;
    el.innerHTML = `
      <div class="tk-head">
        <img class="px tk-logo" src="${esc(t.image)}" alt="${esc(t.ticker)} token logo" width="512" height="512">
        <div><strong>${esc(t.name)}</strong><span>${esc(t.ticker)} · ${esc(t.chain)}</span></div>
      </div>
      <dl class="tk-grid">
        <div><dt>Name</dt><dd>${esc(t.name)}</dd></div>
        <div><dt>Ticker</dt><dd>${esc(t.ticker)}</dd></div>
        <div><dt>Chain</dt><dd>${esc(t.chain)}</dd></div>
        <div class="tk-ca"><dt>Contract</dt><dd>
          <code class="${ca ? '' : 'soon'}">${ca ? esc(ca) : 'Coming soon'}</code>
          <button type="button" class="btn btn-sm" data-action="copy-ca" ${ca ? '' : 'disabled aria-disabled="true"'}>Copy</button>
        </dd></div>
      </dl>
      <div class="tk-links">
        ${cfg.links
          .map((l) =>
            l.url
              ? `<a class="btn tk-link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"><img class="px" data-icon="${l.icon}" alt="">${esc(l.label)} ↗</a>`
              : `<span class="btn tk-link is-soon" aria-disabled="true"><img class="px" data-icon="${l.icon}" alt="">${esc(l.label)}<small>Coming soon</small></span>`
          )
          .join('')}
      </div>`;
    VX.icons.hydrate(el);
  }

  /* ---------- settings controls ---------- */

  function syncSettings(root) {
    $$('[data-setting]', root || document).forEach((inp) => {
      const k = inp.dataset.setting;
      const val = VX.settings.get(k);
      if (inp.type === 'checkbox') inp.checked = k === 'motion' ? val === 'reduced' : !!val;
      else if (inp.type === 'radio') inp.checked = inp.value === String(val);
    });
    $$('[data-pressed-setting]', root || document).forEach((b) => {
      const [k, v] = b.dataset.pressedSetting.split(':');
      b.setAttribute('aria-pressed', String(VX.settings.get(k)) === v ? 'true' : 'false');
    });
  }

  function onSettingInput(e) {
    const inp = e.target.closest('[data-setting]');
    if (inp) {
      const k = inp.dataset.setting;
      let v;
      if (inp.type === 'checkbox') v = k === 'motion' ? (inp.checked ? 'reduced' : 'full') : inp.checked;
      else v = inp.value;
      if (k === 'sound') VX.sound.setEnabled(v);
      else VX.settings.set(k, v);
      return;
    }
  }

  /* ---------- mount & update ---------- */

  function mount(root) {
    root = root || document;
    $$('[data-lab]', root).forEach(buildLab);
    $$('[data-defrag]', root).forEach(buildDefrag);
    $$('canvas[data-sprite]', root).forEach((cv) => {
      if (cv._mounted) return;
      cv._mounted = true;
      const s = cv.dataset.sprite;
      addSpriteView(cv, s === 'current' ? () => VX.virus.stage : () => +s);
    });
    $$('canvas[data-graph]', root).forEach((cv) => {
      if (!graphs.includes(cv)) graphs.push(cv);
    });
    $$('[data-token]', root).forEach(renderToken);
    VX.icons.hydrate(root);
    syncSettings(root);
    $$('[data-feed]', root).forEach(renderFeed);
    updateBinds(root);
    if (root !== document) $$('[data-lab]', root).forEach(updateLab);
  }

  function updateAll() {
    spriteViews.forEach((v) => (v.dirty = true));
    updateBinds(document);
    renderFeeds();
    $$('[data-lab]').forEach(updateLab);
    $$('[data-defrag]').forEach((el) => el._cells && updateDefrag(el));
  }

  function init() {
    VX.store.on('change', updateAll);
    VX.store.on('mood', () => updateBinds(document));
    VX.store.on('snapshot', (v) => tweenBurned(v.totalBurned, true));
    VX.store.on('burn', (b) => {
      tweenBurned(b.total);
      spike = Math.min(90, spike + 55);
    });
    VX.settings.on(() => syncSettings(document));
    document.addEventListener('change', onSettingInput);
    setInterval(tickSprites, 100);
    setInterval(tickGraphs, 500);
    mount(document);
  }

  VX.components = { init, mount, updateAll, updateBinds, selectLab, renderFeed, syncSettings, addSpriteView };
})();
