/* Fake system popups and popup storms. Every button does something. */
(function () {
  'use strict';
  const VX = window.VX;
  const { $, esc, rand, pick, clamp, makeDraggable, mobile } = VX.util;

  let layer, desk;
  let z = 700;
  const live = new Set();
  const MAX = 22;

  const STORM = [
    { title: 'System Warning', text: 'Your files look delicious.', kind: 'warn', buttons: ['OK', 'Also OK'] },
    { title: 'virus.exe', text: 'Are you sure you want to NOT burn?', kind: 'info', buttons: ['Yes', 'No'] },
    { title: 'Error', text: 'Error 0x0BADF00D: antivirus.exe was eaten.', kind: 'error', buttons: ['OK'] },
    { title: 'Low Memory', text: 'The virus is using 99% of your RAM. The other 1% is scared.', kind: 'warn', buttons: ['Fine'] },
    { title: 'Windows Update', text: 'Installing mutation 1 of ∞…', kind: 'info', buttons: ['Cancel'] },
    { title: 'Recycle Bin', text: 'Recycle Bin has been renamed to Infection Bin.', kind: 'info', buttons: ['Cool'] },
    { title: 'Assistant', text: 'It looks like you are being infected. Would you like help?', kind: 'info', buttons: ['No', 'Yes'] },
    { title: 'Notice', text: 'Pixel (12, 44) has been compromised.', kind: 'warn', buttons: ['OK'] },
    { title: 'Firewall', text: 'Firewall disabled. It was on fire anyway.', kind: 'error', buttons: ['OK'] },
    { title: 'C:\\', text: 'C:\\ drive renamed to C:\\VIRUS.', kind: 'warn', buttons: ['Undo', 'OK'] },
    { title: 'Mouse', text: 'Cursor ownership transferred to virus.exe.', kind: 'info', buttons: ['OK'] },
    { title: 'Fatal Exception', text: 'A fatal exception 0E has occurred at 0028:C0011E36. It was delicious.', kind: 'error', buttons: ['Close'] },
  ];

  function init(deskEl) {
    desk = deskEl;
    layer = $('#popupLayer');
  }

  function updateCount() {
    const b = $('#popupCount');
    if (!b) return;
    b.hidden = live.size < 2;
    b.querySelector('span').textContent = live.size;
  }

  function close(el) {
    if (!live.has(el)) return;
    live.delete(el);
    el.classList.add('closing');
    setTimeout(() => el.remove(), VX.util.reduced() ? 0 : 140);
    updateCount();
  }

  /**
   * spawn({ title, text, html, kind: info|warn|error|mutation, buttons: [{label, action, keep}], x, y, focus, width })
   */
  function spawn(o) {
    if (live.size >= MAX) close(live.values().next().value);
    const el = document.createElement('section');
    el.className = `win popup popup-${o.kind || 'info'} opening`;
    el.setAttribute('role', o.kind === 'error' ? 'alertdialog' : 'dialog');
    el.setAttribute('aria-label', o.title || 'Message');
    el.tabIndex = -1;
    const iconName = o.kind === 'mutation' ? 'virus' : o.kind || 'info';
    el.innerHTML = `
      <header class="win-title">
        <h2>${esc(o.title || 'Message')}</h2>
        <div class="win-ctrls"><button type="button" class="btn wc wc-close" aria-label="Close"></button></div>
      </header>
      <div class="win-body popup-body">
        ${o.html ? '' : `<img class="px popup-icon" src="${VX.icons.url(iconName)}" alt="">`}
        <div class="popup-text">${o.html || esc(o.text || '').replace(/\n/g, '<br>')}</div>
      </div>
      <div class="popup-btns"></div>`;
    const btns = el.querySelector('.popup-btns');
    (o.buttons && o.buttons.length ? o.buttons : [{ label: 'OK' }]).forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = b.label;
      btn.addEventListener('click', () => {
        if (!b.keep) close(el);
        if (b.action) b.action(el);
        VX.sound.play('click');
      });
      btns.appendChild(btn);
    });
    el.querySelector('.wc-close').addEventListener('click', () => close(el));

    const dw = desk.clientWidth;
    const dh = desk.clientHeight;
    const w = Math.min(o.width || 320, dw - 20);
    el.style.width = w + 'px';
    let x = o.x;
    let y = o.y;
    if (o.center || mobile()) {
      x = (dw - w) / 2 + (o.center ? 0 : rand(-12, 12));
      y = o.y != null ? o.y : dh * (mobile() ? 0.3 : 0.28) + (o.center ? 0 : rand(-40, 60));
    }
    if (x == null) x = rand(20, Math.max(21, dw - w - 20));
    if (y == null) y = rand(20, Math.max(21, dh * 0.62));
    el.style.left = clamp(x, 6, Math.max(6, dw - w - 6)) + 'px';
    el.style.top = clamp(y, 6, Math.max(6, dh - 200)) + 'px';
    el.style.zIndex = ++z;
    layer.appendChild(el);
    live.add(el);
    el.addEventListener('pointerdown', () => (el.style.zIndex = ++z), true);
    el.addEventListener('animationend', () => el.classList.remove('opening'), { once: true });
    makeDraggable(el, el.querySelector('.win-title'), desk, { canDrag: () => !mobile() });
    if (o.onMount) o.onMount(el);
    if (o.focus) setTimeout(() => (btns.querySelector('button') || el).focus({ preventScroll: true }), 30);
    VX.sound.play(o.kind === 'error' ? 'error' : 'popup');
    updateCount();
    return el;
  }

  function stormButton(label, depth) {
    return {
      label,
      action: () => {
        if (/cancel|undo/i.test(label) && depth < 2) {
          spawn({ title: 'Error', kind: 'error', text: `"${label}" was cancelled by virus.exe.`, buttons: [stormButton('OK', depth + 1)] });
        } else if (/^yes$/i.test(label) && Math.random() < 0.5) {
          VX.virus.say('good human');
        } else if (/^no$/i.test(label) && Math.random() < 0.5) {
          VX.virus.say('wrong answer');
        }
      },
    };
  }

  function storm(n, opts) {
    n = n || 9;
    if (VX.util.reduced()) n = Math.min(n, 4);
    const dw = desk.clientWidth;
    const dh = desk.clientHeight;
    const startX = rand(20, Math.max(30, dw * 0.35));
    const startY = rand(20, dh * 0.2);
    VX.virus.dominate(6000);
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        const m = pick(STORM);
        spawn({
          title: m.title,
          text: m.text,
          kind: m.kind,
          buttons: m.buttons.map((b) => stormButton(b, 0)),
          x: mobile() ? undefined : startX + i * 26 + rand(-8, 8),
          y: mobile() ? undefined : startY + i * 24 + rand(-6, 6),
        });
        if (i % 3 === 0) VX.fx.tear();
      }, i * (VX.util.reduced() ? 40 : 110));
    }
    if (!(opts && opts.silent)) VX.store.addLocalEvent('storm', `Popup storm triggered — ${n} windows spawned`);
  }

  function ambient() {
    const m = pick(STORM);
    spawn({ title: m.title, text: m.text, kind: m.kind, buttons: m.buttons.map((b) => stormButton(b, 0)) });
  }

  function closeAll() {
    Array.from(live).forEach(close);
  }

  function closeTop() {
    let top = null;
    live.forEach((el) => {
      if (!top || +el.style.zIndex > +top.style.zIndex) top = el;
    });
    if (top) close(top);
    return !!top;
  }

  VX.popups = { init, spawn, storm, ambient, closeAll, closeTop, close, get count() { return live.size; } };
})();
