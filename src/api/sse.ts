/* Server-Sent Events, backed by the durable event log (never by in-memory events).
 *
 * One read path for history AND live: every client has a cursor (the last event id it was
 * sent) and always reads "events with id > cursor" from the database, in id order. A shared
 * per-project poller only decides WHEN to wake clients (one cheap query per interval,
 * whatever the number of clients). Because ids are allocated under a row lock and commit in
 * id order (migration 0002), a reader never sees id N+1 without id N: there is no gap
 * between catch-up and live, and a restart or reconnection with Last-Event-ID resumes
 * exactly after the last event received. Delivery is "at least once from the client's last
 * acknowledged id": clients must de-duplicate by id.
 *
 * Slow clients: when a write does not drain within slowClientMs the connection is dropped (the
 * client reconnects with Last-Event-ID and catches up); we never buffer without bound. */

import type { Logger } from '../engine/logger.ts';
import type { ProjectConfig } from '../config/schema.ts';
import { publicEvent } from './serialize.ts';
import type { ApiSource } from './types.ts';

export interface SseConfig {
  readonly maxConnections: number;
  readonly maxPerIp: number;
  readonly heartbeatMs: number;
  readonly pollMs: number;
  readonly slowClientMs: number;
}

/** The slice of http.ServerResponse that we use (lets tests plug in a fake). */
export interface SseResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): boolean;
  end(): unknown;
  destroy(): unknown;
  once(event: 'drain' | 'close', fn: () => void): unknown;
  removeListener(event: 'drain' | 'close', fn: () => void): unknown;
}

const BATCH = 100;

interface Conn {
  readonly project: ProjectConfig;
  readonly res: SseResponse;
  readonly ip: string;
  cursor: number;
  closed: boolean;
  pumping: boolean;
  again: boolean;
  needsRetry: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
}

interface Hub {
  readonly conns: Set<Conn>;
  timer: ReturnType<typeof setInterval> | null;
  lastHead: number;
  polling: boolean;
  failing: boolean;
}

export class SseManager {
  readonly #source: ApiSource;
  readonly #cfg: SseConfig;
  readonly #log: Logger;
  readonly #hubs = new Map<string, Hub>();
  readonly #perIp = new Map<string, number>();
  #total = 0;
  #closing = false;

  constructor(o: { source: ApiSource; config: SseConfig; log: Logger }) {
    this.#source = o.source;
    this.#cfg = o.config;
    this.#log = o.log;
  }

  get size(): number {
    return this.#total;
  }

  stats(): { connections: number; byProject: Record<string, number> } {
    return { connections: this.#total, byProject: Object.fromEntries([...this.#hubs].map(([id, h]) => [id, h.conns.size])) };
  }

  /** Reserves a slot or says why not. Call open() right after a successful admit(). */
  admit(ip: string): 'ok' | 'capacity' | 'ip_limit' | 'closing' {
    if (this.#closing) return 'closing';
    if (this.#total >= this.#cfg.maxConnections) return 'capacity';
    if ((this.#perIp.get(ip) ?? 0) >= this.#cfg.maxPerIp) return 'ip_limit';
    this.#total++;
    this.#perIp.set(ip, (this.#perIp.get(ip) ?? 0) + 1);
    return 'ok';
  }

  /** Gives back a slot reserved by admit() when the stream could not be opened. */
  cancel(ip: string): void {
    this.#total--;
    const n = (this.#perIp.get(ip) ?? 1) - 1;
    if (n <= 0) this.#perIp.delete(ip);
    else this.#perIp.set(ip, n);
  }

  /** `head` = latest event id read before the response started; `after` = client cursor (null = live only). */
  open(res: SseResponse, project: ProjectConfig, ip: string, head: number, after: number | null, extraHeaders: Record<string, string> = {}): void {
    res.writeHead(200, {
      ...extraHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const reset = after !== null && after > head; // the stored log is behind the client: the client must resync
    const c: Conn = { project, res, ip, cursor: reset || after === null ? head : after, closed: false, pumping: false, again: false, needsRetry: false, heartbeat: null };
    let hub = this.#hubs.get(project.id);
    if (!hub) this.#hubs.set(project.id, (hub = { conns: new Set(), timer: null, lastHead: -1, polling: false, failing: false }));
    hub.conns.add(c);
    res.once('close', () => this.#release(c));

    res.write('retry: 3000\n\n');
    if (reset) res.write(`event: reset\ndata: ${JSON.stringify({ latestId: String(head), reason: 'client_cursor_ahead_of_log' })}\n\n`);
    res.write(`event: ready\ndata: ${JSON.stringify({ projectId: project.id, latestId: String(head), resumeAfter: String(c.cursor) })}\n\n`);
    c.heartbeat = setInterval(() => void this.#send(c, ': hb\n\n'), this.#cfg.heartbeatMs);
    c.heartbeat.unref();
    if (!hub.timer) {
      hub.timer = setInterval(() => void this.#tick(project.id), this.#cfg.pollMs);
      hub.timer.unref();
    }
    void this.#pump(c); // first catch-up right away
  }

  /** Refuses new connections, tells clients to reconnect elsewhere/later, ends every stream. */
  async closeAll(): Promise<void> {
    this.#closing = true;
    for (const hub of this.#hubs.values()) {
      for (const c of [...hub.conns]) {
        if (!c.closed) {
          try {
            c.res.write('event: shutdown\ndata: {}\n\n');
            c.res.end();
          } catch {
            /* already gone */
          }
        }
        this.#release(c);
      }
    }
  }

  async #tick(projectId: string): Promise<void> {
    const hub = this.#hubs.get(projectId);
    if (!hub || hub.polling) return;
    hub.polling = true;
    try {
      const head = await this.#source.latestEventId(projectId);
      if (hub.failing) this.#log.info('sse_source_recovered', { project: projectId });
      hub.failing = false;
      const moved = head !== hub.lastHead;
      hub.lastHead = head;
      for (const c of [...hub.conns]) {
        if (c.cursor > head) {
          this.#reset(c, head); // the log shrank (restored database): do not stay silent
        } else if (moved || c.needsRetry) {
          c.needsRetry = false;
          void this.#pump(c);
        }
      }
    } catch (e) {
      if (!hub.failing) this.#log.warn('sse_source_unavailable', { project: projectId, error: e instanceof Error ? e.message : String(e) });
      hub.failing = true;
      hub.lastHead = -1; // wake everybody as soon as the source answers again
    } finally {
      hub.polling = false;
    }
  }

  #reset(c: Conn, head: number): void {
    c.cursor = head;
    void this.#send(c, `event: reset\ndata: ${JSON.stringify({ latestId: String(head), reason: 'client_cursor_ahead_of_log' })}\n\n`);
  }

  async #pump(c: Conn): Promise<void> {
    if (c.pumping) {
      c.again = true;
      return;
    }
    c.pumping = true;
    try {
      do {
        c.again = false;
        for (;;) {
          if (c.closed) return;
          const events = await this.#source.eventsAfter(c.project.id, c.cursor, BATCH);
          for (const e of events) {
            if (c.closed) return;
            const pe = publicEvent(c.project, e);
            if (!(await this.#send(c, `id: ${pe.id}\nevent: ${pe.type}\ndata: ${JSON.stringify(pe)}\n\n`))) return;
            c.cursor = e.id; // advance only after the frame was accepted
          }
          if (events.length < BATCH) break;
        }
      } while (c.again && !c.closed);
    } catch (e) {
      c.needsRetry = true; // database hiccup: the next poll tick retries from the same cursor
      this.#log.debug('sse_read_failed', { project: c.project.id, error: e instanceof Error ? e.message : String(e) });
    } finally {
      c.pumping = false;
    }
  }

  /** Writes with backpressure. Resolves false when the connection is (or just got) closed. */
  async #send(c: Conn, text: string): Promise<boolean> {
    if (c.closed) return false;
    let ok: boolean;
    try {
      ok = c.res.write(text);
    } catch {
      this.#release(c);
      return false;
    }
    if (ok) return true;
    const drained = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => done(false), this.#cfg.slowClientMs);
      const done = (v: boolean) => {
        clearTimeout(timer);
        c.res.removeListener('drain', onDrain);
        c.res.removeListener('close', onClose);
        resolve(v);
      };
      const onDrain = () => done(true);
      const onClose = () => done(false);
      c.res.once('drain', onDrain);
      c.res.once('close', onClose);
    });
    if (drained && !c.closed) return true;
    if (!c.closed) {
      this.#log.debug('sse_slow_client_dropped', { project: c.project.id });
      try {
        c.res.destroy();
      } catch {
        /* ignore */
      }
    }
    this.#release(c);
    return false;
  }

  #release(c: Conn): void {
    if (c.closed) return;
    c.closed = true;
    if (c.heartbeat) clearInterval(c.heartbeat);
    this.#total--;
    const n = (this.#perIp.get(c.ip) ?? 1) - 1;
    if (n <= 0) this.#perIp.delete(c.ip);
    else this.#perIp.set(c.ip, n);
    const hub = this.#hubs.get(c.project.id);
    if (hub) {
      hub.conns.delete(c);
      if (hub.conns.size === 0) {
        if (hub.timer) clearInterval(hub.timer);
        this.#hubs.delete(c.project.id);
      }
    }
  }
}
