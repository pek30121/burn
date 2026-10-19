/* VIRUS.EXE — the ONE place that ties this site to the burn engine.
 *
 * Everything token-related that is not presentation lives here or comes from the engine itself
 * (GET /api/v1/projects -> mint, decimals, token program, cluster, levels). While the token does not exist,
 * leave `mint` null: the site shows "NO TOKEN YET", BURN stays unavailable and BUY / CHART stay disabled.
 *
 * After the token is created (see docs/VIRUS-INTEGRATION.md):
 *   1. the engine project "virus" is added to deploy/projects.mainnet.json (npm run mainnet:onboard -- <mint> virus ...),
 *   2. `mint` below is set to the same address (the bridge refuses to go READY if the engine reports another one),
 *   3. js/config.js: token.contract and the BUY / CHART links are filled in.
 */
(function () {
  'use strict';
  const VX = (window.VX = window.VX || {});
  VX.project = {
    projectId: 'virus', // id of the project in the engine
    cluster: 'mainnet-beta', // the burn window refuses any other network
    mint: null, // expected mint (cross-check only; the engine is the source of truth). null until the token exists.
    engineBase: '', // '' = same origin as this page (the Replit server relays /api/v1 to the engine)
    rpcUrl: '/rpc', // same-origin allow-listed RPC proxy: the Helius key never reaches the browser
    walletModuleUrl: '/dist/wallet/index.js', // the validated wallet module, served by the same server
    explorerTxUrl: 'https://solscan.io/tx/{tx}',
    pollStatusMs: 60000,
  };
})();
