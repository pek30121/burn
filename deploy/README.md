# Deploying the wallet test page on Replit (Devnet only)

`.replit` at the repository root runs `scripts/wallet-test/server.ts` (compiled by `npm run web:build:all`). It serves the unstyled test page and an allowlisted `/rpc` proxy to the **public Devnet RPC** (no API key, no private key, no engine, no database). `deploy/wallet-test-config.json` only lists the public mints of the two Devnet test tokens. Without the engine the counter shows "indisponible" (see docs/WALLET-TEST.md).
