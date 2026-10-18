# Wallet test page (Devnet) — Phantom / Solflare

A minimal, unstyled page (`web/wallet-test/`) to exercise `src/wallet` with real wallets. **Devnet only.** No private key is ever asked for: signing happens in the wallet.

## What was verified, and how (2026-10-18)
`npm run web:browser-test` — **28/28** in a real Chromium (Playwright, iPhone user-agent and 390 px viewport) against real Devnet transactions, the real engine (Helius Devnet + PostgreSQL + public API) and the real proxy server. **The wallets in that test are not Phantom/Solflare**: they are two Wallet-Standard wallets injected into the page through the real registration events (one `signTransaction`, one `signAndSend`-only), keys held in the Node process. The Phantom and Solflare extensions are not installed in the development sandbox and cannot be driven from it.

| Verified in a real browser engine | Result |
|---|---|
| Wallet detection through the Wallet Standard protocol (two wallets) | ✔ |
| Connect, SOL balance, token balance | ✔ |
| Amount, preview (real fee 5 000 lamports, real Devnet simulation), nothing signed before confirmation | ✔ |
| SPL Token burn 12.5 → finalized → counted by the engine; PostgreSQL row exact | ✔ |
| Token-2022 burn 3 through a `signAndSend`-only wallet (message not pre-verifiable, shown as such) | ✔ |
| Counter unchanged while the transaction is only sent/processed/confirmed; +exact amount once the engine counted | ✔ |
| Wallet refusal, amount above balance, too many decimals, garbage amount | ✔ |
| Account switched in the wallet (balance/preview/amount discarded) | ✔ |
| Wallet on the wrong network (signing blocked) | ✔ |
| Account without SOL for the fee | ✔ |
| Disconnect from the page and from the wallet UI | ✔ |
| Helius key/host never in any request, response, script or config reaching the browser; `/rpc` allowlist, batches refused, API proxy GET-only | ✔ |

Devnet transactions of the last run are printed by the script (`INFO SPL burn …`, `INFO Token-2022 burn …`).

## What only you can test (manual)
1. The **real Phantom and Solflare** extensions/apps: detection, connect prompt, approval screen, rejection, account switch, network switch (Testnet Mode in Phantom / network in Solflare), disconnect.
2. Whether the **mobile in-app browsers** of Phantom and Solflare register through the Wallet Standard. If the page lists no wallet there, tell me what the browser exposes (`window.phantom`, `window.solflare`) and a legacy adapter will be added.
3. The `confirmed`/`processed` display (Devnet finalizes in ~1 s, so these phases are rarely visible).

## Run it
Needs Node ≥ 22.18, PostgreSQL (for the engine) and a Helius key. Nothing below prints the key.

```sh
npm ci
npm run devnet:wallet                     # funding wallet (.devnet/wallet.json, git-ignored); airdrops Devnet SOL if the faucet allows
npm run web:build                         # compiles the wallet module for the browser into web/dist
USER_ADDRESS=<your Devnet wallet address> HELIUS_API_KEY=… npm run web:setup
#   creates a test SPL token and a test Token-2022 token, sends 0.2 SOL and 1000 of each token to YOUR address,
#   writes .wallet-test/projects.json (engine) and web/wallet-test/config.json (page); contains no secret

# terminal 1 — the engine (reads the same Devnet)
SOLANA_CLUSTER=devnet HELIUS_API_KEY=… DATABASE_URL=postgres://… PROJECTS_CONFIG=.wallet-test/projects.json npm start
# terminal 2 — the page + RPC proxy
HELIUS_API_KEY=… npm run web:serve        # http://127.0.0.1:8788/
```
Without the engine the page still works up to "finalized"; the counter then shows "indisponible" and the burn stays "en attente du moteur" until the 120 s timeout (not an error).

## Browser RPC without exposing your Helius key
The page never talks to Helius. It calls **`/rpc`** on its own origin; `scripts/wallet-test/server.ts` forwards to Devnet with the key kept in that process:
* allowlist of the 10 methods `src/wallet` uses (no `getProgramAccounts`, no `requestAirdrop`, nothing else), no batches, 64 KB limit, per-client rate limit (`WEB_RATE_PER_MINUTE`, default 120);
* refuses to start unless the upstream is Devnet (genesis hash), so it can never relay Mainnet;
* errors from upstream are scrubbed of `api-key=…`; `/api` and `/health` are GET-only proxies to the engine's read-only API.
For production use the same pattern (server-side proxy) or a provider URL restricted by origin; never ship the engine's key.

## Open it from an iPhone
iOS Safari has no wallet extensions. Phantom and Solflare each have an **in-app browser** that injects the wallet, so the page must be opened *inside* the wallet app, from a **public HTTPS URL** (the development sandbox cannot be reached from your phone, and `localhost` is your computer's, not the phone's).
1. On a computer, run the steps above, then expose port 8788 with a tunnel, e.g. `cloudflared tunnel --url http://localhost:8788` (or `ngrok http 8788`). You get `https://….trycloudflare.com`.
2. In the wallet app set **Devnet**: Phantom → Settings → Developer Settings → *Testnet Mode* → Solana Devnet; Solflare → Settings → Network → Devnet. Use the same wallet address you gave to `web:setup` (or re-run `web:setup` with the address shown in the app).
3. Phantom: *Browser* tab → paste the HTTPS URL. Solflare: *Browser/Explore* → enter the URL. Tap *Connecter Phantom* (or Solflare).
4. Stop the tunnel when finished: while it runs, anyone with the URL can use the rate-limited, Devnet-only, allowlisted `/rpc`.
The same page works on a desktop browser with the extensions at `http://127.0.0.1:8788/` (no tunnel).

## Hosted on Replit (no computer, no engine, no secret)
`.replit` + `deploy/` deploy only the page and its `/rpc` proxy, pointed at the **public Devnet RPC** (no Helius key). `deploy/wallet-test-config.json` lists the public mints of the two Devnet test tokens. Verified here in a real Chromium against `npm run web:start` (compiled copy, public Devnet RPC, no engine): connect, balance, real fee and simulation, burn of 4 tokens finalized on Devnet, balance refreshed. **The Replit import and deployment themselves were not run by me.** The engine (PostgreSQL, API, live counters) can run in the same Replit app: see `deploy/README.md`.

## Si la page affiche `signed_message_mismatch`
Le wallet a renvoyé une transaction qui n'est pas celle prévisualisée. Depuis D30, des ajouts connus et sans danger (instructions Lighthouse / ComputeBudget, ré-encodage v0) sont acceptés ; **tout le reste est refusé et rien n'est envoyé**. L'écran affiche alors une ligne du type `(version legacy->v0; required signers 1->1; accounts 4->6; instructions 1->3; programs [...]; payer same; blockhash same; lookup tables 0)` : faites-en une capture, elle suffit à diagnostiquer. Ce détail ne contient que des informations publiques.

## Tests
`npm run check` (includes `tests/web-server.test.ts`: proxy allowlist, key never returned, rate limit, path traversal) and `npm run web:browser-test` (network + Devnet + PostgreSQL; not part of `npm test`).
