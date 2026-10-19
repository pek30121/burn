/* Post-deploy verification of a running stack (production or preview), over HTTP only. Plain Node, no dependency.
 *
 *   node scripts/replit/verify-deploy.mjs https://<app>.replit.app --network mainnet-beta --project flapy [--commit <sha>] [--site-files web/virus]
 *   npm run verify:deploy -- https://<app>.replit.app --network mainnet-beta --project flapy --commit $(git rev-parse HEAD)
 *
 * It sends no transaction and changes nothing: GET requests, one allow-listed read-only RPC call (getGenesisHash, ~1 credit), and two
 * deliberate POSTs that MUST be refused (read-only API, RPC allowlist). Exit code 0 only if every check passes.
 * `--commit` compares GET /build-info with the expected commit (prefix match); because a build container may have no git, `--site-files`
 * additionally compares the SHA-256 of the key site files served by /virus/ with the local copy (run it from a checkout of the expected commit). */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GENESIS = { 'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' };
const SITE_FILES = ['index.html', 'js/config.js', 'js/project.js', 'js/engine-bridge.js', 'js/burn-ui.js'];

export async function verifyDeploy(base, o = {}) {
  const origin = base.replace(/\/+$/, '');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail) }); };
  const get = async (path, init) => {
    try { const r = await fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(20_000), ...init }); return { status: r.status, text: await r.text(), headers: r.headers }; }
    catch (e) { return { status: 0, text: '', headers: new Headers(), error: e instanceof Error ? e.message : 'network error' }; }
  };
  const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };
  const rpc = (method, params = []) => get('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });

  // 1. which build is running
  const bi = await get('/build-info');
  const info = json(bi);
  check('GET /build-info answers', bi.status === 200 && info, `status ${bi.status}`);
  if (info) {
    check(`build-info network is ${o.network ?? '(any)'}`, !o.network || (o.network === 'mainnet-beta' ? info.network === 'mainnet' : info.network === o.network), `reports "${info.network}"`);
    if (o.commit) check(`build-info commit matches ${o.commit.slice(0, 12)}`, typeof info.commit === 'string' && info.commit !== 'unknown' && (info.commit.startsWith(o.commit) || o.commit.startsWith(info.commit)), `running ${String(info.commit).slice(0, 12)} (${info.branch})`);
  }

  // 2. pages and assets, same origin
  const root = await get('/');
  check('GET / (existing page) is served', root.status === 200 && /<html/i.test(root.text), `status ${root.status}`);
  const virus = await get('/virus/');
  check('GET /virus/ is served', virus.status === 200 && /VIRUS\.EXE/.test(virus.text), `status ${virus.status}`);
  check('/virus/ contains no preview-only demo code', !/virus-demo|__DEMO__/.test(virus.text));
  check('/virus redirects to /virus/', (await get('/virus')).status === 302);
  for (const f of ['js/engine-bridge.js', 'js/burn-ui.js', 'css/burn.css']) check(`GET /virus/${f}`, (await get(`/virus/${f}`)).status === 200);
  check('GET /dist/wallet/index.js (wallet module)', (await get('/dist/wallet/index.js')).status === 200);
  check('no demo controls in this deployment', (await get('/demo/api/state')).status === 404 && (await get('/virus-demo/demo.js')).status === 404);

  // 3. engine, database, API (through the public origin)
  const live = await get('/health/live');
  check('GET /health/live', live.status === 200, `status ${live.status}`);
  const ready = await get('/health/ready');
  check('GET /health/ready (engine running AND PostgreSQL answering)', ready.status === 200 && /ready/i.test(ready.text), `status ${ready.status}`);
  const list = json(await get('/api/v1/projects'));
  const projects = list?.data ?? [];
  check('GET /api/v1/projects answers', Array.isArray(list?.data));
  for (const id of o.projects ?? []) {
    const p = projects.find((x) => x.id === id);
    check(`project "${id}" is configured`, !!p, p ? `${p.cluster}, ${p.tokenProgram}` : 'missing');
    if (p && o.network) check(`project "${id}" is on ${o.network}`, p.cluster === o.network, p.cluster);
    const st = json(await get(`/api/v1/projects/${encodeURIComponent(id)}/status`));
    check(`project "${id}" is synced`, st?.data?.state === 'synced', `state ${st?.data?.state}, level ${st?.progression?.level?.id}, history ${st?.data?.history?.verification}, burns ${st?.totals?.burnCount}`);
    check(`project "${id}" status carries finalized burnCount`, typeof st?.totals?.burnCount === 'number');
  }
  if (!(o.projects ?? []).includes('virus')) {
    const v = await get('/api/v1/projects/virus/status');
    check('no "virus" project exists yet (token not launched) or it is synced', v.status === 404 || json(v)?.data?.state === 'synced', `status ${v.status}`);
  }
  check('the API is read-only (POST is refused)', (await get(`/api/v1/projects/${(o.projects ?? ['x'])[0]}/status`, { method: 'POST' })).status === 405);

  // 4. RPC proxy: right network, allowlist intact, key never echoed
  const g = json(await rpc('getGenesisHash'));
  check(`/rpc relays to ${o.network ?? 'a node'}`, !o.network || g?.result === GENESIS[o.network], g?.result ? `genesis ${String(g.result).slice(0, 8)}…` : 'no answer');
  const denied = await rpc('getProgramAccounts');
  check('/rpc allowlist: getProgramAccounts is refused', denied.status === 403);
  check('/rpc never echoes an API key', !/api-key=|helius/i.test(denied.text + JSON.stringify(g ?? {})));

  // 5. the served site is the expected one
  if (o.siteFiles) {
    for (const f of SITE_FILES) {
      let local = null;
      try { local = createHash('sha256').update(readFileSync(join(o.siteFiles, f))).digest('hex'); } catch { /* missing */ }
      const served = await get(`/virus/${f}`);
      const remote = createHash('sha256').update(Buffer.from(served.text, 'utf8')).digest('hex');
      check(`served /virus/${f} equals the local file`, local !== null && local === remote, local === null ? 'local file missing' : 'differs');
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
  const base = args.find((a) => /^https?:\/\//.test(a));
  if (!base) { console.error('usage: verify-deploy.mjs <https://app> [--network mainnet-beta|devnet] [--project id ...] [--commit sha] [--site-files web/virus]'); process.exit(2); }
  const { ok, results } = await verifyDeploy(base, { network: opt('--network'), projects: all('--project'), commit: opt('--commit'), siteFiles: opt('--site-files') });
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? `  — ${r.detail}` : r.detail ? `  (${r.detail})` : ''}`);
  console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED — do not consider this deployment verified');
  process.exit(ok ? 0 : 1);
}
