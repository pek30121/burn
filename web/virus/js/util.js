(function () {
  'use strict';
  const VX = (window.VX = window.VX || {});

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randi = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const nf = new Intl.NumberFormat('en-US');
  const fmt = (n) => nf.format(Math.round(n || 0));

  function short(x) {
    const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
    return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  }
  function fmtShort(n) {
    n = n || 0;
    const a = Math.abs(n);
    if (a >= 1e9) return short(n / 1e9) + 'B';
    if (a >= 1e6) return short(n / 1e6) + 'M';
    if (a >= 1e3) return short(n / 1e3) + 'K';
    return String(Math.round(n));
  }

  const pad = (n) => String(n).padStart(2, '0');
  function timeStr(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  const GLITCH = '#%&@$?!01379▓░▒¥ẍ';
  function corrupt(str, amount) {
    return Array.from(str)
      .map((ch) => (ch !== ' ' && Math.random() < amount ? GLITCH[Math.floor(Math.random() * GLITCH.length)] : ch))
      .join('');
  }

  const store = {
    get(key, def) {
      try {
        const v = localStorage.getItem('vx:' + key);
        return v == null ? def : JSON.parse(v);
      } catch (e) {
        return def;
      }
    },
    set(key, val) {
      try {
        localStorage.setItem('vx:' + key, JSON.stringify(val));
      } catch (e) {
        /* storage unavailable: settings just won't persist */
      }
    },
  };

  const mq = window.matchMedia('(max-width: 699px)');
  const mobile = () => mq.matches;
  const reduced = () => document.documentElement.dataset.motion === 'reduced';

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  function weighted(list) {
    const total = list.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [v, w] of list) {
      if ((r -= w) <= 0) return v;
    }
    return list[list.length - 1][0];
  }

  // Drag `el` by `handle` inside `container` (absolute-positioned el).
  function makeDraggable(el, handle, container, opts = {}) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, a, input') || (opts.canDrag && !opts.canDrag())) return;
      const cr = container.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const ox = e.clientX - r.left;
      const oy = e.clientY - r.top;
      handle.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      opts.onStart && opts.onStart();
      const move = (ev) => {
        const x = clamp(ev.clientX - cr.left - ox, -r.width + 80, cr.width - 80);
        const y = clamp(ev.clientY - cr.top - oy, 0, cr.height - 80);
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        opts.onMove && opts.onMove();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // Deterministic 0..1 hash for stable pseudo-random layouts.
  const hash = (i) => {
    const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  };

  VX.util = {
    $, $$, clamp, lerp, rand, randi, pick, wait, fmt, fmtShort, timeStr, esc, corrupt,
    store, mobile, reduced, debounce, weighted, makeDraggable, hash, mq,
  };
})();
