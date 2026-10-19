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

## Planned mint and launch procedure (nothing below has been executed)
Planned CA (prepared on Pump.fun, **no first buy yet**): `EuhDQM4c9TsyytKDDj5PkAxoL2n9zUh9bcE8tdDkpump`. Checked read-only on Mainnet: valid base58 / 32 bytes / `pump` suffix; **no account at `finalized` nor `confirmed`** (the token does not exist on-chain yet). Decimals, token program and supply are **not assumed anywhere**: `deploy/virus.prelaunch.json` (not read by the engine) holds only id, name, ticker, mint and the 7 levels; the rest is read from the chain.

**Why the order matters.** The engine refuses to start (for *every* project, FLAPY included) when a configured mint does not exist at `finalized` (H2, `mint-check.ts`). So the `virus` entry must **not** be added to `deploy/projects.mainnet.json` before the mint exists and is finalized. Until then the site stays on `NO TOKEN YET` (the engine has no project `virus`; `project.js` only holds the expected mint as a cross-check).

1. **Before the first buy** (any time, read-only): `npm run virus:prelaunch`. Exit 3 = not created / not finalized yet (expected now): stop. Re-run after the creation.
2. **After the first buy / creation** and once finalized: `npm run virus:prelaunch` again. It reads the real token program, decimals, supply, mint and freeze authority, extensions; **blocks** on an active mint authority, `ConfidentialMintBurn`, wrapped SOL; **warns** on a freeze authority, extensions, and any difference from the reference (6 decimals, 10^9 tokens) because the level percentages then no longer hold (re-decide the thresholds, never change them silently). If clean it runs `mainnet:onboard` to derive `initialSupply` (checked against the mint history: supply = created − burned) and prints the entry.
3. Add that entry to `deploy/projects.mainnet.json` with the 7 levels of `deploy/virus.prelaunch.json` (ids `dormant, seed, bug, parasite, worm, overmind, god`; a level that has fired can never be removed). **FLAPY's entry stays untouched.**
4. `web/virus/js/config.js`: `token.contract` and the BUY / CHART URLs (still `null`, "Coming soon"). `project.js` already holds the mint.
5. `npm run check` (with `TEST_DATABASE_URL`), then your explicit go to push / merge. On Replit: **Pull**, then **Republish** (same `HELIUS_API_KEY`, `DATABASE_URL`); the restart is what makes the engine read the new project. Do it when the mint is already finalized, never before.
6. Verify: `/build-info` (verify-deploy), `GET /api/v1/projects/virus/status` → `data.state: synced`, then the label turns `LIVE`; FLAPY's status unchanged. First small real burn only with your explicit go.
7. **Rollback**: remove the `virus` entry from `deploy/projects.mainnet.json`, Pull + Republish; the site returns to `NO TOKEN YET`. Stored `virus` rows stay in PostgreSQL (keyed by `project_id`, FLAPY unaffected).
8. Publish the CA (X, site, Pump.fun fields) **last**, copied from Pump.fun, after step 6.

Hosting the site elsewhere later (e.g. Netlify) is possible for the counters (`engineBase` + `CORS_ORIGINS`), but the BURN window needs `/rpc` and the wallet module: either keep serving the site from Replit (recommended, no change) or add an exact-origin CORS to `/rpc` and `/dist` first.

## Tests (no Mainnet, no secret, no real wallet)
* `tests/virus-bridge.test.ts` — the real bridge + the real site `store.js` against the real API server (snapshot, finalized `burnCount`, live burn, multi-threshold, level-4 load, reconnection with missed events, duplicates, reset, indexing, unverified/verified label, no token, level/mint mismatch, engine thresholds, outage reporting, read-only).
* `tests/virus-site.browser.test.ts` — Chromium (390 px iPhone-like and desktop) on the real web server: mock Wallet-Standard wallet, mock RPC. Invalid amounts, MAX, recap, explicit confirmation, sign once, chain pending/confirmed/finalized without counter change, counted only when the engine lists it, explorer link, wallet refusal, failed simulation, Phantom-like Lighthouse transaction, no-token state, no overflow. Skipped (and reported as skipped) without Playwright.
* `tests/web-server.test.ts`, `tests/api-rest.test.ts`, `tests/api.pg.test.ts` — `/virus/` serving and non-regression of `/`, `/rpc`, `/api`; `burnCount` (memory and PostgreSQL).

## Limits
* Not tested with a real Phantom, WebKit/Safari (only Chromium), or on a real iPhone. No real token, so no end-to-end Mainnet burn.
* The bridge's `LIVE (UNVERIFIED)` state exists for projects whose supply proof cannot complete; the supply proof for a new Pump.fun token needs `initialSupply` (given by `mainnet:onboard`).
* Site texts are English; the wallet error messages are overridden in English in `burn-ui.js`.

## Thresholds (small community project)
| # | id | Site name | Cumulative finalized burn | % of 1B |
|---|---|---|---|---|
| 1 | `dormant` | Dormant File | 0 | 0 |
| 2 | `seed` | Glitch Seed | 10,000 | 0.001 % |
| 3 | `bug` | Bug Form | 50,000 | 0.005 % |
| 4 | `parasite` | Parasite Form | 150,000 | 0.015 % |
| 5 | `worm` | Worm Form | 400,000 | 0.04 % |
| 6 | `overmind` | Overmind | 1,000,000 | 0.1 % |
| 7 | `god` | System God | 2,500,000 | 0.25 % |

* Where they live: `web/virus/js/config.js` (visual copy, replaced at connection by the engine's values), `config/projects.example.json` (example entry), and, **at onboarding**, `deploy/projects.mainnet.json` (the engine's configuration, the source of truth). The engine code contains no VIRUS-specific threshold. FLAPY's entry is untouched.
* They depend only on the cumulative amount **burned and finalized** (engine total); never on market cap, price or visitors.
* Names shown on the site were kept (`Glitch Seed`, `Bug Form`, ...): only ids and thresholds are contractual.
* **Reference supply 1,000,000,000 (to confirm at creation).** Consistent with every Pump.fun mint measured on Mainnet during this project: exactly 10^15 raw units = 10^9 tokens with 6 decimals, mint authority revoked (FLAPY and the four audited tokens, see `docs/MAINNET.md`). It is a measurement, not a guarantee for the future VIRUS mint: `npm run mainnet:onboard` reads the real supply and decimals and prints `initialSupply`; if it differs from 1,000,000,000 the percentages above no longer hold and the thresholds must be re-decided (not silently changed). Tokens held in the bonding curve / pool are not burnable by holders, so the share of the supply actually in holders' hands is lower; the absolute thresholds stay small relative to it.
