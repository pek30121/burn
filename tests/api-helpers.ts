/* Test tools for the HTTP API: an in-memory twin of the PgStore read side (with fault injection),
 * a raw HTTP requester, a tiny SSE client, and a ready-made API server factory. */
import { request as httpRequest } from 'node:http';
import { StoreError } from '../src/db/errors.ts';
import { createApiServer, type ApiConfig, type ApiRuntime, type ApiServer } from '../src/api/http.ts';
import type { ApiSource, ReachedLevel, StoredBurnRow, StoredEvent } from '../src/api/types.ts';
import { emptyState, type IndexState, type Totals } from '../src/indexer/store.ts';
import type { RunnerSnapshot } from '../src/engine/runner.ts';
import { createLogger } from '../src/engine/logger.ts';
import { parseProjectConfig, type ProjectConfig } from '../src/config/schema.ts';
import { MINT_A, MINT_B, projectInput, randomPubkey, randomSignature } from './helpers.ts';

export const alphaCfg = parseProjectConfig(projectInput({ id: 'alpha' }));
export const betaCfg = parseProjectConfig(projectInput({ id: 'beta', mint: MINT_B, name: 'Beta', ticker: 'BETA' }));

export class MemoryApiSource implements ApiSource {
  readonly events = new Map<string, StoredEvent[]>();
  readonly states = new Map<string, IndexState>();
  readonly finalized = new Map<string, bigint>();
  readonly pending = new Map<string, bigint>();
  readonly reached = new Map<string, ReachedLevel[]>();
  /** Projects whose reads throw StoreError ("*" = the whole database). */
  readonly down = new Set<string>();
  /** Extra latency per read, to exercise concurrency limits. */
  delayMs = 0;
  throwUnexpected: Error | null = null;
  calls = { latest: 0, after: 0 };

  constructor(ids: readonly string[]) {
    for (const id of ids) {
      this.events.set(id, []);
      this.finalized.set(id, 0n);
      this.pending.set(id, 0n);
      this.reached.set(id, []);
      this.states.set(id, { ...emptyState(), finalizedHead: 'headsig', finalizedHeadSlot: 100, backfill: 'done_exhausted' });
    }
  }

  async #guard(id?: string): Promise<void> {
    if (this.throwUnexpected) throw this.throwUnexpected;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.down.has('*') || (id && this.down.has(id))) throw new StoreError('injected outage');
  }

  addBurn(id: string, amountRaw = 100n, o: { slot?: number } = {}): number {
    const list = this.events.get(id)!;
    const seq = list.length + 1;
    list.push({
      id: seq, type: 'burn', createdAt: new Date(1_700_000_000_000 + seq * 1000),
      burn: { signature: randomSignature(), instructionPath: '0', slot: o.slot ?? 1000 + seq, blockTime: 1_700_000_000 + seq, owner: randomPubkey(), amountRaw, finalizedAt: new Date(1_700_000_000_000 + seq * 1000) },
    });
    this.finalized.set(id, this.finalized.get(id)! + amountRaw);
    return seq;
  }

  addMutation(id: string, levelId: string, levelIndex: number): number {
    const list = this.events.get(id)!;
    const seq = list.length + 1;
    list.push({ id: seq, type: 'mutation', createdAt: new Date(1_700_000_000_000 + seq * 1000), mutation: { levelId, levelIndex, totalRaw: this.finalized.get(id)!, triggeredBy: 'sig#0' } });
    this.reached.get(id)!.push({ levelId, at: new Date(1_700_000_000_000 + seq * 1000), triggeredBy: 'sig#0' });
    return seq;
  }

  async latestEventId(id: string) {
    this.calls.latest++;
    await this.#guard(id);
    return this.events.get(id)!.length;
  }
  async eventsAfter(id: string, after: number, limit: number) {
    this.calls.after++;
    await this.#guard(id);
    return this.events.get(id)!.filter((e) => e.id > after).slice(0, limit);
  }
  async burnsPage(id: string, before: number | null, limit: number): Promise<StoredBurnRow[]> {
    await this.#guard(id);
    return this.events.get(id)!.filter((e): e is Extract<StoredEvent, { type: 'burn' }> => e.type === 'burn' && (before === null || e.id < before))
      .reverse().slice(0, limit).map((e) => ({ id: e.id, burn: e.burn }));
  }
  async reachedLevels(id: string) {
    await this.#guard(id);
    return [...this.reached.get(id)!];
  }
  async peekState(id: string) {
    await this.#guard(id);
    return structuredClone(this.states.get(id)!);
  }
  async totals(id: string): Promise<Totals> {
    await this.#guard(id);
    return { finalizedRaw: this.finalized.get(id)!, confirmedRaw: this.finalized.get(id)! + this.pending.get(id)!, count: this.events.get(id)!.length };
  }
  async ping() {
    await this.#guard();
  }
}

export function apiConfig(over: Partial<ApiConfig> = {}): ApiConfig {
  return {
    host: '127.0.0.1', port: 0, corsOrigins: ['https://app.example'], trustProxy: false, rateLimitPerMinute: 10_000,
    sse: { maxConnections: 50, maxPerIp: 50, heartbeatMs: 60_000, pollMs: 20, slowClientMs: 500 },
    statusCacheMs: 0, dbConcurrency: 4, dbQueue: 50, shutdownGraceMs: 300, ...over,
  };
}

export const healthyRunner = (over: Partial<RunnerSnapshot> = {}): RunnerSnapshot => ({ state: 'idle', consecutiveFailures: 0, lastSyncAt: '2026-01-01T00:00:00.000Z', lastError: 'internal text that must never be public', holdsLease: true, ...over });

export interface TestApi {
  api: ApiServer;
  url: string;
  runtime: { state: 'running' | 'stopping' | 'stopped'; runners: Record<string, RunnerSnapshot | null> };
  clock: { t: number };
  logs: any[];
  close(): Promise<void>;
}

export async function startTestApi(source: ApiSource, o: { projects?: readonly ProjectConfig[]; config?: Partial<ApiConfig> } = {}): Promise<TestApi> {
  const projects = o.projects ?? [alphaCfg, betaCfg];
  const runtime = { state: 'running' as 'running' | 'stopping' | 'stopped', runners: Object.fromEntries(projects.map((p) => [p.id, healthyRunner() as RunnerSnapshot | null])) };
  const clock = { t: 1_000_000 };
  const logs: any[] = [];
  const rt: ApiRuntime = { engineState: () => runtime.state, runner: (id) => runtime.runners[id] ?? null };
  const api = createApiServer({ source, projects, runtime: rt, config: apiConfig(o.config), log: createLogger({ level: 'debug', write: (l) => logs.push(JSON.parse(l)) }), now: () => clock.t });
  const port = await api.listen();
  return { api, url: `http://127.0.0.1:${port}`, runtime, clock, logs, close: () => api.close() };
}

export interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any;
}

export function get(url: string, o: { method?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: o.method ?? 'GET', headers: o.headers }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export interface Frame {
  id: string | null;
  event: string;
  data: any;
}

export interface SseClient {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  frames: Frame[];
  comments: string[];
  ended: Promise<void>;
  close(): void;
  waitFor(pred: (f: Frame[]) => boolean, what: string, ms?: number): Promise<void>;
}

/** Opens an event stream. Rejects with the JSON error response when the server refuses it. */
export function openSse(url: string, o: { lastEventId?: string | number; headers?: Record<string, string> } = {}): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Accept: 'text/event-stream', ...(o.headers ?? {}) };
    if (o.lastEventId !== undefined) headers['Last-Event-ID'] = String(o.lastEventId);
    const req = httpRequest(url, { headers }, (res) => {
      const frames: Frame[] = [];
      const comments: string[] = [];
      let buf = '';
      let ended!: () => void;
      const endedP = new Promise<void>((r) => (ended = r));
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => reject(Object.assign(new Error(`stream refused: ${res.statusCode}`), { status: res.statusCode, body: body ? JSON.parse(body) : null, headers: res.headers })));
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let id: string | null = null;
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) comments.push(line);
            else if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) frames.push({ id, event, data: JSON.parse(data) });
        }
      });
      res.on('end', ended);
      res.on('close', ended);
      res.on('error', ended);
      const client: SseClient = {
        status: 200, headers: res.headers, frames, comments, ended: endedP,
        close: () => req.destroy(),
        async waitFor(pred, what, ms = 5_000) {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            if (pred(frames)) return;
            await new Promise((r) => setTimeout(r, 5));
          }
          throw new Error(`timed out waiting for ${what}; got ${frames.map((f) => f.id ?? f.event).join(',')}`);
        },
      };
      resolve(client);
    });
    req.on('error', reject);
    req.end();
  });
}

export const eventIds = (c: SseClient) => c.frames.filter((f) => f.id !== null).map((f) => Number(f.id));
export const waitUntil = async (cond: () => boolean | Promise<boolean>, what: string, ms = 5_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};
void MINT_A;
