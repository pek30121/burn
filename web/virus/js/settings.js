/* Viewer preferences (per browser). Applied as attributes on <html>. */
(function () {
  'use strict';
  const VX = window.VX;
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DEFAULTS = { sound: false, chaos: 'med', motion: prefersReduced ? 'reduced' : 'full', crt: true };
  const s = Object.assign({}, DEFAULTS, VX.util.store.get('settings', {}));
  const subs = new Set();

  function apply() {
    const r = document.documentElement;
    r.dataset.chaos = s.chaos;
    r.dataset.motion = s.motion;
    r.dataset.crt = s.crt ? 'on' : 'off';
  }

  function set(key, val) {
    if (s[key] === val) return;
    s[key] = val;
    VX.util.store.set('settings', s);
    apply();
    subs.forEach((fn) => fn(key, val, s));
  }

  function reset() {
    Object.keys(DEFAULTS).forEach((k) => set(k, DEFAULTS[k]));
  }

  apply();

  VX.settings = {
    get: (k) => s[k],
    set,
    reset,
    on: (fn) => subs.add(fn),
    chaos: () => ({ low: 0.35, med: 1, high: 1.9 })[s.chaos] || 1,
  };
})();
