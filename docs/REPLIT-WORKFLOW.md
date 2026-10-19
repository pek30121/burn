# Replit: audit, VIRUS.EXE preview, Git synchronisation and publication

Sources of truth: **GitHub** (code, via Claude Code) and **Replit** (hosting only). Replit is never used to write or rebuild the application.
What was checked from the repository is marked *verified here*; what depends on the live Replit state is marked *not verifiable from the repository* (no access to the Replit checkout was used).

## 1. Audit of the Replit configuration (verified here, `.replit` and scripts)
| Item | Finding |
|---|---|
| Runtime | `modules = ["nodejs-22"]`, Autoscale deployment, `build = npm install … && npm run build:replit`, `run = DEPLOY_NETWORK=mainnet SOLANA_CLUSTER=mainnet-beta PROJECTS_CONFIG=deploy/projects.mainnet.json npm run replit:start` (the network is pinned in the command AND in `[env]`). |
| What runs | `scripts/replit/supervisor.ts`: the **engine** (`dist/main.js`, PostgreSQL, indexers, read-only API on `127.0.0.1:8787`) and the **web server** (`scripts/wallet-test/server.ts`, public `PORT`, 8080 → 80). Both are restarted with backoff. **It is a Node server, not a static site: nothing may be replaced by a Static deployment** (it would drop the engine, the API and `/rpc`). |
| Routes, one origin | `/` (existing test page), `/wallet-test` → `/`, **`/virus/`** (the VIRUS.EXE site; `/virus` → `/virus/`), `/rpc` (allow-listed JSON-RPC proxy, Helius key stays server-side), `/api/v1/*` and `/health/*` (relay to the engine, GET/OPTIONS), `/dist/*` (wallet module), `/build-info` (new, see below). |
| Is `.replit` suitable for VIRUS? | **Yes, unchanged.** `/virus/` is served by the web server that already runs; `npm run build:replit` already compiles it and the files live in `web/virus/` (read from the repo at run time). No `.replit` edit is needed to publish VIRUS.EXE. |
| New in this branch | `GET /build-info` (commit, branch, build time, network), written at build by `scripts/replit/build-info.mjs` (never fails the build). `build:replit` gained that last step. Nothing else in the production start path changed. |
| Database migrations | None in this release (`migrations/` identical to `main`). `burnCount` uses the existing event log. |
| Deployment type | Autoscale sleeps when idle: the engine only indexes while awake. For an engine that never sleeps use **Reserved VM** (your decision, about $15/month at the time of writing; re-check). |
| Not verifiable from the repository | The live branch and local commits of the Replit checkout; which commit the running deployment was built from; the Replit secrets; the Replit database. See §4 and §6. |

## 2. VIRUS.EXE preview (isolated, nothing real)
`npm run virus:preview` starts **one small Node process with no database, no indexer, no Solana connection, no secret**:
* the **real site** (`/virus/`), the **real web server routes**, the **real public API code** (`src/api`), fed by **in-memory demo data**;
* a **demo project** (`VIRUS.EXE (DEMO)`, a made-up mint that is not a token, the 7 real levels), a **mock RPC** and a **demo wallet** (`Demo Wallet (simulated)`): its "signature" is random bytes that only the mock accepts;
* an orange **DEMO banner** on every page and a **DEMO controls** panel: `+1,000 / +25,000 / +500,000 burned`, `Next form`, `Jump to form 2…7`, `Reset demo`. Simulated burns go through the same event log / stream / mutation logic as real ones and are **never presented as real burns** (their "explorer" link goes nowhere).
* the **BURN window** works end to end against the mock: free amount, MAX (demo balance 1,000,000), recap, explicit tick, the demo wallet's approval prompt, chain phases pending → confirmed → finalized, then "COUNTED by the engine" and the counter moves.

Safety: the preview **refuses to start if `DATABASE_URL`, `HELIUS_API_KEY`, `SOLANA_RPC_URL` or `WEB_UPSTREAM_RPC_URL` is set** (so it can never run beside the production database or key). The demo script and `/demo/api/*` exist only in the preview; the production web server answers 404 for them, and `verify:deploy` fails if a deployment has them. The production supervisor and `.replit` never start the preview. Without the preview the real site (token absent) shows `NO TOKEN YET` and BURN / BUY / CHART stay disabled.

### Opening the preview on your iPhone (a SEPARATE Replit app, no secrets, no database)
The only truly isolated option on Replit is a second app: the production app has the database and the key. (Replit "Run" in the preview app is also harmless: the Mainnet supervisor refuses to start without `DATABASE_URL`/`HELIUS_API_KEY`.)
1. *(Claude, on your authorization)* push the branch `virus-integration` to GitHub as a **branch** (not `main`).
2. *(You)* Replit → create an app by **Import from GitHub** → repo `pek30121/burn`. Do **not** add Secrets, do **not** add a PostgreSQL database, do **not** publish it.
3. *(You)* In that new app's Git pane switch to branch `virus-integration` (or Shell: `git fetch origin && git checkout virus-integration`).
4. *(You)* Shell: `npm install --no-audit --no-fund --include=dev && npm run virus:preview`.
5. Open the app's web view URL and add `/virus/` (e.g. `https://<preview-app>.replit.dev/virus/`) in Safari on your iPhone.
Nothing from this app can reach production: different app, no secrets, no database, and the preview talks only to itself.

## 3. What was prepared and tested
`scripts/virus-preview/server.ts`, `web/virus-preview/demo.js`, `tsconfig.preview.json`, `scripts/replit/{git-check.sh,verify-deploy.mjs,build-info.mjs}`, `tests/virus-preview.test.ts`, `tests/replit-tools.test.ts` (see the commit for results).

## 4. Git synchronisation: the safe method (the old problems)
**What went wrong before** (from the history we saw): Replit commits locally on its own (publish, agent configuration edits), so its branch **diverges** from GitHub after every publish; the **Sync Changes** button then tried a rebase and left the checkout "in the middle of a rebase". The **Pull** button, by contrast, produced a normal merge commit.
**Rules**
1. Never use **Sync Changes**, never push from Replit to `main`, never rebase. Use **Pull** (merge) or the shell merge below.
2. Set once in the Replit Shell: `git config pull.rebase false` (a pull then merges; it can never start a rebase).
3. **Before any Pull**, run the read-only check: `sh scripts/replit/git-check.sh main`. It prints the branch, HEAD, the local-only commits (so nothing is lost silently), the incoming commits, whether an unfinished rebase/merge or uncommitted edits exist, and one verdict:
   * `UP TO DATE`: nothing to do.
   * `FAST-FORWARD`: Pull is safe (no merge commit).
   * `DIVERGED (n local, m incoming)`: use a merge, never a rebase, after a safety branch: `git branch backup-before-sync-$(date +%Y%m%d-%H%M)` then `git merge --no-rebase --no-edit origin/main`. The check predicts conflicts (`no` / `YES in: <files>`); if `YES`, stop and send the output to Claude; do not resolve by guessing.
   * `STOP`: a rebase/merge is in progress or files are modified: fix that first (`git rebase --abort` / `git merge --abort` give back the previous state, nothing is deleted).
4. The local Replit commits (publish markers, configuration edits) stay in the Replit history; a merge keeps them. They are not pushed to `main` unless you decide so.
5. **Which branch**: the production Replit follows `origin/main` (*not verifiable from the repository*: confirm with the first line of the check, `branch : main`). VIRUS.EXE reaches production only after Claude merges `virus-integration` into `main` (fast-forward if `main` has not moved; Claude checks that before any push) and you authorize it. `virus-integration` is currently one line of commits on top of `8e5f0c8` (= `main`).
6. **Is Replit running the right commit?** After the build, `GET /build-info` (`https://<app>/build-info`) shows `commit`, `branch`, `builtAt`, `network`; the deployment build log prints `build-info: <sha> on <branch>`. If a build container has no git, `commit` is `unknown`: then use `verify:deploy --site-files` (hashes of the served site files against the checkout).

## 5. Future publication (production, same origin)
Preconditions: tests green; Claude merged and pushed `main` **on your explicit authorization**; `git-check.sh` verdict is `UP TO DATE`/`FAST-FORWARD`/merged.
1. Replit Git pane → **Pull** (never Sync Changes). Run `sh scripts/replit/git-check.sh main` again: expect `UP TO DATE`.
2. Publish → **Republish** (same deployment, same secrets). Build: `npm install --no-audit --no-fund --include=dev && npm run build:replit`; start: `DEPLOY_NETWORK=mainnet SOLANA_CLUSTER=mainnet-beta PROJECTS_CONFIG=deploy/projects.mainnet.json npm run replit:start`; port 8080 → 80. Secrets (names only): `DATABASE_URL`, `HELIUS_API_KEY`, optional `CORS_ORIGINS`; `RPC_MONTHLY_CREDITS` is in `[env]`. **No secret and no `.replit` change is needed for this release.**
3. Verify, from the Replit Shell (or any machine with Node and the checkout):
   `npm run verify:deploy -- https://<app>.replit.app --network mainnet-beta --project flapy --commit $(git rev-parse HEAD) --site-files web/virus`
   It checks, over HTTP only: `/build-info` (commit, network); `/` and `/virus/` and its assets and `/dist/wallet/index.js`; `/virus` redirect; no preview/demo code; `/health/live` and `/health/ready` (engine **and** PostgreSQL); `/api/v1/projects` and `flapy` `synced` with a numeric `burnCount`; the API refuses POST; `/rpc` returns the Mainnet genesis hash, refuses `getProgramAccounts`, never echoes a key; the served site files equal the local ones. Exit code 0 only if everything passes.
4. Non-regression by hand on the iPhone: `/` still loads, `/virus/` loads and shows `NO TOKEN YET`, FLAPY counter unchanged.
**Restart risks**: the engine resumes from its PostgreSQL cursors (nothing counted twice; uniqueness per `(project, signature, instruction path)`); a republish stops the old instance first (short gap); on Autoscale an idle instance sleeps and catches up on wake; keep the maximum machines at 1 so two engines never index the same project (an advisory lock per project also protects this). Rolling back = Republish the previous commit (`git checkout <sha>` in the Replit checkout or revert on GitHub).
