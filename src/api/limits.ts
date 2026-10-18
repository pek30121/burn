/* Small resource guards for the public API. All state is per process (see DECISIONS D20). */

export class OverloadedError extends Error {
  override name = 'OverloadedError';
}

/** Fixed-window request counter per key (client address). Memory is bounded. */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, { start: number; count: number }>();

  constructor(o: { limit: number; windowMs: number; maxKeys?: number; now?: () => number }) {
    this.#limit = o.limit;
    this.#windowMs = o.windowMs;
    this.#maxKeys = o.maxKeys ?? 10_000;
    this.#now = o.now ?? Date.now;
  }

  check(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = this.#now();
    let h = this.#hits.get(key);
    if (!h || now - h.start >= this.#windowMs) {
      if (!h && this.#hits.size >= this.#maxKeys) this.#evict(now);
      h = { start: now, count: 0 };
      this.#hits.set(key, h);
    }
    h.count++;
    return { allowed: h.count <= this.#limit, retryAfterSec: Math.max(1, Math.ceil((h.start + this.#windowMs - now) / 1000)) };
  }

  #evict(now: number): void {
    for (const [k, h] of this.#hits) if (now - h.start >= this.#windowMs) this.#hits.delete(k);
    for (const k of this.#hits.keys()) {
      if (this.#hits.size < this.#maxKeys) break;
      this.#hits.delete(k); // still full: drop the oldest keys
    }
  }

  get size(): number {
    return this.#hits.size;
  }
}

/** At most `maxConcurrent` running and `maxQueue` waiting; beyond that, fail fast instead of piling up. */
export class Gate {
  readonly #max: number;
  readonly #maxQueue: number;
  #active = 0;
  readonly #queue: (() => void)[] = [];

  constructor(maxConcurrent: number, maxQueue: number) {
    this.#max = maxConcurrent;
    this.#maxQueue = maxQueue;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#max) {
      if (this.#queue.length >= this.#maxQueue) throw new OverloadedError('too many concurrent database reads');
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    } else {
      this.#active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.#queue.shift();
      if (next) next(); // hand our slot over
      else this.#active--;
    }
  }

  get stats(): { active: number; queued: number } {
    return { active: this.#active, queued: this.#queue.length };
  }
}

/** Short-lived cache with in-flight de-duplication; failures are never cached. */
export class TtlCache<T> {
  readonly #entries = new Map<string, { at: number; value?: T; pending?: Promise<T> }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async get(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const e = this.#entries.get(key);
    if (e?.pending) return e.pending;
    if (e && e.value !== undefined && this.#now() - e.at < ttlMs) return e.value;
    const pending = load().then(
      (value) => {
        this.#entries.set(key, { at: this.#now(), value });
        return value;
      },
      (err) => {
        this.#entries.delete(key);
        throw err;
      },
    );
    this.#entries.set(key, { at: e?.at ?? 0, ...(e?.value !== undefined ? { value: e.value } : {}), pending });
    return pending;
  }
}
