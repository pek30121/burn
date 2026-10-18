/* Global request limiter shared by all projects: at most `maxConcurrent` requests in
 * flight and at least `minIntervalMs` between two request starts. FIFO, so no project
 * starves another. drain() is the shutdown switch: queued and future requests are
 * refused, requests already in flight are left to finish. */

export class ShutdownError extends Error {
  override name = 'ShutdownError';
  constructor() {
    super('shutting down');
  }
}

export interface LimiterOptions {
  readonly maxConcurrent: number;
  readonly minIntervalMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (e: Error) => void;
}

export class RequestLimiter {
  readonly #max: number;
  readonly #interval: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #queue: Waiter[] = [];
  #active = 0;
  #lastStart = Number.NEGATIVE_INFINITY;
  #pumping = false;
  #draining = false;

  constructor(o: LimiterOptions) {
    this.#max = o.maxConcurrent;
    this.#interval = o.minIntervalMs;
    this.#now = o.now ?? Date.now;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  acquire(): Promise<() => void> {
    if (this.#draining) return Promise.reject(new ShutdownError());
    return new Promise((resolve, reject) => {
      this.#queue.push({ resolve, reject });
      void this.#pump();
    });
  }

  drain(): void {
    this.#draining = true;
    for (const w of this.#queue.splice(0)) w.reject(new ShutdownError());
  }

  get stats(): { active: number; queued: number } {
    return { active: this.#active, queued: this.#queue.length };
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#queue.length > 0 && !this.#draining && this.#active < this.#max) {
        const wait = this.#lastStart + this.#interval - this.#now();
        if (wait > 0) await this.#sleep(wait);
        const w = this.#draining ? undefined : this.#queue.shift();
        if (!w) break;
        this.#active++;
        this.#lastStart = this.#now();
        let released = false;
        w.resolve(() => {
          if (released) return;
          released = true;
          this.#active--;
          void this.#pump();
        });
      }
    } finally {
      this.#pumping = false;
    }
  }
}
