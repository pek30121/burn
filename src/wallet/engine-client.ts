/* Reads from OUR engine's public, read-only API. This is the only source for the counter and for the
 * "your burn was counted" confirmation: a signature that was merely sent, or even finalized, never moves the
 * counter by itself (CLAUDE.md: only a transaction re-read via RPC by the engine counts). Amounts are strings. */

export interface EngineStatus {
  readonly finalizedRaw: bigint;
  readonly finalized: string;
  readonly levelId: string;
  readonly levelName: string;
  readonly latestEventId: string;
  /** false while the engine reports itself incomplete/unavailable: show the number but do not claim it is up to date. */
  readonly synced: boolean;
}

export interface CountedBurn {
  readonly eventId: string;
  readonly signature: string;
  readonly instructionPath: string;
  readonly owner: string;
  readonly amountRaw: bigint;
  readonly slot: number;
}

export interface EventsPage {
  readonly burns: readonly CountedBurn[];
  readonly nextAfter: string;
  readonly hasMore: boolean;
}

export interface EngineApi {
  getStatus(): Promise<EngineStatus>;
  eventsAfter(after: string): Promise<EventsPage>;
}

export class EngineApiError extends Error {
  override name = 'EngineApiError';
}

const UINT = /^(0|[1-9][0-9]*)$/;
const bi = (v: unknown, what: string): bigint => {
  if (typeof v !== 'string' || !UINT.test(v)) throw new EngineApiError(`malformed ${what}`);
  return BigInt(v);
};

export function createEngineClient(o: { baseUrl: string; projectId: string; fetch?: typeof fetch; timeoutMs?: number }): EngineApi {
  const doFetch = o.fetch ?? fetch;
  const base = `${o.baseUrl.replace(/\/+$/, '')}/api/v1/projects/${encodeURIComponent(o.projectId)}`;
  async function get(path: string): Promise<any> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
    } catch {
      throw new EngineApiError('engine unreachable');
    }
    if (!res.ok) throw new EngineApiError(`engine answered HTTP ${res.status}`);
    try { return await res.json(); } catch { throw new EngineApiError('engine returned invalid JSON'); }
  }
  return {
    async getStatus() {
      const j = await get('/status');
      const lvl = j?.progression?.level;
      return {
        finalizedRaw: bi(j?.totals?.finalizedRaw, 'finalizedRaw'),
        finalized: String(j?.totals?.finalized ?? ''),
        levelId: String(lvl?.id ?? ''),
        levelName: String(lvl?.name ?? ''),
        latestEventId: String(bi(j?.latestEventId, 'latestEventId')),
        synced: j?.data?.state === 'synced',
      };
    },
    async eventsAfter(after) {
      if (!UINT.test(after)) throw new EngineApiError('invalid cursor');
      const j = await get(`/events?after=${after}&limit=100`);
      if (!Array.isArray(j?.data)) throw new EngineApiError('malformed events');
      const burns: CountedBurn[] = [];
      for (const e of j.data) {
        if (e?.type !== 'burn') continue;
        burns.push({
          eventId: String(bi(e.id, 'event id')), signature: String(e.burn?.signature), instructionPath: String(e.burn?.instructionPath),
          owner: String(e.burn?.owner), amountRaw: bi(e.burn?.amountRaw, 'amountRaw'), slot: Number(e.burn?.slot),
        });
      }
      return { burns, nextAfter: String(bi(j?.page?.nextAfter, 'nextAfter')), hasMore: j?.page?.hasMore === true };
    },
  };
}
