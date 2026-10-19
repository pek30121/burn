/* The deployment tools: /build-info, build-info.mjs, verify-deploy.mjs (HTTP verification of a stack) and git-check.sh (read-only Git
 * diagnosis before synchronising a Replit checkout). No network beyond localhost, no secret, no change to any real repository. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createWebServer } from '../scripts/wallet-test/server.ts';
import { startPreview } from '../scripts/virus-preview/server.ts';
import { parseProjectConfig } from '../src/config/schema.ts';
import { GENESIS_HASHES } from '../src/chain/rpc.ts';
import { MemoryApiSource, startTestApi } from './api-helpers.ts';
import { projectInput } from './helpers.ts';
// @ts-expect-error plain .mjs module without type declarations
import { verifyDeploy } from '../scripts/replit/verify-deploy.mjs';

const GIT_CHECK = resolve('scripts/replit/git-check.sh');
const BUILD_INFO = resolve('scripts/replit/build-info.mjs');

/* ------------------------------------------- build-info ------------------------------------------- */

test('[tools] build-info.mjs writes commit/branch/time, and never fails the build (no git, unwritable target)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bi-'));
  const out = join(dir, 'sub', 'build-info.json');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const r = spawnSync('node', [BUILD_INFO, out], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const info = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(info.commit, sha);
  assert.equal(info.branch, 'main');
  assert.ok(Date.parse(info.builtAt) > 0);
  // not a git checkout: "unknown", exit 0
  const bare = mkdtempSync(join(tmpdir(), 'bi2-'));
  const r2 = spawnSync('node', [BUILD_INFO, join(bare, 'b.json')], { cwd: bare, encoding: 'utf8' });
  assert.equal(r2.status, 0);
  assert.equal(JSON.parse(readFileSync(join(bare, 'b.json'), 'utf8')).commit, 'unknown');
  // unwritable target: still exit 0
  writeFileSync(join(bare, 'blocker'), 'a file, not a directory');
  const r3 = spawnSync('node', [BUILD_INFO, join(bare, 'blocker', 'b.json')], { cwd: bare, encoding: 'utf8' });
  assert.equal(r3.status, 0);
  assert.match(r3.stdout, /not written/);
});

test('[tools] GET /build-info: public, no secret; unknown when not provided; the other routes are unchanged', async () => {
  const s = createWebServer({ upstreamRpc: 'http://127.0.0.1:9', engineUrl: 'http://127.0.0.1:9' });
  const t = createWebServer({ upstreamRpc: 'http://127.0.0.1:9', engineUrl: 'http://127.0.0.1:9', buildInfo: () => ({ commit: 'abc', branch: 'main', network: 'mainnet' }) });
  for (const srv of [s, t]) await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = (srv: typeof s) => `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    assert.deepEqual(await (await fetch(`${url(s)}/build-info`)).json(), { commit: 'unknown' });
    assert.deepEqual(await (await fetch(`${url(t)}/build-info`)).json(), { commit: 'abc', branch: 'main', network: 'mainnet' });
    assert.equal((await fetch(`${url(t)}/build-info`)).headers.get('cache-control'), 'no-store');
    assert.match(await (await fetch(`${url(t)}/`)).text(), /Burn — page wallet/);
    assert.equal((await fetch(`${url(t)}/virus/`)).status, 200);
  } finally { for (const srv of [s, t]) await new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }); }
});

/* ----------------------------------------- verify-deploy ----------------------------------------- */

async function stack(o: { commit?: string; genesis?: string; withFlapy?: boolean; network?: string; pending?: any[] } = {}) {
  const source = new MemoryApiSource(['flapy']);
  source.addBurn('flapy', 1_000_000n);
  const flapy = parseProjectConfig(projectInput({ id: 'flapy', cluster: 'mainnet-beta' }));
  const api = await startTestApi(source, { projects: o.withFlapy === false ? [parseProjectConfig(projectInput({ id: 'other' }))] : [flapy], ...(o.pending ? { pending: () => o.pending! } : {}) });
  const rpc = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: o.genesis ?? GENESIS_HASHES['mainnet-beta'] })); });
  });
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', r));
  const web = createWebServer({ upstreamRpc: `http://127.0.0.1:${(rpc.address() as { port: number }).port}`, engineUrl: api.url, ratePerMinute: 100_000, buildInfo: () => ({ commit: o.commit ?? 'a'.repeat(40), branch: 'main', network: o.network ?? 'mainnet' }) });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(web.address() as { port: number }).port}`, close: async () => { for (const s of [web, rpc]) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }); await api.close(); } };
}
const failed = (r: { results: { name: string; ok: boolean }[] }) => r.results.filter((x) => !x.ok).map((x) => x.name);

test('[tools] verify-deploy: a project waiting for its mint is healthy; a blocked or unknown one fails', async () => {
  const waiting = await stack({ pending: [{ id: 'virus', name: 'V', ticker: 'V', cluster: 'mainnet-beta', mint: 'x', lifecycle: 'awaiting_mint', code: null }] });
  try {
    const r = await verifyDeploy(waiting.url, { network: 'mainnet-beta', projects: [], pending: ['virus'] });
    assert.ok(!failed(r).some((n) => n.includes('pending project')), failed(r).join(' | '));
    assert.ok(r.results.some((x: { name: string; ok: boolean }) => x.name.includes('waiting for its mint') && x.ok));
  } finally { await waiting.close(); }
  const blocked = await stack({ pending: [{ id: 'virus', name: 'V', ticker: 'V', cluster: 'mainnet-beta', mint: 'x', lifecycle: 'blocked', code: 'mint_authority_active' }] });
  try { assert.ok(failed(await verifyDeploy(blocked.url, { network: 'mainnet-beta', projects: [], pending: ['virus'] })).some((n) => n.includes('pending project "virus"'))); } finally { await blocked.close(); }
  const unknown = await stack();
  try { assert.ok(failed(await verifyDeploy(unknown.url, { network: 'mainnet-beta', projects: [], pending: ['virus'] })).some((n) => n.includes('pending project "virus"'))); } finally { await unknown.close(); }
});

test('[tools] verify-deploy: a healthy Mainnet stack passes every check (pages, build, health, API, RPC allowlist, served files)', async () => {
  const s = await stack();
  try {
    const r = await verifyDeploy(s.url, { network: 'mainnet-beta', projects: ['flapy'], commit: 'a'.repeat(12), siteFiles: 'web/virus' });
    assert.deepEqual(failed(r), []);
    assert.equal(r.ok, true);
    assert.ok(r.results.length >= 25);
  } finally { await s.close(); }
});

test('[tools] verify-deploy: each kind of defect is detected (wrong commit, wrong network, missing project, wrong RPC network, demo build, unreachable)', async () => {
  const wrongCommit = await stack({ commit: 'b'.repeat(40) });
  try { assert.deepEqual(failed(await verifyDeploy(wrongCommit.url, { network: 'mainnet-beta', projects: ['flapy'], commit: 'a'.repeat(12) })), [`build-info commit matches ${'a'.repeat(12)}`]); } finally { await wrongCommit.close(); }
  const devnetBuild = await stack({ network: 'devnet' });
  try { assert.ok(failed(await verifyDeploy(devnetBuild.url, { network: 'mainnet-beta', projects: ['flapy'] })).includes('build-info network is mainnet-beta')); } finally { await devnetBuild.close(); }
  const missing = await stack({ withFlapy: false });
  try { assert.ok(failed(await verifyDeploy(missing.url, { network: 'mainnet-beta', projects: ['flapy'] })).includes('project "flapy" is configured')); } finally { await missing.close(); }
  const wrongRpc = await stack({ genesis: GENESIS_HASHES.devnet });
  try { assert.ok(failed(await verifyDeploy(wrongRpc.url, { network: 'mainnet-beta', projects: ['flapy'] })).includes('/rpc relays to mainnet-beta')); } finally { await wrongRpc.close(); }
  const demo = await startPreview({ port: 0, host: '127.0.0.1', root: resolve('web'), env: {} });
  try {
    const f = failed(await verifyDeploy(demo.url, { network: 'mainnet-beta', projects: [] }));
    assert.ok(f.includes('/virus/ contains no preview-only demo code'));
    assert.ok(f.includes('no demo controls in this deployment'), 'a preview deployed by mistake as production is caught');
  } finally { await demo.close(); }
  const down = await verifyDeploy('http://127.0.0.1:9', { network: 'mainnet-beta', projects: ['flapy'] });
  assert.equal(down.ok, false);
  const tampered = await stack();
  try { assert.ok(failed(await verifyDeploy(tampered.url, { siteFiles: resolve('tests') })).some((n) => n.startsWith('served /virus/'))); } finally { await tampered.close(); }
});

/* ------------------------------------------- git-check ------------------------------------------- */

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...args], { encoding: 'utf8' });
function repos() {
  const root = mkdtempSync(join(tmpdir(), 'gc-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const replit = join(root, 'replit');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  writeFileSync(join(work, 'app.txt'), 'one\n');
  writeFileSync(join(work, 'config.txt'), 'prod\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'base'); git(work, 'push', '-q', 'origin', 'HEAD:main');
  execFileSync('git', ['clone', '-q', origin, replit]);
  const check = () => spawnSync('sh', [GIT_CHECK, 'main'], { cwd: replit, encoding: 'utf8' });
  const upstream = (file: string, text: string, msg: string) => { writeFileSync(join(work, file), text); git(work, 'add', '.'); git(work, 'commit', '-qm', msg); git(work, 'push', '-q', 'origin', 'HEAD:main'); };
  const local = (file: string, text: string, msg: string) => { writeFileSync(join(replit, file), text); git(replit, 'add', '.'); git(replit, 'commit', '-qm', msg); };
  return { replit, check, upstream, local };
}
const verdict = (out: string) => /VERDICT: (.*)/.exec(out)?.[1] ?? '';

test('[tools] git-check: up to date, fast-forward, local ahead — and it changes nothing in the repository', () => {
  const r = repos();
  const snapshot = () => [git(r.replit, 'rev-parse', 'HEAD'), git(r.replit, 'for-each-ref', 'refs/heads', '--format=%(refname) %(objectname)'), git(r.replit, 'status', '--porcelain'), readFileSync(join(r.replit, '.git', 'config'), 'utf8').replace(/\n.*(remote-tracking|fetch).*/g, '')].join('|');
  const before = snapshot();
  assert.match(verdict(r.check().stdout), /^UP TO DATE/);
  r.upstream('app.txt', 'two\n', 'site update');
  const ff = r.check();
  assert.match(verdict(ff.stdout), /^FAST-FORWARD/);
  assert.match(ff.stdout, /incoming commits.*: 1/);
  assert.equal(snapshot(), before, 'the diagnosis moved no branch, touched no file, changed no setting');
  assert.equal(git(r.replit, 'rev-parse', 'HEAD'), before.split('|')[0]);
  r.local('replit-note.txt', 'x\n', 'Replit local commit');
  // now diverged AND the incoming side is 1 ahead: covered below; first a pure "local ahead" on a fresh repo
  const r2 = repos();
  r2.local('replit-note.txt', 'x\n', 'Published your App');
  const ahead = r2.check();
  assert.match(verdict(ahead.stdout), /^LOCAL IS AHEAD/);
  assert.match(ahead.stdout, /Published your App/);
});

test('[tools] git-check: diverged without conflict says MERGE (never rebase) and keeps the local commits listed; with a conflict it names the file', () => {
  const r = repos();
  r.local('replit-note.txt', 'x\n', 'Update Replit configuration settings');
  r.upstream('app.txt', 'two\n', 'site update');
  const d = r.check();
  assert.match(verdict(d.stdout), /^DIVERGED \(1 local, 1 incoming\)\. Use a MERGE, never a rebase/);
  assert.match(d.stdout, /predicted conflicts: no/);
  assert.match(d.stdout, /Update Replit configuration settings/);
  assert.match(d.stdout, /backup-before-sync/);
  const c = repos();
  c.local('config.txt', 'replit-edit\n', 'Replit edits config');
  c.upstream('config.txt', 'github-edit\n', 'GitHub edits config');
  const dc = c.check();
  assert.match(verdict(dc.stdout), /^DIVERGED/);
  assert.match(dc.stdout, /predicted conflicts: YES in: .*config\.txt/);
});

test('[tools] git-check: STOP on a rebase or merge in progress, and on uncommitted changes', () => {
  const r = repos();
  mkdirSync(join(r.replit, '.git', 'rebase-merge'));
  const rb = r.check();
  assert.equal(rb.status, 1);
  assert.match(rb.stdout, /STOP: a rebase is in progress/);
  assert.match(rb.stdout, /VERDICT: STOP/);
  const d = repos();
  writeFileSync(join(d.replit, 'app.txt'), 'dirty\n');
  const dirty = d.check();
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /STOP: uncommitted changes/);
  const m = repos();
  writeFileSync(join(m.replit, '.git', 'MERGE_HEAD'), execFileSync('git', ['-C', m.replit, 'rev-parse', 'HEAD'], { encoding: 'utf8' }));
  assert.match(m.check().stdout, /STOP: a merge is in progress/);
  assert.equal(existsSync(join(m.replit, '.git', 'rebase-merge')), false, 'the check does not create or remove anything');
});

test('[tools] git-check: warns when pull.rebase is enabled', () => {
  const r = repos();
  git(r.replit, 'config', 'pull.rebase', 'true');
  assert.match(r.check().stdout, /pull\.rebase\s*: true\s+<- must NOT be 'true'/);
});
