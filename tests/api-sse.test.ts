import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/engine/logger.ts';
import { SseManager, type SseResponse } from '../src/api/sse.ts';
import { alphaCfg, eventIds, MemoryApiSource, openSse, startTestApi, waitUntil, type SseClient } from './api-helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const strictlyIncreasing = (ids: number[]) => ids.every((v, i) => i === 0 || v > ids[i - 1]!);

async function setup(config = {}) {
  const src = new MemoryApiSource(['alpha', 'beta']);
  const api = await startTestApi(src, { config });
  return { src, api, url: `${api.url}/api/v1/projects/alpha/stream` };
}

test('SSE: connect, receive live events in order with stable ids, heartbeat, clean disconnect', async () => {
  const { src, api, url } = await setup({ sse: { maxConnections: 50, maxPerIp: 50, heartbeatMs: 40, pollMs: 20, slowClientMs: 500 } });
  try {
    src.addBurn('alpha', 1n);
    const c = await openSse(url, { headers: { Origin: 'https://app.example' } });
    assert.equal(c.status, 200);
    assert.match(String(c.headers['content-type']), /text\/event-stream/);
    assert.equal(c.headers['access-control-allow-origin'], 'https://app.example');
    assert.equal(c.headers['cache-control'], 'no-store, no-transform');
    await c.waitFor((f) => f.some((x) => x.event === 'ready'), 'ready');
    const ready = c.frames.find((f) => f.event === 'ready')!;
    assert.deepEqual(ready.data, { projectId: 'alpha', latestId: '1', resumeAfter: '1' }); // no Last-Event-ID: live only, no replay

    src.addBurn('alpha', 20n);
    src.addMutation('alpha', 'l1', 1);
    src.addBurn('beta', 999n); // another project: must not appear here
    await c.waitFor((f) => f.filter((x) => x.id).length === 2, 'two live events');
    assert.deepEqual(c.frames.filter((f) => f.id).map((f) => [f.id, f.event, f.data.id, f.data.type, f.data.projectId]), [['2', 'burn', '2', 'burn', 'alpha'], ['3', 'mutation', '3', 'mutation', 'alpha']]);
    assert.equal(c.frames[c.frames.length - 2]!.data.burn.amountRaw, '20');

    await waitUntil(() => c.comments.some((x) => x.startsWith(': hb')), 'heartbeat');
    assert.equal(api.api.stats().sse.connections, 1);
    c.close();
    await waitUntil(() => api.api.stats().sse.connections === 0, 'connection released');
    assert.deepEqual(api.api.stats().sse.byProject, {}); // nothing left behind for the project
  } finally {
    await api.close();
  }
});

test('SSE: reconnection with Last-Event-ID (or ?after=) replays exactly the missed events, then goes live', async () => {
  const { src, api, url } = await setup();
  try {
    for (let i = 0; i < 5; i++) src.addBurn('alpha', BigInt(i + 1));
    const a = await openSse(url, { lastEventId: 2 });
    await a.waitFor((f) => f.some((x) => x.id === '5'), 'replay');
    assert.deepEqual(eventIds(a), [3, 4, 5]); // nothing before 3, no duplicate of 2
    src.addBurn('alpha', 6n);
    await a.waitFor((f) => f.some((x) => x.id === '6'), 'live after replay');
    assert.deepEqual(eventIds(a), [3, 4, 5, 6]);
    a.close();

    src.addBurn('alpha', 7n); // missed while disconnected
    src.addMutation('alpha', 'l1', 1);
    const b = await openSse(url, { lastEventId: 6 });
    await b.waitFor((f) => f.some((x) => x.id === '8'), 'catch-up');
    assert.deepEqual(eventIds(b), [7, 8]);
    b.close();

    const q = await openSse(`${url}?after=7`); // first connect of an EventSource cannot set headers
    await q.waitFor((f) => f.some((x) => x.id === '8'), '?after');
    assert.deepEqual(eventIds(q), [8]);
    q.close();

    const h = await openSse(`${url}?after=1`, { lastEventId: 7 }); // the header wins
    await h.waitFor((f) => f.some((x) => x.id === '8'), 'header wins');
    assert.deepEqual(eventIds(h), [8]);
    h.close();

    const full = await openSse(url, { lastEventId: 0 }); // from the very beginning
    await full.waitFor((f) => f.some((x) => x.id === '8'), 'full history');
    assert.deepEqual(eventIds(full), range(1, 8));
    full.close();
  } finally {
    await api.close();
  }
});

test('SSE: a cursor ahead of the stored log yields a reset event instead of silence', async () => {
  const { src, api, url } = await setup();
  try {
    for (let i = 0; i < 3; i++) src.addBurn('alpha', 1n);
    const c = await openSse(url, { lastEventId: 99 });
    await c.waitFor((f) => f.some((x) => x.event === 'ready'), 'ready');
    assert.deepEqual(c.frames.map((f) => f.event), ['reset', 'ready']);
    assert.deepEqual(c.frames[0]!.data, { latestId: '3', reason: 'client_cursor_ahead_of_log' });
    src.addBurn('alpha', 4n);
    await c.waitFor((f) => f.some((x) => x.id === '4'), 'events flow again');
    assert.deepEqual(eventIds(c), [4]);
    c.close();
  } finally {
    await api.close();
  }
});

test('SSE: invalid input and unknown projects are refused before any stream starts', async () => {
  const { api, url } = await setup();
  try {
    for (const id of ['abc', '-1', '1.5', '99999999999999999999']) {
      await assert.rejects(openSse(url, { lastEventId: id }), (e: any) => e.status === 400 && e.body.error.code === 'invalid_last_event_id', id);
    }
    await assert.rejects(openSse(`${url}?after=zzz`), (e: any) => e.status === 400);
    await assert.rejects(openSse(`${url}?x=1`), (e: any) => e.status === 400);
    await assert.rejects(openSse(`${api.url}/api/v1/projects/ghost/stream`), (e: any) => e.status === 404);
    await assert.rejects(openSse(url, { headers: { Origin: 'https://evil.example' } }), (e: any) => e.status === 403);
    assert.equal(api.api.stats().sse.connections, 0); // refused requests hold no slot
  } finally {
    await api.close();
  }
});

test('SSE: no loss, no duplicate and strict order between history and live while events are being written', async () => {
  const { src, api, url } = await setup();
  const N = 400;
  try {
    const producer = (async () => {
      for (let i = 1; i <= N; i++) {
        if (i % 9 === 0) src.addMutation('alpha', 'l1', 1);
        else src.addBurn('alpha', BigInt(i));
        if (i % 4 === 0) await sleep(1 + (i % 3));
      }
    })();
    await waitUntil(() => src.events.get('alpha')!.length >= 80, 'some history');
    const resumed = await openSse(url, { lastEventId: 25 }); // history + live race
    await waitUntil(() => src.events.get('alpha')!.length >= 200, 'more events');
    const liveOnly = await openSse(url); // joins in the middle
    await producer;
    await resumed.waitFor((f) => f.some((x) => x.id === String(N)), 'resumed complete');
    await liveOnly.waitFor((f) => f.some((x) => x.id === String(N)), 'live complete');

    assert.deepEqual(eventIds(resumed), range(26, N)); // contiguous: not a single event lost or repeated
    const from = Number(liveOnly.frames.find((f) => f.event === 'ready')!.data.resumeAfter);
    assert.deepEqual(eventIds(liveOnly), range(from + 1, N));
    // both streams carry identical payloads for the same id
    const byId = (c: SseClient) => new Map(c.frames.filter((f) => f.id).map((f) => [f.id, JSON.stringify(f.data)]));
    const r = byId(resumed);
    for (const [id, data] of byId(liveOnly)) assert.equal(r.get(id), data);
    resumed.close();
    liveOnly.close();
  } finally {
    await api.close();
  }
});

test('SSE: repeated disconnect/reconnect during production still yields every event at least once, in order per connection', async () => {
  const { src, api, url } = await setup();
  const N = 300;
  try {
    const producer = (async () => {
      for (let i = 1; i <= N; i++) {
        src.addBurn('alpha', BigInt(i));
        if (i % 3 === 0) await sleep(1);
      }
    })();
    const seen = new Set<number>();
    let last = 0;
    let duplicates = 0;
    for (let cycle = 0; cycle < 12 && last < N; cycle++) {
      const c = await openSse(url, { lastEventId: last });
      await sleep(15 + ((cycle * 7) % 25));
      c.close();
      await c.ended;
      const ids = eventIds(c);
      assert.ok(strictlyIncreasing(ids), `cycle ${cycle}: ids not increasing`);
      assert.ok(ids.every((id) => id > last), `cycle ${cycle}: replayed an event older than Last-Event-ID`);
      for (const id of ids) (seen.has(id) ? duplicates++ : seen.add(id));
      if (ids.length) last = Math.max(last, ...ids);
    }
    await producer;
    const final = await openSse(url, { lastEventId: last });
    if (last < N) await final.waitFor((f) => f.some((x) => x.id === String(N)), 'final catch-up');
    for (const id of eventIds(final)) (seen.has(id) ? duplicates++ : seen.add(id));
    final.close();
    assert.deepEqual([...seen].sort((a, b) => a - b), range(1, N)); // nothing missing
    assert.equal(duplicates, 0); // resuming from the last id never repeats
  } finally {
    await api.close();
  }
});

test('SSE: a database outage keeps the connection open; every missed event arrives in order after recovery', async () => {
  const { src, api, url } = await setup();
  try {
    src.addBurn('alpha', 1n);
    const c = await openSse(url, { lastEventId: 0 });
    await c.waitFor((f) => f.some((x) => x.id === '1'), 'first');
    src.down.add('*');
    for (let i = 2; i <= 6; i++) src.addBurn('alpha', BigInt(i)); // committed while the API cannot read
    await sleep(150);
    assert.deepEqual(eventIds(c), [1]); // nothing invented, nothing lost yet
    assert.equal(api.api.stats().sse.connections, 1);
    assert.ok(api.logs.some((l) => l.event === 'sse_source_unavailable'));
    src.down.clear();
    await c.waitFor((f) => f.some((x) => x.id === '6'), 'recovery');
    assert.deepEqual(eventIds(c), range(1, 6));
    assert.ok(api.logs.some((l) => l.event === 'sse_source_recovered'));
    c.close();
  } finally {
    await api.close();
  }
});

test('SSE: connection limits (global and per client), slots are released on disconnect', async () => {
  const { api, url } = await setup({ trustProxy: true, sse: { maxConnections: 3, maxPerIp: 1, heartbeatMs: 60_000, pollMs: 20, slowClientMs: 500 } });
  try {
    const as = (ip: string) => ({ headers: { 'X-Forwarded-For': ip } });
    const a = await openSse(url, as('10.0.0.1'));
    const b = await openSse(url, as('10.0.0.2'));
    await assert.rejects(openSse(url, as('10.0.0.1')), (e: any) => e.status === 429 && e.body.error.code === 'too_many_streams' && e.headers['retry-after'] === '5');
    const c = await openSse(url, as('10.0.0.3'));
    await assert.rejects(openSse(url, as('10.0.0.4')), (e: any) => e.status === 503 && e.body.error.code === 'stream_capacity');
    assert.equal(api.api.stats().sse.connections, 3);
    a.close();
    await waitUntil(() => api.api.stats().sse.connections === 2, 'slot freed');
    const d = await openSse(url, as('10.0.0.4'));
    for (const x of [b, c, d]) x.close();
    await waitUntil(() => api.api.stats().sse.connections === 0, 'all freed');
  } finally {
    await api.close();
  }
});

test('SSE: a refused stream (database down) does not leak its reserved slot', async () => {
  const { src, api, url } = await setup({ sse: { maxConnections: 1, maxPerIp: 1, heartbeatMs: 60_000, pollMs: 20, slowClientMs: 500 } });
  try {
    src.down.add('*');
    for (let i = 0; i < 3; i++) await assert.rejects(openSse(url), (e: any) => e.status === 503 && e.body.error.code === 'data_unavailable');
    src.down.clear();
    const c = await openSse(url); // would be refused if the slot had leaked
    c.close();
  } finally {
    await api.close();
  }
});

test('SSE: a client that cannot keep up is dropped (bounded memory); it catches up on reconnect', async () => {
  const src = new MemoryApiSource(['alpha']);
  for (let i = 0; i < 5; i++) src.addBurn('alpha', BigInt(i + 1));
  const logs: any[] = [];
  const mgr = new SseManager({
    source: src, log: createLogger({ level: 'debug', write: (l) => logs.push(JSON.parse(l)) }),
    config: { maxConnections: 5, maxPerIp: 5, heartbeatMs: 60_000, pollMs: 20, slowClientMs: 60 },
  });
  const listeners = new Map<string, () => void>();
  const written: string[] = [];
  let destroyed = false;
  const stuck: SseResponse = { // a socket whose buffer is full and never drains
    writeHead: () => undefined,
    write: (chunk) => (written.push(chunk), !chunk.startsWith('id: ')),
    end: () => undefined,
    destroy: () => { destroyed = true; listeners.get('close')?.(); },
    once: (ev, fn) => void listeners.set(ev, fn),
    removeListener: (ev) => void listeners.delete(ev),
  };
  assert.equal(mgr.admit('1.1.1.1'), 'ok');
  mgr.open(stuck, alphaCfg, '1.1.1.1', 5, 0);
  await waitUntil(() => destroyed, 'slow client dropped');
  assert.equal(mgr.size, 0);
  assert.equal(written.filter((w) => w.startsWith('id: ')).length, 1, 'stopped reading/sending as soon as a write did not drain');
  assert.ok(logs.some((l) => l.event === 'sse_slow_client_dropped'));
});

test('SSE: shutdown tells clients, ends every stream, refuses new ones; reconnecting elsewhere loses nothing', async () => {
  const src = new MemoryApiSource(['alpha', 'beta']);
  const s1 = await startTestApi(src, { config: { shutdownGraceMs: 3_000 } }); // streams must end by themselves, not by the forced close after the grace period
  for (let i = 0; i < 3; i++) src.addBurn('alpha', BigInt(i + 1));
  const a = await openSse(`${s1.url}/api/v1/projects/alpha/stream`, { lastEventId: 0 });
  const b = await openSse(`${s1.url}/api/v1/projects/beta/stream`);
  await a.waitFor((f) => f.some((x) => x.id === '3'), 'events');
  const t0 = Date.now();
  await s1.close();
  assert.ok(Date.now() - t0 < 1_000, `close took ${Date.now() - t0} ms`);
  await Promise.all([a.ended, b.ended]);
  assert.ok(a.frames.some((f) => f.event === 'shutdown') && b.frames.some((f) => f.event === 'shutdown'));
  assert.equal(s1.api.stats().sse.connections, 0);
  await assert.rejects(openSse(`${s1.url}/api/v1/projects/alpha/stream`)); // port closed

  // a "restart": events written meanwhile are found by the new server through the shared storage
  src.addBurn('alpha', 4n);
  src.addMutation('alpha', 'l1', 1);
  const s2 = await startTestApi(src);
  try {
    const last = Math.max(...eventIds(a));
    const again = await openSse(`${s2.url}/api/v1/projects/alpha/stream`, { lastEventId: last });
    await again.waitFor((f) => f.some((x) => x.id === '5'), 'catch-up after restart');
    assert.deepEqual(eventIds(again), [4, 5]);
    src.addBurn('alpha', 6n);
    await again.waitFor((f) => f.some((x) => x.id === '6'), 'live after restart');
    assert.deepEqual([...eventIds(a), ...eventIds(again)], range(1, 6)); // ids are stable across restarts
    again.close();
  } finally {
    await s2.close();
  }
});

test('SSE: many simultaneous clients share one poller per project and all receive the same ordered events', async () => {
  const { src, api, url } = await setup();
  try {
    const clients = await Promise.all(Array.from({ length: 25 }, () => openSse(url, { lastEventId: 0 })));
    const before = src.calls.latest;
    for (let i = 1; i <= 30; i++) src.addBurn('alpha', BigInt(i));
    await Promise.all(clients.map((c) => c.waitFor((f) => f.some((x) => x.id === '30'), 'all events')));
    for (const c of clients) assert.deepEqual(eventIds(c), range(1, 30));
    const polls = src.calls.latest - before;
    assert.ok(polls < 25 * 10, `head polling must not scale with clients (polls=${polls})`);
    clients.forEach((c) => c.close());
    await waitUntil(() => api.api.stats().sse.connections === 0, 'freed');
  } finally {
    await api.close();
  }
});
