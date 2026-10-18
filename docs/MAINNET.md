# Mainnet audit (READ-ONLY)

Nothing here sends a transaction or spends funds. `scripts/mainnet/rpc.ts` only allows an explicit list of read methods (`getGenesisHash, getSlot, getBlocks, getBlock, getSignaturesForAddress, getTransaction, getTokenSupply, getAccountInfo, getBlockTime`) and refuses any endpoint whose genesis hash is not Mainnet's. The API key is read from `HELIUS_API_KEY` and never printed. Request counts below are a **local estimate, not Helius billing**.

## Commands
| Command | What it does |
|---|---|
| `npm run mainnet:scan` | reference = whole finalized blocks. Decodes every Token / Token-2022 `Burn`/`BurnChecked` (outer + CPI, successful transactions only) and checks each (mint, signature) is listed by `getSignaturesForAddress(mint)` as the engine reads it. `MISSED` only when the pages read already went past the burn's slot. Also checks `parseBurns` (engine) = raw block decode. Env: `AUDIT_BLOCKS` (default 40), `AUDIT_PAGE_BUDGET`, `AUDIT_FINALITY_MARGIN`. |
| `node scripts/mainnet/recheck-deep.ts` | re-verifies, with a bigger page budget, the hot mints the first pass could not reach. |
| `npm run mainnet:reconcile` | for real tokens with a small history: sums every `MintTo` ever, runs the **production Indexer** from slot 0 and the engine's own supply check (D8); also compares with an independent raw decode. Env: `AUDIT_MAX_SIGS`, `AUDIT_MAX_MINTS`, `MINTS=a,b`. |

Results are written to `.mainnet/` (git-ignored).

## Results (2026-10-18, Helius Mainnet)
**Scan, 2 000 finalized blocks** (slots 458528851–458530850, ~14 min of chain): 2 197 645 transactions, **7 500 successful burn instructions** in 3 795 transactions on 408 mints, 6 628 distinct authorities (wallets unknown to us), 713 failed transactions containing a burn (correctly ignored).

| Dimension | Seen |
|---|---|
| program | Token-2022 5 133, Token 2 367 |
| instruction | Burn 5 916, BurnChecked 1 584 |
| tx version | legacy 1 269, v0 6 005, v1 226 |
| path | direct 4 793, CPI 2 707 |
| mint account | static 5 534, loaded from an address lookup table 1 966 |

* Engine parser vs raw block decode: **4 599 (tx, mint) pairs, 0 differences**.
* Listed by the mint's signature history: **6 041, MISSED 0**. Not verifiable: 1 730 (USDC 36, one Token-2022 mint 1 670, two other mints 24) because those mints had > 40 000 signatures in ~15 min and the 40-page budget did not reach the burns.
* This closes the E1 gap “mint loaded from an address lookup table”, “Token-2022” and “real BurnChecked” on a real chain, for a short window.

**Supply reconciliation with the production indexer, 4 real tokens** (authority revoked, full history read): `minted − supply now = indexed burns = raw-decoded burns`, engine verdict `verified` for all four (e.g. 359 signatures → 28 burn instructions, 8 333 792 715 971 raw; two Pump.fun mints with initial supply exactly 10¹⁵ raw).

**Cost (estimate, 1 Helius credit per standard call per the Helius docs read on 2026-10-18; free plan 1 M credits/month):** scan 2 000 blocks = 2 463 requests; deep recheck = 322; reconciliation of 4 tokens = 964. A single hot token produced 31 000 signatures in ~15 min: following it with one `getTransaction` per signature would be ≈ 2 requests/s ≈ 5 M/month for that token alone.

## Conclusions and limits
* **No missed burn observed; exhaustive coverage is NOT proven** (15-minute sample, 4 mints not reachable). The guarantee remains the supply reconciliation (D8), now observed on real data.
* **The real constraint is cost, not discovery**: the mint address appears in thousands of non-burn transactions (hot tokens) and each is fetched. Options (not implemented, see DECISIONS E2): Helius `getTransactionsForAddress` (10 credits per 100 full transactions), and supply-gated skipping. Reconciliation (D8) only works for mints with a revoked authority and a known supply history.
* **Bug found by this audit**: wrong Token-2022 program id (D23). Before the fix the engine ignored 68 % of the burn instructions in this window, silently.
* Not tested: burns by multisig/delegate, confidential Token-2022 burns, mints created before the node's retention, other providers.
