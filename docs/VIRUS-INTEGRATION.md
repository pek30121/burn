# VIRUS.EXE × universal burn engine (branch `virus-integration`)

**State: integrated and tested with mocks and simulated chains. The VIRUS token does not exist yet: nothing here is announced as working on Mainnet.**
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

## Automatic activation (D41): deploy BEFORE the launch, nothing to do after the first buy
FLAPY was only a test token and is gone from the configuration: `deploy/projects.mainnet.json` holds **VIRUS only**, declared `"awaitMint": true`.

Planned CA (prepared on Pump.fun, no first buy yet): `EuhDQM4c9TsyytKDDj5PkAxoL2n9zUh9bcE8tdDkpump`. Checked read-only on Mainnet: valid base58 / 32 bytes / `pump` suffix; **no account at `finalized` nor `confirmed` yet**.

**What the engine does by itself** (`src/engine/activation.ts`, one `MintWatcher` per pending project, isolated from every other project):
1. **Waiting**: one cheap `getAccountInfo` (finalized) every `PENDING_POLL_INTERVAL_MS` (default 15 s ≈ 170k credits/month while the token does not exist; local estimate, not billing). RPC failures back off (`ERROR_BACKOFF_*`) and are never a verdict. A mint seen only at `confirmed` is not a mint yet. The engine starts, serves its API and `/health/ready` normally with nothing active.
2. **Validation, as soon as the mint is finalized**, all read from the chain, nothing assumed: owner = Token or Token-2022 program (else `not_a_token_mint`); mint authority revoked (`mint_authority_active`); no freeze authority (`freeze_authority_active`); no Token-2022 confidential mint/burn or unknown extension (`unsupported_mint_extension`); not wrapped SOL; supply > 0; decimals within range. The mint's own finalized history is read (bounded by `PENDING_MAX_HISTORY_SIGNATURES`, default 1500) to derive the creation supply (MintTo) and to check that `supply = created − burned` holds exactly (`supply_history_mismatch`). A history longer than the bound is never guessed: the project is still activated, without `initialSupply` (`initial_supply_unknown`, the site shows `LIVE (UNVERIFIED)`). Optional operator guard rails (`"expect": { decimals, tokenProgram, supply }`) block on a difference (`decimals_mismatch`, `token_program_mismatch`, `supply_mismatch`); VIRUS does not set any.
3. **Activation without restart**: the project (real program, decimals, thresholds scaled by the real decimals, derived `initialSupply`) is registered in PostgreSQL and its indexer + runner start in the running process. Backfill from the beginning (`startSlot 0`) reads **every finalized burn since the creation**, including those that happened before the activation or during the sync; the tail, the supply proof and the level events then work as for any project. After a restart the same path runs again (the stored cursor resumes, nothing is recounted).
4. **A refusal blocks only this project**: explicit `mint_blocked` log (once per cause), public code in `GET /api/v1/projects` under `pending`, no data served, nothing indexed. It is re-checked every `PENDING_BLOCKED_RETRY_MS` (5 min): an authority revoked later unblocks it by itself.

**Public API**: `GET /api/v1/projects` returns `data` (active projects, unchanged shape) and, only while there is one, `pending: [{ id, name, ticker, cluster, mint, lifecycle: awaiting_mint | validating | activating | blocked, code }]`. Nothing else (no RPC URL, no internal text).

**Site (`engine-bridge.js`)**: `NO TOKEN YET` ("the engine is watching for it and starts by itself") → `ACTIVATING` → `INDEXING` → `LIVE` / `LIVE (UNVERIFIED)`, polled every 10 s, no reload. `TOKEN BLOCKED` (plain reason + one error popup) if refused. LIVE only when the engine reports the project synced. The Windows 98 look, windows, popups, animations and the 7 forms are untouched.

**Before the launch (the only manual part, once)**
1. `npm run virus:prelaunch` (read-only dry run of the engine's own activation code): today `NOT CREATED` (exit 3). After the first buy it prints the verdict and the project the engine would start.
2. `npm run check` (with `TEST_DATABASE_URL`), your explicit go to push / merge, then on Replit **Pull + Republish** while the token does not exist yet (same `HELIUS_API_KEY`, `DATABASE_URL`).
3. `npm run verify:deploy -- https://<app>.replit.app --network mainnet-beta --pending virus --commit <sha> --site-files web/virus`: passes while the engine lists VIRUS as waiting.
4. Your first buy. The engine detects, validates and activates; `GET /api/v1/projects/virus/status` shows `synced`, the site turns `LIVE`. Nothing to redeploy.
5. Fill `web/virus/js/config.js` (`token.contract`, BUY / CHART links) only if you want them on the site; this is the one optional post-launch edit and it does not touch the engine (a site-only republish). Publish the CA on X last, copied from Pump.fun.
6. **Rollback**: remove the entry from `deploy/projects.mainnet.json`, Pull + Republish; stored `virus` rows stay in PostgreSQL (keyed by `project_id`).

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
