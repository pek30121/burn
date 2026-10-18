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
| `npm run devnet:rpc-check` | no | real read-only requests against the configured RPC (Helius when `HELIUS_API_KEY` is set) |
| `npm run devnet:probe` | yes | focused experiment: how the engine's status evolves between `confirmed` and `finalized` for one real burn |
| `npm run devnet:e2e` | **yes** | our own real transactions end to end: tokens created, burns below / across / over several thresholds, one tx with two burns, burn while the engine is down, RPC outage, restarts, no mutation before finalization, supply reconciliation proving completeness, SSE reconnection |

`devnet:e2e` prints every transaction signature (all FINALIZED) and writes `.devnet/results/*.json`.

## Using Helius for Devnet (from the Helius documentation)
* **One API key serves every network.** The dashboard's RPC page may list only Mainnet URLs; the Devnet endpoint is the same URL with the `devnet` host: `https://devnet.helius-rpc.com/?api-key=YOUR_API_KEY` (documented at <https://www.helius.dev/docs/llms.txt>; WebSocket: `wss://devnet.helius-rpc.com/?api-key=…`). Nothing has to be enabled on the dashboard.
* **Engine:** set `SOLANA_CLUSTER=devnet` and `HELIUS_API_KEY` (and leave `SOLANA_RPC_URL` unset). The host is derived from the cluster, and at start-up the engine verifies the genesis hash, so a Devnet engine can never run against Mainnet by mistake.
* **Where the key goes:** in the hosting environment's secrets (cloud environment menu → Edit → *Network secrets* or an environment variable named `HELIUS_API_KEY`), **never in Git, `.env.example` or the chat**. A new session picks it up.
* **Check it:** `npm run devnet:rpc-check` makes real read-only requests (network, health, history, decoding of a real burn, latency, throttling) and never prints the key. The scenario scripts (`devnet:e2e`, `devnet:observe`, …) use the same variable automatically.

## Funding the wallet
The sandbox's own faucet calls (`requestAirdrop`) are refused (HTTP 429, the address of the sandbox is shared). Fund the **public** address from your own session at <https://faucet.solana.com> (0.5 SOL was used for the validated run; about 0.015 SOL is spent per run). The faucet page also documents a proof-of-work faucet (`devnet-pow`); we read its source: the reward goes to the *payer*, which still needs a few thousand lamports for the first transaction fee (a payer with 0 lamports cannot send anything), so it cannot bootstrap an empty wallet. It was not needed and is not part of this repository.
**The wallet key lives only in this sandbox. Never send real (Mainnet) SOL to that address** — they cannot be recovered without exporting the key.

## Validated run (Devnet, `npm run devnet:e2e`, 41/41 checks)
Two SPL tokens (6 decimals, supply 1 000 000, mint authority revoked), engine with PostgreSQL, REST and SSE. Every transaction below was **finalized** on Devnet and checked three ways: Devnet = engine event = PostgreSQL row, exact raw amount.

| id | token | instruction | raw amount | slot | signature |
|---|---|---|---:|---:|---|
| create | tok-a (`CEXzM7BGgKuhNyXoWjGKz9WuegU1VM2FAxfxSBxewemv`) | create, mint, revoke | supply 10¹² | 512454644 | `5F5GXR9NKsgGt7Ts6Hy4tBpuuybDWiC1kXXBmfZTTdfWYRv3ThrQc8LRXdxChR9N4sZhchxCurbzg4awiTiobMny` |
| create | tok-b (`5GKHf95sVm1d6dvDCeLyXToxoJHRQfF5K4VsU25ko9Ln`) | create, mint, revoke | supply 10¹² | 512454649 | `27dP7yZer9TjKyhQAxgyAppRKaX3sWfUWTfUZtV7xUsaragnvKzX76bbhFpax7BDSQZk5d9t6XFZokHnbvSbZ4MD` |
| a1 | tok-a | Burn (no threshold) | 3 000 000 | 512454663 | `3YtuSnnDcZnVC5LVBBUp586PHauZGZejEwv4g3TwBFJdKgiRvX8SoMmkzconvTWPoEdFkt5TQASGDehDbaxzq8BY` |
| a2 | tok-a | BurnChecked (no threshold) | 4 000 000 | 512454668 | `3cE4YByX7VwYW3sKReTuszcLXb1fYayMToTBGnQ7ELms1yBrUXEtnJt4KAvsv9QAZdaUHoLU113ES3akQA2eHYso` |
| a3 | tok-a | BurnChecked, crosses **l1** | 5 000 000 | 512454676 | `5htsYsMsvPGCx4SepphGZ4LFrSxc1T22Fm3ex2scFJe8VqSZtmZ9r1hsc3sKuXYg5xYyjZyeseteiixdk2XtVXk4` |
| a4 | tok-a | **one tx, two burns**: Burn (path 0) + BurnChecked (path 1), crosses **l2** | 20 000 000 + 30 000 000 | 512454684 | `5EVrdJeF1GLLHkwHqbJspVZTmLnmhKPhhbhqggqgfMS6vmaUh4vMu3sSFAQd2t2zHUWDaD7zQaqFGmNovoJgX2mr` |
| b1 | tok-b | BurnChecked while the engine was **stopped**, crosses **l1, l2, l3 at once** | 300 000 000 | 512455040 | `3VB2aqF3SzyWWXqcu4gP4mXiZjP7MAT9xs9A84yPfR1GYpbMefs75ic3pupheRzWqcx93zXZwmcEj4oBzdtACKba` |
| a5 | tok-a | Burn sent during an **RPC outage**, crosses **l3** | 150 000 000 | 512455050 | `4gSWW3zHYHDBUX4txGTUb6hWrM1AeUxr8ar7TEzb9aaiBvsN4xwPfkWCiF9zuW1FSsAsEZKdbWjtr2MrnMeo9YDz` |
| fail | tok-a | BurnChecked with wrong decimals: **failed on-chain** (`Custom 18`), not counted | — | 512455133 | `XD3PB9ucFfZpPgjjr5HBeECZvB4LjDvSG36fdF98FwZ3a3Rv62ZqtgfXQhxEY9uiRY1HtKHx2QGyyJrBfxv2txA` |

Outcome: tok-a 212 000 000 raw burned, tok-b 300 000 000, both equal to `initial supply − on-chain supply`, level l3 on both, each mutation published exactly once, `history.complete = true` (supply reconciliation), no incident, SSE follower (reconnecting across two engine restarts and the outage) delivered events 1..9 once, in order, identical to REST.

**Honest limits of that evidence**
* This Devnet finalizes in about **1 second** (`unseen → processed → finalized` in 1.2 s), so the `confirmed`-but-not-`finalized` window is tiny: "no mutation before finalization" was observed with real transactions only over that ~1 s (no violation, 1–2 samples). The strong proof is in the automated tests, where finality is controlled.
* The first run of the scenario timed out once while waiting for a mutation (before diagnostics existed); three later runs passed. The public Devnet RPC answered **429 to ~60 % of the engine's requests** in a measured run, which is the likely cause but was not proven. Use a dedicated RPC for sustained use.

## Not covered (and why)
* **Burn by CPI with our own transaction**: needs a deployed program (build toolchain + SOL for deployment). CPI parsing is validated on real third-party CPI burns (`tests/fixtures/devnet-cpi-burn-*.json`, `devnet:observe`).
* **Token-2022**: the program account `TokenzQd…` does not exist on this Devnet (checked with `getAccountInfo`), so no scenario can run. Token-2022 is covered by parser unit tests only.
* **Mainnet / Helius**: not tested.

## Findings that shaped the code
* The Devnet Token program no longer logs `Instruction: Burn`. The engine decodes instruction bytes and never relies on logs — keep it that way (a log filter would miss every burn).
* Nothing called `reconcile()`, so `history.complete` could never become true; the runner now runs it periodically (`RECONCILE_INTERVAL_MS`) for projects with `initialSupply`.
* The connection holding the project lease could die silently (and crash the process through an unhandled `error` event); `PgStore` now detects it (`leaseValid`) and the runner re-acquires before writing again.
