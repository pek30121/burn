/* `npm run devnet:observe` — NO FUNDS NEEDED. Runs the whole engine (real RPC client, PostgreSQL, indexers,
 * REST, SSE) against the real Devnet on burns made by OTHER parties (recorded in tests/fixtures: one direct
 * burn, one burn by CPI). These are not our own transactions; they validate the read side on real data:
 * parsing, finalized-only indexing, persistence, REST/SSE, restart, and an RPC outage (simulated by a local
 * pass-through proxy, with real data behind it). */
import { readFileSync } from 'node:fs';
import { parseBurns } from '../../src/chain/burn-parser.ts';
import { Report } from './check.ts';
import { boot, newRun, projectJson } from './harness.ts';
import { getJson, openSse, waitUntil } from './http.ts';
import { startCuttableProxy } from './proxy.ts';
import { assertDevnet, rpc } from './rpc.ts';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../../tests/fixtures/${n}`, import.meta.url), 'utf8'));
const targets = [
  { id: 'ext-direct', f: fx('devnet-direct-burn.json') },
  { id: 'ext-cpi', f: fx('devnet-cpi-burn-1.json') },
];

const r = new Report();
await assertDevnet();
const run = await newRun();
const proxy = await startCuttableProxy();
let booted: Awaited<ReturnType<typeof boot>> | null = null;
try {
  const projects = [];
  const expected: Record<string, { signature: string; amountRaw: bigint; path: string }> = {};
  for (const t of targets) {
    const supply = (await rpc<{ value: { decimals: number } }>('getTokenSupply', [t.f.mint, { commitment: 'finalized' }])).value;
    const parsed = parseBurns(t.f.response, { mint: t.f.mint, expectedSignature: t.f.signature });
    if (parsed.status !== 'ok') throw new Error('fixture does not parse');
    const b = parsed.burns.find((x) => x.instructionPath === t.f.path)!;
    expected[t.id] = { signature: t.f.signature, amountRaw: b.amountRaw, path: t.f.path };
    projects.push(projectJson({ id: t.id, mint: t.f.mint, decimals: supply.decimals, startSlot: t.f.response.slot - 300, levels: [{ id: 'l0', name: 'Zero', threshold: '0' }, { id: 'l1', name: 'One', threshold: '1' }, { id: 'l2', name: 'Two', threshold: '1000000' }] }));
    r.fact(`${t.id}.burn`, `${t.f.signature} path ${t.f.path} amountRaw ${b.amountRaw} (${t.f.path.includes('.') ? 'CPI' : 'direct'})`);
  }

  /* ---- A. RPC outage before anything is indexed ---- */
  proxy.cut(true);
  booted = await boot(run, { projects, rpcUrl: proxy.url });
  await waitUntil(async () => (await getJson(`${booted!.url}/api/v1/projects/ext-direct/status`)).json?.data?.reasons?.includes('sync_failing'), 'outage detected');
  const during = (await getJson(`${booted.url}/api/v1/projects/ext-direct/status`)).json;
  r.check('RPC outage: project reported incomplete with reason sync_failing (no crash)', during.data.state === 'incomplete' && during.data.reasons.includes('sync_failing'));
  r.check('RPC outage: API still serves and engine stays ready', (await getJson(`${booted.url}/health/ready`)).status === 200);
  r.check('RPC outage: backoff, not a tight loop', proxy.stats().refused < 40, `refused requests: ${proxy.stats().refused}`);

  /* ---- B. recovery and indexing of the real burns ---- */
  proxy.cut(false);
  const synced = async (id: string) => { const s = (await getJson(`${booted!.url}/api/v1/projects/${id}/status`)).json; return s?.data?.state === 'synced' && s.data.history.backfill !== 'pending'; };
  await waitUntil(async () => (await synced('ext-direct')) && (await synced('ext-cpi')), 'both projects synced after the outage', 180_000);
  r.check('RPC recovery: projects return to synced on their own', true);

  const eventsOf = async (id: string) => (await getJson(`${booted!.url}/api/v1/projects/${id}/events?limit=500`)).json.data as any[];
  const snapshot: Record<string, string[]> = {};
  for (const t of targets) {
    const ev = await eventsOf(t.id);
    const e = ev.find((x) => x.type === 'burn' && x.burn.signature === expected[t.id]!.signature);
    r.check(`${t.id}: real burn detected with the exact raw amount`, !!e && e.burn.amountRaw === expected[t.id]!.amountRaw.toString() && e.burn.instructionPath === expected[t.id]!.path, e ? `event ${e.id}, amountRaw ${e.burn.amountRaw}, path ${e.burn.instructionPath}` : 'missing');
    r.check(`${t.id}: every burn event is unique (no double counting)`, new Set(ev.filter((x) => x.type === 'burn').map((x) => `${x.burn.signature}#${x.burn.instructionPath}`)).size === ev.filter((x) => x.type === 'burn').length);
    const st = (await getJson(`${booted.url}/api/v1/projects/${t.id}/status`)).json;
    const sum = ev.filter((x) => x.type === 'burn').reduce((a, x) => a + BigInt(x.burn.amountRaw), 0n);
    r.check(`${t.id}: REST total equals the sum of the burn events`, st.totals.finalizedRaw === sum.toString(), `${st.totals.finalizedRaw} raw in the window`);
    r.check(`${t.id}: completeness is honestly NOT claimed (no supply proof configured)`, st.data.history.complete === false && st.data.history.verification === 'unverified');
    snapshot[t.id] = ev.map((x) => x.id);
  }
  r.check('isolation: each project only lists its own mint events', (await eventsOf('ext-direct')).every((e) => e.type !== 'burn' || e.burn.signature !== expected['ext-cpi']!.signature));

  /* ---- C. SSE equals REST; reconnection with Last-Event-ID ---- */
  const url = `${booted.url}/api/v1/projects/ext-direct/stream`;
  const s1 = await openSse(url, 0);
  const evs = await eventsOf('ext-direct');
  await waitUntil(() => s1.frames.filter((f) => f.id).length === evs.length, 'SSE replay');
  r.check('SSE replay from Last-Event-ID 0 equals GET /events', JSON.stringify(s1.frames.filter((f) => f.id).map((f) => f.data)) === JSON.stringify(evs));
  s1.close();
  const mid = Number(evs[Math.max(0, Math.floor(evs.length / 2) - 1)]!.id);
  const s2 = await openSse(url, mid);
  await waitUntil(() => s2.frames.filter((f) => f.id).length === evs.filter((e) => Number(e.id) > mid).length, 'SSE resume');
  r.check('SSE reconnection with Last-Event-ID resumes exactly after that id', s2.frames.filter((f) => f.id).map((f) => Number(f.id)).join() === evs.filter((e) => Number(e.id) > mid).map((e) => Number(e.id)).join());
  s2.close();

  /* ---- D. restart: resume without loss or double counting ---- */
  const before = Object.fromEntries(await Promise.all(targets.map(async (t) => [t.id, (await getJson(`${booted!.url}/api/v1/projects/${t.id}/status`)).json.totals.finalizedRaw])));
  const reqsBefore = proxy.stats().forwarded;
  const stopped = await booted.stop();
  r.check('graceful stop is clean', stopped.clean);
  booted = await boot(run, { projects, rpcUrl: proxy.url });
  r.check('restart: cursors reloaded from PostgreSQL ("resumed" logged for both projects)', booted.lines.filter((l) => l.event === 'resumed').length === 2);
  await waitUntil(async () => (await synced('ext-direct')) && (await synced('ext-cpi')), 'synced after restart', 120_000);
  await new Promise((res) => setTimeout(res, 6000)); // a few polling cycles
  for (const t of targets) {
    const st = (await getJson(`${booted.url}/api/v1/projects/${t.id}/status`)).json;
    r.check(`${t.id}: restart changed nothing (same total, same event ids)`, st.totals.finalizedRaw === before[t.id] && JSON.stringify((await eventsOf(t.id)).map((x) => x.id)) === JSON.stringify(snapshot[t.id]));
  }
  r.fact('rpc requests after restart', `${proxy.stats().forwarded - reqsBefore} (no re-reading of already indexed transactions: cheap polling only)`);
  const incidents = booted.lines.filter((l) => l.event === 'incident');
  r.check('no incident recorded on real data', incidents.length === 0, incidents.map((i) => i.code).join());
  r.fact('estimated RPC credits (local estimate, NOT billing)', booted.engine.meter.snapshot().total);
} catch (e) {
  r.check('script completed without error', false, (e as Error).message);
} finally {
  await booted?.stop().catch(() => {});
  await proxy.close();
  await run.dispose();
  r.finish(`observe-${Date.now()}.json`);
}
