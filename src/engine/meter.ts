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
/** Requests whose cost depends on what they returned (credits recorded per request, not a flat per-method cost). */
interface Variable {
  requests: number;
  credits: number;
}

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
  readonly #variable = new Map<string, Map<string, Variable>>();

  constructor(costs: Readonly<Record<string, number>>, now: () => Date = () => new Date()) {
    this.#costs = costs;
    this.#since = now().toISOString();
  }

  /** `credits` = this request's own estimated cost (Helius bills `getTransactionsForAddress` per transaction returned). */
  record(project: string, method: string, outcome: Outcome, credits?: number): void {
    if (credits !== undefined) {
      let vm = this.#variable.get(project);
      if (!vm) this.#variable.set(project, (vm = new Map()));
      const v = vm.get(method) ?? { requests: 0, credits: 0 };
      v.requests++;
      v.credits += credits;
      vm.set(method, v);
    }
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
        const v = this.#variable.get(id)?.get(m);
        p.estimatedCredits += (c.requests - (v?.requests ?? 0)) * (this.#costs[m] ?? 1) + (v?.credits ?? 0);
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

/** Helius: 10 credits per 100 transactions returned (rounded up), 10 minimum. Read from a clone; the caller's body is untouched. */
async function bulkCredits(res: Response): Promise<number | undefined> {
  try {
    const body = (await res.clone().json()) as { result?: { data?: unknown[] }; error?: unknown };
    if (body.error) return 0; // failed responses are not billed
    const n = Array.isArray(body.result?.data) ? body.result.data.length : 0;
    return Math.max(10, Math.ceil(n / 100) * 10);
  } catch {
    return undefined; // unreadable: fall back to the flat per-method floor
  }
}

export function meteredFetch(o: { base: typeof fetch; project: string; meter: RpcMeter; limiter: RequestLimiter }): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const release = await o.limiter.acquire(); // throws ShutdownError once draining
    const method = methodOf(init);
    try {
      const res = await o.base(input, init);
      const outcome = res.status === 429 ? 'rate_limited' : res.ok ? 'ok' : 'error';
      o.meter.record(o.project, method, outcome, method === 'getTransactionsForAddress' && res.ok ? await bulkCredits(res) : undefined);
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
