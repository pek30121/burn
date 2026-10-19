/* Visual state store. It does NOT compute anything about the token: it only
 * holds what the data source reports (total burned, burns, optional stage)
 * and derives presentation values (which visual form, how full the meters are). */
(function () {
  'use strict';
  const VX = window.VX;
  const { stages, token } = VX.config;
  const { fmt, fmtShort, clamp } = VX.util;
  const MAX_EVENTS = 150;
  const PHASES = [25, 50, 75, 100];

  let seq = 0;
  const listeners = {};
  const state = {
    status: 'loading', // loading | ready | error
    error: null,
    hasData: false,
    source: { id: 'none', label: '—', live: false },
    totalBurned: 0,
    burnCount: 0,
    stageIndex: 0,
    events: [],
    mood: 'dormant',
  };

  function on(type, fn) {
    (listeners[type] = listeners[type] || new Set()).add(fn);
    return () => listeners[type].delete(fn);
  }
  function emit(type, payload) {
    (listeners[type] || []).forEach((fn) => {
      try {
        fn(payload, state);
      } catch (e) {
        console.error('[VX]', type, e);
      }
    });
  }

  function stageFor(total) {
    let idx = 0;
    stages.forEach((s, k) => {
      if (total >= s.threshold) idx = k;
    });
    return idx;
  }
  function stageProgress(total, i) {
    const cur = stages[i];
    const next = stages[i + 1];
    if (!next) return 1;
    return clamp((total - cur.threshold) / (next.threshold - cur.threshold), 0, 1);
  }
  function infectionAt(total, i) {
    const n = stages.length - 1;
    if (i >= n) return 100;
    return ((i + stageProgress(total, i)) / n) * 100;
  }

  function view() {
    const i = state.stageIndex;
    const next = stages[i + 1] || null;
    return {
      ...state,
      stage: stages[i],
      next,
      toNext: next ? Math.max(0, next.threshold - state.totalBurned) : 0,
      stageProgress: stageProgress(state.totalBurned, i) * 100,
      infection: infectionAt(state.totalBurned, i),
    };
  }

  function burnMsg(amount) {
    return `${fmt(amount)} ${token.ticker} burned — fed to the virus`;
  }

  function normalize(e) {
    const ev = Object.assign({}, e);
    ev.id = ++seq;
    ev.time = ev.time || Date.now();
    ev.type = ev.type || 'burn';
    if (!ev.msg) {
      if (ev.type === 'burn') ev.msg = burnMsg(ev.amount || 0);
      else if (ev.type === 'mutation') ev.msg = `Mutation unlocked: ${(stages[ev.stage] || {}).name || 'unknown form'}`;
      else ev.msg = String(ev.type);
    }
    return ev;
  }

  function addEvent(e) {
    const ev = normalize(e);
    state.events.unshift(ev);
    if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
    emit('event', ev);
    return ev;
  }

  function resolveStage(engineStage, total) {
    if (Number.isInteger(engineStage)) return clamp(engineStage, 0, stages.length - 1);
    return stageFor(total);
  }

  /* ---- Ingest API (called by the data source) ---- */

  function setSource(src) {
    state.source = src;
    emit('change', state);
  }

  function setStatus(status, error) {
    const prev = state.status;
    state.status = status;
    state.error = error ? String(error.message || error) : null;
    if (status === 'error' && prev !== 'error') {
      addEvent({ type: 'error', msg: `Engine link failed: ${state.error || 'unknown error'}` });
    }
    emit('status', state);
    emit('change', state);
  }

  function applySnapshot(snap) {
    snap = snap || {};
    state.totalBurned = Number(snap.totalBurned) || 0;
    state.burnCount = Number(snap.burnCount) || 0;
    state.stageIndex = resolveStage(snap.stageIndex, state.totalBurned);
    state.events = (snap.events || [])
      .slice()
      .sort((a, b) => (b.time || 0) - (a.time || 0))
      .slice(0, MAX_EVENTS)
      .map(normalize);
    state.hasData = true;
    state.status = 'ready';
    state.error = null;
    addEvent({ type: 'system', msg: `Engine feed connected [${state.source.label}]` });
    emit('snapshot', view());
    emit('status', state);
    emit('change', state);
  }

  function applyBurn(b) {
    if (!b) return;
    const amount = Number(b.amount) || 0;
    const prevStage = state.stageIndex;
    const prevInf = infectionAt(state.totalBurned, prevStage);
    state.totalBurned = b.totalBurned != null ? Number(b.totalBurned) : state.totalBurned + amount;
    state.burnCount += 1;
    state.stageIndex = resolveStage(b.stageIndex, state.totalBurned);
    if (state.status !== 'ready') {
      state.status = 'ready';
      state.error = null;
      emit('status', state);
    }
    state.hasData = true;

    addEvent({ type: 'burn', amount, time: b.time, tx: b.tx });
    emit('burn', { amount, tx: b.tx, total: state.totalBurned });

    for (let s = prevStage + 1; s <= state.stageIndex; s++) {
      addEvent({ type: 'mutation', stage: s });
      emit('mutation', { from: s - 1, to: s });
    }

    const inf = infectionAt(state.totalBurned, state.stageIndex);
    PHASES.forEach((p, k) => {
      if (prevInf < p && inf >= p) {
        addEvent({ type: 'phase', msg: `Infection phase ${k + 1} reached — ${p}% of the system compromised` });
        emit('phase', { phase: k + 1, pct: p });
      }
    });
    emit('change', state);
  }

  // Visual-only events generated by the frontend itself (corrupted icons, popup storms...).
  function addLocalEvent(type, msg) {
    addEvent({ type, msg, local: true });
    emit('change', state);
  }

  function setMood(m) {
    if (state.mood === m) return;
    state.mood = m;
    emit('mood', m);
  }

  VX.store = {
    state, on, emit, view, stageFor, infectionAt,
    setSource, setStatus, applySnapshot, applyBurn, addLocalEvent, setMood,
    fmtShort,
  };
})();
