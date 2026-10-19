/* ENGINE BRIDGE — feeds the visuals from the universal burn engine (read-only public API).
 *
 *   GET  /api/v1/projects                      -> project meta (mint, decimals, token program, cluster, levels)
 *   GET  /api/v1/projects/<id>/status          -> total (finalized only), burnCount (finalized only), level, data state
 *   GET  /api/v1/projects/<id>/events?after=N  -> the durable event log (initial history)
 *   GET  /api/v1/projects/<id>/stream?after=N  -> SSE from the same log (burn / mutation / reset / ready)
 *
 * The engine is the source of truth: nothing is invented here. A burn changes the counter only when the engine lists it.
 * Amounts stay exact (BigInt raw units) and are converted to UI numbers only at the edge for display.
 * Levels come from the engine: the site refuses to go READY if they do not match its 7 forms.
 * Mutation animations are produced once by the store (from level changes); engine "mutation" events are never forwarded. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const VX = root.VX;
  const cfg = VX && VX.project;
  if (!cfg || !cfg.projectId) return; // not configured: the site stays in its LINKING state

  // waits (ms); overridable through VX.project.timing (used by the tests, never needed in production)
  const T = Object.assign({ indexing: 5000, noProject: 10000, fatal: 30000, backoffMax: 15000, outage: 60000, silence: 45000 }, cfg.timing || {});
  const base = String(cfg.engineBase || '').replace(/\/$/, '');
  const id = encodeURIComponent(cfg.projectId);
  const api = (path) => `${base}/api/v1/projects${path}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class Fatal extends Error {}
  class Resync extends Error {}
  class NoProject extends Error {
    constructor(message, pending) { super(message); this.pending = pending || null; }
  }
  // public codes of a project the engine refuses to activate (the engine never sends internal details)
  const BLOCKED = {
    mint_authority_active: 'the mint authority is still active, so the supply could grow',
    freeze_authority_active: 'a freeze authority exists, so holder accounts could be frozen',
    unsupported_mint_extension: 'the mint uses a token extension the engine cannot count safely',
    decimals_mismatch: 'the token decimals are not the expected ones',
    token_program_mismatch: 'the token program is not the expected one',
    supply_zero: 'the token supply is 0',
    supply_mismatch: 'the token supply is not the expected one',
    supply_history_mismatch: 'the token supply does not match its own history',
    not_a_token_mint: 'the address is not a token mint',
    native_mint: 'the address is wrapped SOL, not the project token',
    levels_incompatible: 'the mutation thresholds do not fit this token',
    stored_project_mismatch: 'the engine database holds this project with different settings',
  };

  async function getJson(path, signal) {
    const res = await root.fetch(api(path), { headers: { accept: 'application/json' }, signal, cache: 'no-store' });
    if (res.status === 404) throw new NoProject('project not found');
    if (!res.ok) throw new Error(`engine answered ${res.status}`);
    return res.json();
  }

  const rawToUi = (raw, decimals) => {
    const s = raw.toString().padStart(decimals + 1, '0');
    const whole = s.slice(0, s.length - decimals);
    const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
    return frac ? `${whole}.${frac}` : whole;
  };
  const levelIndexFor = (levels, total) => {
    let idx = 0;
    levels.forEach((l, i) => { if (total >= l.thresholdRaw) idx = i; });
    return idx;
  };
  const burnTime = (b) => (b.blockTime ? b.blockTime * 1000 : Date.parse(b.finalizedAt) || Date.now());

  class Session {
    constructor(cb) {
      this.cb = cb;
      this.stopped = false;
      this.abort = new AbortController();
      this.meta = null;
      this.lastId = 0;
      this.total = 0n;
      this.burnCount = 0;
      this.ready = false;
      this.failingSince = 0;
      this.reportedError = false;
      this.lastData = {};
    }

    stop() {
      this.stopped = true;
      this.abort.abort();
    }

    label(label, description, live) {
      if (this.stopped) return;
      VX.store.setSource({ id: 'engine', label, live: !!live, description });
    }

    async run() {
      let delay = Math.min(1000, T.backoffMax);
      while (!this.stopped) {
        try {
          if (!this.ready) await this.sync();
          if (this.ready) await this.follow(() => { this.failingSince = 0; delay = Math.min(1000, T.backoffMax); });
        } catch (e) {
          if (this.stopped) return;
          if (e instanceof Fatal) {
            this.ready = false;
            this.label('MISMATCH', e.message, false);
            if (!this.reportedError) { this.reportedError = true; this.cb.onError(e); }
            await sleep(T.fatal);
            continue;
          }
          if (e instanceof NoProject) {
            this.ready = false;
            const w = e.pending;
            if (w && w.lifecycle === 'blocked') {
              const why = BLOCKED[w.code] || 'the token configuration is not the expected one';
              this.label('TOKEN BLOCKED', `The token exists but the engine refuses to count it: ${why}. Nothing is counted until this is resolved.`, false);
              if (!this.reportedError) { this.reportedError = true; this.cb.onError(new Error(`Token blocked: ${why}.`)); }
              await sleep(T.fatal);
              continue;
            }
            if (w && (w.lifecycle === 'validating' || w.lifecycle === 'activating')) {
              this.label('ACTIVATING', 'The token has appeared on-chain: the engine is checking it and starting the burn tracking.', false);
              await sleep(Math.min(T.indexing, T.noProject));
              continue;
            }
            this.label('NO TOKEN YET', w ? 'The token is not on-chain yet. The engine is watching for it and starts by itself: no need to refresh.' : 'The token has not launched: the engine does not know this project yet.', false);
            await sleep(T.noProject);
            continue;
          }
          if (e instanceof Resync) { this.ready = false; await sleep(Math.min(500, T.backoffMax)); continue; }
          // network / engine trouble: keep what is shown, retry with backoff, report only a lasting outage
          if (!this.failingSince) this.failingSince = Date.now();
          if (this.ready) this.label('RECONNECTING', 'Engine link interrupted: reconnecting. Figures shown may be behind.', true);
          else this.label('LINKING', 'Waiting for the engine.', false);
          if (Date.now() - this.failingSince > T.outage && !this.reportedError) { this.reportedError = true; this.cb.onError(new Error('engine unreachable')); }
          await sleep(delay);
          delay = Math.min(delay * 2, T.backoffMax);
        }
      }
    }

    /** Consistent initial state: meta + status + the event log up to the status' own cursor. */
    async sync() {
      const list = await getJson('', this.abort.signal);
      const meta = (list.data || []).find((p) => p.id === cfg.projectId);
      if (!meta) {
        const waiting = (list.pending || []).find((p) => p.id === cfg.projectId) || null;
        if (waiting && cfg.mint && waiting.mint !== cfg.mint) throw new Fatal('The engine is waiting for a different mint than this site is configured for.');
        throw new NoProject('unknown project', waiting);
      }
      if (cfg.mint && meta.mint !== cfg.mint) throw new Fatal('The engine reports a different mint than this site is configured for.');
      const levels = (meta.levels || []).map((l) => ({ id: l.id, index: l.index, thresholdRaw: BigInt(l.thresholdRaw), threshold: l.threshold }));
      const stages = VX.config.stages;
      if (levels.length !== stages.length || levels.some((l, i) => l.id !== stages[i].id || l.index !== i)) {
        throw new Fatal(`Engine levels (${levels.map((l) => l.id).join(', ')}) do not match the site's ${stages.length} forms.`);
      }
      if (levels[0].thresholdRaw !== 0n) throw new Fatal('The first engine level must start at 0.');
      // The engine is the source of truth for thresholds (the visuals derive infection / progress from them).
      levels.forEach((l, i) => { stages[i].threshold = Number(l.threshold); });
      const decimals = Number(meta.decimals);
      this.meta = { id: meta.id, mint: meta.mint, decimals, tokenProgram: meta.tokenProgram, cluster: meta.cluster, levels };
      VX.engineMeta = this.meta;
      VX.store.emit('meta', this.meta);

      const status = await getJson(`/${id}/status`, this.abort.signal);
      const data = status.data || {};
      if (data.state !== 'synced') {
        this.label('INDEXING', 'The engine is still reading the chain history: totals are partial and not shown yet.', false);
        VX.store.setStatus('loading');
        await sleep(T.indexing);
        throw new Resync('not synced');
      }
      const latest = Number(status.latestEventId);
      const total = BigInt(status.totals.finalizedRaw);
      const index = levelIndexFor(levels, total);
      if (status.progression.level.index !== index) throw new Fatal('The engine progression does not match its own thresholds.');
      const after = Math.max(0, latest - 150);
      const log = await getJson(`/${id}/events?after=${after}&limit=200`, this.abort.signal);
      const events = (log.data || [])
        .filter((e) => e.type === 'burn' && Number(e.id) <= latest)
        .map((e) => ({ type: 'burn', amount: Number(e.burn.amount), time: burnTime(e.burn), tx: e.burn.signature }));
      this.lastId = latest;
      this.total = total;
      this.burnCount = Number(status.totals.burnCount) || 0;
      this.ready = true;
      this.reportedError = false;
      this.lastData = data;
      this.applyLabel(data);
      this.cb.onSnapshot({ totalBurned: Number(rawToUi(total, decimals)), burnCount: this.burnCount, stageIndex: index, events });
    }

    applyLabel(data) {
      const verified = data.history && data.history.complete === true;
      this.label(verified ? 'LIVE' : 'LIVE (UNVERIFIED)', verified ? 'Live burn engine feed. History verified against the on-chain supply.' : 'Live burn engine feed. Totals are indexed but not yet proven complete.', true);
    }

    async follow(connected) {
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      this.abort.signal.addEventListener('abort', onAbort);
      let watchdog;
      const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ctl.abort(), T.silence); };
      const poll = setInterval(() => this.checkStatus().catch(() => {}), cfg.pollStatusMs || 60000);
      try {
        arm();
        const res = await root.fetch(api(`/${id}/stream?after=${this.lastId}`), { headers: { accept: 'text/event-stream' }, signal: ctl.signal, cache: 'no-store' });
        if (res.status === 404) throw new NoProject('project not found');
        if (!res.ok || !res.body) throw new Error(`stream answered ${res.status}`);
        connected();
        this.reportedError = false;
        if (this.ready) this.applyLabel(this.lastData || {});
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return; // reconnect from lastId
          arm();
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            this.frame(frame);
          }
        }
      } catch (e) {
        if (e instanceof Resync || e instanceof NoProject || e instanceof Fatal || this.stopped) throw e;
        throw new Error('stream interrupted');
      } finally {
        clearTimeout(watchdog);
        clearInterval(poll);
        this.abort.signal.removeEventListener('abort', onAbort);
      }
    }

    frame(text) {
      let event = 'message';
      let data = '';
      for (const line of text.split('\n')) {
        if (line.startsWith(':')) continue; // heartbeat
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (event === 'reset') throw new Resync('log reset');
      if (event === 'shutdown') throw new Error('engine shutting down');
      if (event !== 'burn' && event !== 'mutation') return; // ready etc.
      const pe = JSON.parse(data);
      const eid = Number(pe.id);
      if (!Number.isSafeInteger(eid)) throw new Resync('bad event id');
      if (eid <= this.lastId) return; // duplicate (replay after a reconnection)
      if (eid !== this.lastId + 1) throw new Resync('gap in the event log'); // never skip an event: re-read the state
      this.lastId = eid;
      if (event === 'mutation') {
        // the store derives mutations from level changes; here we only check we agree with the engine
        if (pe.mutation.levelIndex > levelIndexFor(this.meta.levels, this.total)) throw new Resync('level ahead of the total');
        return;
      }
      this.total += BigInt(pe.burn.amountRaw);
      this.burnCount += 1;
      const dec = this.meta.decimals;
      this.cb.onBurn({
        amount: Number(pe.burn.amount), totalBurned: Number(rawToUi(this.total, dec)), time: burnTime(pe.burn), tx: pe.burn.signature,
        stageIndex: levelIndexFor(this.meta.levels, this.total),
      });
    }

    /** Periodic status: refresh the label and detect a drift between our running total and the engine's. */
    async checkStatus() {
      const status = await getJson(`/${id}/status`, this.abort.signal);
      const data = status.data || {};
      this.lastData = data;
      if (!this.ready) return;
      if (data.state !== 'synced') this.label('DELAYED', 'The engine is catching up: figures may be behind.', true);
      else this.applyLabel(data);
      if (Number(status.latestEventId) === this.lastId && status.totals.finalizedRaw !== this.total.toString()) {
        this.ready = false; // our total drifted from the engine's: re-read everything
        this.abort.abort();
        this.abort = new AbortController();
      }
    }
  }

  root.VIRUS_ENGINE_ADAPTER = {
    id: 'engine',
    label: 'LINKING',
    live: true,
    description: 'Universal burn engine (read-only API).',
    connect(cb) {
      const s = new Session(cb);
      void s.run();
      return () => s.stop();
    },
  };
})();
