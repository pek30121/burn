import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RpcError, SolanaRpc } from '../src/chain/rpc.ts';
import { TOKEN_PROGRAMS, parseProjectConfig } from '../src/config/schema.ts';
import { checkMintPrograms, mintProgramProblem } from '../src/engine/mint-check.ts';
import { ProjectRunner } from '../src/engine/runner.ts';
import { createLogger } from '../src/engine/logger.ts';
import { projectInput, randomPubkey } from './helpers.ts';

const spl = TOKEN_PROGRAMS['spl-token'];
const t22 = TOKEN_PROGRAMS['token-2022'];
const project = (over: Record<string, unknown> = {}) => parseProjectConfig(projectInput(over));
const ownerIs = (owner: string | null) => ({ getAccountOwner: async () => owner });

test('[H2] matching program: no problem, for both token programs', async () => {
  assert.equal(await mintProgramProblem(ownerIs(spl), project()), null);
  assert.equal(await mintProgramProblem(ownerIs(t22), project({ tokenProgram: 'token-2022' })), null);
});

test('[H2] mismatch in both directions names the project, both programs and the fix', async () => {
  const a = (await mintProgramProblem(ownerIs(spl), project({ id: 'gamma', tokenProgram: 'token-2022' })))!;
  assert.match(a, /project "gamma": tokenProgram is "token-2022" but the mint is owned on-chain by "spl-token"; set tokenProgram to "spl-token"/);
  const b = (await mintProgramProblem(ownerIs(t22), project()))!;
  assert.match(b, /tokenProgram is "spl-token" but the mint is owned on-chain by "token-2022"/);
});

test('[H2] absent mint and non-token owner are explicit refusals, not silent', async () => {
  assert.match((await mintProgramProblem(ownerIs(null), project()))!, /does not exist on devnet/);
  const stranger = randomPubkey();
  const msg = (await mintProgramProblem(ownerIs(stranger), project()))!;
  assert.match(msg, /is not a token program/);
  assert.ok(msg.includes(stranger));
});

test('[H2] a transient RPC failure is "unverified", never a mismatch; a definitive mismatch is reported alongside', async () => {
  const flaky = project({ id: 'flaky' });
  const wrong = project({ id: 'wrong', tokenProgram: 'token-2022', mint: 'So11111111111111111111111111111111111111112' });
  const fine = project({ id: 'fine', mint: randomPubkey() });
  const rpc = {
    getAccountOwner: async (mint: string) => {
      if (mint === flaky.mint) throw new RpcError('getAccountInfo: HTTP 500', { retryable: true });
      return spl;
    },
  };
  const r = await checkMintPrograms(rpc, [flaky, wrong, fine]);
  assert.deepEqual(r.unverified.map((p) => p.id), ['flaky']);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0]!, /project "wrong"/);
  await assert.rejects(() => checkMintPrograms({ getAccountOwner: async () => { throw new TypeError('bug'); } }, [fine]), TypeError);
});

test('[H2] SolanaRpc.getAccountOwner: owner without account data, null for a missing account, malformed replies refused', async () => {
  const seen: any[] = [];
  const answer = (value: unknown): typeof fetch => (async (_u: unknown, init?: RequestInit) => {
    const b = JSON.parse(String(init!.body));
    seen.push(b);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { value } }));
  }) as typeof fetch;
  const mint = randomPubkey();
  assert.equal(await new SolanaRpc({ url: 'http://x', fetch: answer({ owner: t22, lamports: 1, data: ['', 'base64'] }) }).getAccountOwner(mint, 'finalized'), t22);
  assert.deepEqual(seen[0].params[1].dataSlice, { offset: 0, length: 0 }, 'no account data is downloaded');
  assert.equal(seen[0].params[1].commitment, 'finalized');
  assert.equal(await new SolanaRpc({ url: 'http://x', fetch: answer(null) }).getAccountOwner(mint, 'finalized'), null);
  for (const bad of [{ owner: 5 }, { owner: 'not-an-address' }, {}]) {
    await assert.rejects(() => new SolanaRpc({ url: 'http://x', fetch: answer(bad), maxRetries: 0 }).getAccountOwner(mint, 'finalized'), /malformed/);
  }
});

test('[H2] runner preflight: nothing is indexed until the check passes; it backs off, then runs once and never again', async () => {
  let syncs = 0, checks = 0, fail = 2;
  const sleeps: number[] = [];
  const ac = new AbortController();
  const runner = new ProjectRunner({
    projectId: 'p', store: {}, log: createLogger({ write: () => {} }), pollIntervalMs: 5, backoff: { baseMs: 10, maxMs: 40 }, leaseRetryMs: 5,
    indexer: { syncOnce: async () => { syncs++; if (syncs >= 3) ac.abort(); return { burnsRecorded: 0, burnsPromoted: 0, burnsDropped: 0, eventsDelivered: 0, moreWork: false, error: null, warnings: [] }; }, status: async () => { throw new Error('n/a'); } },
    preflight: async () => { checks++; if (fail-- > 0) throw new Error('project "p": tokenProgram mismatch'); },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await runner.run(ac.signal);
  assert.equal(checks, 3, '2 failures then 1 success, never re-run afterwards');
  assert.equal(syncs, 3);
  assert.equal(sleeps.filter((m) => m >= 5 && m <= 40).length >= 2, true, 'backoff between failed checks');
});

test('[H2] runner preflight failure blocks every sync and is visible as the last error', async () => {
  let syncs = 0;
  const ac = new AbortController();
  let n = 0;
  const runner = new ProjectRunner({
    projectId: 'p', store: {}, log: createLogger({ write: () => {} }), pollIntervalMs: 5, backoff: { baseMs: 1, maxMs: 2 }, leaseRetryMs: 5,
    indexer: { syncOnce: async () => { syncs++; throw new Error('must not run'); }, status: async () => { throw new Error('n/a'); } },
    preflight: async () => { if (++n >= 4) ac.abort(); throw new Error('project "p": the mint does not exist'); },
    sleep: async () => {},
  });
  await runner.run(ac.signal);
  assert.equal(syncs, 0);
  assert.match(runner.snapshot().lastError ?? '', /the mint does not exist/);
  assert.ok(runner.snapshot().consecutiveFailures >= 3);
});
