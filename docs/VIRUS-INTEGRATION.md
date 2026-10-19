# VIRUS.EXE × universal burn engine (branch `virus-integration`)

**State: integrated and tested with mocks. The VIRUS token does not exist yet: nothing here is announced as working on Mainnet.**
Nothing has been published, pushed to `main`, or sent to the chain from this work.

## What was added
| Where | What |
|---|---|
| `web/virus/` | The site (HTML/CSS/JS), **visually unchanged**: same 7 forms, animations, texts. Only additions: a BURN window, a bridge, a config point. |
| `web/virus/js/project.js` | The **single configuration point**: `projectId`, expected `mint` (null until the token exists), `cluster`, RPC proxy and wallet-module URLs, explorer. |
| `web/virus/js/engine-bridge.js` | The real bridge to the engine's read-only API (meta, status, event log, SSE). No simulated data. |
| `web/virus/js/burn-ui.js`, `css/burn.css`, `tpl-burn` in `index.html` | The BURN window (retro style) over the **wallet module already validated on Mainnet** (`/dist/wallet/index.js`). |
| `scripts/wallet-test/server.ts` | `GET /virus/` (redirect from `/virus`), image types. `/`, `/rpc`, `/api`, `/wallet-test`, `/dist` unchanged. |
| `src/api/*`, `src/indexer/pg-store.ts` | `GET .../status` → `totals.burnCount`: FINALIZED burns only (from the durable event log, consistent with `latestEventId`). Additive; no migration. |
| `web/virus/js/config.js` | Provisional mint removed: `contract: null`; BUY / CHART `url: null` ("Coming soon"). |

Served from the **same origin** as `/rpc` and `/api/v1` by the Replit web server: **no CORS, no second proxy, no key in the browser**. Page URL: `https://<your-app>.replit.app/virus/`.

## Behaviour
* **Token absent** (engine does not know project `virus`): label `NO TOKEN YET`, counters empty, BURN window says so and every control is disabled, BUY/CHART disabled, no RPC call.
* **Engine indexing / not synced**: label `INDEXING`, no figures (partial data is never shown as final).
* **Ready**: label `LIVE` (history proven against the on-chain supply) or `LIVE (UNVERIFIED)` (indexed, proof not available/complete: said explicitly, with the reason in the label text). `DELAYED` if the engine falls behind; `RECONNECTING` during an interruption (last figures stay); an error popup only after 60 s of continuous outage or a configuration mismatch.
* **Counter** = engine only: it moves when the engine lists the finalized burn. A signature, a sent transaction, `confirmed` or even `finalized` on chain do **not** move it (tested). The BURN window shows chain status and engine counting separately.
* **Levels**: the engine is the source of truth. The bridge refuses to go READY (`MISMATCH`, error popup) unless the engine has the same 7 level ids in the same order (`dormant, seed, bug, parasite, worm, overmind, god`) and the first threshold is 0; the engine's thresholds then replace the site's. One level change = one mutation animation (the store derives it; engine `mutation` events are never forwarded). A burn crossing several thresholds plays one mutation per level, once. Loading the page already at level 4 plays none.
* **Reconnection**: SSE resumes from the last event id (`?after=`); duplicates are ignored; a gap or a `reset` event triggers a full re-read; 45 s of silence reopens the stream.
* **BURN window** (free amount): connect wallet → on-chain mint / program / decimals / balance → amount (any positive amount ≤ available balance; MAX = exactly the balance in raw units; 0, negative, NaN, `1e3`, too many decimals, > balance refused) → PREVIEW (simulation, fee, recap, "permanent" notice) → explicit tick → the wallet asks for the signature → the signed message is checked against the preview (Phantom's ComputeBudget + Lighthouse assertions accepted, D35) → sent → explorer link. Never automatic. No wallet: message + Phantom deep link (`phantom.app/ul/browse/…`, **to be validated on a real iPhone**).

## Procedure once the token exists (not executed)
1. Create the token (Pump.fun). Mint authority must be revoked (default there); note the mint.
2. Read-only check, from a shell with `HELIUS_API_KEY`: `npm run mainnet:onboard -- <MINT> virus VIRUS.EXE VIRUS`. It prints the token program, decimals, `initialSupply` and refuses when the supply proof cannot apply.
3. Add the printed entry to `deploy/projects.mainnet.json` with the **7 levels**, ids exactly `dormant, seed, bug, parasite, worm, overmind, god`, thresholds in whole tokens (site defaults: `0, 1000000, 5000000, 15000000, 40000000, 100000000, 250000000`; decide them now: a level that has fired can never be removed).
4. In `web/virus/js/project.js` set `mint` (cross-check); in `web/virus/js/config.js` set `token.contract` and the BUY / CHART URLs.
5. Run the tests, merge, then on Replit: **Pull**, then **Republish** (the supervisor serves `/virus/` with the engine; nothing else to configure: same `HELIUS_API_KEY`, `DATABASE_URL`). The restart is what makes the engine read the new project.
6. Verify: `GET /api/v1/projects/virus/status` shows `data.state: synced`; the site label turns `LIVE`; then the first small real burn test (needs your explicit go).

Hosting the site elsewhere later (e.g. Netlify) is possible for the counters (`engineBase` + `CORS_ORIGINS`), but the BURN window needs `/rpc` and the wallet module: either keep serving the site from Replit (recommended, no change) or add an exact-origin CORS to `/rpc` and `/dist` first.

## Tests (no Mainnet, no secret, no real wallet)
* `tests/virus-bridge.test.ts` — the real bridge + the real site `store.js` against the real API server (snapshot, finalized `burnCount`, live burn, multi-threshold, level-4 load, reconnection with missed events, duplicates, reset, indexing, unverified/verified label, no token, level/mint mismatch, engine thresholds, outage reporting, read-only).
* `tests/virus-site.browser.test.ts` — Chromium (390 px iPhone-like and desktop) on the real web server: mock Wallet-Standard wallet, mock RPC. Invalid amounts, MAX, recap, explicit confirmation, sign once, chain pending/confirmed/finalized without counter change, counted only when the engine lists it, explorer link, wallet refusal, failed simulation, Phantom-like Lighthouse transaction, no-token state, no overflow. Skipped (and reported as skipped) without Playwright.
* `tests/web-server.test.ts`, `tests/api-rest.test.ts`, `tests/api.pg.test.ts` — `/virus/` serving and non-regression of `/`, `/rpc`, `/api`; `burnCount` (memory and PostgreSQL).

## Limits
* Not tested with a real Phantom, WebKit/Safari (only Chromium), or on a real iPhone. No real token, so no end-to-end Mainnet burn.
* The bridge's `LIVE (UNVERIFIED)` state exists for projects whose supply proof cannot complete; the supply proof for a new Pump.fun token needs `initialSupply` (given by `mainnet:onboard`).
* Site texts are English; the wallet error messages are overridden in English in `burn-ui.js`.
