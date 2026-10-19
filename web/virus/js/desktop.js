/* Desktop shell: icons, start menu, taskbar, file explorer, quarantine,
 * toasts, ambient chaos and every click action on the page. */
(function () {
  'use strict';
  const VX = window.VX;
  const { $, $$, esc, rand, randi, pick, corrupt, timeStr, wait } = VX.util;
  const cfg = VX.config;

  const ICONS = [
    { id: 'mycomputer', label: 'My Computer', icon: 'computer', win: 'explorer' },
    { id: 'sysmon', label: 'System Monitor', icon: 'monitor', win: 'sysmon' },
    { id: 'lab', label: 'Mutation Lab', icon: 'lab', win: 'lab' },
    { id: 'log', label: 'virus.log', icon: 'log', win: 'log' },
    { id: 'readme', label: 'README.txt', icon: 'txt', win: 'readme' },
    { id: 'token', label: '$VIRUS.lnk', icon: 'coin', win: 'token' },
    { id: 'quarantine', label: 'Quarantine', icon: 'bin', win: 'quarantine' },
    { id: 'control', label: 'Control Panel', icon: 'settings', win: 'control' },
  ];
  const infected = new Map(); // icon id -> time

  let desk;

  /* ---------- icons ---------- */

  function renderIcons() {
    const nav = $('#icons');
    nav.innerHTML = ICONS.map(
      (i) => `<button type="button" class="icon" data-icon-id="${i.id}" data-action="open" data-win="${i.win}">
        <img class="px" src="${VX.icons.url(i.icon)}" alt=""><span class="lbl">${esc(i.label)}</span></button>`
    ).join('');
  }

  function iconDef(id) {
    return ICONS.find((i) => i.id === id);
  }

  function pickIconTarget() {
    const els = $$('#icons .icon').filter((el) => el.offsetParent !== null);
    if (!els.length) return null;
    const fresh = els.filter((el) => !infected.has(el.dataset.iconId));
    return fresh.length && Math.random() < 0.85 ? pick(fresh) : pick(els);
  }

  function infectIcon(el) {
    const id = el.dataset.iconId;
    const def = iconDef(id);
    const r = el.getBoundingClientRect();
    const d = desk.getBoundingClientRect();
    VX.corruption.splash(r.left - d.left + r.width / 2, r.top - d.top + r.height / 2, 46);
    if (infected.has(id)) return;
    infected.set(id, Date.now());
    el.classList.add('infected');
    el.querySelector('.lbl').textContent = corrupt(def.label, 0.3);
    el.setAttribute('aria-label', `${def.label} (infected)`);
    VX.store.addLocalEvent('corrupt', `${def.label} corrupted by virus.exe`);
    refreshQuarantine();
  }

  function cleanIcon(id) {
    const el = $(`#icons [data-icon-id="${id}"]`);
    infected.delete(id);
    if (el) {
      el.classList.remove('infected');
      el.querySelector('.lbl').textContent = iconDef(id).label;
      el.removeAttribute('aria-label');
    }
  }

  /* ---------- file system (My Computer) ---------- */

  const FS = {
    name: 'My Computer',
    icon: 'computer',
    children: [
      {
        name: 'Local Disk (C:)', icon: 'drive', children: [
          { name: 'VIRUS', icon: 'folder', children: [
            { name: 'virus.exe', icon: 'virus', open: 'virus-exe' },
            { name: 'mutation_lab.exe', icon: 'lab', open: 'win:lab' },
            { name: 'virus.log', icon: 'log', open: 'win:log' },
            { name: 'README.txt', icon: 'txt', open: 'win:readme' },
          ] },
          { name: 'Documents', icon: 'folder', children: [
            { name: 'passwords.txt', icon: 'txt', open: 'passwords' },
            { name: 'family_photo.bmp', icon: 'image', open: 'photo' },
            { name: 'homework.doc', icon: 'doc', open: 'homework' },
            { name: 'taxes_2003.xls', icon: 'xls', open: 'taxes' },
          ] },
          { name: 'Downloads', icon: 'folder', children: [
            { name: 'burn_me.exe', icon: 'burnfile', open: 'burn-me' },
            { name: 'do_not_open.exe', icon: 'exe', open: 'storm' },
            { name: 'free_ram.exe', icon: 'exe', open: 'free-ram' },
          ] },
          { name: 'System32', icon: 'folder', open: 'system32' },
        ],
      },
      { name: '3½ Floppy (A:)', icon: 'floppy', open: 'floppy' },
      { name: 'VIRUS_OST (D:)', icon: 'cd', children: [{ name: 'track01_infection.mid', icon: 'cd', open: 'track' }] },
    ],
  };

  function nodeAt(path) {
    let n = FS;
    for (const i of path) n = n.children[i];
    return n;
  }
  function pathName(path) {
    const names = [];
    let n = FS;
    for (const i of path) {
      n = n.children[i];
      names.push(n.name);
    }
    if (!names.length) return 'My Computer';
    const drive = names[0].match(/\((\w:)\)/);
    return (drive ? drive[1] : names[0]) + '\\' + names.slice(1).join('\\');
  }

  function renderExplorer(body) {
    body.classList.add('explorer');
    body.innerHTML = `
      <div class="ex-bar">
        <button type="button" class="btn btn-sm" data-ex="back" aria-label="Back">◄ Back</button>
        <button type="button" class="btn btn-sm" data-ex="up" aria-label="Up one level">▲ Up</button>
        <div class="ex-addr" aria-live="polite"></div>
      </div>
      <ul class="ex-list" role="list"></ul>
      <div class="ex-status"></div>`;
    const st = { path: [], hist: [] };
    const draw = () => {
      const node = nodeAt(st.path);
      body.querySelector('.ex-addr').textContent = pathName(st.path);
      body.querySelector('[data-ex="back"]').disabled = !st.hist.length;
      body.querySelector('[data-ex="up"]').disabled = !st.path.length;
      const stage = VX.virus.art;
      body.querySelector('.ex-list').innerHTML = node.children
        .map((c, i) => {
          const sick = stage >= 2 && VX.util.hash(i + c.name.length + st.path.length * 7) < stage / 9;
          return `<li><button type="button" class="ex-item${sick ? ' sick' : ''}" data-i="${i}" aria-label="${esc(c.name)}${sick ? ' (infected)' : ''}">
            <img class="px" src="${VX.icons.url(c.icon)}" alt=""><span>${esc(sick ? corrupt(c.name, 0.12) : c.name)}</span></button></li>`;
        })
        .join('');
      body.querySelector('.ex-status').textContent = `${node.children.length} object(s)${stage >= 3 ? ' · 1 hidden process (virus.exe)' : ''}`;
    };
    body.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-ex]');
      if (nav) {
        if (nav.dataset.ex === 'back' && st.hist.length) st.path = st.hist.pop();
        if (nav.dataset.ex === 'up' && st.path.length) {
          st.hist.push(st.path);
          st.path = st.path.slice(0, -1);
        }
        draw();
        return;
      }
      const it = e.target.closest('.ex-item');
      if (!it) return;
      const node = nodeAt(st.path).children[+it.dataset.i];
      VX.sound.play('click');
      if (node.children) {
        st.hist.push(st.path);
        st.path = st.path.concat(+it.dataset.i);
        draw();
      } else openFile(node);
    });
    draw();
  }

  const HOMEWORK =
    'History essay — The Year 2000 Problem\n\nIn 1999 people were worried that computers would stop working at midnight. ' +
    'Planes would fall, banks would forget everybody. Nothing happened. Computers are perfectly safe and nothing ' +
    'will ever take over a desktop computer, especially not a small green creature that eats files.\n\n— by me, age 12';

  function openFile(node) {
    const a = node.open;
    if (a.startsWith('win:')) {
      VX.wm.open(a.slice(4));
      return;
    }
    const art = VX.virus.art;
    switch (a) {
      case 'virus-exe':
        VX.popups.spawn({ title: 'virus.exe', kind: 'info', text: 'virus.exe is already running.\nIt is right there. Looking at you.', buttons: [{ label: 'Say hi', action: () => VX.virus.say('hi :)') }, { label: 'OK' }], focus: true });
        VX.virus.wake();
        break;
      case 'passwords':
        VX.wm.open('notepad', { key: 'passwords', title: 'passwords.txt — Notepad', text: 'nice try.\n\nthere are no passwords here.\nonly virus.\n\n- virus.exe' });
        break;
      case 'homework':
        VX.wm.open('notepad', { key: 'homework', title: 'homework.doc — WordPad', icon: 'doc', text: corrupt(HOMEWORK, Math.min(0.5, art * 0.07)) });
        break;
      case 'photo':
        VX.wm.open('photo');
        break;
      case 'taxes':
        VX.popups.spawn({ title: 'Spreadsheet', kind: 'error', text: 'taxes_2003.xls cannot be opened.\nThe virus ate column B.', buttons: [{ label: 'OK', action: () => VX.virus.say('it was crunchy') }], focus: true });
        break;
      case 'burn-me':
        feedAction();
        break;
      case 'storm':
        VX.popups.spawn({
          title: 'do_not_open.exe', kind: 'warn', focus: true,
          text: 'Are you sure? This file is extremely openable.',
          buttons: [{ label: 'Open anyway', action: () => VX.popups.storm(10) }, { label: 'Cancel' }],
        });
        break;
      case 'free-ram':
        freeRam();
        break;
      case 'system32':
        VX.popups.spawn({ title: 'Access denied', kind: 'error', text: 'C:\\System32 is now the virus\' bedroom.\nPlease knock.', buttons: [{ label: 'Knock', action: () => VX.virus.say('WHO IS IT') }, { label: 'Leave' }], focus: true });
        break;
      case 'floppy':
        floppy();
        break;
      case 'track':
        if (VX.sound.isOn()) {
          VX.sound.play('jingle');
          VX.virus.say('♪ my theme song ♪');
        } else {
          VX.popups.spawn({ title: 'Media Player', kind: 'info', text: 'Sound is turned off.\nTurn it on to play track01_infection.mid?', buttons: [{ label: 'Turn on & play', action: () => { VX.sound.setEnabled(true); setTimeout(() => VX.sound.play('jingle'), 200); } }, { label: 'Cancel' }], focus: true });
        }
        break;
      default:
        break;
    }
  }

  function floppy() {
    VX.popups.spawn({
      title: 'A:\\', kind: 'error', focus: true,
      text: 'Please insert a disk into drive A:.',
      buttons: [{ label: 'Retry', action: () => setTimeout(floppy, 120) }, { label: 'Cancel' }],
    });
  }

  function freeRam() {
    const el = VX.popups.spawn({
      title: 'free_ram.exe', kind: 'info', width: 320, focus: true,
      html: '<p>Downloading more RAM…</p><div class="meter"><i></i><span>0%</span></div>',
      buttons: [{ label: 'Cancel' }],
    });
    const meter = el.querySelector('.meter');
    let p = 0;
    const iv = setInterval(() => {
      if (!el.isConnected) return clearInterval(iv);
      p = Math.min(99, p + randi(4, 13));
      meter.style.setProperty('--p', p);
      meter.querySelector('span').textContent = p + '%';
      if (p >= 99) {
        clearInterval(iv);
        setTimeout(() => {
          VX.popups.close(el);
          VX.popups.spawn({ title: 'Download failed', kind: 'error', text: 'The virus ate the RAM on its way in.', buttons: [{ label: 'Of course it did' }], focus: true });
          VX.virus.say('*burp*');
        }, 500);
      }
    }, 180);
  }

  /* ---------- family photo (corrupts with infection) ---------- */

  function renderPhoto(body) {
    body.classList.add('photo');
    body.innerHTML = '<canvas class="px photo-cv" width="96" height="64" aria-label="A family photo, partially corrupted by the virus" role="img"></canvas><p class="photo-cap"></p>';
    const cv = body.querySelector('canvas');
    const g = cv.getContext('2d');
    const sky = ['#6fb8ff', '#8cc8ff', '#a8d8ff'];
    sky.forEach((c, i) => {
      g.fillStyle = c;
      g.fillRect(0, i * 12, 96, 12);
    });
    g.fillStyle = '#ffe14d';
    g.fillRect(74, 6, 10, 10);
    g.fillStyle = '#3b8f3b';
    g.fillRect(0, 44, 96, 20);
    g.fillStyle = '#2d6e2d';
    for (let x = 0; x < 96; x += 4) g.fillRect(x, 44, 2, 2);
    g.fillStyle = '#b5523b';
    g.fillRect(14, 28, 26, 18);
    g.fillStyle = '#7a2e1f';
    for (let i = 0; i < 9; i++) g.fillRect(12 + i * 1.5, 28 - i * 1.5, 30 - i * 3, 2);
    g.fillStyle = '#ffd36b';
    g.fillRect(19, 33, 6, 6);
    g.fillStyle = '#4a3020';
    g.fillRect(30, 36, 6, 10);
    [[52, '#ff7aa8'], [60, '#4f7cff'], [67, '#ffb347']].forEach(([x, c], k) => {
      g.fillStyle = '#ffd9b3';
      g.fillRect(x, 36 - k, 4, 4);
      g.fillStyle = c;
      g.fillRect(x - 1, 40 - k, 6, 8 + k);
    });
    const inf = VX.store.view().infection / 100;
    const n = Math.floor(inf * 140);
    const acc = VX.theme.accent;
    for (let i = 0; i < n; i++) {
      const x = randi(0, 92);
      const y = randi(0, 60);
      g.fillStyle = Math.random() < 0.5 ? acc : pick(['#000', '#ff2bd6', '#ffffff']);
      g.fillRect(x, y, randi(1, 4), randi(1, 2));
    }
    if (inf > 0.45) {
      const off = g.getImageData(0, 20, 96, 6);
      g.putImageData(off, randi(3, 8), 22);
    }
    body.querySelector('.photo-cap').textContent =
      inf < 0.15 ? 'Summer 1999. Everyone looks happy.' : inf < 0.6 ? `Summer 1999. ${Math.round(inf * 100)}% of the pixels are infected.` : 'Summer 1999. The virus is in the photo now.';
  }

  /* ---------- quarantine ---------- */

  let scanning = false;

  function renderQuarantine(body) {
    body.classList.add('quarantine');
    body.dataset.quarantine = '1';
    drawQuarantine(body);
  }

  function drawQuarantine(body) {
    const items = Array.from(infected.entries());
    body.innerHTML = `
      <div class="q-head"><img class="px" src="${VX.icons.url(items.length ? 'error' : 'info')}" alt="">
        <p><b>${items.length} threat${items.length === 1 ? '' : 's'}</b> found on this desktop${items.length ? '.' : '. For now.'}</p></div>
      <ul class="q-list">${
        items.length
          ? items
              .map(([id, t]) => {
                const d = iconDef(id);
                return `<li><img class="px" src="${VX.icons.url(d.icon)}" alt=""><span><b>${esc(d.label)}</b><small>infected ${timeStr(t)}</small></span>
                  <button type="button" class="btn btn-sm" data-action="q-restore" data-id="${id}">Restore</button></li>`;
              })
              .join('')
          : '<li class="q-empty">No infected files. The virus has not touched any icons yet — give it a minute.</li>'
      }</ul>
      <div class="q-scan">
        <div class="meter q-meter"><i></i><span>${scanning ? 'Scanning…' : 'Ready'}</span></div>
        <button type="button" class="btn" data-action="q-scan" ${scanning ? 'disabled' : ''}>Run full scan</button>
      </div>
      <p class="q-note">Restoring files is cosmetic. The virus can always come back.</p>`;
  }

  function refreshQuarantine() {
    $$('[data-quarantine]').forEach((b) => !scanning && drawQuarantine(b));
    VX.components.updateBinds();
  }

  async function runScan(btn) {
    const body = btn.closest('[data-quarantine]');
    if (!body || scanning) return;
    scanning = true;
    btn.disabled = true;
    const meter = body.querySelector('.q-meter');
    const label = meter.querySelector('span');
    const files = ['C:\\VIRUS\\virus.exe', 'C:\\Documents\\passwords.txt', 'C:\\System32\\kernel.dll', 'C:\\Documents\\family_photo.bmp', 'A:\\', 'C:\\Downloads\\burn_me.exe'];
    for (let p = 0; p <= 100; p += 4) {
      if (!body.isConnected) break;
      meter.style.setProperty('--p', p);
      label.textContent = `${p}% ${files[Math.floor(p / 17) % files.length]}`;
      await wait(VX.util.reduced() ? 10 : 90);
    }
    scanning = false;
    Array.from(infected.keys()).forEach(cleanIcon);
    VX.corruption.clear();
    refreshQuarantine();
    VX.store.addLocalEvent('system', 'Full scan complete — desktop icons restored. 1 threat could not be removed.');
    VX.popups.spawn({
      title: 'Scan complete', kind: 'warn', focus: true,
      text: '1 threat could not be removed:\nvirus.exe\n\nReason: too powerful.',
      buttons: [{ label: 'OK' }],
    });
    setTimeout(() => VX.virus.say('rude.'), 400);
  }

  /* ---------- start menu ---------- */

  function setStartOpen(open) {
    const m = $('#startMenu');
    const b = $('#startBtn');
    m.hidden = !open;
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    b.classList.toggle('pressed', open);
    if (open) {
      const first = m.querySelector('button');
      first && first.focus({ preventScroll: true });
    }
  }

  function syncSoundLabels() {
    const on = VX.sound.isOn();
    $$('[data-sound-label]').forEach((el) => (el.textContent = on ? 'Sound: ON' : 'Sound: OFF'));
    const tb = $('#soundBtn');
    if (tb) {
      tb.setAttribute('aria-pressed', on ? 'true' : 'false');
      tb.setAttribute('aria-label', on ? 'Sound on — click to mute' : 'Sound off — click to enable');
      tb.querySelector('img').src = VX.icons.url(on ? 'speaker' : 'mute');
    }
  }

  /* ---------- toasts ---------- */

  function toast(text, title) {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.innerHTML = `${title ? `<b>${esc(title)}</b>` : ''}<span>${esc(text)}</span>`;
    wrap.appendChild(el);
    while (wrap.children.length > 3) wrap.firstChild.remove();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, 3400);
  }

  /* ---------- shutdown ---------- */

  async function shutdown() {
    const ov = document.createElement('div');
    ov.className = 'shutdown';
    ov.setAttribute('role', 'alert');
    ov.innerHTML = '<p class="sd-msg">Shutting down…</p>';
    desk.appendChild(ov);
    await wait(900);
    ov.innerHTML = '<p class="sd-msg sd-safe">It\'s now safe to turn off<br>your computer.</p>';
    await wait(1800);
    ov.innerHTML = '<canvas class="px sd-virus" width="64" height="64" aria-hidden="true"></canvas><p class="sd-msg sd-no">just kidding.</p>';
    const cv = ov.querySelector('canvas');
    const g = cv.getContext('2d');
    const t0 = performance.now();
    const anim = () => {
      if (!cv.isConnected) return;
      VX.sprite.render(g, VX.virus.art, { t: (performance.now() - t0) / 1000, mouth: 0.6, look: { x: 0, y: 0.3 } });
      requestAnimationFrame(anim);
    };
    anim();
    VX.sound.play('giggle');
    await wait(1700);
    ov.classList.add('out');
    await wait(400);
    ov.remove();
    VX.virus.say('you can\'t get rid of me');
    VX.store.addLocalEvent('system', 'Shutdown blocked by virus.exe');
  }

  /* ---------- actions ---------- */

  function feedAction() {
    VX.wm.open('burn');
  }

  const ACTIONS = {
    open: (el) => VX.wm.open(el.dataset.win),
    feed: feedAction,
    'toggle-sound': () => VX.sound.toggle(),
    'close-popups': () => VX.popups.closeAll(),
    storm: () => VX.popups.storm(10),
    shutdown: () =>
      VX.popups.spawn({
        title: 'Shut Down', kind: 'warn', focus: true, center: true,
        text: 'Shut down VIRUS.EXE?',
        buttons: [{ label: 'Yes', action: shutdown }, { label: 'No', action: () => VX.virus.say('good choice') }],
      }),
    'scroll-to': (el) => {
      const t = document.querySelector(el.dataset.target);
      if (t) t.scrollIntoView({ behavior: VX.util.reduced() ? 'auto' : 'smooth', block: 'start' });
    },
    retry: () => {
      VX.source.reconnect();
      toast('Reconnecting to the engine feed…', 'Retry');
    },
    'copy-ca': async () => {
      const ca = cfg.token.contract;
      if (!ca) return;
      try {
        await navigator.clipboard.writeText(ca);
        toast('Contract address copied.', cfg.token.ticker);
      } catch (e) {
        toast('Copy failed — select the address manually.', 'Clipboard');
      }
    },
    'q-restore': (el) => {
      cleanIcon(el.dataset.id);
      refreshQuarantine();
      VX.store.addLocalEvent('system', `${iconDef(el.dataset.id).label} restored from quarantine`);
      VX.virus.say(pick(['hey!', 'i\'ll be back', 'that was MINE']));
    },
    'q-scan': (el) => runScan(el),
    'lab-select': (el) => {
      const root = el.closest('[data-lab]');
      if (root) VX.components.selectLab(root, +el.dataset.stage);
    },
    'lab-open': () => VX.wm.open('lab'),
    'log-filter': (el) => {
      const list = document.querySelector(el.dataset.target);
      if (!list) return;
      list.dataset.filter = el.dataset.filter;
      $$(`[data-action="log-filter"][data-target="${el.dataset.target}"]`).forEach((b) => b.setAttribute('aria-pressed', b === el ? 'true' : 'false'));
      VX.components.renderFeed(list);
    },
    'end-task': (el) => {
      const p = el.dataset.proc;
      const msg = {
        'virus.exe': ['Access denied', 'error', 'virus.exe cannot be ended.\nvirus.exe has ended your permission to end it.'],
        'antivirus.exe': ['Task Manager', 'info', 'antivirus.exe is not responding.\nIt has not responded since 1999.'],
        'explorer.exe': ['Task Manager', 'warn', 'explorer.exe is infected and refuses to leave.'],
      }[p] || ['Task Manager', 'info', `${p} ended.`];
      VX.popups.spawn({ title: msg[0], kind: msg[1], text: msg[2], focus: true });
      if (p === 'virus.exe') VX.virus.say('nice try');
    },
    'set-chaos': (el) => {
      VX.settings.set('chaos', el.dataset.value);
      toast(`Chaos level: ${el.dataset.value.toUpperCase()}`, 'Display');
    },
    'toggle-motion': () => {
      const v = VX.settings.get('motion') === 'reduced' ? 'full' : 'reduced';
      VX.settings.set('motion', v);
      toast(v === 'reduced' ? 'Reduced motion ON' : 'Full motion ON', 'Display');
    },
    'toggle-crt': () => VX.settings.set('crt', !VX.settings.get('crt')),
    'reset-settings': () => {
      VX.settings.reset();
      toast('Settings restored to defaults.', 'Control Panel');
    },
    poke: () => VX.virus.poke(),
  };

  function onClick(e) {
    const el = e.target.closest('[data-action]');
    const menu = $('#startMenu');
    if (!menu.hidden && !e.target.closest('#startMenu') && !e.target.closest('#startBtn')) setStartOpen(false);
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    const fn = ACTIONS[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    if (el.closest('#startMenu')) setStartOpen(false);
    if (el.classList.contains('icon')) {
      $$('#icons .icon.sel').forEach((i) => i.classList.remove('sel'));
      el.classList.add('sel');
    }
    VX.sound.play('click');
    fn(el, e);
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    const menu = $('#startMenu');
    if (!menu.hidden) {
      setStartOpen(false);
      $('#startBtn').focus();
      return;
    }
    if (VX.popups.closeTop()) return;
    VX.wm.closeTop();
  }

  /* ---------- ambient chaos ---------- */

  function scheduleTear() {
    const c = VX.settings.chaos();
    const art = VX.virus.art;
    const delay = (rand(5, 13) * 1000) / (c * (0.6 + art * 0.2));
    setTimeout(() => {
      if (!document.hidden && VX.store.state.hasData && art >= 1) VX.fx.tear();
      scheduleTear();
    }, delay);
  }

  function scheduleAmbientPopup() {
    setTimeout(() => {
      const chaos = VX.settings.get('chaos');
      const art = VX.virus.art;
      const ok = !document.hidden && VX.store.state.hasData && chaos !== 'low' && art >= (chaos === 'high' ? 1 : 3) && VX.popups.count < 4;
      if (ok && Math.random() < (chaos === 'high' ? 0.8 : 0.45)) VX.popups.ambient();
      scheduleAmbientPopup();
    }, rand(30, 70) * 1000);
  }

  function clock() {
    const t = $('#clock');
    const d = new Date();
    t.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    t.dateTime = d.toISOString();
  }

  /* ---------- registry & init ---------- */

  function registerWindows() {
    const wm = VX.wm;
    wm.register('explorer', { title: 'My Computer', icon: 'computer', w: 460, render: renderExplorer });
    wm.register('sysmon', { title: 'System Monitor', icon: 'monitor', w: 400, tpl: 'tpl-sysmon' });
    wm.register('lab', { title: 'Mutation Lab', icon: 'lab', w: 640, tpl: 'tpl-lab' });
    wm.register('log', { title: 'virus.log — tail -f', icon: 'log', w: 480, tpl: 'tpl-log' });
    wm.register('readme', { title: 'README.txt — Notepad', icon: 'txt', w: 480, tpl: 'tpl-readme' });
    wm.register('token', { title: '$VIRUS.lnk — Properties', icon: 'coin', w: 440, tpl: 'tpl-token' });
    wm.register('quarantine', { title: 'Quarantine', icon: 'bin', w: 420, render: renderQuarantine });
    wm.register('control', { title: 'Control Panel', icon: 'settings', w: 400, tpl: 'tpl-control' });
    wm.register('photo', { title: 'family_photo.bmp — Paint', icon: 'image', w: 360, render: renderPhoto });
    wm.register('notepad', {
      multi: true, icon: 'txt', w: 420,
      render: (b, p) => {
        b.classList.add('notepad-body');
        b.innerHTML = `<pre class="notepad">${esc(p.text || '')}</pre>`;
      },
    });
  }

  function init(deskEl) {
    desk = deskEl;
    renderIcons();
    registerWindows();
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    $('#startBtn').addEventListener('click', () => setStartOpen($('#startMenu').hidden));
    VX.settings.on((k) => k === 'sound' && syncSoundLabels());
    syncSoundLabels();
    VX.wm.on((type, key) => {
      if (type === 'open') VX.virus.onWindowOpened(key);
    });
    clock();
    setInterval(clock, 10000);
    scheduleTear();
    scheduleAmbientPopup();
  }

  VX.desktop = {
    init, pickIconTarget, infectIcon, cleanIcon, toast, feedAction, setStartOpen,
    infectedCount: () => infected.size,
  };
})();
