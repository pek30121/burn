# Burn engine + web server on ONE Replit app

> **Current state:** the app is pinned to **Mainnet** in `.replit` (see `docs/MAINNET-LAUNCH.md`); the web server also serves the VIRUS.EXE site under `/virus/`. The Devnet description below is the historical default. For the audit, the preview, Git synchronisation and the publication checklist see **`docs/REPLIT-WORKFLOW.md`**.

`.replit` runs `scripts/replit/supervisor.ts` (compiled), which keeps two processes alive in the same container:

| Process | Role | Listens on |
|---|---|---|
| **web** (`scripts/wallet-test/server.ts`) | the Phantom test page, the allowlisted `/rpc` proxy (your Helius key stays here), and a read-only proxy to the engine API incl. the live event stream | the public port (`PORT`, 8080) |
| **engine** (`dist/main.js`) | indexers for the two Devnet test tokens, PostgreSQL, the public read-only API + SSE | `127.0.0.1:8787` only (not reachable from outside) |

The page reaches the engine through its own origin (`/api/...`), shows the counters and levels, and updates live from the engine's event stream. Nothing here touches Mainnet (the supervisor refuses any other cluster), creates tokens or burns.

## What you must provide (Replit side, from the app, no file to edit)
1. **A PostgreSQL database** attached to the app, so that `DATABASE_URL` exists (also in the published deployment). Without it only the page runs and the log says so.
2. **Secret `HELIUS_API_KEY`** (recommended; without it the engine uses the public Devnet RPC, which rate-limits). Never put it in a file.
3. Optional: Secret `DATABASE_URL` override with the database's DIRECT connection string if the provided one goes through a connection pooler (see below).

## Deployment type and cost (decide yourself; nothing is activated by this repository)
Prices read from Replit's documentation on 2026-10-18 (re-check before paying):
* **Autoscale** (current, `deploymentTarget = "autoscale"`): base fee about $2/month plus $0.60 per million compute units and $0.40 per million requests. It **scales to zero when idle**: the engine only indexes while an instance is awake, and catches up from its saved cursor on wake-up (no burn is lost; counters can lag until the page is opened). Set the maximum number of machines to **1** in "Adjust settings" to avoid several engines.
* **Reserved VM** (always on, what "permanent" really needs): **$15/month** (shared 0.5 vCPU / 2 GB), $35 (1 vCPU / 4 GB), $50, $130. Switch the deployment type in the Publish panel when you accept the cost.
* **Database**: Replit documents 20 GB of included storage per app; compute is billed by hours of use and **the price was not stated** on the pages I could read: check Replit's billing page before relying on it.
* **Helius** (your plan: 10 M credits/month): about 0.27 M credits/month per project at a 10 s poll (about 0.54 M for the two tokens) plus the page's `/rpc` traffic.

## Behaviour to know
* **Restart**: each process is restarted with backoff (1 s to 30 s). The engine resumes from the cursors in PostgreSQL; nothing is counted twice (uniqueness `(project, signature, instruction path)` in the database).
* **Single writer**: the engine takes a PostgreSQL advisory lock per project. Behind a transaction-mode **pooler** (PgBouncer) session locks are unreliable: you would see repeated `lease_lost` warnings but indexing still runs (idempotent writes). Use the direct connection string if you see them.
* **Completeness**: these tokens keep their mint authority, so the supply check cannot prove completeness (`history.complete = false`, by design).
* **Health**: `/health/ready` (through the public port) is `ready` only when the database answers and the engine runs.
* **Updating**: Git pane, Pull, then Run (workspace) / Republish (deployment).

## Mainnet
Not active by default. See `docs/MAINNET-LAUNCH.md` (`DEPLOY_NETWORK=mainnet`, engine only; unset it to return to this Devnet deployment).
