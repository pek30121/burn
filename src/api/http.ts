/* Read-only public HTTP API (REST + SSE) on node:http, no framework. It can only read: the
 * only methods accepted are GET/HEAD/OPTIONS, nothing here can trigger a burn, a mutation or a
 * configuration change. Public responses never contain RPC URLs, database details, error
 * texts or incident details. See README "HTTP API" for the endpoint list. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StoreError } from '../db/errors.ts';
import type { ProjectConfig } from '../config/schema.ts';
import { formatUiAmount } from '../core/amount.ts';
import { jsonSafe, type Logger } from '../engine/logger.ts';
import type { RunnerSnapshot } from '../engine/runner.ts';
import { Gate, OverloadedError, RateLimiter, TtlCache } from './limits.ts';
import { dataState, publicBurn, publicEvent, publicProgression, publicProject } from './serialize.ts';
import { SseManager, type SseConfig } from './sse.ts';
import type { ApiSource } from './types.ts';

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly corsOrigins: readonly string[];
  readonly trustProxy: boolean;
  readonly rateLimitPerMinute: number;
  readonly sse: SseConfig;
  readonly statusCacheMs: number;
  readonly dbConcurrency: number;
  readonly dbQueue: number;
  readonly shutdownGraceMs: number;
}

export interface ApiRuntime {
  engineState(): 'running' | 'stopping' | 'stopped';
  runner(projectId: string): RunnerSnapshot | null;
}

export interface ApiDeps {
  readonly source: ApiSource;
  readonly projects: readonly ProjectConfig[];
  readonly runtime: ApiRuntime;
  readonly config: ApiConfig;
  readonly log: Logger;
  readonly now?: () => number;
}

export interface ApiServer {
  listen(): Promise<number>;
  close(): Promise<void>;
  stats(): { sse: ReturnType<SseManager['stats']>; db: Gate['stats']; rateLimitedClients: number };
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.extra = extra;
  }
}

const ID = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;
const UINT = /^\d{1,15}$/;
const ROUTE = /^\/api\/v1\/projects\/([^/]+)\/(status|burns|progression|events|stream)$/;

export function createApiServer(deps: ApiDeps): ApiServer {
  const { source, config: cfg, log, runtime } = deps;
  const now = deps.now ?? Date.now;
  const byId = new Map(deps.projects.map((p) => [p.id, p]));
  const gate = new Gate(cfg.dbConcurrency, cfg.dbQueue);
  const limiter = new RateLimiter({ limit: cfg.rateLimitPerMinute, windowMs: 60_000, now });
  const cache = new TtlCache<unknown>(now);
  const sse = new SseManager({ source, config: cfg.sse, log });
  let draining = false;

  const server: Server = createServer((req, res) => {
    const t0 = now();
    handle(req, res)
      .catch((e) => sendError(req, res, e))
      .finally(() => log.debug('api_request', { method: req.method, path: (req.url ?? '').split('?')[0]?.slice(0, 120), status: res.statusCode, ms: now() - t0 }));
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = cfg.sse.maxConnections + 500;

  /* ------------------------------ plumbing ------------------------------- */

  const clientIp = (req: IncomingMessage): string => {
    if (cfg.trustProxy) {
      const last = String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim(); // appended by the one trusted proxy
      if (last && last.length <= 45) return last;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const baseHeaders = (req: IncomingMessage): Record<string, string> => {
    const h: Record<string, string> = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    const origin = req.headers.origin;
    if (cfg.corsOrigins.length) h.Vary = 'Origin';
    if (typeof origin === 'string' && cfg.corsOrigins.includes(origin)) {
      h['Access-Control-Allow-Origin'] = origin;
    }
    return h;
  };

  const sendJson = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    const payload = jsonSafe(body);
    res.writeHead(status, { ...baseHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), ...extra });
    res.end(req.method === 'HEAD' ? undefined : payload);
  };

  function sendError(req: IncomingMessage, res: ServerResponse, e: unknown): void {
    let err: ApiError;
    if (e instanceof ApiError) err = e;
    else if (e instanceof OverloadedError) err = new ApiError(503, 'overloaded', 'The server is busy, retry shortly.', { 'Retry-After': '2' });
    else if (e instanceof StoreError) {
      err = new ApiError(503, 'data_unavailable', 'Data is temporarily unavailable.', { 'Retry-After': '5' }, { dataState: 'unavailable' });
      log.warn('api_data_unavailable', { code: e.code });
    } else {
      log.error('api_error', { path: (req.url ?? '').split('?')[0]?.slice(0, 120), error: e instanceof Error ? e.message : String(e) });
      err = new ApiError(500, 'internal_error', 'Internal error.');
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(req, res, err.status, { error: { code: err.code, message: err.message }, ...err.extra }, err.headers);
  }

  const strictQuery = (url: URL, allowed: readonly string[]): URLSearchParams => {
    const seen = new Set<string>();
    for (const k of url.searchParams.keys()) {
      if (!allowed.includes(k) || seen.has(k)) throw new ApiError(400, 'invalid_parameter', `Unknown or repeated query parameter "${k.slice(0, 40)}".`);
      seen.add(k);
    }
    return url.searchParams;
  };
  const intParam = (v: string | null, name: string, min: number, max: number, def: number): number => {
    if (v === null) return def;
    const n = /^\d{1,6}$/.test(v) ? Number(v) : NaN;
    if (!(n >= min && n <= max)) throw new ApiError(400, 'invalid_parameter', `"${name}" must be an integer between ${min} and ${max}.`);
    return n;
  };
  const idParam = (v: string | null, name: string): number | null => {
    if (v === null) return null;
    if (!UINT.test(v)) throw new ApiError(400, 'invalid_parameter', `"${name}" must be a non-negative integer id.`);
    return Number(v);
  };

  /* ------------------------------- routing ------------------------------- */

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (draining) throw new ApiError(503, 'shutting_down', 'The server is shutting down.', { Connection: 'close', 'Retry-After': '5' });
    let url: URL;
    try {
      if ((req.url ?? '').length > 300) throw new Error('too long');
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      throw new ApiError(400, 'bad_request', 'Malformed request URL.');
    }
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'OPTIONS') return preflight(req, res);
    if (method !== 'GET' && method !== 'HEAD') throw new ApiError(405, 'method_not_allowed', 'This API is read-only.', { Allow: 'GET, HEAD, OPTIONS' });

    if (path !== '/health/live') {
      const rl = limiter.check(clientIp(req));
      if (!rl.allowed) throw new ApiError(429, 'rate_limited', 'Too many requests.', { 'Retry-After': String(rl.retryAfterSec) });
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !cfg.corsOrigins.includes(origin)) throw new ApiError(403, 'origin_not_allowed', 'This origin is not allowed.');

    if (path === '/health/live') return sendJson(req, res, 200, { status: 'ok' });
    if (path === '/health/ready') return ready(req, res);
    if (path === '/api/v1/projects') {
      strictQuery(url, []);
      return sendJson(req, res, 200, { data: deps.projects.map(publicProject) });
    }
    const m = ROUTE.exec(path);
    if (!m) throw new ApiError(404, 'not_found', 'Unknown route.');
    const id = m[1]!;
    const project = ID.test(id) ? byId.get(id) : undefined;
    if (!project) throw new ApiError(404, 'project_not_found', 'Unknown project.');
    switch (m[2]) {
      case 'status': return status(req, res, url, project);
      case 'progression': return progression(req, res, url, project);
      case 'burns': return burns(req, res, url, project);
      case 'events': return events(req, res, url, project);
      default: return stream(req, res, url, project);
    }
  }

  function preflight(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      if (!cfg.corsOrigins.includes(origin)) throw new ApiError(403, 'origin_not_allowed', 'This origin is not allowed.');
      res.writeHead(204, {
        ...baseHeaders(req), 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Last-Event-ID, Content-Type', 'Access-Control-Max-Age': '600',
      });
    } else {
      res.writeHead(204, { ...baseHeaders(req), Allow: 'GET, HEAD, OPTIONS' });
    }
    res.end();
  }

  async function ready(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const checks = await cache.get('ready', 1_000, async () => {
      let database: 'ok' | 'unavailable' = 'ok';
      try {
        await source.ping();
      } catch {
        database = 'unavailable';
      }
      return { database };
    }) as { database: 'ok' | 'unavailable' };
    const engine = runtime.engineState();
    const ok = checks.database === 'ok' && engine === 'running';
    sendJson(req, res, ok ? 200 : 503, { status: ok ? 'ready' : 'not_ready', checks: { database: checks.database, engine } });
  }

  interface ReadModel {
    state: Awaited<ReturnType<ApiSource['peekState']>>;
    totals: Awaited<ReturnType<ApiSource['totals']>>;
    reached: Awaited<ReturnType<ApiSource['reachedLevels']>>;
    latest: number;
  }
  /** Cached per project so that public traffic costs a handful of queries per interval, not per request. */
  const readModel = (p: ProjectConfig): Promise<ReadModel> =>
    cache.get(`rm:${p.id}`, cfg.statusCacheMs, () =>
      gate.run(async () => ({
        state: await source.peekState(p.id), totals: await source.totals(p.id), reached: await source.reachedLevels(p.id), latest: await source.latestEventId(p.id),
      })),
    ) as Promise<ReadModel>;

  async function status(req: IncomingMessage, res: ServerResponse, url: URL, p: ProjectConfig): Promise<void> {
    strictQuery(url, []);
    const rm = await readModel(p);
    const pending = rm.totals.confirmedRaw - rm.totals.finalizedRaw;
    const prog = publicProgression(p, rm.totals.finalizedRaw, rm.reached);
    sendJson(req, res, 200, {
      project: { id: p.id, name: p.name, ticker: p.ticker, cluster: p.cluster, mint: p.mint },
      engine: runtime.engineState(),
      data: dataState(rm.state, runtime.runner(p.id)),
      totals: {
        finalizedRaw: rm.totals.finalizedRaw.toString(), finalized: prog.total.ui,
        pendingFinalizationRaw: pending.toString(), pendingFinalization: formatUiAmount(pending, p.decimals),
      },
      progression: { level: prog.level, nextLevel: prog.nextLevel, levelProgressBps: prog.levelProgressBps, maxed: prog.maxed },
      latestEventId: String(rm.latest),
    });
  }

  async function progression(req: IncomingMessage, res: ServerResponse, url: URL, p: ProjectConfig): Promise<void> {
    strictQuery(url, []);
    const rm = await readModel(p);
    const d = dataState(rm.state, runtime.runner(p.id));
    sendJson(req, res, 200, { ...publicProgression(p, rm.totals.finalizedRaw, rm.reached), data: { state: d.state, reasons: d.reasons } });
  }

  async function burns(req: IncomingMessage, res: ServerResponse, url: URL, p: ProjectConfig): Promise<void> {
    const q = strictQuery(url, ['limit', 'cursor']);
    const limit = intParam(q.get('limit'), 'limit', 1, 200, 50);
    const before = idParam(q.get('cursor'), 'cursor');
    const rows = await gate.run(() => source.burnsPage(p.id, before, limit + 1));
    const page = rows.slice(0, limit);
    sendJson(req, res, 200, {
      data: page.map((r) => ({ id: String(r.id), ...publicBurn(p, r.burn) })),
      page: { limit, nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null },
    });
  }

  async function events(req: IncomingMessage, res: ServerResponse, url: URL, p: ProjectConfig): Promise<void> {
    const q = strictQuery(url, ['limit', 'after']);
    const limit = intParam(q.get('limit'), 'limit', 1, 500, 100);
    const after = idParam(q.get('after'), 'after') ?? 0;
    const [list, latest] = await gate.run(async () => [await source.eventsAfter(p.id, after, limit), await source.latestEventId(p.id)] as const);
    const last = list[list.length - 1];
    sendJson(req, res, 200, {
      data: list.map((e) => publicEvent(p, e)),
      page: { limit, after: String(after), nextAfter: String(last?.id ?? after), latestId: String(latest), hasMore: (last?.id ?? after) < latest },
    });
  }

  async function stream(req: IncomingMessage, res: ServerResponse, url: URL, p: ProjectConfig): Promise<void> {
    if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Streams are GET only.', { Allow: 'GET' });
    const q = strictQuery(url, ['after']);
    const header = req.headers['last-event-id'];
    const fromHeader = typeof header === 'string' && header !== '' ? header : null;
    if (fromHeader !== null && !UINT.test(fromHeader)) throw new ApiError(400, 'invalid_last_event_id', 'Last-Event-ID must be a numeric event id.');
    const after = fromHeader !== null ? Number(fromHeader) : idParam(q.get('after'), 'after');
    const ip = clientIp(req);
    const admitted = sse.admit(ip);
    if (admitted === 'capacity') throw new ApiError(503, 'stream_capacity', 'Too many open streams.', { 'Retry-After': '5' });
    if (admitted === 'ip_limit') throw new ApiError(429, 'too_many_streams', 'Too many open streams for this client.', { 'Retry-After': '5' });
    if (admitted === 'closing') throw new ApiError(503, 'shutting_down', 'The server is shutting down.', { 'Retry-After': '5' });
    let head: number;
    try {
      head = await gate.run(() => source.latestEventId(p.id));
    } catch (e) {
      sse.cancel(ip);
      throw e;
    }
    sse.open(res, p, ip, head, after, baseHeaders(req));
  }

  /* ------------------------------ lifecycle ------------------------------ */

  return {
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', (e: NodeJS.ErrnoException) => reject(new Error(`HTTP server cannot listen (${e.code ?? 'error'})`)));
        server.listen(cfg.port, cfg.host, () => {
          const port = (server.address() as AddressInfo).port;
          log.info('api_listening', { host: cfg.host, port });
          resolve(port);
        });
      }),
    async close() {
      draining = true;
      await sse.closeAll();
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeIdleConnections();
      const timer = setTimeout(() => server.closeAllConnections(), cfg.shutdownGraceMs);
      await closed;
      clearTimeout(timer);
    },
    stats: () => ({ sse: sse.stats(), db: gate.stats, rateLimitedClients: limiter.size }),
  };
}
