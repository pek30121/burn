# Mainnet launch runbook (engine only)

Nothing here is executed by the repository: every step is yours. The engine never signs and never sends a transaction.

## 0. Rollback is one variable
Replit Secrets: `DEPLOY_NETWORK` unset or `devnet` → the Devnet deployment (page + engine, `deploy/projects.devnet.json`) exactly as before. `DEPLOY_NETWORK=mainnet` → Mainnet mode (below). Switching back = delete/rename that secret and the `PROJECTS_CONFIG` override, then Run again. Use a **separate PostgreSQL database** for Mainnet (data is keyed by `project_id`, but never mix Devnet and Mainnet rows).

## 1. Mainnet mode (supervisor `mainnetSpecs`, fail-closed)
Engine only, read-only public API on the public port (`/api/...`, SSE). No wallet page, no `/rpc` proxy: the Helius key lives only in the engine. Refuses to start unless set: `DATABASE_URL`, `HELIUS_API_KEY`, `PROJECTS_CONFIG` (a non-Devnet file); `SOLANA_RPC_URL` must be unset. It forces `SOLANA_CLUSTER=mainnet-beta` (Helius host `mainnet.helius-rpc.com` derived by the engine). Protections already in the engine: Mainnet genesis-hash check (a Devnet endpoint is refused), H2 (`tokenProgram` = on-chain owner of the mint, else no start), retry/backoff per project, lease per project, quota monitor (`RPC_MONTHLY_CREDITS=10000000`, local estimate only), migrations on start (`MIGRATE_ON_START`, default true).

Secrets to set in Replit: `DEPLOY_NETWORK=mainnet`, `HELIUS_API_KEY`, `DATABASE_URL` (Mainnet DB), `PROJECTS_CONFIG=deploy/projects.mainnet.json`, `CORS_ORIGINS=<your front-end origin>`. `.replit [env]` sets `SOLANA_CLUSTER=devnet`; it is overridden in Mainnet mode. Deployment type: Reserved VM if the engine must never sleep (see deploy/README.md).

## 2. Add the real token (read-only)
`npm run mainnet:onboard -- <MINT> <id> <name> <TICKER>` (needs `HELIUS_API_KEY` locally). It prints program, decimals, mint authority, extensions, history, created/burned and a ready JSON entry with `initialSupply`; it refuses when the proof cannot apply. Put that entry in `deploy/projects.mainnet.json` (`{"projects":[ ... ]}`, `cluster: "mainnet-beta"`, `startSlot: 0`, your levels as raw-unit strings). Commit it (no secret inside).

## 3. First real burn (small amount)
1. Start the engine; wait for `GET /api/projects/<id>` → `data.history.complete: true` and `verification: verified`, `reason: null`.
2. Note counter `burned` (string, raw units) and the mint `supply` (`getTokenSupply`, Solscan).
3. With Phantom, burn a tiny amount of **your own** tokens (e.g. 1 token = 10^decimals raw) via BurnChecked.
4. Wait for finalization (~13 s after confirmation). The engine counts only finalized burns: expect `burned` += amount, a new row in `/api/projects/<id>/burns` with your signature, and an SSE event only if a level was crossed.
5. PostgreSQL proof: `SELECT signature, instruction_path, amount, slot FROM burns WHERE project_id='<id>' ORDER BY slot DESC LIMIT 5;` (amount raw, exactly your burn).
6. Historical proof: after the next reconcile (≤ 5 min, or right after the burn) `history.verifiedAt` is updated and `initialSupply − supply = burned` holds. Any `supply_mismatch` or `incomplete` state = stop and investigate; it is never ignored.
7. Restart the engine: counters unchanged (idempotency).
