/* VIRUS.EXE PREVIEW — demo layer. Served ONLY by the preview server (scripts/virus-preview/server.ts), never by production.
 * It adds: a permanent DEMO banner, a demo wallet (Wallet Standard) whose "signature" is random bytes that only the preview's
 * mock RPC accepts, and a small control panel that adds SIMULATED burns to the preview's in-memory engine. */
(function () {
  'use strict';
  const BANNER = 'DEMO — simulated data. No token exists. No real burn, no real wallet, no blockchain.';

  function banner() {
    const bar = document.createElement('div');
    bar.id = 'demo-banner';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#ffb000;color:#000;font:600 12px/1.3 system-ui,sans-serif;padding:4px 8px;display:flex;gap:8px;align-items:center;justify-content:space-between';
    const t = document.createElement('span');
    t.textContent = BANNER;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'DEMO controls ▾';
    b.style.cssText = 'font:inherit;padding:3px 8px;border:1px solid #000;background:#fff;color:#000;min-height:28px';
    bar.append(t, b);
    document.body.appendChild(bar);
    const fit = () => { document.body.style.paddingTop = bar.offsetHeight + 'px'; panel.style.top = bar.offsetHeight + 'px'; };
    window.addEventListener('resize', () => fit());

    const panel = document.createElement('div');
    panel.id = 'demo-panel';
    panel.hidden = true;
    panel.style.cssText = 'position:fixed;top:34px;right:0;z-index:2147483647;background:#fff;color:#000;font:13px/1.35 system-ui,sans-serif;border:2px solid #000;padding:8px;max-width:min(100vw,320px);max-height:70vh;overflow:auto';
    const state = document.createElement('p');
    state.id = 'demo-state';
    state.style.margin = '0 0 6px';
    panel.append(state);
    const row = (label, fn) => {
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = label;
      x.style.cssText = 'font:inherit;margin:2px;padding:6px 8px;min-height:36px;border:1px solid #000;background:#eee;color:#000';
      x.onclick = () => fn().then(refresh).catch((e) => (state.textContent = String(e.message || e)));
      panel.append(x);
    };
    const post = async (path) => { const r = await fetch(path, { method: 'POST' }); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); };
    let levels = [];
    async function refresh() {
      const s = await (await fetch('/demo/api/state')).json();
      levels = s.levels;
      const tokens = Number(BigInt(s.total) / 10n ** BigInt(s.decimals));
      state.textContent = `DEMO total burned: ${tokens.toLocaleString('en-US')} · demo balance: ${Number(BigInt(s.balanceRaw) / 10n ** BigInt(s.decimals)).toLocaleString('en-US')}`;
    }
    row('+1,000 burned', () => post('/demo/api/burn?tokens=1000'));
    row('+25,000 burned', () => post('/demo/api/burn?tokens=25000'));
    row('+500,000 burned', () => post('/demo/api/burn?tokens=500000'));
    row('Next form ▶', async () => {
      const s = await (await fetch('/demo/api/state')).json();
      const next = s.levels.findIndex((l) => BigInt(l.thresholdRaw) > BigInt(s.total));
      if (next < 0) throw new Error('already at the final form');
      return post(`/demo/api/level?index=${next}`);
    });
    for (let i = 1; i < 7; i++) row(`Jump to form ${i + 1}`, () => post(`/demo/api/level?index=${i}`));
    row('Reset demo', () => post('/demo/api/reset'));
    const note = document.createElement('p');
    note.style.cssText = 'margin:6px 0 0;font-size:11px';
    note.textContent = 'Simulated burns go through the same engine API / event stream as real ones. They are not real burns.';
    panel.append(note);
    document.body.appendChild(panel);
    fit();
    b.onclick = () => { fit(); panel.hidden = !panel.hidden; if (!panel.hidden) refresh(); };
    void levels;
  }

  function demoWallet(account) {
    const pub = new Uint8Array(32);
    const w = { name: 'Demo Wallet (simulated)', version: '1.0.0', icon: 'data:image/svg+xml;base64,PHN2Zy8+', chains: ['solana:mainnet'], accounts: [], features: {}, _l: new Set() };
    const acct = () => ({ address: account, publicKey: pub, chains: ['solana:mainnet'], features: ['solana:signTransaction'] });
    w.features['standard:connect'] = { version: '1.0.0', connect: async () => { w.accounts = [acct()]; return { accounts: w.accounts }; } };
    w.features['standard:disconnect'] = { version: '1.0.0', disconnect: async () => { w.accounts = []; } };
    w.features['standard:events'] = { version: '1.0.0', on: (_e, l) => { w._l.add(l); return () => w._l.delete(l); } };
    w.features['solana:signTransaction'] = {
      version: '1.0.0', supportedTransactionVersions: ['legacy'],
      signTransaction: async (...inputs) => {
        if (!window.confirm('DEMO wallet: approve this SIMULATED burn?')) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        const tx = Uint8Array.from(inputs[0].transaction);
        tx.set(crypto.getRandomValues(new Uint8Array(64)), 1); // random bytes: only the preview's mock RPC accepts it
        return [{ signedTransaction: tx }];
      },
    };
    const cb = (api) => api.register(w);
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: cb }));
    window.addEventListener('wallet-standard:app-ready', (e) => cb(e.detail));
  }

  window.__DEMO__ = true;
  // the preview is never "LIVE": every engine status badge / boot line / description says DEMO (production code is not touched)
  if (window.VX && window.VX.store && typeof window.VX.store.setSource === 'function') {
    const setSource = window.VX.store.setSource;
    window.VX.store.setSource = (src) => setSource(src && src.id === 'engine' && /^LIVE/.test(src.label) ? Object.assign({}, src, { label: 'DEMO', description: 'DEMO: simulated data, no token, no real burn.' }) : src);
  }
  // simulated transactions do not exist on any explorer: never link them to one
  if (window.VX) {
    if (window.VX.project) { window.VX.project.explorerTxUrl = '#demo-simulated-transaction-{tx}'; window.VX.project.mint = null; } // the demo mint is a made-up constant: never cross-check it against the real planned mint
    if (window.VX.config) window.VX.config.explorerTxUrl = '#demo-simulated-transaction-{tx}';
  }
  fetch('/demo/api/state').then((r) => r.json()).then((s) => { demoWallet(s.account); banner(); }).catch(() => banner());
})();
