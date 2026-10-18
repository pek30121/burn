import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { replitSpecs, supervise } from '../scripts/replit/supervisor.ts';

class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 1e6);
  killed: string[] = [];
  kill(sig: string) { this.killed.push(sig); queueMicrotask(() => this.emit('exit', null, sig)); return true; }
}

function rig() {
  const children: { name: string; child: FakeChild; env: Record<string, string | undefined> }[] = [];
  const logs: { event: string; f: any }[] = [];
  const sleeps: number[] = [];
  let t = 0;
  const spawn = (cmd: string, _args: readonly string[], env: Record<string, string | undefined>) => {
    const child = new FakeChild();
    children.push({ name: env.NAME ?? cmd, child, env });
    return child as unknown as ChildProcess;
  };
  return { children, logs, sleeps, advance: (ms: number) => (t += ms), opts: { spawn, log: (event: string, f: any) => logs.push({ event, f }), sleep: async (ms: number) => { sleeps.push(ms); await new Promise((r) => setImmediate(r)); }, now: () => t } };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('[replit] a crashing child restarts with exponential backoff; the other one is never touched', async () => {
  const r = rig();
  const sup = supervise({ ...r.opts, specs: [{ name: 'engine', command: 'e', args: [], env: { NAME: 'engine' } }, { name: 'web', command: 'w', args: [], env: { NAME: 'web' } }] });
  await tick();
  assert.deepEqual(r.children.map((c) => c.name), ['engine', 'web']);
  for (let i = 0; i < 4; i++) { r.children.filter((c) => c.name === 'engine').at(-1)!.child.emit('exit', 1, null); await tick(); }
  assert.deepEqual(r.sleeps, [1000, 2000, 4000, 8000]);
  assert.equal(r.children.filter((c) => c.name === 'web').length, 1, 'web never restarted');
  assert.equal(sup.restarts.engine, 4);
  assert.equal(sup.restarts.web, 0);
  assert.ok(r.logs.some((l) => l.event === 'child_exited' && l.f.name === 'engine' && l.f.code === 1));
  await sup.stop();
});

test('[replit] the backoff is capped, and resets after a child stayed up long enough', async () => {
  const r = rig();
  const sup = supervise({ ...r.opts, maxDelayMs: 5000, stableAfterMs: 60_000, specs: [{ name: 'engine', command: 'e', args: [], env: { NAME: 'engine' } }] });
  await tick();
  for (let i = 0; i < 5; i++) { r.children.at(-1)!.child.emit('exit', 1, null); await tick(); }
  assert.deepEqual(r.sleeps, [1000, 2000, 4000, 5000, 5000]);
  r.advance(120_000); // the new child lives for two minutes, then dies
  r.children.at(-1)!.child.emit('exit', 1, null);
  await tick();
  assert.equal(r.sleeps.at(-1), 1000, 'back to the base delay');
  await sup.stop();
});

test('[replit] spawn errors are logged and retried, never thrown out of the supervisor', async () => {
  const logs: any[] = [];
  let n = 0;
  const sup = supervise({
    specs: [{ name: 'engine', command: 'e', args: [], env: {} }], log: (e, f) => logs.push({ e, f }), sleep: async () => { await new Promise((r) => setImmediate(r)); },
    spawn: () => { if (++n < 3) throw new Error('ENOENT'); return new FakeChild() as unknown as ChildProcess; },
  });
  await tick();
  assert.equal(n, 3);
  assert.equal(logs.filter((l) => l.e === 'child_exited').length, 2);
  await sup.stop();
});

test('[replit] stop(): both children get SIGTERM, the loops end, nothing is restarted', async () => {
  const r = rig();
  const sup = supervise({ ...r.opts, specs: [{ name: 'engine', command: 'e', args: [], env: { NAME: 'engine' } }, { name: 'web', command: 'w', args: [], env: { NAME: 'web' } }] });
  await tick();
  await sup.stop('SIGTERM');
  assert.deepEqual(r.children.map((c) => c.child.killed), [['SIGTERM'], ['SIGTERM']]);
  assert.equal(r.children.length, 2, 'no restart after stop');
  await sup.done;
  assert.equal(r.logs.at(-1)!.event, 'stopped');
});

test('[replit] a child that ignores SIGTERM is killed after the grace period', async () => {
  const r = rig();
  const stubborn = new FakeChild();
  stubborn.kill = function (sig: string) { (this as FakeChild).killed.push(sig); if (sig === 'SIGKILL') queueMicrotask(() => this.emit('exit', null, sig)); return true; };
  const sup = supervise({ ...r.opts, killAfterMs: 30, spawn: () => stubborn as unknown as ChildProcess, specs: [{ name: 'engine', command: 'e', args: [], env: {} }] });
  await tick();
  await sup.stop();
  assert.deepEqual(stubborn.killed, ['SIGTERM', 'SIGKILL']);
});

test('[replit] environment: engine bound to 127.0.0.1 behind the web proxy, Devnet only, no secret in the arguments', () => {
  const env = { DATABASE_URL: 'postgres://u:Sup3rSecretPw@h/db', HELIUS_API_KEY: 'KEY-123456789', PORT: '8080', SOLANA_CLUSTER: 'devnet' };
  const { specs, warnings } = replitSpecs(env, '/app');
  assert.deepEqual(specs.map((s) => s.name), ['engine', 'web']);
  const [engine, web] = specs as [typeof specs[0], typeof specs[0]];
  assert.equal(engine.env.HTTP_HOST, '127.0.0.1');
  assert.equal(engine.env.HTTP_PORT, '8787');
  assert.equal(engine.env.TRUST_PROXY, 'true');
  assert.equal(engine.env.SOLANA_CLUSTER, 'devnet');
  assert.equal(engine.env.PROJECTS_CONFIG, 'deploy/projects.devnet.json');
  assert.equal(engine.env.SOLANA_RPC_URL, undefined, 'a Helius key is used on its own (the engine refuses both)');
  assert.equal(engine.env.PORT, undefined, 'the engine must not grab the public PORT');
  assert.equal(web.env.WEB_HOST, '0.0.0.0');
  assert.equal(web.env.WEB_PORT, '8080');
  assert.equal(web.env.ENGINE_URL, 'http://127.0.0.1:8787');
  assert.equal(web.env.WEB_TRUST_PROXY, '1');
  assert.deepEqual(warnings, []);
  for (const s of specs) assert.doesNotMatch(JSON.stringify(s.args), /Sup3rSecretPw|KEY-123/);
});

test('[replit] without a Helius key the engine uses the public Devnet RPC (with a warning); without DATABASE_URL only the page starts; Mainnet is refused', () => {
  const a = replitSpecs({ DATABASE_URL: 'postgres://u:p@h/db' }, '/app');
  assert.equal(a.specs[0]!.env.SOLANA_RPC_URL, 'https://api.devnet.solana.com');
  assert.match(a.warnings.join(), /public Devnet RPC/);
  const b = replitSpecs({ HELIUS_API_KEY: 'K12345678' }, '/app');
  assert.deepEqual(b.specs.map((s) => s.name), ['web']);
  assert.match(b.warnings.join(), /DATABASE_URL is not set/);
  assert.throws(() => replitSpecs({ SOLANA_CLUSTER: 'mainnet-beta', DATABASE_URL: 'postgres://u:p@h/db' }), /Devnet only/);
  assert.equal(replitSpecs({ DATABASE_URL: 'postgres://u:p@h/db', SOLANA_RPC_URL: 'https://custom.example' }, '/app').specs[0]!.env.SOLANA_RPC_URL, 'https://custom.example');
});
