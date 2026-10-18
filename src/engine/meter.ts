/* Counts the HTTP requests really sent to the RPC (retries included), per project and
 * per method, and turns them into a LOCAL credit estimate. The estimate comes from
 * configurable per-method costs and is NOT the provider's billing. The same wrapper
 * applies the shared request limiter, so throttling covers retries too. */

import { RequestLimiter, ShutdownError } from './limiter.ts';

type Outcome = 'ok' | 'error' | 'rate_limited';
interface Counts {
  requests: number;
  errors: number;
  rateLimited: number;
}
const zero = (): Counts => ({ requests: 0, errors: 0, rateLimited: 0 });

export interface MeterSnapshot {
  note: string;
  since: string;
  total: Counts & { estimatedCredits: number };
  projects: Record<string, Counts & { estimatedCredits: number; byMethod: Record<string, Counts> }>;
}

export class RpcMeter {
  readonly #costs: Readonly<Record<string, number>>;
  readonly #since: string;
  readonly #byProject = new Map<string, Map<string, Counts>>();

  constructor(costs: Readonly<Record<string, number>>, now: () => Date = () => new Date()) {
    this.#costs = costs;
    this.#since = now().toISOString();
  }

  record(project: string, method: string, outcome: Outcome): void {
    let methods = this.#byProject.get(project);
    if (!methods) this.#byProject.set(project, (methods = new Map()));
    let c = methods.get(method);
    if (!c) methods.set(method, (c = zero()));
    c.requests++;
    if (outcome === 'error') c.errors++;
    if (outcome === 'rate_limited') c.rateLimited++;
  }

  snapshot(): MeterSnapshot {
    const total = { ...zero(), estimatedCredits: 0 };
    const projects: MeterSnapshot['projects'] = {};
    for (const [id, methods] of this.#byProject) {
      const p = { ...zero(), estimatedCredits: 0, byMethod: {} as Record<string, Counts> };
      for (const [m, c] of methods) {
        p.byMethod[m] = { ...c };
        p.requests += c.requests;
        p.errors += c.errors;
        p.rateLimited += c.rateLimited;
        p.estimatedCredits += c.requests * (this.#costs[m] ?? 1);
      }
      projects[id] = p;
      total.requests += p.requests;
      total.errors += p.errors;
      total.rateLimited += p.rateLimited;
      total.estimatedCredits += p.estimatedCredits;
    }
    return {
      note: 'Local estimate from request counts and RPC_CREDIT_COSTS. It is NOT the provider billing (e.g. Helius); check the provider dashboard for real usage.',
      since: this.#since,
      total,
      projects,
    };
  }
}

function methodOf(init?: RequestInit): string {
  try {
    if (typeof init?.body === 'string') {
      const m = (JSON.parse(init.body) as { method?: unknown }).method;
      if (typeof m === 'string') return m;
    }
  } catch {
    /* fall through */
  }
  return 'unknown';
}

export function meteredFetch(o: { base: typeof fetch; project: string; meter: RpcMeter; limiter: RequestLimiter }): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const release = await o.limiter.acquire(); // throws ShutdownError once draining
    const method = methodOf(init);
    try {
      const res = await o.base(input, init);
      o.meter.record(o.project, method, res.status === 429 ? 'rate_limited' : res.ok ? 'ok' : 'error');
      return res;
    } catch (e) {
      o.meter.record(o.project, method, 'error');
      throw e;
    } finally {
      release();
    }
  }) as typeof fetch;
}

export { ShutdownError };
