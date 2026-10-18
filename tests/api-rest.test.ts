import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, healthyRunner, MemoryApiSource, startTestApi, waitUntil } from './api-helpers.ts';

const U64_MAX = 2n ** 64n - 1n;
const ODD = 9_007_199_254_740_993n; // 2^53 + 1: not representable as a JS number

async function withApi<T>(fn: (c: { src: MemoryApiSource; api: Awaited<ReturnType<typeof startTestApi>>; url: string }) => Promise<T>, config = {}) {
  const src = new MemoryApiSource(['alpha', 'beta']);
  const api = await startTestApi(src, { config });
  try {
    return await fn({ src, api, url: api.url });
  } finally {
    await api.close();
  }
}

test('GET /health/live and /health/ready (also with HEAD)', async () => {
  await withApi(async ({ api, url }) => {
    assert.deepEqual((await get(`${url}/health/live`)).json, { status: 'ok' });
    const ready = await get(`${url}/health/ready`);
    assert.deepEqual([ready.status, ready.json], [200, { status: 'ready', checks: { database: 'ok', engine: 'running' } }]);
    const head = await get(`${url}/health/live`, { method: 'HEAD' });
    assert.deepEqual([head.status, head.text], [200, '']);
    api.runtime.state = 'stopping';
    api.clock.t += 2_000; // readiness is cached for 1 s
    const notReady = await get(`${url}/health/ready`);
    assert.deepEqual([notReady.status, notReady.json.status, notReady.json.checks.engine], [503, 'not_ready', 'stopping']);
    assert.equal((await get(`${url}/health/live`)).status, 200); // liveness does not depend on the engine state
  });
});

test('GET /api/v1/projects: public metadata only, amounts as strings', async () => {
  await withApi(async ({ url }) => {
    const r = await get(`${url}/api/v1/projects`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    const alpha = r.json.data.find((p: any) => p.id === 'alpha');
    assert.deepEqual(Object.keys(alpha).sort(), ['cluster', 'decimals', 'id', 'levels', 'links', 'mint', 'name', 'ticker', 'tokenProgram']);
    assert.deepEqual(alpha.levels[2], { id: 'l2', name: 'Two', index: 2, thresholdRaw: '5000500000', threshold: '5000.5' });
    assert.equal(alpha.links.stream, '/api/v1/projects/alpha/stream');
    assert.doesNotMatch(r.text, /postgres|api-key|rpc|password|secret/i);
    assert.equal((await get(`${url}/api/v1/projects?x=1`)).status, 400);
  });
});

test('status: synced / incomplete / degraded are explicit and carry no internal detail', async () => {
  await withApi(async ({ src, api, url }) => {
    const status = async () => (await get(`${url}/api/v1/projects/alpha/status`)).json;

    let s = await status();
    assert.deepEqual([s.data.state, s.data.reasons, s.data.history.complete, s.data.history.verification], ['synced', [], false, 'unverified']); // synced != proven complete
    assert.equal(s.engine, 'running');
    assert.doesNotMatch(JSON.stringify(s), /internal text/);

    src.states.get('alpha')!.backfill = 'running';
    s = await status();
    assert.deepEqual([s.data.state, s.data.reasons], ['incomplete', ['backfill_running']]);
    src.states.get('alpha')!.backfill = 'done_exhausted';

    api.runtime.runners.alpha = healthyRunner({ consecutiveFailures: 3, state: 'backoff' });
    s = await status();
    assert.deepEqual([s.data.state, s.data.reasons, s.data.indexer], ['incomplete', ['sync_failing'], 'backoff']);

    api.runtime.runners.alpha = healthyRunner({ state: 'waiting_lease' });
    s = await status();
    assert.deepEqual([s.data.state, s.data.reasons], ['synced', ['standby']]); // another process indexes; data is still served

    api.runtime.runners.alpha = healthyRunner();
    src.states.get('alpha')!.issues = [{ code: 'malformed', signature: 'SIGSECRET', detail: 'internal node detail xyz' }, { code: 'malformed', signature: 'S2', detail: 'd' }];
    s = await status();
    assert.deepEqual([s.data.state, s.data.reasons, s.data.issues], ['incomplete', ['open_issues'], { count: 2, codes: { malformed: 2 } }]);
    assert.doesNotMatch(JSON.stringify(s), /SIGSECRET|internal node detail/);

    src.states.get('alpha')!.issues = [];
    src.states.get('alpha')!.verification = { status: 'mismatch', expectedBurnedRaw: '10', indexedBurnedRaw: '9' };
    s = await status();
    assert.deepEqual([s.data.state, s.data.reasons], ['incomplete', ['verification_mismatch']]);
    src.states.get('alpha')!.verification = { status: 'verified', burnedRaw: '0' };
    s = await status();
    assert.deepEqual([s.data.state, s.data.history.complete], ['synced', true]);

    src.states.set('alpha', { ...src.states.get('alpha')!, finalizedHead: null, backfill: 'pending' });
    api.runtime.runners.alpha = null;
    s = await status();
    assert.deepEqual([s.data.state, s.data.reasons], ['incomplete', ['not_started']]);
  });
});

test('status totals and progression use exact decimal strings (no JS number precision loss)', async () => {
  await withApi(async ({ src, url }) => {
    src.addBurn('alpha', ODD);
    src.addBurn('alpha', U64_MAX - ODD);
    src.pending.set('alpha', 5n);
    const s = (await get(`${url}/api/v1/projects/alpha/status`)).json;
    assert.equal(s.totals.finalizedRaw, U64_MAX.toString());
    assert.equal(s.totals.finalized, '18446744073709.551615');
    assert.deepEqual([s.totals.pendingFinalizationRaw, s.totals.pendingFinalization], ['5', '0.000005']);
    assert.equal(s.latestEventId, '2');
    assert.equal(s.progression.level.id, 'l3'); // far beyond every threshold
    assert.equal(s.progression.maxed, true);
    assert.match((await get(`${url}/api/v1/projects/alpha/status`)).text, /"finalizedRaw":"18446744073709551615"/);
  });
});

test('progression: level, next level, remaining, basis points, reached flags with timestamps', async () => {
  await withApi(async ({ src, url }) => {
    src.addBurn('alpha', 1_000_000_000n + 2_000_000_000n); // 3000 UI: past l1 (1000), before l2 (5000.5)
    src.addMutation('alpha', 'l1', 1);
    const p = (await get(`${url}/api/v1/projects/alpha/progression`)).json;
    assert.deepEqual([p.total.raw, p.total.ui], ['3000000000', '3000']);
    assert.deepEqual([p.level.id, p.nextLevel.id, p.maxed], ['l1', 'l2', false]);
    assert.deepEqual([p.remaining.raw, p.remaining.ui], ['2000500000', '2000.5']);
    assert.equal(p.levelProgressBps, 4999); // floor(10000 * (3000-1000)/(5000.5-1000)) = floor(4999.37)
    assert.deepEqual(p.levels.map((l: any) => [l.id, l.reached]), [['l0', true], ['l1', true], ['l2', false], ['l3', false]]);
    assert.ok(p.levels[1].reachedAt && p.levels[2].reachedAt === null);
    assert.deepEqual(p.data, { state: 'synced', reasons: [] });
  });
});

test('burns: bounded pagination, newest first, exact amounts, no duplicates or gaps across pages', async () => {
  await withApi(async ({ src, url }) => {
    const amounts = [1n, ODD, U64_MAX, 7n, 8n, 9n, 10n];
    for (const a of amounts) src.addBurn('alpha', a);
    src.addBurn('beta', 555n);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: any = await get(`${url}/api/v1/projects/alpha/burns?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(r.status, 200);
      assert.ok(r.json.data.length <= 3);
      seen.push(...r.json.data.map((b: any) => b.id));
      cursor = r.json.page.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, ['7', '6', '5', '4', '3', '2', '1']); // newest first, each exactly once

    const all = (await get(`${url}/api/v1/projects/alpha/burns?limit=200`)).json;
    assert.equal(all.page.nextCursor, null);
    const byId = Object.fromEntries(all.data.map((b: any) => [b.id, b]));
    assert.equal(byId['3'].amountRaw, U64_MAX.toString());
    assert.equal(byId['3'].amount, '18446744073709.551615');
    assert.equal(byId['2'].amountRaw, '9007199254740993');
    assert.equal(typeof byId['1'].slot, 'number');
    assert.deepEqual(Object.keys(byId['1']).sort(), ['amount', 'amountRaw', 'blockTime', 'finalizedAt', 'id', 'instructionPath', 'owner', 'signature', 'slot']);
    assert.equal((await get(`${url}/api/v1/projects/alpha/burns`)).json.data.length, 7); // default limit 50
  });
});

test('burns/events: strict parameter validation with consistent errors', async () => {
  await withApi(async ({ url }) => {
    const bad = [
      '/burns?limit=0', '/burns?limit=201', '/burns?limit=abc', '/burns?limit=-1', '/burns?limit=1.5', '/burns?limit=1&limit=2',
      '/burns?cursor=abc', '/burns?cursor=-5', '/burns?cursor=99999999999999999999', '/burns?foo=bar',
      '/events?limit=501', '/events?after=x', '/events?after=1.5', '/events?cursor=1', '/status?limit=1', '/progression?x=1',
    ];
    for (const q of bad) {
      const r = await get(`${url}/api/v1/projects/alpha${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(r.json.error.code, 'invalid_parameter', q);
      assert.equal(typeof r.json.error.message, 'string');
    }
    assert.equal((await get(`${url}/api/v1/projects/alpha/burns?limit=200`)).status, 200);
    assert.equal((await get(`${url}/api/v1/projects/alpha/events?limit=500&after=0`)).status, 200);
  });
});

test('events: ascending, resumable with after, with hasMore/latestId, burn and mutation shapes', async () => {
  await withApi(async ({ src, url }) => {
    src.addBurn('alpha', 100n);
    src.addBurn('alpha', 2_000_000_000n);
    src.addMutation('alpha', 'l1', 1);
    src.addBurn('alpha', 1n);
    const r1 = (await get(`${url}/api/v1/projects/alpha/events?limit=2`)).json;
    assert.deepEqual(r1.data.map((e: any) => [e.id, e.type]), [['1', 'burn'], ['2', 'burn']]);
    assert.deepEqual(r1.page, { limit: 2, after: '0', nextAfter: '2', latestId: '4', hasMore: true });
    const r2 = (await get(`${url}/api/v1/projects/alpha/events?limit=2&after=${r1.page.nextAfter}`)).json;
    assert.deepEqual(r2.data.map((e: any) => [e.id, e.type]), [['3', 'mutation'], ['4', 'burn']]);
    assert.equal(r2.page.hasMore, false);
    assert.deepEqual(r2.data[0].mutation, { levelId: 'l1', levelName: 'One', levelIndex: 1, totalRaw: '2000000100', total: '2000.0001', triggeredBy: 'sig#0' });
    assert.equal(r2.data[1].burn.amountRaw, '1');
    const empty = (await get(`${url}/api/v1/projects/alpha/events?after=4`)).json;
    assert.deepEqual([empty.data, empty.page.nextAfter, empty.page.hasMore], [[], '4', false]);
  });
});

test('projects are isolated: events, burns and totals never leak across projects', async () => {
  await withApi(async ({ src, url }) => {
    src.addBurn('alpha', 111n);
    src.addBurn('beta', 222n);
    src.addBurn('beta', 333n);
    for (const [id, other] of [['alpha', '222'], ['beta', '111']] as const) {
      const burns = (await get(`${url}/api/v1/projects/${id}/burns`)).text;
      const events = (await get(`${url}/api/v1/projects/${id}/events`)).text;
      assert.doesNotMatch(burns + events, new RegExp(`"amountRaw":"${other}"`));
    }
    assert.equal((await get(`${url}/api/v1/projects/alpha/status`)).json.totals.finalizedRaw, '111');
    assert.equal((await get(`${url}/api/v1/projects/beta/status`)).json.totals.finalizedRaw, '555');
    assert.equal((await get(`${url}/api/v1/projects/beta/events`)).json.data.length, 2);
  });
});

test('database outage: data endpoints answer 503 data_unavailable, liveness stays up, other routes keep working, recovery is automatic', async () => {
  await withApi(async ({ src, api, url }) => {
    src.addBurn('alpha', 5n);
    src.down.add('*');
    for (const path of ['status', 'burns', 'progression', 'events']) {
      const r = await get(`${url}/api/v1/projects/alpha/${path}`);
      assert.deepEqual([r.status, r.json.error.code, r.json.dataState], [503, 'data_unavailable', 'unavailable'], path);
      assert.equal(r.headers['retry-after'], '5');
      assert.doesNotMatch(r.text, /injected|StoreError|postgres/);
    }
    assert.equal((await get(`${url}/api/v1/projects`)).status, 200); // static metadata needs no database
    assert.equal((await get(`${url}/health/live`)).status, 200);
    const ready = await get(`${url}/health/ready`);
    assert.deepEqual([ready.status, ready.json.checks.database], [503, 'unavailable']);

    src.down.clear();
    api.clock.t += 2_000;
    assert.equal((await get(`${url}/health/ready`)).status, 200);
    assert.equal((await get(`${url}/api/v1/projects/alpha/status`)).json.totals.finalizedRaw, '5');
  });
});

test('one degraded project does not affect the others', async () => {
  await withApi(async ({ src, api, url }) => {
    src.addBurn('alpha', 1n);
    src.addBurn('beta', 2n);
    src.down.add('alpha'); // alpha unreadable
    api.runtime.runners.beta = healthyRunner({ consecutiveFailures: 4, state: 'backoff' }); // beta's indexer failing
    assert.equal((await get(`${url}/api/v1/projects/alpha/status`)).status, 503);
    const b = await get(`${url}/api/v1/projects/beta/status`);
    assert.deepEqual([b.status, b.json.data.state, b.json.data.reasons, b.json.totals.finalizedRaw], [200, 'incomplete', ['sync_failing'], '2']);
    assert.equal((await get(`${url}/api/v1/projects/beta/burns`)).status, 200);
    assert.equal((await get(`${url}/health/ready`)).status, 200); // a degraded project does not make the instance unready
  });
});

test('routing: unknown routes/projects, trailing slash, malformed ids, read-only methods', async () => {
  await withApi(async ({ url }) => {
    for (const p of ['/', '/api', '/api/v1', '/api/v1/projects/alpha', '/api/v1/projects/alpha/nope', '/api/v1/projects/alpha/status/', '/health', '/admin']) {
      const r = await get(`${url}${p}`);
      assert.deepEqual([r.status, r.json.error.code], [404, 'not_found'], p);
    }
    for (const id of ['ghost', 'ALPHA', 'a'.repeat(80), '..%2Fetc', 'al%20pha', '-alpha']) {
      const r = await get(`${url}/api/v1/projects/${id}/status`);
      assert.deepEqual([r.status, r.json.error.code], [404, 'project_not_found'], id);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await get(`${url}/api/v1/projects/alpha/status`, { method });
      assert.deepEqual([r.status, r.json.error.code, r.headers.allow], [405, 'method_not_allowed', 'GET, HEAD, OPTIONS'], method);
    }
    assert.equal((await get(`${url}/api/v1/projects/alpha/stream`, { method: 'HEAD' })).status, 405);
    assert.equal((await get(`${url}/${'a'.repeat(400)}`)).status, 400);
  });
});

test('CORS: explicit origin list, preflight, rejection of other origins, no wildcard', async () => {
  await withApi(async ({ url }) => {
    const ok = await get(`${url}/api/v1/projects`, { headers: { Origin: 'https://app.example' } });
    assert.deepEqual([ok.status, ok.headers['access-control-allow-origin'], ok.headers.vary], [200, 'https://app.example', 'Origin']);

    const evil = await get(`${url}/api/v1/projects`, { headers: { Origin: 'https://evil.example' } });
    assert.deepEqual([evil.status, evil.json.error.code, evil.headers['access-control-allow-origin']], [403, 'origin_not_allowed', undefined]);

    const none = await get(`${url}/api/v1/projects`); // server-to-server, no Origin
    assert.deepEqual([none.status, none.headers['access-control-allow-origin']], [200, undefined]);

    const pre = await get(`${url}/api/v1/projects/alpha/stream`, { method: 'OPTIONS', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'GET' } });
    assert.deepEqual([pre.status, pre.headers['access-control-allow-origin'], pre.headers['access-control-allow-methods']], [204, 'https://app.example', 'GET, HEAD, OPTIONS']);
    assert.match(String(pre.headers['access-control-allow-headers']), /Last-Event-ID/);
    const preEvil = await get(`${url}/api/v1/projects/alpha/stream`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(preEvil.status, 403);
  });
  await withApi(async ({ url }) => {
    const r = await get(`${url}/api/v1/projects`, { headers: { Origin: 'https://app.example' } });
    assert.equal(r.status, 403); // no origin configured: browsers from other sites are refused
    assert.equal(r.headers.vary, undefined);
  }, { corsOrigins: [] });
});

test('rate limiting: per client, 429 with Retry-After, liveness exempt, window reset, proxy-aware only when trusted', async () => {
  await withApi(async ({ api, url }) => {
    for (let i = 0; i < 3; i++) assert.equal((await get(`${url}/api/v1/projects`)).status, 200);
    const limited = await get(`${url}/api/v1/projects`);
    assert.deepEqual([limited.status, limited.json.error.code], [429, 'rate_limited']);
    assert.ok(Number(limited.headers['retry-after']) >= 1 && Number(limited.headers['retry-after']) <= 60);
    assert.equal((await get(`${url}/health/live`)).status, 200); // never throttled: orchestrators poll it
    api.clock.t += 61_000;
    assert.equal((await get(`${url}/api/v1/projects`)).status, 200);
    // X-Forwarded-For is ignored unless TRUST_PROXY is on: it cannot be used to dodge the limit
    for (let i = 0; i < 4; i++) await get(`${url}/api/v1/projects`, { headers: { 'X-Forwarded-For': `9.9.9.${i}` } });
    assert.equal((await get(`${url}/api/v1/projects`, { headers: { 'X-Forwarded-For': '8.8.8.8' } })).status, 429);
  }, { rateLimitPerMinute: 3 });

  await withApi(async ({ url }) => {
    const hit = (ip: string) => get(`${url}/api/v1/projects`, { headers: { 'X-Forwarded-For': `1.2.3.4, ${ip}` } }).then((r) => r.status);
    assert.deepEqual([await hit('10.0.0.1'), await hit('10.0.0.1'), await hit('10.0.0.2')], [200, 429, 200]); // keyed on the address added by the proxy
  }, { rateLimitPerMinute: 1, trustProxy: true });
});

test('expensive requests are bounded: excess database reads are refused with 503, never queued without limit', async () => {
  await withApi(async ({ src, url }) => {
    src.addBurn('alpha', 1n);
    src.delayMs = 80;
    const statuses = await Promise.all(Array.from({ length: 8 }, () => get(`${url}/api/v1/projects/alpha/burns`).then((r) => r.status)));
    assert.ok(statuses.includes(503), `statuses=${statuses}`);
    assert.ok(statuses.includes(200));
    assert.ok(statuses.every((s) => s === 200 || s === 503));
    src.delayMs = 0;
    assert.equal((await get(`${url}/api/v1/projects/alpha/burns`)).status, 200); // recovers
  }, { dbConcurrency: 1, dbQueue: 1 });
});

test('unexpected failures return a generic 500: no internals, no secrets', async () => {
  await withApi(async ({ src, api, url }) => {
    src.throwUnexpected = new Error('boom postgres://user:pw@db.internal/x api-key=TOPSECRET');
    const r = await get(`${url}/api/v1/projects/alpha/burns`);
    assert.deepEqual([r.status, r.json.error.code], [500, 'internal_error']);
    assert.doesNotMatch(r.text, /boom|postgres|TOPSECRET|db\.internal/);
    assert.ok(api.logs.some((l) => l.event === 'api_error')); // it is logged (the real logger redacts secrets)
  });
});

test('the server answers after errors and closes cleanly (no leftover connections)', async () => {
  const src = new MemoryApiSource(['alpha', 'beta']);
  const api = await startTestApi(src);
  await get(`${api.url}/api/v1/projects/ghost/status`);
  const t0 = Date.now();
  await api.close();
  assert.ok(Date.now() - t0 < 1_000);
  await assert.rejects(get(`${api.url}/health/live`)); // port released
  await waitUntil(() => api.api.stats().sse.connections === 0, 'no connections');
});

test('history trust state: a stable public reason code and the proof time, never the internal free text', async () => {
  await withApi(async ({ src, url }) => {
    const history = async () => (await get(`${url}/api/v1/projects/alpha/status`)).json.data.history;
    const st = src.states.get('alpha')!;
    // states stored before codes existed (no `code`) read as "not read yet", not as an error
    st.verification = { status: 'unverified', reason: 'internal text that must never be public' };
    let h = await history();
    assert.deepEqual([h.verification, h.complete, h.reason, h.verifiedAt], ['unverified', false, 'history_not_read', null]);
    st.verification = { status: 'unverified', reason: 'sync failed: connect ECONNREFUSED 10.0.0.5:5432 internal text', code: 'sync_failed' };
    h = await history();
    assert.equal(h.reason, 'sync_failed');
    assert.doesNotMatch(JSON.stringify(h), /ECONNREFUSED|internal text|10\.0\.0\.5/);
    for (const code of ['initial_supply_not_configured', 'mint_authority_active', 'unsupported_mint_extension', 'native_mint', 'indexed_changed', 'history_incomplete'] as const) {
      st.verification = { status: 'unverified', reason: 'x', code };
      assert.equal((await history()).reason, code);
    }
    st.verification = { status: 'verified', burnedRaw: '700', at: '2026-10-18T12:00:00.000Z' };
    h = await history();
    assert.deepEqual([h.verification, h.complete, h.reason, h.verifiedAt], ['verified', true, null, '2026-10-18T12:00:00.000Z']);
    st.verification = { status: 'mismatch', expectedBurnedRaw: '140', indexedBurnedRaw: '100', at: '2026-10-18T12:05:00.000Z' };
    h = await history();
    assert.deepEqual([h.verification, h.complete, h.reason, h.verifiedAt], ['mismatch', false, 'supply_mismatch', '2026-10-18T12:05:00.000Z']);
    assert.doesNotMatch(JSON.stringify(h), /expectedBurnedRaw|140/, 'the exact gap stays internal');
  });
});
