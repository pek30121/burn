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

Real-database tests: create a dedicated database whose name contains `test`, then
`TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/engine_test npm test` (each test uses its own schema, dropped afterwards).

See `DECISIONS.md` for architecture decisions and `CLAUDE.md` for project rules.
