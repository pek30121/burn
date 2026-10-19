/* Tiny WebAudio synth for retro SFX. Off by default; no audio files. */
(function () {
  'use strict';
  const VX = window.VX;
  let ac = null;
  let master = null;
  let noiseBuf = null;
  const last = {};

  function ensure() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      master = ac.createGain();
      master.gain.value = 0.16;
      master.connect(ac.destination);
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }

  function tone(f, dur, o = {}) {
    const t = ac.currentTime + (o.at || 0);
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(f, t);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(o.slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.vol || 0.8, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  function noise(dur, o = {}) {
    const t = ac.currentTime + (o.at || 0);
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = o.filter || 1500;
    const g = ac.createGain();
    g.gain.setValueAtTime(o.vol || 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.03);
  }

  const SFX = {
    click: () => tone(1500, 0.025, { vol: 0.25 }),
    open: () => { tone(520, 0.05); tone(780, 0.07, { at: 0.05 }); },
    close: () => { tone(700, 0.04); tone(420, 0.06, { at: 0.04 }); },
    error: () => { tone(880, 0.12, { type: 'triangle' }); tone(587, 0.22, { type: 'triangle', at: 0.11 }); },
    popup: () => tone(1046, 0.05, { vol: 0.4, type: 'triangle' }),
    burn: () => { noise(0.4, { vol: 0.7, filter: 900 }); tone(110, 0.35, { type: 'sine', slide: 40, vol: 0.9 }); },
    chomp: () => [0, 0.13, 0.26].forEach((a) => { tone(200, 0.06, { at: a, slide: 90 }); noise(0.05, { at: a, vol: 0.35, filter: 2200 }); }),
    mutate: () => {
      [262, 330, 392, 523, 659, 784, 1046, 1318, 1568].forEach((f, i) => tone(f, 0.13, { type: 'sawtooth', at: i * 0.09, vol: 0.45 }));
      noise(1.1, { at: 0.75, vol: 0.35, filter: 3200 });
      tone(65, 1.2, { type: 'sine', at: 0.8, vol: 0.9, slide: 40 });
    },
    giggle: () => [0, 0.08, 0.16].forEach((a, i) => tone(900 + i * 140, 0.06, { at: a, slide: 1400 + i * 120, vol: 0.4 })),
    boot: () => [392, 523, 659, 784].forEach((f, i) => tone(f, 0.7 - i * 0.12, { type: 'triangle', at: i * 0.11, vol: 0.45 })),
    glitch: () => noise(0.07, { vol: 0.25, filter: 6000 }),
    phase: () => [523, 659, 523, 784].forEach((f, i) => tone(f, 0.1, { at: i * 0.1, vol: 0.4 })),
    jingle: () => {
      const mel = [[659, 0.15], [784, 0.15], [659, 0.15], [494, 0.3], [523, 0.15], [494, 0.15], [440, 0.3], [392, 0.15], [440, 0.15], [494, 0.45]];
      let at = 0;
      mel.forEach(([f, d]) => { tone(f, d * 0.9, { at, vol: 0.4 }); at += d; });
      [[165, 0.6], [147, 0.6], [131, 0.6], [123, 0.6]].forEach(([f, d], i) => tone(f, d * 0.9, { type: 'triangle', at: i * 0.6, vol: 0.6 }));
    },
  };

  function on() {
    return !!VX.settings.get('sound');
  }

  function play(name) {
    if (!on() || !SFX[name]) return;
    if (!ensure()) return;
    const now = performance.now();
    if (last[name] && now - last[name] < 45) return;
    last[name] = now;
    try {
      SFX[name]();
    } catch (e) {
      /* audio is best-effort */
    }
  }

  function setEnabled(v) {
    VX.settings.set('sound', !!v);
    if (v) {
      ensure();
      play('open');
    }
  }

  // Browsers need a gesture before audio can start.
  document.addEventListener('pointerdown', () => on() && ensure(), { passive: true });

  VX.sound = { play, setEnabled, toggle: () => setEnabled(!on()), isOn: on };
})();
