# Solana Token Engine

Universal, frontend-agnostic engine that counts verified SPL token burns (Token / Token-2022) and drives configurable level progression for any number of tokens.

```sh
npm install
npm run check                      # types + unit tests (PostgreSQL tests are skipped without TEST_DATABASE_URL)
```

## PostgreSQL

```sh
export DATABASE_URL=postgres://user:pass@host:5432/db   # never logged
npm run db:migrate                                      # applies migrations/ (idempotent)
```

```ts
const pool = createPool(loadDbConfig());
const store = await PgStore.create(pool, registry.list());   // registers projects, checks immutable settings
if (await store.tryLockProject(project.id)) new Indexer({ project, rpc, store }).run(signal, 2000);
```

## Run the engine

```sh
cp .env.example .env     # set SOLANA_RPC_URL, DATABASE_URL, PROJECTS_CONFIG (no secret is ever committed)
npm start                # applies migrations, then watches every configured project
```

JSON logs on stdout; `SIGTERM`/`SIGINT` stop it cleanly (no new RPC reads, in-flight work finishes, leases and
connections released); `SIGUSR2` logs the internal status including per-project RPC request counters and a
local credit *estimate* (not the provider's billing). Polling and rate limits are set in `.env.example`.

## HTTP API (read-only)

Started with the engine (`HTTP_*` / `SSE_*` / `CORS_ORIGINS` in `.env.example`). Only `GET`/`HEAD`/`OPTIONS` exist: nothing public can trigger a burn,
a mutation or a configuration change. Token amounts are always decimal **strings** (`*Raw` = base units, the unprefixed twin = human units); event ids are strings.
Errors: `{ "error": { "code", "message" } }` (400 invalid parameter, 403 origin, 404, 405, 429 + `Retry-After`, 503 `data_unavailable` / `overloaded` / `shutting_down`).

| Route | Purpose |
|---|---|
| `GET /health/live` | process is up (never throttled) |
| `GET /health/ready` | 200 only if PostgreSQL answers and the engine is running (a degraded *project* does not make the instance unready) |
| `GET /api/v1/projects` | public metadata + levels of every token |
| `GET /api/v1/projects/:id/status` | `data.state` = `synced` or `incomplete` (+ `reasons`), `data.history.complete` (true only after supply reconciliation), totals, current level, `latestEventId`. When the database cannot be read: **503 `data_unavailable`** with `"dataState":"unavailable"` |
| `GET /api/v1/projects/:id/progression` | level, next level, remaining amount, progress in basis points, every level with `reached`/`reachedAt` |
| `GET /api/v1/projects/:id/burns?limit=50&cursor=` | finalized burns, newest first (limit ≤ 200, `page.nextCursor` is opaque) |
| `GET /api/v1/projects/:id/events?after=0&limit=100` | event log, ascending (limit ≤ 500): `burn` and `mutation` events with stable ids; poll with `after=page.nextAfter` |
| `GET /api/v1/projects/:id/stream` | Server-Sent Events: same events, live |

**SSE contract.** Events come only from finalized, committed data (the `project_events` table), so history and live use one read path and cannot disagree.
Each frame is `id: <n>` / `event: burn|mutation` / `data: <same JSON as /events>`; other frames: `ready` (first, no id), `reset`, `shutdown`, and `: hb` comments.
Reconnect with `Last-Event-ID: <last id>` (browsers do it by themselves) or `?after=<id>` on the first connection: the server replays everything after it, then continues live.
Without it you get live events only (`ready.resumeAfter` tells where you are; use `/events` for history). Delivery is **at least once from your last id** — de-duplicate by `id`
(ids are strictly increasing per project; across restarts they are stable). On `reset` (your id is ahead of the server's log, e.g. restored database) refetch state from REST.
`shutdown` means reconnect (it resumes where it stopped).

Devnet validation (real transactions, no Mainnet): see [`docs/DEVNET.md`](docs/DEVNET.md) — `npm run devnet:wallet | devnet:observe | devnet:simulate | devnet:e2e`.

Real-database tests: create a dedicated database whose name contains `test`, then
`TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/engine_test npm test` (each test uses its own schema, dropped afterwards).

See `DECISIONS.md` for architecture decisions and `CLAUDE.md` for project rules.
