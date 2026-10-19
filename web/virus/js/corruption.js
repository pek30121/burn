/* The spreading infection layer behind icons and windows: a low-res cellular
 * grid that grows from the virus' trail. Coverage is capped by infection %. */
(function () {
  'use strict';
  const VX = window.VX;
  const CELL = 10;
  let cvs, ctx, desk;
  let gw = 0;
  let gh = 0;
  let grid = null;
  let alive = null;
  let img = null;
  let u32 = null;
  let level = 0;
  let rgb = [57, 255, 20];
  let visible = true;

  function init(canvas, deskEl) {
    cvs = canvas;
    desk = deskEl;
    ctx = cvs.getContext('2d');
    resize();
    window.addEventListener('resize', VX.util.debounce(resize, 200));
    new IntersectionObserver((e) => (visible = e[0].isIntersecting)).observe(desk);
    setInterval(tick, 120);
  }

  function resize() {
    const ngw = Math.max(1, Math.ceil(desk.clientWidth / CELL));
    const ngh = Math.max(1, Math.ceil(desk.clientHeight / CELL));
    if (ngw === gw && ngh === gh) return;
    const old = grid;
    const ow = gw;
    const oh = gh;
    gw = ngw;
    gh = ngh;
    grid = new Uint8Array(gw * gh);
    if (old) {
      for (let y = 0; y < Math.min(oh, gh); y++) for (let x = 0; x < Math.min(ow, gw); x++) grid[y * gw + x] = old[y * ow + x];
    }
    alive = new Int32Array(gw * gh);
    cvs.width = gw;
    cvs.height = gh;
    img = ctx.createImageData(gw, gh);
    u32 = new Uint32Array(img.data.buffer);
  }

  function setLevel(pct) {
    level = Math.max(0, Math.min(1, pct / 100));
  }

  function setAccent(hex) {
    const h = hex.replace('#', '');
    rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function deposit(px, py, r, v) {
    const cx = Math.floor(px / CELL);
    const cy = Math.floor(py / CELL);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r + 0.5) continue;
        const i = y * gw + x;
        if (grid[i] < v) grid[i] = v;
      }
    }
  }

  function splash(px, py, radiusPx) {
    const r = Math.max(1, Math.round(radiusPx / CELL));
    const cx = Math.floor(px / CELL);
    const cy = Math.floor(py / CELL);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d > 1 || Math.random() < d * 0.8) continue;
        const i = y * gw + x;
        grid[i] = Math.max(grid[i], 150 + Math.floor(Math.random() * 105));
      }
    }
  }

  function clear() {
    if (grid) grid.fill(0);
    render();
  }

  function tick() {
    if (!grid || document.hidden || !visible) return;
    const v = VX.virus && VX.virus.groundPoint();
    if (v && !v.sleeping && Math.random() < 0.25 + level * 0.75) deposit(v.x, v.y, level > 0.5 ? 2 : 1, 255);
    if (level >= 0.999 && Math.random() < 0.6) splash(Math.random() * gw * CELL, Math.random() * gh * CELL, 40);

    const total = gw * gh;
    const maxCov = 0.03 + level * 0.52;
    let n = 0;
    for (let i = 0; i < total; i++) if (grid[i]) n++;
    const cov = n / total;
    const decayP = cov > maxCov ? 0.3 : 0.004 + (1 - level) * 0.03;
    n = 0;
    for (let i = 0; i < total; i++) {
      let g = grid[i];
      if (!g) continue;
      if (Math.random() < decayP) {
        g = g > 24 ? g - 24 : 0;
        grid[i] = g;
      }
      if (g) alive[n++] = i;
    }
    if (cov < maxCov && n) {
      const tries = Math.min(n, 30 + n * (0.03 + level * 0.06));
      for (let k = 0; k < tries; k++) {
        const i = alive[(Math.random() * n) | 0];
        const g = grid[i];
        if (g < 90) continue;
        const x = i % gw;
        const y = (i / gw) | 0;
        const d = (Math.random() * 4) | 0;
        const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const j = ny * gw + nx;
        if (grid[j] < g - 40) grid[j] = g - 20 - ((Math.random() * 40) | 0);
      }
    }
    render();
  }

  function render() {
    if (!u32) return;
    u32.fill(0);
    const [r, g, b] = rgb;
    for (let i = 0; i < gw * gh; i++) {
      const v = grid[i];
      if (!v) continue;
      const x = i % gw;
      const y = (i / gw) | 0;
      let a;
      let k = 1;
      if (v > 200) a = 210;
      else if (v > 120) {
        a = 150;
        k = 0.6;
      } else {
        a = (x + y) & 1 ? 110 : 0;
        k = 0.35;
      }
      if (!a) continue;
      u32[i] = ((a << 24) | (Math.round(b * k) << 16) | (Math.round(g * k) << 8) | Math.round(r * k)) >>> 0;
    }
    ctx.putImageData(img, 0, 0);
  }

  VX.corruption = { init, setLevel, setAccent, splash, clear, resize };
})();
