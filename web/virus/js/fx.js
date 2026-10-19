/* Particles, floating labels, flashes, shakes and glitch tears for the desktop. */
(function () {
  'use strict';
  const VX = window.VX;
  const { rand, pick } = VX.util;
  let cvs, ctx, desk;
  let parts = [];
  let running = false;
  let lastTs = 0;
  let W = 0;
  let H = 0;

  function init(canvas, deskEl) {
    cvs = canvas;
    desk = deskEl;
    ctx = cvs.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function resize() {
    W = cvs.width = desk.clientWidth;
    H = cvs.height = desk.clientHeight;
  }

  function burst(x, y, o = {}) {
    let n = o.count || 16;
    if (VX.util.reduced()) n = Math.ceil(n / 3);
    const cols = o.colors || [VX.theme.accent];
    for (let i = 0; i < n; i++) {
      const a = o.angle != null ? o.angle + rand(-(o.spread || 0.6), o.spread || 0.6) : rand(0, Math.PI * 2);
      const sp = rand(0.3, 1) * (o.speed || 220);
      parts.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - (o.lift == null ? 60 : o.lift),
        life: rand(0.5, 1) * (o.life || 0.9),
        age: 0,
        s: o.size || pick([3, 4, 4, 6]),
        c: pick(cols),
        g: o.gravity == null ? 520 : o.gravity,
      });
    }
    if (parts.length > 700) parts.splice(0, parts.length - 700);
    if (!running) {
      running = true;
      lastTs = performance.now();
      requestAnimationFrame(step);
    }
  }

  function step(ts) {
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;
    ctx.clearRect(0, 0, W, H);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.age += dt;
      if (p.age >= p.life) {
        parts.splice(i, 1);
        continue;
      }
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.globalAlpha = 1 - Math.pow(p.age / p.life, 2);
      ctx.fillStyle = p.c;
      ctx.fillRect(Math.round(p.x / 2) * 2, Math.round(p.y / 2) * 2, p.s, p.s);
    }
    ctx.globalAlpha = 1;
    if (parts.length) requestAnimationFrame(step);
    else {
      running = false;
      ctx.clearRect(0, 0, W, H);
    }
  }

  function text(x, y, str, cls) {
    const el = document.createElement('div');
    el.className = 'float-text ' + (cls || '');
    el.textContent = str;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    desk.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  }

  function shake(ms) {
    if (VX.util.reduced()) return;
    desk.classList.remove('shake');
    void desk.offsetWidth;
    desk.classList.add('shake');
    clearTimeout(shake.t);
    shake.t = setTimeout(() => desk.classList.remove('shake'), ms || 500);
  }

  function flash(color) {
    const f = document.getElementById('flash');
    if (!f) return;
    f.style.background = color || '#fff';
    f.classList.remove('on');
    void f.offsetWidth;
    f.classList.add('on');
  }

  function tear() {
    if (VX.util.reduced()) return;
    const n = Math.random() < 0.4 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'tear';
      el.style.top = rand(5, 90) + '%';
      el.style.height = Math.round(rand(6, 38)) + 'px';
      el.style.setProperty('--dx', Math.round(rand(-24, 24)) + 'px');
      desk.appendChild(el);
      setTimeout(() => el.remove(), 420);
    }
    const logo = desk.querySelector('.wp-logo');
    if (logo) {
      logo.classList.add('glitching');
      setTimeout(() => logo.classList.remove('glitching'), 380);
    }
    VX.sound.play('glitch');
  }

  VX.fx = { init, resize, burst, text, shake, flash, tear };
})();
