/* The VIRUS.EXE site's engine bridge (web/virus/js/engine-bridge.js) against the REAL public API server (same code as production,
 * with the in-memory twin of the read side). The real site files config.js / util.js / store.js run in the same sandbox, so
 * "how many mutation animations fire" is measured on the real store. No chain, no wallet, no secret. */
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { parseProjectConfig } from '../src/config/schema.ts';
import { MemoryApiSource, startTestApi, type TestApi } from './api-helpers.ts';
import { MINT_A, MINT_B, projectInput } from './helpers.ts';

const SITE = new URL('../web/virus/js/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, SITE), 'utf8');

/** The site's 7 forms, with the same thresholds as web/virus/js/config.js (read from the real file below). */
const STAGE_IDS = ['dormant', 'seed', 'bug', 'parasite', 'worm', 'overmind', 'god'];
const THRESHOLDS = ['0', '1000000', '5000000', '15000000', '40000000', '100000000', '250000000'];
const virusInput = (over: Record<string, unknown> = {}) => projectInput({
  id: 'virus', name: 'VIRUS.EXE', ticker: 'VIRUS', cluster: 'mainnet-beta', mint: MINT_B, tokenProgram: 'token-2022',
  levels: STAGE_IDS.map((id, i) => ({ id, name: id, threshold: THRESHOLDS[i] })), ...over,
});
const virusCfg = parseProjectConfig(virusInput());
const T = (tokens: number | string) => BigInt(tokens) * 1_000_000n; // raw units (6 decimals)

interface Harness {
  api: TestApi;
  source: MemoryApiSource;
  snapshots: any[];
  burns: any[];
  errors: Error[];
  sources: any[];
  mutations: { from: number; to: number }[];
  statuses: string[];
  vx: any;
  disconnect: () => void;
  wait: (pred: () => boolean, what: string, ms?: number) => Promise<void>;
  stop: () => Promise<void>;
}

async function boot(o: { project?: Record<string, unknown>; cfg?: unknown[]; url?: string; project_cfg?: Record<string, unknown>; seed?: (s: MemoryApiSource) => void; stages?: { id: string; threshold: number }[] } = {}): Promise<Harness> {
  const source = new MemoryApiSource(['virus']);
  o.seed?.(source);
  const api = await startTestApi(source, { projects: [parseProjectConfig(o.project ?? virusInput())] });
  return attach(api, source, o);
}

async function attach(api: TestApi, source: MemoryApiSource, o: { url?: string; project_cfg?: Record<string, unknown> } = {}): Promise<Harness> {
  const win: any = { VX: {} };
  const sandbox: any = {
    window: win, document: { querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} } },
    localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    console, setTimeout, clearTimeout, setInterval, clearInterval, fetch, TextDecoder, AbortController, Date, URL,
  };
  win.matchMedia = sandbox.matchMedia;
  win.fetch = fetch;
  win.document = sandbox.document;
  sandbox.VX = win.VX;
  const ctx = Object.assign(sandbox, { globalThis: sandbox });
  runInNewContext(`${read('config.js')}\n${read('util.js')}\n${read('store.js')}`, ctx);
  const VX = win.VX;
  VX.project = { projectId: 'virus', mint: null, engineBase: o.url ?? api.url, pollStatusMs: 60_000, timing: { indexing: 40, noProject: 40, fatal: 40, backoffMax: 60, outage: 400, silence: 5000 }, ...(o.project_cfg ?? {}) };
  const h: Harness = {
    api, source, snapshots: [], burns: [], errors: [], sources: [], mutations: [], statuses: [], vx: VX, disconnect: () => {},
    wait: async (pred, what, ms = 4000) => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > ms) assert.fail(`timed out waiting for: ${what}`);
        await new Promise((r) => setTimeout(r, 15));
      }
    },
    stop: async () => { h.disconnect(); await api.close(); },
  };
  VX.store.on('mutation', (m: any) => h.mutations.push(m));
  VX.store.on('status', (s: any) => h.statuses.push(s.status));
  const realSetSource = VX.store.setSource;
  VX.store.setSource = (src: any) => { h.sources.push(src); realSetSource(src); };
  runInNewContext(read('engine-bridge.js'), ctx);
  const adapter = win.VIRUS_ENGINE_ADAPTER;
  assert.ok(adapter, 'the bridge defines the adapter');
  h.disconnect = adapter.connect({
    onSnapshot: (s: any) => { h.snapshots.push(s); VX.store.applySnapshot(s); },
    onBurn: (b: any) => { h.burns.push(b); VX.store.applyBurn(b); },
    onError: (e: Error) => { h.errors.push(e); VX.store.setStatus('error', e); },
  });
  return h;
}

const lastLabel = (h: Harness) => h.sources.at(-1)?.label;

test('[virus-bridge] the real config.js has exactly the 7 forms and thresholds this test assumes (no drift)', () => {
  const win: any = { VX: {} };
  runInNewContext(read('config.js'), { window: win });
  const stages = win.VX.config.stages;
  assert.deepEqual(Array.from(stages as any[], (s) => s.id), STAGE_IDS);
  assert.deepEqual(Array.from(stages as any[], (s) => String(s.threshold)), THRESHOLDS);
});

test('[virus-bridge] initial snapshot: exact finalized total, finalized burn count, level and history; no mutation animation on load (already at level 4)', async () => {
  const h = await boot({ seed: (s) => { s.addBurn('virus', T(30_000_000)); s.addMutation('virus', 'seed', 1); s.addMutation('virus', 'bug', 2); s.addMutation('virus', 'parasite', 3); s.addBurn('virus', T(12_000_000)); s.addMutation('virus', 'worm', 4); s.pending.set('virus', T(900)); } });
  try {
    await h.wait(() => h.snapshots.length === 1, 'snapshot');
    const s = h.snapshots[0];
    assert.equal(s.totalBurned, 42_000_000);
    assert.equal(s.burnCount, 2, 'finalized burns only (the event log), never the confirmed-but-not-finalized amount');
    assert.equal(s.stageIndex, 4, 'Worm Form');
    assert.equal(s.events.length, 2);
    assert.ok(s.events.every((e: any) => e.type === 'burn' && typeof e.tx === 'string' && e.time > 0));
    assert.equal(h.mutations.length, 0, 'loading the page already at level 4 plays no mutation');
    assert.equal(h.vx.store.state.stageIndex, 4);
    assert.equal(lastLabel(h), 'LIVE (UNVERIFIED)', 'indexed but the supply proof is not available here: said explicitly');
    assert.equal(h.vx.engineMeta.mint, MINT_B);
    assert.equal(h.vx.engineMeta.tokenProgram, 'token-2022');
    assert.equal(h.statuses.at(-1), 'ready');
  } finally { await h.stop(); }
});

test('[virus-bridge] a live burn updates the counter only once the engine lists it; one burn crossing several thresholds gives ONE mutation per level, in order', async () => {
  const h = await boot({});
  try {
    await h.wait(() => h.snapshots.length === 1, 'snapshot');
    assert.equal(h.snapshots[0].totalBurned, 0);
    h.source.pending.set('virus', T(50_000_000)); // confirmed on chain but NOT finalized: nothing may move
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(h.burns.length, 0);
    assert.equal(h.vx.store.state.totalBurned, 0);
    h.source.pending.set('virus', 0n);

    h.source.addBurn('virus', T(16_000_000)); // 0 -> 16M: crosses seed (1M), bug (5M) and parasite (15M)
    h.source.addMutation('virus', 'seed', 1); h.source.addMutation('virus', 'bug', 2); h.source.addMutation('virus', 'parasite', 3);
    await h.wait(() => h.burns.length === 1, 'burn');
    assert.equal(h.burns[0].amount, 16_000_000);
    assert.equal(h.burns[0].totalBurned, 16_000_000);
    assert.equal(h.burns[0].stageIndex, 3);
    assert.match(h.burns[0].tx, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    await new Promise((r) => setTimeout(r, 200)); // the engine's own mutation events follow: they must not add animations
    assert.deepEqual(JSON.parse(JSON.stringify(h.mutations)), [{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 }]);
    assert.equal(h.vx.store.state.burnCount, 1);

    h.source.addBurn('virus', 1_500_000n); // 1.5 tokens: exact fractional amount
    await h.wait(() => h.burns.length === 2, 'second burn');
    assert.equal(h.burns[1].amount, 1.5);
    assert.equal(h.burns[1].totalBurned, 16_000_001.5);
    assert.equal(h.mutations.length, 3, 'no mutation for a burn that stays inside the level');
  } finally { await h.stop(); }
});

/** A forwarding proxy that can cut the event streams, refuse them, or repeat every chunk (duplicates). */
async function chaosProxy(target: string) {
  const state = { blackout: false, dupe: false, streamRequests: [] as { after: string | null; lastEventId: string | undefined }[], open: new Set<{ destroy(): void }>() };
  const srv: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', target);
    const isStream = u.pathname.endsWith('/stream');
    if (isStream) state.streamRequests.push({ after: u.searchParams.get('after'), lastEventId: req.headers['last-event-id'] as string | undefined });
    if (state.blackout && isStream) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"code":"down"}}'); return; }
    const up = httpRequest(u, { method: req.method, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.on('data', (d) => { res.write(d); if (state.dupe && isStream) res.write(d); });
      ur.on('end', () => res.end());
      state.open.add(ur);
      ur.on('close', () => { state.open.delete(ur); if (!res.writableEnded) res.destroy(); });
    });
    up.on('error', () => res.destroy());
    up.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    state, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`,
    cut: () => { for (const s of state.open) s.destroy(); },
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

test('[virus-bridge] reconnection after missed events: nothing lost, nothing counted twice, resumed from the last event id', async () => {
  const source = new MemoryApiSource(['virus']);
  const api = await startTestApi(source, { projects: [virusCfg] });
  const proxy = await chaosProxy(api.url);
  const h = await attach(api, source, { url: proxy.url });
  try {
    await h.wait(() => h.snapshots.length === 1, 'snapshot');
    source.addBurn('virus', T(2_000_000)); source.addMutation('virus', 'seed', 1);
    await h.wait(() => h.burns.length === 1, 'first burn');

    proxy.state.blackout = true; // the stream cannot be re-opened for a while
    proxy.cut();
    source.addBurn('virus', T(1_000_000)); // two burns land while the site is blind; the second crosses level 2 (5M)
    source.addBurn('virus', T(3_000_000)); source.addMutation('virus', 'bug', 2);
    await h.wait(() => lastLabel(h) === 'RECONNECTING', 'reconnecting label');
    assert.equal(h.burns.length, 1, 'nothing is invented while disconnected');
    assert.equal(h.vx.store.state.status, 'ready', 'the last known figures stay on screen');

    proxy.state.blackout = false;
    await h.wait(() => h.burns.length === 3, 'both missed burns replayed');
    assert.deepEqual(h.burns.map((b: any) => b.totalBurned), [2_000_000, 3_000_000, 6_000_000]);
    assert.deepEqual(JSON.parse(JSON.stringify(h.mutations)), [{ from: 0, to: 1 }, { from: 1, to: 2 }]);
    assert.equal(h.snapshots.length, 1, 'a plain reconnection does not reset the page');
    assert.equal(h.errors.length, 0);
    const resumes = proxy.state.streamRequests.filter((r) => r.after !== '0').map((r) => r.after);
    assert.ok(resumes.includes('2'), `resumed after the last seen id, saw ${JSON.stringify(resumes)}`);
    assert.equal(lastLabel(h), 'LIVE (UNVERIFIED)');
  } finally { await h.stop(); await proxy.close(); }
});

test('[virus-bridge] duplicated stream chunks are ignored (a burn is applied once); a lasting outage ends in ONE explicit error', async () => {
  const source = new MemoryApiSource(['virus']);
  const api = await startTestApi(source, { projects: [virusCfg] });
  const proxy = await chaosProxy(api.url);
  proxy.state.dupe = true;
  const h = await attach(api, source, { url: proxy.url });
  try {
    await h.wait(() => h.snapshots.length === 1, 'snapshot');
    source.addBurn('virus', T(1_100_000)); source.addMutation('virus', 'seed', 1);
    source.addBurn('virus', T(10));
    await h.wait(() => h.burns.length === 2, 'two burns');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(h.burns.length, 2, 'duplicates do not count twice');
    assert.equal(h.vx.store.state.totalBurned, 1_100_010);
    assert.equal(h.mutations.length, 1);

    proxy.state.dupe = false;
    await proxy.close(); // the engine becomes unreachable altogether
    await h.wait(() => h.errors.length === 1, 'outage reported', 3000);
    assert.equal(h.vx.store.state.status, 'error');
    assert.equal(h.errors.length, 1, 'reported once, not on every retry');
  } finally { await h.stop(); }
});

test('[virus-bridge] reset (the engine log is behind the client): the whole state is re-read, with no mutation animation', async () => {
  const h = await boot({ seed: (s) => { s.addBurn('virus', T(2_000_000)); s.addMutation('virus', 'seed', 1); } });
  try {
    await h.wait(() => h.snapshots.length === 1, 'snapshot');
    // a restored database: the log and totals are older than what the page has seen
    h.source.events.set('virus', []); h.source.finalized.set('virus', 0n); h.source.reached.set('virus', []);
    h.source.addBurn('virus', T(500));
    // force the stream to reconnect: the new connection finds its cursor (1) ahead of the log (1 event, id 1 -> cursor == head, so push it ahead)
    h.source.addBurn('virus', T(500)); h.source.events.get('virus')!.pop(); h.source.finalized.set('virus', T(500));
    // the client cursor is 2 (one mutation + one burn); the log now has only 1 event
    await h.wait(() => h.snapshots.length >= 2, 'resynchronised after reset', 6000);
    assert.equal(h.snapshots.at(-1).totalBurned, 500);
    assert.equal(h.snapshots.at(-1).stageIndex, 0);
    assert.equal(h.mutations.length, 0);
  } finally { await h.stop(); }
});

test('[virus-bridge] engine still indexing: no figures are shown (explicit INDEXING label), then READY once synced', async () => {
  const h = await boot({ seed: (s) => { s.addBurn('virus', T(7)); const st = s.states.get('virus')!; st.backfill = 'running'; } });
  try {
    await h.wait(() => lastLabel(h) === 'INDEXING', 'indexing label');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(h.snapshots.length, 0, 'partial data is never presented as final');
    assert.equal(h.vx.store.state.hasData, false);
    h.source.states.get('virus')!.backfill = 'done_exhausted';
    await h.wait(() => h.snapshots.length === 1, 'snapshot once synced');
    assert.equal(h.snapshots[0].totalBurned, 7);
  } finally { await h.stop(); }
});

test('[virus-bridge] a verified history is labelled LIVE; an unproven one LIVE (UNVERIFIED)', async () => {
  const h = await boot({ seed: (s) => { s.states.get('virus')!.verification = { status: 'verified', at: '2026-01-01T00:00:00.000Z' } as any; } });
  try {
    await h.wait(() => h.snapshots.length === 1, 'snapshot');
    assert.equal(lastLabel(h), 'LIVE');
  } finally { await h.stop(); }
});

test('[virus-bridge] no token yet: the engine does not know the project -> "NO TOKEN YET", no figures, no error popup, no invented data', async () => {
  const source = new MemoryApiSource(['other']);
  const api = await startTestApi(source, { projects: [parseProjectConfig(projectInput({ id: 'other' }))] });
  const h = await attach(api, source);
  try {
    await h.wait(() => lastLabel(h) === 'NO TOKEN YET', 'no token label');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(h.snapshots.length, 0);
    assert.equal(h.errors.length, 0);
    assert.equal(h.vx.store.state.hasData, false);
    assert.equal(h.vx.engineMeta, undefined, 'nothing the burn window could use');
  } finally { await h.stop(); }
});

test('[virus-bridge] levels that do not match the 7 forms, or another mint than configured, are refused (never READY, explicit error)', async () => {
  const wrongLevels = await boot({ project: virusInput({ levels: [{ id: 'l0', name: 'Zero', threshold: '0' }, { id: 'l1', name: 'One', threshold: '1000' }] }) });
  try {
    await wrongLevels.wait(() => wrongLevels.errors.length === 1, 'level mismatch error');
    assert.match(wrongLevels.errors[0]!.message, /do not match/);
    assert.equal(wrongLevels.snapshots.length, 0);
    assert.equal(lastLabel(wrongLevels), 'MISMATCH');
  } finally { await wrongLevels.stop(); }

  const reordered = await boot({ project: virusInput({ levels: STAGE_IDS.map((id, i) => ({ id: i === 1 ? 'bug' : i === 2 ? 'seed' : id, name: id, threshold: THRESHOLDS[i] })) }) });
  try {
    await reordered.wait(() => reordered.errors.length === 1, 'reordered levels refused');
    assert.equal(reordered.snapshots.length, 0);
  } finally { await reordered.stop(); }

  const wrongMint = await boot({ project_cfg: { mint: MINT_A } } as any);
  try {
    await wrongMint.wait(() => wrongMint.errors.length === 1, 'mint mismatch error');
    assert.match(wrongMint.errors[0]!.message, /different mint/);
    assert.equal(wrongMint.snapshots.length, 0);
  } finally { await wrongMint.stop(); }
});

test('[virus-bridge] thresholds come from the engine: a different threshold on the engine side replaces the site value before READY', async () => {
  const levels = STAGE_IDS.map((id, i) => ({ id, name: id, threshold: i === 1 ? '2000000' : THRESHOLDS[i] }));
  const h = await boot({ project: virusInput({ levels }), seed: (s) => s.addBurn('virus', T(1_500_000)) });
  try {
    await h.wait(() => h.snapshots.length === 1, 'snapshot');
    assert.equal(h.vx.config.stages[1].threshold, 2_000_000);
    assert.equal(h.snapshots[0].stageIndex, 0, '1.5M is below the engine\'s 2M threshold');
  } finally { await h.stop(); }
});

test('[virus-bridge] without a configured project the bridge does not even define an adapter (the site stays in its LINKING state)', () => {
  const win: any = { VX: { project: { projectId: null } } };
  runInNewContext(read('engine-bridge.js'), { window: win });
  assert.equal(win.VIRUS_ENGINE_ADAPTER, undefined);
});

test('[virus-bridge] the bridge never mutates anything: the only requests it makes are GETs to the read-only API', () => {
  const src = read('engine-bridge.js');
  assert.doesNotMatch(src, /method:\s*['"](POST|PUT|PATCH|DELETE)/i);
  assert.doesNotMatch(src, /localStorage|sendTransaction|signTransaction|privateKey|secretKey/);
});
