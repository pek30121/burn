# Wallet module (`src/wallet/`)

Client-side, design-agnostic building blocks for “burn from the browser”. No framework, no styling, no server key. See DECISIONS D24 for the rules.

```ts
import { createBurnController, createEngineClient, createJsonRpc, createWalletRegistry } from './src/wallet/index.ts';

const controller = createBurnController({
  project: { id: 'alpha', mint, cluster: 'mainnet-beta', tokenProgram: 'spl-token', decimals: 6 }, // from GET /api/v1/projects
  registry: createWalletRegistry(),                                   // Phantom, Solflare, Backpack… (Wallet Standard)
  rpc: createJsonRpc({ url: BROWSER_SAFE_RPC_URL }),                  // NEVER the engine's Helius key
  engine: createEngineClient({ baseUrl: ENGINE_URL, projectId: 'alpha' }),
});
controller.subscribe((state) => render(state));
await controller.connect('Phantom');   // listWallets() gives the detected names
controller.setAmount('12.5');          // or 'max'
const preview = await controller.prepare();   // fee, SOL balance, simulation, warnings
await controller.confirm(preview.id);         // explicit; signs in the wallet, sends, follows to finalized, waits for the engine
```

State to render (`getState()`): `status`, `wallet`, `account`, `token` (program, decimals, extensions), `holding` (balance, **available**, eligibility), `amountInput/amountRaw`, `preview`, `tx` (`signature`, `phase`: sent → processed → confirmed → finalized | failed | expired), `engine.phase` (`waiting` → `counted` | `timeout`), `counter` (from the engine API only) and `error {code, message}` (French defaults, overridable via `messages`).

## What is guaranteed
* The only signature is produced by the user's wallet; the signed message must equal the previewed one or nothing is sent.
* The counter is never changed by the module. “Counted” only when the engine's event journal lists the signature; `timeout` means “still waiting”, not failure.
* Nothing is signed without `confirm(previewId)` on the current, unexpired, simulated-OK preview (used once).
* Account/network changes discard balance, amount and preview.
* Token-2022: unknown/incompatible extensions block the burn (fail-closed).

## What is NOT proven
* **Real Phantom / Solflare extensions were never driven** (only a Wallet-Standard-shaped mock; real Devnet transactions were signed behind that mock: `npm run devnet:wallet-flow`).
* No UI, no `window.phantom.solana` legacy adapter, no hardware-wallet specifics, no `POST /burns/notify` (API is read-only).
* The RPC used by the browser is the integrator's responsibility (rate limits, origin restriction).
