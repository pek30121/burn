/* Window manager: open/focus/drag/minimize/maximize/close + taskbar buttons. */
(function () {
  'use strict';
  const VX = window.VX;
  const { $, esc, clamp, makeDraggable, mobile } = VX.util;

  const registry = {};
  const wins = new Map(); // key -> { el, def, task, key }
  let layer, tasks, desk;
  let z = 20;
  let cascade = 0;
  const subs = new Set();

  function init(deskEl) {
    desk = deskEl;
    layer = $('#winLayer');
    tasks = $('#tasks');
  }

  function register(id, def) {
    registry[id] = def;
  }

  function notify(type, key) {
    subs.forEach((fn) => fn(type, key));
  }

  function open(id, params) {
    params = params || {};
    const def = registry[id];
    if (!def) return null;
    const key = def.multi ? `${id}:${params.key || Math.random().toString(36).slice(2)}` : id;
    const existing = wins.get(key);
    if (existing) {
      restore(key);
      return existing.el;
    }
    const title = params.title || def.title;
    const icon = params.icon || def.icon;
    const el = document.createElement('section');
    el.className = 'win opening';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', title);
    el.tabIndex = -1;
    el.dataset.key = key;
    el.innerHTML = `
      <header class="win-title">
        <img class="px" src="${VX.icons.url(icon)}" alt="">
        <h2>${esc(title)}</h2>
        <div class="win-ctrls">
          <button type="button" class="btn wc wc-min" data-wc="min" aria-label="Minimize"></button>
          <button type="button" class="btn wc wc-max" data-wc="max" aria-label="Maximize"></button>
          <button type="button" class="btn wc wc-close" data-wc="close" aria-label="Close"></button>
        </div>
      </header>
      <div class="win-body"></div>`;
    const body = el.querySelector('.win-body');
    if (def.tpl) body.appendChild(document.getElementById(def.tpl).content.cloneNode(true));
    if (def.render) def.render(body, params, el);
    if (def.cls) el.classList.add(def.cls);

    const dw = desk.clientWidth;
    const dh = desk.clientHeight;
    const w = Math.min(def.w || 420, dw - 24);
    el.style.width = w + 'px';
    const n = cascade++ % 7;
    const left = clamp(params.x != null ? params.x : 130 + n * 32 + (dw > 1100 ? 80 : 0), 8, Math.max(8, dw - w - 8));
    const top = clamp(params.y != null ? params.y : 36 + n * 28, 8, Math.max(8, dh - 220));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    layer.appendChild(el);

    const task = document.createElement('button');
    task.type = 'button';
    task.className = 'btn task';
    task.innerHTML = `<img class="px" src="${VX.icons.url(icon)}" alt=""><span>${esc(title)}</span>`;
    task.addEventListener('click', () => {
      const rec = wins.get(key);
      if (!rec) return;
      if (rec.el.classList.contains('active') && !rec.el.classList.contains('min')) minimize(key);
      else restore(key);
    });
    tasks.appendChild(task);

    const rec = { el, def, task, key };
    wins.set(key, rec);

    el.addEventListener('pointerdown', () => focus(key), true);
    el.querySelector('.win-ctrls').addEventListener('click', (e) => {
      const b = e.target.closest('[data-wc]');
      if (!b) return;
      if (b.dataset.wc === 'close') close(key);
      else if (b.dataset.wc === 'min') minimize(key);
      else toggleMax(key);
    });
    const head = el.querySelector('.win-title');
    head.addEventListener('dblclick', (e) => {
      if (!e.target.closest('button')) toggleMax(key);
    });
    makeDraggable(el, head, desk, { canDrag: () => !mobile() && !el.classList.contains('max') });
    el.addEventListener('animationend', () => el.classList.remove('opening'), { once: true });

    focus(key);
    VX.components.mount(body);
    VX.sound.play('open');
    if (def.onOpen) def.onOpen(body, params, el);
    notify('open', key);
    if (!def.noFocus) setTimeout(() => el.focus({ preventScroll: true }), 30);
    return el;
  }

  function focus(key) {
    const rec = wins.get(key);
    if (!rec) return;
    wins.forEach((r) => {
      r.el.classList.toggle('active', r === rec);
      r.task.setAttribute('aria-pressed', r === rec ? 'true' : 'false');
    });
    rec.el.style.zIndex = ++z;
  }

  function topKey() {
    let best = null;
    let bz = -1;
    wins.forEach((r, k) => {
      const zi = +r.el.style.zIndex || 0;
      if (!r.el.classList.contains('min') && zi > bz) {
        bz = zi;
        best = k;
      }
    });
    return best;
  }

  function minimize(key) {
    const rec = wins.get(key);
    if (!rec) return;
    rec.el.classList.add('min');
    rec.el.classList.remove('active');
    rec.task.setAttribute('aria-pressed', 'false');
    VX.sound.play('close');
    const next = topKey();
    if (next) focus(next);
    notify('min', key);
  }

  function restore(key) {
    const rec = wins.get(key);
    if (!rec) return;
    rec.el.classList.remove('min');
    focus(key);
    rec.el.focus({ preventScroll: true });
    notify('restore', key);
  }

  function toggleMax(key) {
    const rec = wins.get(key);
    if (!rec) return;
    rec.el.classList.toggle('max');
    notify('max', key);
  }

  function close(key) {
    const rec = wins.get(key);
    if (!rec) return;
    wins.delete(key);
    rec.task.remove();
    rec.el.classList.add('closing');
    VX.sound.play('close');
    const remove = () => rec.el.remove();
    if (VX.util.reduced()) remove();
    else setTimeout(remove, 160);
    if (rec.def.onClose) rec.def.onClose(rec.el);
    const next = topKey();
    if (next) focus(next);
    notify('close', key);
  }

  function closeTop() {
    const k = topKey();
    if (k) close(k);
    return !!k;
  }

  function rect(key) {
    const rec = wins.get(key);
    if (!rec || rec.el.classList.contains('min') || rec.el.classList.contains('closing')) return null;
    return { x: rec.el.offsetLeft, y: rec.el.offsetTop, w: rec.el.offsetWidth, h: rec.el.offsetHeight };
  }

  function visibleIds() {
    return Array.from(wins.keys()).filter((k) => rect(k));
  }

  VX.wm = {
    init, register, open, close, closeTop, focus, minimize, restore, rect, visibleIds,
    get: (key) => (wins.get(key) || {}).el || null,
    isOpen: (key) => wins.has(key),
    on: (fn) => subs.add(fn),
  };
})();
