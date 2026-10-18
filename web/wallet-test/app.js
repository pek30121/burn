/* Minimal test harness for the wallet module (src/wallet). No design, no animation: it only exercises the module.
 * Counter source: the engine API only (never computed here). */
import { createBurnController, createEngineClient, createJsonRpc, createWalletRegistry } from '../dist/wallet/index.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const logEl = $('log');
const log = (m) => { logEl.textContent += `${new Date().toISOString().slice(11, 19)} ${m}\n`; logEl.scrollTop = logEl.scrollHeight; };
window.addEventListener('error', (e) => log(`JS error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => log(`unhandled: ${e.reason?.message ?? e.reason}`));

// every action is guarded: a rejected promise must never surface as an uncaught error
const act = (name, fn) => fn().catch((e) => log(`${name}: ${e?.code ?? ''} ${e?.message ?? e}`));

let config;
try { config = await (await fetch('./config.json', { cache: 'no-store' })).json(); } catch { config = null; }
if (!config) {
  config = { cluster: q.get('cluster') ?? 'devnet', rpcUrl: '/rpc', engineBase: '', projects: [] };
  if (q.get('mint')) config.projects.push({ id: q.get('id') ?? 'manual', name: 'manual', mint: q.get('mint'), tokenProgram: q.get('program') ?? 'spl-token', decimals: Number(q.get('decimals') ?? 6) });
}
const rpcUrl = q.get('rpc') ?? config.rpcUrl;
const engineBase = q.get('engine') ?? config.engineBase ?? '';
const rpcAbs = rpcUrl.startsWith('/') ? location.origin + rpcUrl : rpcUrl;

$('net').textContent = `(${config.cluster})`;
$('cfgKv').innerHTML = '';
for (const [k, v] of [['RPC navigateur', rpcUrl.replace(/api-key=[^&]*/i, 'api-key=***')], ['Moteur (API publique)', engineBase || '(même origine)'], ['Projets', String(config.projects.length)]]) {
  $('cfgKv').insertAdjacentHTML('beforeend', `<b>${k}</b><span></span>`);
  $('cfgKv').lastElementChild.textContent = v;
}
if (config.projects.length === 0) { $('status').textContent = 'aucun projet : lancez npm run web:setup ou ouvrez ?mint=…&program=spl-token&decimals=6'; throw new Error('no project configured'); }

const registry = createWalletRegistry();
const rpc = createJsonRpc({ url: rpcAbs });
let controller = null;
let walletName = null;
let unsub = null;
let project = config.projects[0];

for (const p of config.projects) $('project').insertAdjacentHTML('beforeend', `<option value="${p.id}">${p.name ?? p.id} — ${p.tokenProgram}</option>`);
$('project').addEventListener('change', () => { project = config.projects.find((p) => p.id === $('project').value); void newController(true); });

function renderWallets() {
  const names = registry.list().map((w) => w.name);
  const box = $('wallets');
  box.innerHTML = '';
  if (names.length === 0) box.textContent = 'Aucun portefeuille Solana détecté (Wallet Standard). Sur iPhone : ouvrez cette page dans le navigateur intégré de Phantom ou Solflare.';
  for (const n of names) {
    const b = document.createElement('button');
    b.textContent = `Connecter ${n}`;
    b.onclick = () => { walletName = n; log(`connect ${n}`); void act('connect', () => controller.connect(n)); };
    box.append(b);
  }
}
registry.subscribe(() => { renderWallets(); log(`wallets: ${registry.list().map((w) => `${w.name}[sign:${w.canSign},send:${w.canSignAndSend}]`).join(', ') || 'none'}`); });
renderWallets();

async function newController(reconnect) {
  unsub?.();
  controller?.dispose();
  controller = createBurnController({
    project: { id: project.id, mint: project.mint, cluster: config.cluster, tokenProgram: project.tokenProgram, decimals: project.decimals },
    registry, rpc, engine: createEngineClient({ baseUrl: engineBase, projectId: project.id }), pollMs: 1000,
  });
  unsub = controller.subscribe(render);
  render(controller.getState());
  if (reconnect && walletName) await act('reconnect', () => controller.connect(walletName));
}

const lamports = (v) => (v === null || v === undefined ? '—' : `${(Number(v) / 1e9).toFixed(6)} SOL`);
let lastErr = '';
let refreshedFor = null;
function render(s) {
  $('status').textContent = s.status;
  $('account').textContent = s.account ?? '—';
  $('sol').textContent = lamports(s.solBalanceLamports);
  $('mint').textContent = project.mint;
  $('program').textContent = s.token ? `${s.token.tokenProgram} (${s.token.decimals} décimales)` : project.tokenProgram;
  $('ext').textContent = s.token?.extensions.length ? s.token.extensions.join(', ') : '—';
  $('balance').textContent = s.holding ? s.holding.balance : '—';
  $('available').textContent = s.holding ? `${s.holding.available}${s.holding.eligibility.warnings.length ? ` (${s.holding.eligibility.warnings.join(', ')})` : ''}` : '—';
  $('disconnect').disabled = !s.account;
  $('refresh').disabled = !s.account;
  const idle = !['connecting', 'loading_token', 'previewing', 'awaiting_signature', 'sending', 'confirming'].includes(s.status);
  $('preview').disabled = !(idle && s.holding && s.amountRaw && s.amountRaw <= s.holding.availableRaw);
  $('confirm').disabled = !(idle && s.preview && s.preview.simulation.ok);
  $('reset').disabled = !idle;
  const pk = $('previewKv');
  pk.innerHTML = '';
  if (s.preview) {
    const p = s.preview;
    for (const [k, v] of [['Montant', `${p.amount} (${p.amountRaw} brut)`], ['Reste après', `${p.remainingRaw} brut`], ['Frais réseau', `${p.feeLamports} lamports (${lamports(p.feeLamports)}) ${p.feeExact ? '' : '[estimation]'}`], ['Simulation', p.simulation.ok ? `OK (${p.simulation.unitsConsumed ?? '?'} CU)` : `ÉCHEC: ${p.simulation.message}`], ['Avertissements', p.warnings.join(', ') || '—'], ['Valide jusqu\'à', new Date(p.expiresAt).toLocaleTimeString()]]) {
      pk.insertAdjacentHTML('beforeend', '<b></b><span></span>');
      pk.children[pk.children.length - 2].textContent = k;
      pk.lastElementChild.textContent = v;
    }
  }
  $('txPhase').textContent = s.tx.phase + (s.tx.slot ? ` (slot ${s.tx.slot})` : '') + (s.tx.signature ? (s.tx.messageVerified ? ' — message vérifié' : ' — message non vérifiable (wallet signAndSend)') : '');
  $('sig').innerHTML = '';
  if (s.tx.signature) { const a = document.createElement('a'); a.href = `https://explorer.solana.com/tx/${s.tx.signature}?cluster=${config.cluster === 'devnet' ? 'devnet' : ''}`; a.target = '_blank'; a.rel = 'noopener'; a.textContent = s.tx.signature; $('sig').append(a); } else $('sig').textContent = '—';
  $('enginePhase').textContent = { idle: '—', waiting: 'en attente du moteur…', counted: `COMPTÉ par le moteur (événement ${s.engine.burnEventId})`, timeout: 'délai dépassé : pas encore listé par le moteur (pas une erreur)' }[s.engine.phase];
  const e = s.counter.engine;
  $('counter').textContent = e ? `${e.finalized} (${e.finalizedRaw} brut)${e.synced ? '' : ' [moteur non synchronisé]'}` : s.counter.status === 'unavailable' ? 'indisponible' : '—';
  $('level').textContent = e ? `${e.levelName || e.levelId}` : '—';
  $('errBox').hidden = !s.error;
  $('err').textContent = s.error ? `${s.error.code}: ${s.error.message}${s.error.detail ? ` (${s.error.detail})` : ''}` : '';
  // Once the transaction is finalized the on-chain balance is final: show it without waiting for the engine (which may be absent).
  if (s.tx.phase === 'finalized' && s.tx.signature && refreshedFor !== s.tx.signature && s.status === 'finalized') { refreshedFor = s.tx.signature; setTimeout(() => void act('refresh', () => controller.refresh()), 500); }
  const key = `${s.status}|${s.tx.phase}|${s.engine.phase}|${s.error?.code ?? ''}|${s.account ?? ''}`;
  if (key !== lastErr) { lastErr = key; log(`state ${key}`); }
}

$('disconnect').onclick = () => { log('disconnect'); walletName = null; void act('disconnect', () => controller.disconnect()); };
$('refresh').onclick = () => void act('refresh', () => controller.refresh());
$('amount').oninput = () => controller.setAmount($('amount').value);
$('max').onclick = () => { controller.setAmount('max'); $('amount').value = controller.getState().amountInput; };
$('preview').onclick = () => void act('preview', () => controller.prepare());
$('confirm').onclick = () => { const p = controller.getState().preview; if (p) void act('confirm', () => controller.confirm(p.id)); };
$('reset').onclick = () => { controller.reset(); $('amount').value = ''; };

// Live counter straight from the engine (independent of any wallet), so a change can be seen after a burn is counted.
setInterval(() => void act('counter', () => controller.refreshCounter()), 4000);
await newController(false);
void act('counter', () => controller.refreshCounter());
window.__burn = { get controller() { return controller; }, registry }; // for the automated browser test
log('ready');
