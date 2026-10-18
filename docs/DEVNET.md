# Devnet validation

Everything here targets **Solana Devnet only**: the scripts check the RPC genesis hash and refuse anything else. They never touch Mainnet and never ask for real SOL.

## Setup
```sh
export TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/engine_test   # dedicated DB, name contains "test"; one throw-away schema per run
npm run devnet:wallet     # creates .devnet/wallet.json (0600, git-ignored) and prints ONLY the public address + balance
```
The private key stays in `.devnet/wallet.json`. It is never printed, logged or committed (`.devnet/` is git-ignored; the key class refuses to serialize). If the faucet RPC refuses, fund the printed **public** address at <https://faucet.solana.com> (0.1 SOL is enough; the scenario spends about 0.015 SOL).

## Commands
| Command | Needs funds | What it proves |
|---|---|---|
| `npm run devnet:observe` | no | the whole engine (real RPC client, PostgreSQL, indexers, REST, SSE) on **real burns made by others** (one direct, one by CPI): exact amounts, finalized-only indexing, persistence, SSE = REST, `Last-Event-ID`, restart without loss, RPC outage (local pass-through proxy, real data behind it) |
| `npm run devnet:simulate` | no (nothing is sent) | our token instructions (create, mint, `Burn`, `BurnChecked`, revoke) run on the **real Devnet runtime** via `simulateTransaction`: exact supply arithmetic, authority revoked, runtime rejects wrong decimals / over-burn / mint after revoke |
| `npm run devnet:e2e` | **yes** | our own real transactions end to end: tokens created, burns below / across / over several thresholds, one tx with two burns, burn while the engine is down, RPC outage, restarts, no mutation before finalization, supply reconciliation proving completeness, SSE reconnection |

`devnet:e2e` prints every transaction signature (all FINALIZED) and writes `.devnet/results/*.json`.

## Not covered (and why)
* **Burn by CPI with our own transaction**: needs a deployed program (build toolchain + SOL for deployment). CPI parsing is validated on real third-party CPI burns (`tests/fixtures/devnet-cpi-burn-*.json`, `devnet:observe`).
* **Token-2022**: the program account `TokenzQd…` does not exist on this Devnet (checked with `getAccountInfo`), so no scenario can run. Token-2022 is covered by parser unit tests only.
* **Mainnet / Helius**: not tested.

## Findings that shaped the code
* The Devnet Token program no longer logs `Instruction: Burn`. The engine decodes instruction bytes and never relies on logs — keep it that way (a log filter would miss every burn).
* Nothing called `reconcile()`, so `history.complete` could never become true; the runner now runs it periodically (`RECONCILE_INTERVAL_MS`) for projects with `initialSupply`.
* The connection holding the project lease could die silently (and crash the process through an unhandled `error` event); `PgStore` now detects it (`leaseValid`) and the runner re-acquires before writing again.
