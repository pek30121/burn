/* The virus as a creature on the desktop: wandering, hopping onto windows,
 * eating icons, feeding on burns, mutating, reacting to pokes. */
(function () {
  'use strict';
  const VX = window.VX;
  const { $, clamp, lerp, rand, pick, weighted, fmtShort } = VX.util;

  const LINES = {
    poke: ['hey!', 'that tickles', 'feed me $VIRUS', 'boop', '01101000 01101001', 'rude.', 'i bite, you know', 'more burns pls'],
    pokeBig: ['DO NOT TOUCH THE GOD', 'I SEE YOU', 'kneel, user', 'your cursor is mine'],
    idle: ['*munch*', 'so hungry…', 'this desktop is mine', 'scanning…', 'burn. burn. burn.', 'nice files you got', 'is that antivirus? cute'],
    infect: ['nom', 'mine now', 'delicious bytes', 'corrupted ✓', 'crunchy'],
    wake: ['huh?', 'who woke me', '…five more minutes', 'is it burn time?'],
    feed: ['YUM', 'MORE', 'burnt tokens taste the best', 'FUEL', 'growing…'],
    mutate: ['I FEEL DIFFERENT', 'NEW FORM UNLOCKED', 'more… MORE', 'evolution complete'],
    perch: ['nice view', 'this window is comfy', 'mine', 'hi'],
  };

  let desk, root, cvs, ctx, bubble, hit;
  let size = 256;
  let B = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  let home = { x: 0, y: 0 };
  let visible = true;
  let bubbleTimer = 0;
  let lastTs = 0;
  let lastX = null;
  let lastY = null;

  const S = {
    x: 0, y: 0, t: 0, mode: 'idle', stage: 0, art: 0,
    lookX: 0, lookY: 0, ptr: null, lookAt: null, glance: null, glanceAt: 0,
    blinkUntil: 0, nextBlink: 2, mouthT: 0, mouth: 0, chompUntil: 0,
    squash: 0, walk: null, jump: null, nextAction: 2.5, sleeping: true,
    perch: null, perchOff: 0, mut: null, evolvedUntil: 0, dominantUntil: 0,
    pokes: 0, frame: -1, dirX: 0, dirY: 0, flash: 0, glitch: 0, pulse: 0,
  };

  function init(deskEl) {
    desk = deskEl;
    root = $('#virus');
    cvs = root.querySelector('canvas');
    ctx = cvs.getContext('2d');
    bubble = root.querySelector('.bubble');
    hit = root.querySelector('.virus-hit');
    measure();
    S.x = home.x;
    S.y = home.y;
    desk.addEventListener('pointermove', (e) => {
      const r = desk.getBoundingClientRect();
      S.ptr = { x: e.clientX - r.left, y: e.clientY - r.top, at: S.t };
    });
    desk.addEventListener('pointerleave', () => (S.ptr = null));
    hit.addEventListener('click', poke);
    window.addEventListener('resize', VX.util.debounce(measure, 150));
    new IntersectionObserver((e) => (visible = e[0].isIntersecting)).observe(desk);
    requestAnimationFrame(loop);
  }

  function measure() {
    const w = desk.clientWidth;
    const h = desk.clientHeight;
    const mobile = VX.util.mobile();
    size = mobile ? (h >= 700 ? 256 : 192) : w > 1700 && h > 950 ? 384 : h >= 720 ? 320 : 256;
    root.style.setProperty('--vsize', size + 'px');
    const tb = $('.taskbar', desk).offsetHeight;
    let top = 10;
    let bottom = h - tb - size * 0.86;
    if (mobile) {
      const icons = $('#icons').getBoundingClientRect();
      const hud = $('#hud').getBoundingClientRect();
      const dr = desk.getBoundingClientRect();
      top = icons.bottom - dr.top - size * 0.3;
      bottom = hud.top - dr.top - size * 0.86;
    }
    B = {
      minX: -size * 0.12,
      maxX: Math.max(0, w - size * 0.88),
      minY: Math.min(top, bottom),
      maxY: Math.max(top, bottom),
    };
    home = {
      x: (w - size) / 2,
      y: mobile ? lerp(B.minY, B.maxY, 0.55) : clamp(h * 0.5 - size * 0.45, B.minY, B.maxY),
    };
    if (S.mode !== 'jump' && !S.perch) {
      S.x = clamp(S.x, B.minX, B.maxX);
      S.y = clamp(S.y, B.minY, B.maxY);
    }
    if (VX.fx) VX.fx.resize();
  }

  /* ---------- helpers ---------- */

  const center = () => ({ x: S.x + size / 2, y: S.y + size * 0.6 });
  function mouthPx() {
    const a = VX.sprite.mouth(S.art);
    return { x: (a.x / 64) * size, y: (a.y / 64) * size };
  }
  function speed() {
    return (VX.util.reduced() ? 40 : 55) + S.art * 14;
  }
  function relRect(el) {
    const r = el.getBoundingClientRect();
    const d = desk.getBoundingClientRect();
    return { x: r.left - d.left, y: r.top - d.top, w: r.width, h: r.height };
  }

  function walkTo(x, y, cb) {
    S.perch = null;
    S.sleeping = false;
    S.jump = null;
    S.walk = { x: clamp(x, B.minX, B.maxX), y: clamp(y, B.minY - size * 0.6, B.maxY), cb };
    S.mode = 'walk';
  }

  function jumpTo(x, y, cb) {
    if (VX.util.reduced()) return walkTo(x, y, cb);
    S.perch = null;
    S.sleeping = false;
    S.walk = null;
    const tx = clamp(x, B.minX, B.maxX);
    const ty = clamp(y, -size * 0.2, B.maxY + size * 0.2);
    const dist = Math.hypot(tx - S.x, ty - S.y);
    S.jump = { sx: S.x, sy: S.y, x: tx, y: ty, p: 0, dur: 0.6 + dist / 1800, h: 70 + dist * 0.22, cb };
    S.mode = 'jump';
    S.squash = -0.18;
  }

  function goTo(x, y, cb) {
    const far = Math.hypot(x - S.x, y - S.y) > 340;
    if ((far && S.art >= 2) || S.art >= 4) jumpTo(x, y, cb);
    else walkTo(x, y, cb);
  }

  function say(text, ms) {
    bubble.textContent = text;
    bubble.classList.toggle('left', S.x > desk.clientWidth - size - 140);
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms || 2300);
  }

  function chomp() {
    S.chompUntil = S.t + 0.6;
    S.squash = 0.2;
    VX.sound.play('chomp');
  }

  /* ---------- behaviour ---------- */

  function think() {
    S.perch = S.perch && S.mode === 'idle' ? S.perch : null;
    const st = VX.store.state;
    if (st.status === 'error' || !st.hasData) {
      S.sleeping = true;
      S.nextAction = S.t + 3;
      return;
    }
    const mobile = VX.util.mobile();
    const wins = VX.wm.visibleIds();
    if (mobile && wins.length) {
      if (!S.perch || !wins.includes(S.perch)) perchOn(wins[wins.length - 1]);
      S.nextAction = S.t + rand(2, 4);
      if (Math.random() < 0.25) say(pick(LINES.perch));
      return;
    }
    if (S.art === 0) {
      if (Math.random() < 0.7) {
        S.sleeping = true;
        S.nextAction = S.t + rand(4, 8);
        return;
      }
      S.sleeping = false;
      walkTo(S.x + rand(-70, 70), S.y + rand(-25, 25));
      return;
    }
    S.sleeping = false;
    const opts = [['idle', 2], ['wander', 3], ['icon', S.art >= 2 ? 3.5 : 1.2]];
    if (wins.length && (S.art >= 3 || mobile)) opts.push(['perch', mobile ? 2 : 3]);
    if (S.art >= 4) opts.push(['hop', 2]);
    if (S.perch) opts.push(['stay', 3]);
    const action = weighted(opts);
    const prevPerch = S.perch;
    S.perch = null;

    if (action === 'stay' && prevPerch) {
      S.perch = prevPerch;
      S.nextAction = S.t + rand(2, 5);
    } else if (action === 'idle') {
      S.nextAction = S.t + rand(2, 4.5);
      if (Math.random() < 0.3) say(pick(LINES.idle));
      if (prevPerch) S.perch = prevPerch;
    } else if (action === 'wander') {
      let tx = rand(B.minX, B.maxX);
      let ty = rand(B.minY, B.maxY);
      if (mobile) {
        tx = clamp(home.x + rand(-1, 1) * desk.clientWidth * 0.28, B.minX, B.maxX);
        ty = clamp(home.y + rand(-1, 1) * 70, B.minY, B.maxY);
      }
      goTo(tx, ty);
    } else if (action === 'icon') {
      const el = VX.desktop.pickIconTarget();
      if (!el) {
        S.nextAction = S.t + 2;
        return;
      }
      const r = relRect(el);
      const m = mouthPx();
      goTo(r.x + r.w / 2 - m.x, r.y + r.h * 0.45 - m.y, () => {
        if (!el.isConnected) return;
        chomp();
        VX.desktop.infectIcon(el);
        if (Math.random() < 0.6) say(pick(LINES.infect));
      });
    } else if (action === 'perch') {
      if (!perchOn(pick(wins))) S.nextAction = S.t + 1;
    } else if (action === 'hop') {
      jumpTo(rand(B.minX, B.maxX), rand(B.minY, B.maxY));
    }
  }

  // Sit on a window's title bar, or cling to its bottom edge when there's no room above.
  function perchSpot(r) {
    if (r.y - size * 0.84 >= -size * 0.2) return { mode: 'top', y: r.y - size * 0.84 };
    if (r.y + r.h - size * 0.3 <= B.maxY + size * 0.2) return { mode: 'bottom', y: r.y + r.h - size * 0.3 };
    return null;
  }

  function perchOn(id) {
    const r = VX.wm.rect(id);
    if (!r) return false;
    const spot = perchSpot(r);
    if (!spot) return false;
    const off = rand(0, Math.max(0, r.w - size * 0.9)) - size * 0.05;
    jumpTo(r.x + off, spot.y, () => {
      const r2 = VX.wm.rect(id);
      if (!r2) return;
      S.perch = id;
      S.perchOff = off;
      S.perchMode = spot.mode;
      S.nextAction = S.t + rand(3, 6);
      if (Math.random() < 0.4) say(pick(LINES.perch));
    });
    return true;
  }

  function onWindowOpened(id) {
    if (S.mode === 'feed' || S.mut) return;
    if (VX.util.mobile()) {
      // Phone windows are sheets: hop out of the way and sit on top of it.
      setTimeout(() => {
        if (S.mode === 'feed' || S.mut) return;
        S.walk = null;
        S.mode = 'idle';
        perchOn(id);
      }, 250);
    } else if (S.art >= 3 && Math.random() < 0.6) {
      setTimeout(() => S.mode === 'idle' && perchOn(id), 350);
    }
  }

  function fallDown() {
    S.perch = null;
    jumpTo(clamp(S.x, B.minX, B.maxX), rand(B.minY + (B.maxY - B.minY) * 0.5, B.maxY));
  }

  /* ---------- public reactions ---------- */

  function poke() {
    VX.sound.play('giggle');
    S.squash = 0.3;
    S.pokes++;
    const c = center();
    VX.fx.burst(c.x, c.y - size * 0.1, { count: 10, speed: 160 });
    if (S.sleeping) {
      S.sleeping = false;
      say(pick(LINES.wake));
    } else if (S.pokes % 8 === 0) {
      say('ENOUGH.');
      VX.popups.spawn({
        title: 'virus.exe',
        kind: 'warn',
        text: 'Please stop poking the virus. It is trying to evolve.',
        buttons: [{ label: 'Sorry' }, { label: 'Poke again', action: () => poke() }],
      });
    } else {
      say(pick(S.art >= 5 ? LINES.pokeBig : LINES.poke));
    }
    S.nextAction = Math.max(S.nextAction, S.t + 1.4);
  }

  function pickStart() {
    const w = desk.clientWidth;
    const h = desk.clientHeight;
    const side = Math.floor(Math.random() * 3);
    if (side === 0) return { x: rand(w * 0.1, w * 0.9), y: -30 };
    if (side === 1) return { x: -40, y: rand(h * 0.1, h * 0.6) };
    return { x: w + 40, y: rand(h * 0.1, h * 0.6) };
  }

  function feed(amount, origin) {
    return new Promise((resolve) => {
      const red = VX.util.reduced();
      if (S.jump) {
        S.x = S.jump.x;
        S.y = S.jump.y;
      }
      S.walk = null;
      S.jump = null;
      S.mode = 'feed';
      S.sleeping = false;
      const m = mouthPx();
      const mx = S.x + m.x;
      const my = S.y + m.y;
      const start = origin || pickStart();
      const food = document.createElement('div');
      food.className = 'food';
      food.innerHTML = `<img src="${VX.icons.url('burnfile')}" alt=""><b>${fmtShort(amount)}</b>`;
      desk.appendChild(food);
      const dur = red ? 400 : 1150;
      const anim = food.animate(
        [
          { transform: `translate(${start.x - 24}px, ${start.y - 24}px) rotate(0deg) scale(1)` },
          { transform: `translate(${mx - 24}px, ${my - 24}px) rotate(${red ? 0 : 540}deg) scale(0.35)` },
        ],
        { duration: dur, easing: 'cubic-bezier(.55,0,.8,.35)', fill: 'forwards' }
      );
      const t0 = performance.now();
      const track = () => {
        const p = Math.min(1, (performance.now() - t0) / dur);
        S.lookAt = { x: lerp(start.x, mx, p), y: lerp(start.y, my, p) };
        S.mouthT = 0.2 + p * 0.8;
        if (p < 1 && S.mode === 'feed') requestAnimationFrame(track);
      };
      requestAnimationFrame(track);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        food.remove();
        S.lookAt = null;
        S.mouthT = 0;
        chomp();
        VX.fx.burst(mx, my, { count: 26, colors: ['#ff8a00', '#ffd400', '#ff3b3b', VX.theme.accent], speed: 260 });
        VX.fx.text(mx, my - size * 0.45, `+${fmtShort(amount)} BURNED`, 'burn');
        VX.sound.play('burn');
        VX.corruption.splash(mx, my + size * 0.2, 60 + S.art * 12);
        if (Math.random() < 0.5) say(pick(LINES.feed), 1600);
        setTimeout(() => {
          if (S.mode === 'feed') S.mode = 'idle';
          S.nextAction = S.t + 1.2;
          resolve();
        }, red ? 200 : 750);
      };
      anim.onfinish = finish;
      setTimeout(finish, dur + 1500); // safety net if the tab was hidden
    });
  }

  function mutate(toStage) {
    return new Promise((res) => {
      if (S.jump) {
        S.x = S.jump.x;
        S.y = S.jump.y;
      }
      S.walk = null;
      S.jump = null;
      S.perch = null;
      S.mode = 'mutate';
      S.sleeping = false;
      S.mut = { from: S.art, to: VX.sprite.artFor(toStage), stage: toStage, start: S.t, dur: VX.util.reduced() ? 1 : 2.6, res };
      VX.sound.play('mutate');
    });
  }

  function setStage(i) {
    S.stage = i;
    S.art = VX.sprite.artFor(i);
    S.frame = -1;
    root.dataset.art = S.art;
  }

  function dominate(ms) {
    S.dominantUntil = S.t + ms / 1000;
  }

  /* ---------- loop ---------- */

  function update(dt) {
    if (S.perch && S.mode !== 'jump') {
      const r = VX.wm.rect(S.perch);
      const spot = r && perchSpot(r);
      if (!spot) fallDown();
      else {
        S.x = r.x + S.perchOff;
        S.y = spot.y;
      }
    }
    if (S.mode === 'walk' && S.walk) {
      const dx = S.walk.x - S.x;
      const dy = S.walk.y - S.y;
      const d = Math.hypot(dx, dy);
      const sp = speed() * dt;
      if (d <= sp) {
        S.x = S.walk.x;
        S.y = S.walk.y;
        const cb = S.walk.cb;
        S.walk = null;
        S.mode = 'idle';
        S.nextAction = S.t + rand(1.5, 4);
        cb && cb();
      } else {
        S.x += (dx / d) * sp;
        S.y += (dy / d) * sp;
        S.dirX = dx / d;
        S.dirY = dy / d;
      }
    } else if (S.mode === 'jump' && S.jump) {
      const j = S.jump;
      j.p += dt / j.dur;
      const p = Math.min(1, j.p);
      S.x = lerp(j.sx, j.x, p);
      S.y = lerp(j.sy, j.y, p) - Math.sin(Math.PI * p) * j.h;
      S.dirX = Math.sign(j.x - j.sx);
      if (p >= 1) {
        S.jump = null;
        S.mode = 'idle';
        S.squash = 0.24;
        const g = groundPoint();
        VX.fx.burst(g.x, g.y, { count: 8, colors: ['#ffffff', VX.theme.accent], speed: 120, angle: -Math.PI / 2, spread: 1.4, lift: 20 });
        S.nextAction = S.t + rand(2, 4.5);
        j.cb && j.cb();
      }
    } else if (S.mode === 'idle' && S.t >= S.nextAction) {
      think();
    }

    if (S.mut) {
      const m = S.mut;
      const p = (S.t - m.start) / m.dur;
      if (p >= 1) {
        setStage(m.stage);
        S.mut = null;
        S.mode = 'idle';
        S.flash = 0;
        S.glitch = 0;
        S.pulse = 0;
        S.squash = 0.3;
        S.evolvedUntil = S.t + 7;
        S.nextAction = S.t + 2;
        const c = center();
        VX.fx.burst(c.x, c.y, { count: 60, speed: 420, colors: [VX.theme.accent, '#ffffff', VX.theme.accent2] });
        say(pick(LINES.mutate), 2600);
        m.res();
      } else if (VX.util.reduced()) {
        S.art = p < 0.5 ? m.from : m.to;
        S.glitch = 0;
        S.flash = 0;
      } else {
        S.art = Math.sin(p * p * 95) > 0 || p > 0.86 ? m.to : m.from;
        S.flash = p > 0.82 && p < 0.9 ? 1 : 0;
        S.glitch = 0.3 + p;
        S.pulse = Math.sin(p * 50) * 0.05 * p;
      }
    }

    S.squash += (0 - S.squash) * Math.min(1, dt * 7);

    if (S.t > S.nextBlink) {
      S.blinkUntil = S.t + 0.13;
      S.nextBlink = S.t + rand(2, 5.5);
    }
    const chomping = S.t < S.chompUntil;
    const targetMouth = chomping ? Math.abs(Math.sin(S.t * 17)) : S.mode === 'feed' ? S.mouthT : 0;
    S.mouth += (targetMouth - S.mouth) * Math.min(1, dt * 18);

    // where to look
    const c = center();
    let tx;
    let ty;
    if (S.lookAt) {
      tx = S.lookAt.x;
      ty = S.lookAt.y;
    } else if (S.ptr && S.t - S.ptr.at < 5) {
      tx = S.ptr.x;
      ty = S.ptr.y;
    } else if (S.mode === 'walk' || S.mode === 'jump') {
      tx = c.x + S.dirX * 100;
      ty = c.y + S.dirY * 60;
    } else {
      if (!S.glance || S.t > S.glanceAt) {
        S.glance = { x: c.x + rand(-150, 150), y: c.y + rand(-90, 90) };
        S.glanceAt = S.t + rand(1.5, 3.5);
      }
      tx = S.glance.x;
      ty = S.glance.y;
    }
    const dx = tx - c.x;
    const dy = ty - c.y;
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, d / 140);
    S.lookX += ((dx / d) * k - S.lookX) * Math.min(1, dt * 10);
    S.lookY += ((dy / d) * k - S.lookY) * Math.min(1, dt * 10);

    const mood = computeMood();
    if (mood !== VX.store.state.mood) {
      VX.store.setMood(mood);
      root.dataset.mood = mood;
    }
  }

  function computeMood() {
    if (VX.store.state.status === 'error') return 'dormant';
    if (S.mut) return 'mutating';
    if (S.mode === 'feed' || S.t < S.chompUntil) return 'feeding';
    if (S.art >= 6 || S.t < S.dominantUntil) return 'dominant';
    if (S.t < S.evolvedUntil) return 'evolved';
    if (S.sleeping) return 'dormant';
    return 'active';
  }

  function draw() {
    const moving = S.mode === 'walk' || S.mode === 'jump';
    const wob = S.mode === 'walk' && !VX.util.reduced() ? Math.sin(S.t * 13) * 0.045 : 0;
    const sq = S.squash + wob;
    cvs.style.transform = `scale(${(1 + sq).toFixed(3)}, ${(1 - sq).toFixed(3)})`;
    if (S.x !== lastX || S.y !== lastY) {
      root.style.transform = `translate3d(${S.x.toFixed(1)}px, ${S.y.toFixed(1)}px, 0)`;
      lastX = S.x;
      lastY = S.y;
    }
    if (!visible) return;
    const fps = S.mut ? 30 : 15;
    const frame = Math.floor(S.t * fps);
    if (frame === S.frame) return;
    S.frame = frame;
    VX.sprite.render(ctx, S.art, {
      t: S.t,
      look: { x: S.lookX, y: S.lookY },
      blink: S.t < S.blinkUntil,
      sleep: S.sleeping && S.art === 0,
      mouth: S.mouth,
      moving,
      flash: S.flash,
      glitch: S.glitch + (VX.store.state.status === 'error' ? 0.35 : 0),
      pulse: S.pulse,
    });
  }

  function loop(ts) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (ts - (lastTs || ts)) / 1000);
    lastTs = ts;
    S.t += dt;
    update(dt);
    draw();
  }

  function groundPoint() {
    return { x: S.x + size / 2, y: S.y + size * 0.82, sleeping: S.sleeping };
  }

  VX.virus = {
    init, measure, feed, mutate, setStage, say, poke, dominate, onWindowOpened, groundPoint,
    center: () => center(),
    get stage() {
      return S.stage;
    },
    get art() {
      return S.art;
    },
    wake() {
      S.sleeping = false;
      S.nextAction = Math.min(S.nextAction, S.t + 0.5);
    },
    lines: LINES,
  };
})();
