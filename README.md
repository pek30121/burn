# Solana Token Engine

Universal, frontend-agnostic engine that counts verified SPL token burns and drives configurable level progression, for any number of Solana tokens (Pump.fun first).

Status: **step 1** — multi-token config, exact amounts, progression and the reference burn ledger. Indexer, PostgreSQL store and API come next (see `DECISIONS.md`).

```sh
npm install
npm run check   # typecheck + unit tests
```

Requires Node ≥ 22.18. Configuration: copy `.env.example` to `.env`, list projects in a JSON file like `config/projects.example.json`.
