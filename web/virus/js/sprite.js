/* Procedural pixel-art renderer for the virus mascot. Draws one of 7 forms
 * into a 64x64 buffer (scaled up with CSS `image-rendering: pixelated`).
 *
 * Art direction: dark charcoal body with a glossy top-left highlight, a
 * neon rim light on the right edge, half-lidded glowing neon eyes, a smug
 * smirk with a little pink tongue, neon "+" sparkles and a glowing floor.
 * Each form keeps the same character (a spiky virus particle) and only the
 * neon colour and the mutations (legs, tentacles, tail, brain, crown) change. */
(function () {
  'use strict';
  const VX = window.VX;
  const W = 64;
  const H = 64;
  const U = new Uint32Array(W * H);
  const M = new Uint8Array(W * H); // 0 empty, 1 body, 2 limb, 3 outline, 4 feature, 5 fx
  const TMP = new Uint8Array(W * H);
  const imgs = new WeakMap();
  const cache = {};

  function c(hex) {
    let v = cache[hex];
    if (v !== undefined) return v;
    const h = hex.replace('#', '');
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
    v = ((a << 24) | (parseInt(h.slice(4, 6), 16) << 16) | (parseInt(h.slice(2, 4), 16) << 8) | parseInt(h.slice(0, 2), 16)) >>> 0;
    return (cache[hex] = v);
  }

  function set(x, y, col, m) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x;
    U[i] = col;
    M[i] = m;
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : M[Math.floor(y) * W + Math.floor(x)]);

  function disc(cx, cy, r, col, m) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) set(x, y, col, m);
      }
    }
  }

  function seg(x0, y0, x1, y1, r, col, m) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.5) + 1;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      if (r <= 0.6) set(x, y, col, m);
      else disc(x, y, r, col, m);
    }
  }

  // Neon light pooling on the floor under the creature.
  function floorGlow(cx, y, rx, p) {
    const a1 = c(p.accent + '70');
    const a2 = c(p.accent + '38');
    const a3 = c(p.accent + '1c');
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const k = Math.abs(x + 0.5 - cx) / rx;
      if (k < 0.75) set(x, y, a1, 0);
      else if ((x & 1) === 0) set(x, y, a2, 0);
      if (k < 0.95 && (x + 1) % 3) set(x, y + 1, a2, 0);
      if (k < 0.6 && x % 4 === 0) set(x, y + 2, a3, 0);
    }
  }

  /* Dark glossy body: charcoal base, grey gloss top-left, neon rim on the
   * right edge, darker underside. `test(x, y)` says whether a point is inside. */
  function darkBody(test, x0, y0, x1, y1, cx, cy, R, p) {
    const B = c(p.body);
    const L = c(p.light);
    const HI = c(p.hi);
    const D = c(p.dark);
    const RIM = c(p.accent);
    const RS = c(p.rimSoft);
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(H - 1, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(W - 1, Math.ceil(x1)); x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        if (!test(px, py)) continue;
        const nx = (px - cx) / R;
        const ny = (py - cy) / R;
        const chk = (x + y) & 1;
        let col = B;
        const edge1 = !test(px + 1, py) || !test(px + 1, py - 1) || !test(px, py - 1) && nx > 0.45;
        const edge2 = !test(px + 2, py) || !test(px + 2, py - 1);
        const g = -nx * 0.62 - ny * 0.78; // towards the top-left
        if (edge1 && nx > 0.12 && ny < 0.75) col = RIM;
        else if (edge2 && nx > 0.3 && ny < 0.6) col = chk ? RS : B;
        else if (g > 0.78 && nx * nx + ny * ny < 0.62) col = HI;
        else if (g > 0.52 && nx * nx + ny * ny < 0.75) col = L;
        else if (g > 0.38 && nx * nx + ny * ny < 0.75) col = chk ? L : B;
        else if (ny > 0.62) col = chk ? D : B;
        set(x, y, col, 1);
      }
    }
  }

  function outline() {
    const C = c('#000000');
    TMP.fill(0);
    const solid = (i) => M[i] === 1 || M[i] === 2;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (M[i]) continue;
        if ((x > 0 && solid(i - 1)) || (x < W - 1 && solid(i + 1)) || (y > 0 && solid(i - W)) || (y < H - 1 && solid(i + W))) TMP[i] = 1;
      }
    }
    for (let i = 0; i < W * H; i++) {
      if (TMP[i]) {
        U[i] = C;
        M[i] = 3;
      }
    }
  }

  /* Half-lidded glowing eye. r = half height; the eye is ~1.4x wider. */
  function eye(x, y, r, o, p, side) {
    const O = c('#000000');
    const A = c(p.accent);
    const w = r * 1.4;
    if (o.blink) {
      // closed: a glowing happy curve
      const n = Math.round(w);
      for (let dx = -n; dx <= n; dx++) set(x + dx, y + (Math.abs(dx) >= n - 0.5 ? 0 : -1) + 0.5, A, 4);
      return;
    }
    const inE = (px, py, ew, eh) => {
      const ex = (px - x) / ew;
      const ey = (py - y) / eh;
      return ex * ex + ey * ey <= 1;
    };
    const lid = (px) => {
      // heavy top lid -> smug look; angry tilts it down towards the nose
      let l = y - r * 0.3;
      if (o.angry) l += ((px - x) / w) * -side * r * 0.7;
      return l;
    };
    for (let py = Math.floor(y - r - 2); py <= Math.ceil(y + r + 1); py++) {
      for (let px = Math.floor(x - w - 2); px <= Math.ceil(x + w + 1); px++) {
        const cxp = px + 0.5;
        const cyp = py + 0.5;
        if (inE(cxp, cyp, w, r) && cyp >= lid(cxp)) set(px, py, A, 4);
        else if (inE(cxp, cyp, w + 1, r + 1)) set(px, py, O, 4);
      }
    }
    const pr = Math.max(0.9, r * 0.55);
    const ppx = x + o.look.x * w * 0.42;
    const ppy = y + r * 0.25 + Math.max(-0.2, o.look.y) * r * 0.25;
    for (let py = Math.floor(ppy - pr - 1); py <= Math.ceil(ppy + pr); py++) {
      for (let px = Math.floor(ppx - pr - 1); px <= Math.ceil(ppx + pr); px++) {
        const dx = px + 0.5 - ppx;
        const dy = py + 0.5 - ppy;
        if (dx * dx + dy * dy <= pr * pr && at(px, py) === 4 && U[py * W + px] === A) set(px, py, O, 4);
      }
    }
    const Wh = c('#ffffff');
    const hx = ppx - pr * 0.75;
    const hy = Math.max(lid(ppx - pr), ppy - pr * 0.6);
    set(hx, hy, Wh, 4);
    if (r >= 2.6) {
      set(hx + 1, hy, Wh, 4);
      set(hx, hy + 1, Wh, 4);
      set(hx + 1, hy + 1, Wh, 4);
    }
  }

  /* Smug smirk with a little pink tongue; opens wide when eating. */
  function smirk(x, y, w, open, p, fangs) {
    const O = c('#000000');
    const T = c('#ff7aa8');
    const TD = c('#d94d80');
    const Wh = c('#ffffff');
    x = Math.floor(x);
    y = Math.floor(y);
    if (open < 0.15) {
      for (let dx = -w; dx <= w; dx++) set(x + dx, y - (dx > w / 2 ? 1 : 0) - (dx === -w ? 1 : 0), O, 4);
      set(x, y + 1, T, 4);
      set(x + 1, y + 1, T, 4);
      if (w >= 3) set(x + 1, y + 2, TD, 4);
      if (fangs) {
        set(x - w + 1, y + 1, Wh, 4);
        set(x + w - 1, y, Wh, 4);
      }
      return;
    }
    const h = 1 + Math.round(open * (w + 1));
    for (let dy = -1; dy <= h + 1; dy++) {
      for (let dx = -w - 1; dx <= w + 1; dx++) {
        const inside = dy >= 0 && dy <= h && Math.abs(dx) <= w - (dy === h ? 1 : 0);
        const edge = !inside && Math.abs(dx) <= w + 1 - (dy === h + 1 || dy === -1 ? 1 : 0);
        let col = c('#120006');
        if (inside && dy === 0 && ((dx + w) & 1) === 0) col = Wh;
        else if (inside && dy >= h - 1 && Math.abs(dx) <= w - 2) col = dy === h ? TD : T;
        if (inside) set(x + dx, y + dy, col, 4);
        else if (edge) set(x + dx, y + dy, O, 4);
      }
    }
  }

  // Twinkling neon "+" sparkles around the creature.
  function sparkles(list, t, p) {
    const A = c(p.accent);
    list.forEach(([x, y, big], i) => {
      const ph = Math.sin(t * 2.6 + i * 1.9);
      if (ph < -0.2) return;
      const arm = big && ph > 0.35 ? 2 : 1;
      const pts = [[0, 0]];
      for (let k = 1; k <= arm; k++) pts.push([k, 0], [-k, 0], [0, k], [0, -k]);
      if (pts.some(([dx, dy]) => at(x + dx, y + dy))) return;
      pts.forEach(([dx, dy]) => set(x + dx, y + dy, A, 5));
    });
  }

  // Virus spikes: dark stalks with glowing bulbs, slowly rotating.
  function spikes(n, cx, cy, R, len, p, t, o) {
    const S = c(p.stalk);
    const B = c(p.bulb);
    const tips = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + t * 0.12 + (o.rot || 0);
      if (o.skipTop && Math.abs(Math.atan2(Math.sin(a), Math.cos(a)) + Math.PI / 2) < 0.55) continue;
      if (o.skipBottom && Math.abs(Math.atan2(Math.sin(a), Math.cos(a)) - Math.PI / 2) < 0.7) continue;
      const l = len + Math.sin(t * 3 + i * 1.3) * 0.5;
      const dx = Math.cos(a) * (o.sx || 1);
      const dy = Math.sin(a) * (o.sy || 1);
      seg(cx + dx * (R - 1), cy + dy * (R - 1), cx + dx * (R + l), cy + dy * (R + l), 0.6, S, 2);
      const bx = cx + dx * (R + l + 0.8);
      const by = cy + dy * (R + l + 0.8);
      disc(bx, by, o.bulb || 1.3, B, 2);
      tips.push([bx, by]);
    }
    return tips;
  }
  // After the outline pass: light up each bulb with a neon core.
  function lightTips(tips, p, all) {
    const A = c(p.accent);
    tips.forEach(([x, y], i) => {
      if (all || i % 2 === 0) {
        set(x, y, A, 4);
        set(x + 0.6, y - 0.6, A, 4);
      } else set(x + 0.4, y - 0.4, A, 4);
    });
  }

  function tentacles(n, cx, cy, R, p, t, spread, len0) {
    const B = c(p.body);
    const D = c(p.dark);
    const G = c(p.dots);
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (0.5 + ((i + 0.5) / n - 0.5) * spread);
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const bx = cx + dx * R * 0.7;
      const by = cy + dy * R * 0.7;
      const len = len0 + (i % 2) * 2;
      for (let j = 0; j <= len; j++) {
        const wv = Math.sin(t * 3.4 + j * 0.55 + i * 1.7) * (j / len) * 3;
        const x = bx + dx * j * 1.2 - dy * wv;
        const y = by + dy * j * 1.2 + dx * wv;
        const r = j < len * 0.45 ? 1.6 : j < len - 1 ? 1.1 : 0.6;
        disc(x, y, r, j % 2 ? B : D, 2);
        if (j > 1 && j % 3 === 0) out.push([x, y]);
      }
    }
    return () => out.forEach(([x, y]) => at(x, y) === 2 && set(x, y, G, 4)); // suction dots
  }

  /* ---------- palettes & form definitions ---------- */

  const BASE = { body: '#27272c', light: '#44444d', hi: '#70707c', dark: '#151519', stalk: '#3a3a41', bulb: '#202025', dots: '#6d6d78' };
  const NEON = ['#c8ff00', '#c8ff00', '#3dffa0', '#b07cff', '#ff8a3d', '#ff3fdc', '#ff2a48'];
  const SOFT = ['#5c7300', '#5c7300', '#167a4c', '#4e3480', '#7a3f18', '#7a1d6a', '#7a1424'];
  const P = NEON.map((accent, i) => Object.assign({}, BASE, { accent, rimSoft: SOFT[i], crown: '#ffe14d', crownDark: '#a68a00' }));

  const FORMS = {
    1: { R: 10, cy: 40, spikes: 7, len: 2.6, eyes: [[-3.9, -1, 2.7], [3.9, -1, 2.7]], mouth: [0, 4.5, 2], sparks: [[13, 22, 1], [50, 28, 0], [17, 46, 0], [49, 46, 1]] },
    2: { R: 10.5, cy: 39, sx: 1.12, spikes: 8, len: 3, legs: true, antennae: true, eyes: [[-4.4, -1.5, 2.8], [4.4, -1.5, 2.8]], mouth: [0, 4.5, 3], sparks: [[10, 18, 1], [54, 22, 0], [8, 40, 0], [56, 44, 1]] },
    3: { R: 11.5, cy: 35, spikes: 9, len: 3.6, tentacles: 4, eyes: [[-4.8, -0.5, 2.9], [4.8, -0.5, 2.9], [0, -7.5, 1.7]], mouth: [0, 5.5, 3, true], sparks: [[8, 14, 1], [56, 16, 0], [6, 36, 0], [58, 38, 1]] },
    5: { R: 13, cy: 34, spikes: 11, len: 3.8, tentacles: 6, brain: true, eyes: [[-5.2, 0.5, 3], [5.2, 0.5, 3], [0, -6.5, 1.8]], mouth: [0, 7.5, 3, true], orbs: 3, sparks: [[5, 10, 1], [59, 12, 1], [4, 40, 0], [60, 42, 0]] },
    6: { R: 13, cy: 38, spikes: 12, len: 4, skipTop: true, tentacles: 6, crown: true, orbit: true, angry: true, allTips: true, eyes: [[-5.2, -1, 3], [5.2, -1, 3], [0, -8, 1.7]], mouth: [0, 6.5, 4, true], sparks: [[5, 8, 1], [59, 8, 1], [3, 34, 0], [61, 34, 0]] },
  };

  // Mouth anchor (grid coords) — where burned "food" flies to.
  const ANCHOR = [
    { x: 27, y: 47 }, { x: 32, y: 45 }, { x: 32, y: 44 }, { x: 32, y: 41 },
    { x: 50, y: 40 }, { x: 32, y: 42 }, { x: 32, y: 45 },
  ];

  /* ---------- forms ---------- */

  // Dormant File: a dark file with glowing text lines; the baby virus sleeps in the corner.
  function drawFile(o, p) {
    const t = o.t;
    const bob = o.sleep ? 0 : Math.round(Math.sin(t * 5) * 0.6);
    const x0 = 21;
    const y0 = 10 + bob;
    const w = 24;
    const h = 32;
    const f = 7;
    floorGlow(32, 52, 15, p);
    const fileTest = (px, py) => {
      const x = px - x0;
      const y = py - y0;
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      return !(y < f && x > w - f + y);
    };
    darkBody(fileTest, x0, y0, x0 + w, y0 + h, x0 + w / 2, y0 + h / 2, h / 1.6, p);
    for (let y = 0; y < f; y++) for (let x = w - f; x <= w - f + y && x < w; x++) set(x0 + x, y0 + y, c(p.hi), 1);
    // baby virus in the bottom-left corner
    const bx = 27;
    const by = 44;
    const br = 6.6;
    const tips = spikes(7, bx, by, br, 1.8, p, t * 0.6, { bulb: 1.1, skipBottom: true });
    darkBody((px, py) => (px - bx) ** 2 + (py - by) ** 2 <= br * br, bx - br - 1, by - br - 1, bx + br + 1, by + br + 1, bx, by, br, p);
    outline();
    lightTips(tips, p);
    const TL = c(p.accent + '99');
    [15, 9, 13, 7].forEach((len, k) => {
      for (let i = 0; i < len; i++) {
        const glitchy = o.glitch > 0 && Math.random() < o.glitch * 0.4;
        set(x0 + 4 + i, y0 + 6 + k * 3, glitchy ? c('#ffffff') : TL, 4);
      }
    });
    const awake = !o.sleep;
    eye(bx - 2.7, by - 0.8, 1.8, { look: o.look, blink: !awake || o.blink }, p, -1);
    eye(bx + 2.7, by - 0.8, 1.8, { look: o.look, blink: !awake || o.blink }, p, 1);
    smirk(bx, by + 2.6, 1, o.mouth || 0, p);
    if (o.sleep) {
      const zt = (t * 0.6) % 1;
      const A = c(p.accent);
      const zx = 47 + Math.round(zt * 4);
      const zy = 10 - Math.round(zt * 6);
      ['1111', '0010', '0100', '1111'].forEach((row, j) => {
        for (let i = 0; i < 4; i++) if (row[i] === '1') set(zx + i, zy + j, A, 5);
      });
    }
    sparkles([[13, 18, 0], [52, 34, 1]], t, p);
  }

  function drawVirus(a, o, p) {
    const t = o.t;
    const cx = 32;
    const cy = a.cy;
    const R = a.R * (1 + 0.035 * Math.sin(t * 2.4) + (o.pulse || 0));
    const sx = a.sx || 1;
    const test = (x, y) => {
      const dx = (x - cx) / sx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      return d <= R + 0.35 * Math.sin(Math.atan2(dy, dx) * 5 + t * 2);
    };

    floorGlow(cx, Math.min(61, cy + R + (a.tentacles ? 9 : a.legs ? 8 : 4)), R * sx * 1.15, p);

    const D = c(p.dark);
    const A = c(p.accent);
    let dots = null;
    if (a.legs) {
      [-1, 1].forEach((s) => {
        for (let k = 0; k < 3; k++) {
          const bx = cx + s * (R * sx * 0.55 + k * 1.2);
          const by = cy + (k - 1) * 3.5 + 3;
          const ph = Math.sin(t * (o.moving ? 15 : 3) + k * 2.1 + (s > 0 ? Math.PI : 0));
          const kx = bx + s * (5 + k);
          const ky = by - 2 + ph * 1.6;
          seg(bx, by, kx, ky, 1.1, c(p.body), 2);
          seg(kx, ky, kx + s * 2.5, ky + 7 + (k - 1), 0.6, D, 2);
        }
      });
    }
    if (a.antennae) {
      [-1, 1].forEach((s) => {
        const tx = cx + s * 7 + Math.sin(t * 3 + s) * 1.2;
        const ty = cy - R - 7;
        seg(cx + s * 3, cy - R + 2, tx, ty, 0.5, D, 2);
        disc(tx, ty, 1.2, c(p.bulb), 2);
      });
    }
    if (a.tentacles) dots = tentacles(a.tentacles, cx, cy, R, p, t, a.tentacles > 4 ? 1.1 : 0.85, a.tentacles > 4 ? 9 : 8);
    const tips = spikes(a.spikes, cx, cy, R, a.len, p, t, { sx, skipTop: a.skipTop || a.antennae, skipBottom: !!a.tentacles || a.legs });

    darkBody(test, cx - R * sx - 2, cy - R - 2, cx + R * sx + 2, cy + R + 2, cx, cy, R, p);

    if (a.crown) {
      const top = cy - R - 3 + Math.round(Math.sin(t * 2) * 0.8);
      const CR = c(p.crown);
      const CD = c(p.crownDark);
      for (let x = cx - 7; x <= cx + 7; x++) for (let y = top - 1; y <= top + 1; y++) set(x, y, y === top + 1 ? CD : CR, 2);
      [-7, 0, 7].forEach((px) => {
        for (let hh = 0; hh < 5; hh++) {
          const half = hh < 2 ? 1 : 0;
          for (let dx = -half; dx <= half; dx++) set(cx + px + dx, top - 2 - hh, CR, 2);
        }
      });
    }

    outline();
    lightTips(tips, p, a.allTips);
    if (a.antennae) [-1, 1].forEach((s) => set(cx + s * 7 + Math.sin(t * 3 + s) * 1.2, cy - R - 7, A, 4));
    if (dots) dots();

    if (a.brain) {
      const V = c(p.rimSoft);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (M[y * W + x] !== 1 || (y - cy) / R > -0.2) continue;
          const v = Math.sin(x * 0.75 + Math.sin(y * 0.6 + t * 0.8) * 2.4);
          if (v > 0.88) set(x, y, v > 0.975 && Math.sin(t * 4) > 0.3 ? A : V, 4);
        }
      }
    }
    if (a.crown) set(cx, cy - R - 3 + Math.round(Math.sin(t * 2) * 0.8), A, 4);

    a.eyes.forEach(([dx, dy, r], k) => {
      const blink = o.blink && (k < 2 || k % 2 === 0);
      eye(cx + dx, cy + dy, r, { look: o.look, blink, angry: a.angry && k < 2 }, p, dx < 0 ? -1 : 1);
    });
    if (a.mouth) smirk(cx + a.mouth[0], cy + a.mouth[1], a.mouth[2], o.mouth || 0, p, a.mouth[3]);

    if (a.orbs) {
      for (let k = 0; k < a.orbs; k++) {
        const ang = t * 0.9 + (k * Math.PI * 2) / a.orbs;
        const ox = cx + Math.cos(ang) * (R + 8);
        const oy = cy - 4 + Math.sin(ang * 2) * 3 + Math.sin(ang) * 6;
        if (!at(ox, oy)) {
          set(ox, oy, A, 5);
          set(ox + 1, oy, A, 5);
          set(ox, oy + 1, A, 5);
          set(ox + 1, oy + 1, c('#ffffff'), 5);
        }
      }
    }
    if (a.orbit) {
      for (let k = 0; k < 8; k++) {
        const ang = t * 1.4 + (k * Math.PI * 2) / 8;
        const ox = cx + Math.cos(ang) * (R + 10);
        const oy = cy + Math.sin(ang) * (R + 10) * 0.32 - 3;
        if (at(ox, oy)) continue;
        set(ox, oy, A, 5);
        if (Math.sin(ang) > 0) set(ox + 1, oy, A, 5);
      }
    }
    sparkles(a.sparks, t, p);
  }

  // Worm Form: virus head dragging a long segmented, spiky tail.
  function drawWorm(o, p) {
    const t = o.t;
    const N = 6;
    const segs = [];
    for (let i = 0; i < N; i++) {
      segs.push({
        x: 46 - i * 6.2,
        y: 37 + Math.sin(t * (o.moving ? 7 : 2.6) - i * 0.9) * 2.4,
        r: i === 0 ? 9 : 7.2 - i * 0.7,
      });
    }
    floorGlow(30, 50, 24, p);
    const D = c(p.dark);
    const hd = segs[0];
    const tips = spikes(7, hd.x, hd.y, hd.r, 2.8, p, t, { skipBottom: true });
    segs.forEach((s, i) => {
      if (i === 0) return;
      seg(s.x, s.y - s.r + 1, s.x - 1.5, s.y - s.r - 2.4, 0.6, c(p.stalk), 2);
      disc(s.x - 1.5, s.y - s.r - 2.6, 0.9, c(p.bulb), 2);
      tips.push([s.x - 1.5, s.y - s.r - 2.6]);
      const lp = Math.sin(t * 12 + i) > 0 ? 1 : 0;
      seg(s.x - 2, s.y + s.r - 1, s.x - 2 - lp, s.y + s.r + 2, 0.5, D, 2);
      seg(s.x + 2, s.y + s.r - 1, s.x + 2 + lp, s.y + s.r + 2, 0.5, D, 2);
    });
    for (let i = N - 1; i >= 0; i--) {
      const s = segs[i];
      darkBody((px, py) => (px - s.x) ** 2 + (py - s.y) ** 2 <= s.r * s.r, s.x - s.r - 1, s.y - s.r - 1, s.x + s.r + 1, s.y + s.r + 1, s.x, s.y, s.r, p);
      if (i > 0) {
        // dark seam where this segment meets the one in front
        for (let y = Math.floor(s.y - s.r); y <= s.y + s.r; y++) {
          for (let x = Math.floor(s.x); x <= s.x + s.r; x++) {
            const d = Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y);
            if (d > s.r - 1 && d <= s.r && at(x, y) === 1) set(x, y, D, 1);
          }
        }
      }
    }
    outline();
    lightTips(tips, p);
    eye(hd.x - 0.5, hd.y - 2.2, 2.1, o, p, -1);
    eye(hd.x + 5, hd.y - 1.8, 1.6, o, p, 1);
    smirk(hd.x + 4, hd.y + 3, 2, o.mouth || 0, p, true);
    sparkles([[8, 16, 1], [56, 14, 0], [4, 44, 0], [60, 48, 1]], t, p);
  }

  /* ---------- post effects ---------- */

  function mulberry(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ROW = new Uint32Array(W);
  function post(o, p) {
    if (o.glitch > 0) {
      const rng = mulberry(Math.floor(o.t * 15) * 7919 + (o.art || 0) * 13);
      const A = c(p.accent);
      for (let y = 0; y < H; y++) {
        if (rng() < o.glitch * 0.22) {
          const shift = (rng() < 0.5 ? -1 : 1) * (1 + Math.floor(rng() * 3 * o.glitch + 0.5));
          for (let x = 0; x < W; x++) ROW[x] = U[y * W + x];
          for (let x = 0; x < W; x++) {
            const sxp = x - shift;
            U[y * W + x] = sxp >= 0 && sxp < W ? ROW[sxp] : 0;
          }
        }
        if (rng() < o.glitch * 0.05) {
          for (let x = 0; x < W; x++) if (M[y * W + x] && U[y * W + x] >>> 24 === 255) U[y * W + x] = A;
        }
      }
    }
    if (o.flash > 0) {
      const Wh = c('#ffffff');
      for (let i = 0; i < W * H; i++) if (M[i] && (o.flash > 0.7 || (i + (i / W) | 0) & 1)) U[i] = Wh;
    }
    if (o.silhouette) {
      const S1 = c('#3a3f3a');
      const S2 = c('#5f665f');
      for (let i = 0; i < W * H; i++) {
        if (M[i] === 5) U[i] = 0;
        else if (M[i]) U[i] = M[i] === 3 ? S2 : S1;
        else U[i] = 0;
      }
    }
  }

  function artFor(stageIndex) {
    const n = VX.config.stages.length;
    if (n <= 1) return 0;
    return Math.max(0, Math.min(6, Math.round((stageIndex * 6) / (n - 1))));
  }

  function render(ctx, art, opts) {
    const o = Object.assign({ t: 0, look: { x: 0, y: 0 }, blink: false, mouth: 0, flash: 0, glitch: 0, silhouette: false, sleep: false, moving: false, pulse: 0 }, opts);
    o.art = art;
    U.fill(0);
    M.fill(0);
    const p = P[art];
    if (art === 0) drawFile(o, p);
    else if (art === 4) drawWorm(o, p);
    else drawVirus(FORMS[art], o, p);
    if (art === 1 && !o.silhouette && !o.clean) o.glitch = Math.max(o.glitch, 0.08);
    post(o, p);
    let img = imgs.get(ctx);
    if (!img) {
      img = ctx.createImageData(W, H);
      imgs.set(ctx, img);
    }
    new Uint32Array(img.data.buffer).set(U);
    ctx.putImageData(img, 0, 0);
  }

  VX.sprite = {
    W, H, render, artFor,
    mouth: (art) => ANCHOR[art] || ANCHOR[1],
    palette: (art) => P[art],
  };
})();
