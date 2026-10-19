/* BURN window: connects the user's wallet (Wallet Standard / Phantom), lets them choose any positive amount up to their balance,
 * shows a recap and asks for an explicit confirmation; the wallet then asks for the signature. Nothing is ever signed or sent
 * automatically. All the on-chain logic is the wallet module already validated on Mainnet (BurnChecked, on-chain mint / program /
 * decimals checks, simulation, verification of the signed message). The counter on the page moves only when the ENGINE lists the
 * burn (see engine-bridge.js); this window shows chain confirmation and engine counting as two separate things. */
(function () {
  'use strict';
  const VX = window.VX;
  const P = VX.project;

  const EN = {
    no_wallet: 'No Solana wallet detected. On iPhone, open this page inside the Phantom app browser.',
    wallet_not_connected: 'Connect your wallet first.',
    user_rejected: 'You rejected the request in your wallet. Nothing was sent.',
    wallet_error: 'The wallet reported an error. Nothing was sent.',
    wrong_network: 'Your wallet is not on the right Solana network. Switch network in the wallet and try again.',
    rpc_wrong_network: 'The RPC node does not match the expected network. The burn is blocked for safety.',
    rpc_unavailable: 'The Solana network is briefly unreachable. Try again in a moment.',
    token_not_found: 'This token was not found on the network.',
    token_program_mismatch: 'The on-chain token program or decimals do not match the engine configuration. The burn is blocked.',
    token_blocked: 'This token cannot be burned from this interface (incompatible Token-2022 extension).',
    no_token_account: 'Your wallet holds no account for this token.',
    account_frozen: 'Your token account is frozen: it cannot be burned.',
    insufficient_token_balance: 'Amount is higher than your available balance.',
    amount_invalid: 'Invalid amount. Enter a positive number, e.g. 12.5.',
    amount_too_many_decimals: 'Too many decimals for this token.',
    amount_zero: 'The amount must be greater than zero.',
    amount_too_large: 'Amount too large.',
    insufficient_sol: 'Not enough SOL to pay the network fee.',
    preview_missing: 'Preview the burn before confirming it.',
    preview_stale: 'The amount or account changed since the preview. Preview again.',
    preview_expired: 'The preview expired. Preview again to get a fresh fee and block.',
    account_changed: 'The wallet account changed. Check the new account and start again.',
    simulation_failed: 'The burn simulation failed: the transaction would be rejected. Nothing was sent.',
    signed_message_mismatch: 'The wallet returned a different transaction than the one previewed. It was NOT sent.',
    send_failed: 'Sending the transaction failed. If it was sent, it will show in your wallet; check the explorer link.',
    blockhash_expired: 'The transaction expired before confirmation and was not executed. No token was burned; you can try again.',
    transaction_failed: 'The network rejected the transaction. No token was burned.',
    busy: 'An operation is already in progress.',
    engine_unavailable: 'The counter is briefly unavailable. Your burn stays valid on-chain.',
  };
  const TX_PHASE = {
    none: '—', sent: 'SENT — pending', processed: 'PROCESSED — not final', confirmed: 'CONFIRMED on chain', finalized: 'FINALIZED on chain',
    failed: 'FAILED — nothing burned', expired: 'EXPIRED — not executed, nothing burned',
  };

  let mod = null;
  let controller = null;
  let controllerKey = '';
  let registry = null;
  let unsubs = [];
  let root = null;

  const q = (name) => root.querySelector(`[data-b="${name}"]`);
  const set = (name, text) => { const el = q(name); if (el && el.textContent !== text) el.textContent = text; };
  const lamports = (v) => (v === null || v === undefined ? '—' : `${(Number(v) / 1e9).toFixed(6)} SOL`);

  /** Why burning is unavailable right now (null when it is available). */
  function unavailable() {
    const meta = VX.engineMeta;
    if (!meta) {
      return VX.store.state.source.label === 'NO TOKEN YET'
        ? 'BURN is not available yet: the VIRUS token has not launched, so the engine does not track it.'
        : 'BURN is not available yet: waiting for the engine link.';
    }
    if (P.cluster && meta.cluster !== P.cluster) return `BURN is disabled: the engine reports network "${meta.cluster}", this site burns on "${P.cluster}" only.`;
    if (VX.store.state.status !== 'ready') return 'BURN is paused: the engine feed is not ready, so a burn would not be counted live. Try again in a moment.';
    return null;
  }

  async function ensureController() {
    const meta = VX.engineMeta;
    const key = meta ? `${meta.id}:${meta.mint}:${meta.tokenProgram}:${meta.decimals}:${meta.cluster}` : '';
    if (controller && key === controllerKey) return controller;
    if (!mod) mod = await import(P.walletModuleUrl);
    controller?.dispose();
    registry = registry || mod.createWalletRegistry();
    const abs = P.rpcUrl.startsWith('/') ? location.origin + P.rpcUrl : P.rpcUrl;
    controller = mod.createBurnController({
      project: { id: meta.id, mint: meta.mint, cluster: meta.cluster, tokenProgram: meta.tokenProgram, decimals: meta.decimals },
      registry, rpc: mod.createJsonRpc({ url: abs }), engine: mod.createEngineClient({ baseUrl: P.engineBase, projectId: meta.id }),
      pollMs: 1500, messages: EN,
    });
    controllerKey = key;
    return controller;
  }

  const guard = (fn) => fn().catch((e) => { const el = q('error'); if (el) el.textContent = (e && e.message) || 'Unexpected error.'; });

  function renderWallets() {
    const box = q('wallets');
    if (!box) return;
    box.innerHTML = '';
    const names = registry ? registry.list().map((w) => w.name) : [];
    const help = q('help');
    if (!names.length) {
      help.hidden = false;
      help.textContent = '';
      help.append(document.createTextNode('No Solana wallet detected. On iPhone, open this page inside the Phantom app: '));
      const a = document.createElement('a');
      a.href = `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`;
      a.textContent = 'open in Phantom';
      a.rel = 'noopener';
      help.append(a, document.createTextNode('.'));
    } else help.hidden = true;
    for (const n of names) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = `Connect ${n}`;
      b.onclick = () => guard(() => controller.connect(n));
      box.append(b);
    }
  }

  function render(s) {
    if (!root || !root.isConnected) { unsubs.forEach((u) => u()); unsubs = []; return; }
    const why = unavailable();
    const st = q('state');
    st.classList.toggle('is-bad', !!why || s.status === 'failed');
    st.classList.toggle('is-ok', !why && s.status === 'finalized');
    const idle = !['connecting', 'loading_token', 'previewing', 'awaiting_signature', 'sending', 'confirming'].includes(s.status);
    st.textContent = why || ({
      disconnected: `Connect your wallet to burn ${VX.config.token.ticker}.`, connecting: 'Connecting…', connected: 'Connected.', loading_token: 'Reading your token balance on-chain…',
      ready: 'Choose an amount to burn.', previewing: 'Preparing and simulating the burn…', preview_ready: 'Review the recap, then confirm.',
      awaiting_signature: 'Waiting for your signature in the wallet…', sending: 'Sending the signed transaction…', confirming: 'Waiting for the chain…',
      finalized: 'Burn finalized on chain.', failed: 'The burn did not complete (see below).',
    }[s.status] || s.status);
    const act = !why && idle;
    set('account', s.account || '—');
    set('sol', lamports(s.solBalanceLamports));
    set('balance', s.holding ? s.holding.balance : '—');
    q('disconnect').disabled = !s.account;
    q('refresh').disabled = !s.account || !idle;
    const amount = q('amount');
    amount.disabled = !(act && s.holding);
    q('max').disabled = !(act && s.holding);
    q('preview').disabled = !(act && s.holding && s.amountRaw && s.amountRaw <= s.holding.availableRaw);
    set('amountErr', s.error && /^amount|insufficient_token|insufficient_sol/.test(s.error.code) ? s.error.message : '');
    set('error', s.error && !/^amount|insufficient_token_balance/.test(s.error.code) ? s.error.message : '');
    const recap = q('recap');
    const wasHidden = recap.hidden;
    recap.hidden = !s.preview;
    if (s.preview) {
      if (wasHidden && recap.scrollIntoView) setTimeout(() => recap.scrollIntoView({ block: 'nearest' }), 0); // small screens: bring the recap into view
      const p = s.preview;
      const kv = q('recapKv');
      kv.textContent = '';
      for (const [k, v] of [
        ['Burn', `${p.amount} ${VX.config.token.ticker} (${p.amountRaw} raw)`], ['Left after', `${p.remainingRaw} raw`],
        ['Network fee', `${lamports(p.feeLamports)}${p.feeExact ? '' : ' (estimate)'}`],
        ['Simulation', p.simulation.ok ? 'OK' : `FAILED: ${p.simulation.message || ''}`], ['Token', p.mint],
        ['Warnings', p.warnings.join(', ') || '—'],
      ]) { const b = document.createElement('b'); b.textContent = k; const sp = document.createElement('span'); sp.textContent = v; kv.append(b, sp); }
    } else { const ack = q('ack'); if (ack) ack.checked = false; }
    q('confirm').disabled = !(act && s.preview && s.preview.simulation.ok && s.status === 'preview_ready' && q('ack').checked);
    set('txPhase', TX_PHASE[s.tx.phase] + (s.tx.walletAdditions ? ' — wallet safety checks verified' : ''));
    const sig = q('sig');
    if (s.tx.signature) {
      if (!sig.querySelector('a') || sig.dataset.sig !== s.tx.signature) {
        sig.textContent = '';
        const a = document.createElement('a');
        a.href = P.explorerTxUrl.replace('{tx}', s.tx.signature);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = s.tx.signature;
        sig.append(a);
        sig.dataset.sig = s.tx.signature;
      }
    } else { sig.textContent = '—'; delete sig.dataset.sig; }
    set('enginePhase', { idle: '—', waiting: 'chain confirmed — waiting for the engine to count it…', counted: `COUNTED by the engine (event #${s.engine.burnEventId})`, timeout: 'not listed by the engine yet — it appears once the engine finalizes it (not an error)' }[s.engine.phase]);
  }

  async function mount(body) {
    root = body.querySelector('[data-burn]');
    await Promise.resolve(); // the window manager attaches the window right after render(): wait for it
    unsubs.forEach((u) => u());
    unsubs = [];
    const why = unavailable();
    if (!VX.engineMeta) {
      render({ status: 'disconnected', account: null, holding: null, solBalanceLamports: null, amountRaw: null, error: null, preview: null, tx: { phase: 'none', signature: null }, engine: { phase: 'idle' } });
    }
    unsubs.push(VX.store.on('status', () => controller && render(controller.getState())));
    unsubs.push(VX.store.on('meta', () => guard(mountController)));
    if (!why || VX.engineMeta) await guard(mountController);

    q('amount').oninput = () => controller && controller.setAmount(q('amount').value);
    q('max').onclick = () => { controller.setAmount('max'); q('amount').value = controller.getState().amountInput; };
    q('preview').onclick = () => { q('ack').checked = false; guard(() => controller.prepare()); };
    q('ack').onchange = () => render(controller.getState());
    q('confirm').onclick = () => {
      const s = controller.getState();
      // explicit user action, one click, and only for the exact previewed burn: the wallet then asks for the signature
      if (s.preview && q('ack').checked) guard(() => controller.confirm(s.preview.id));
    };
    q('disconnect').onclick = () => guard(() => controller.disconnect());
    q('refresh').onclick = () => guard(() => controller.refresh());
  }

  async function mountController() {
    if (!root || !root.isConnected || !VX.engineMeta) return;
    const c = await ensureController();
    unsubs.forEach((u) => u());
    unsubs = [c.subscribe(render), registry.subscribe(renderWallets), VX.store.on('status', () => render(c.getState())), VX.store.on('meta', () => guard(mountController))];
    renderWallets();
    render(c.getState());
  }

  VX.wm.register('burn', { title: 'BURN.EXE — feed the virus', icon: 'burnfile', w: 460, tpl: 'tpl-burn', render: (body) => void mount(body) });
  VX.burn = { unavailable };
})();
