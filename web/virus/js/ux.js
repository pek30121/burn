/* First-screen actions (display only): wires the HUD buttons to what already exists.
 *  - CONNECT WALLET opens the BURN window (data-action="open", handled by desktop.js).
 *  - OPEN IN PHANTOM is the same deep link the BURN window offers (burn-ui.js); hidden inside the Phantom app, where it is pointless.
 *  - BUY $VIRUS follows the "buy" entry of config.js: no URL = visibly disabled "COMING SOON", never a placeholder link.
 * No engine, wallet, burn or mutation logic here. */
(function () {
  'use strict';
  const VX = window.VX;
  const phantom = document.getElementById('ctaPhantom');
  const buy = document.getElementById('ctaBuy');

  if (phantom) {
    phantom.href = `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`;
    const inside = !!(window.phantom && window.phantom.solana && window.phantom.solana.isPhantom);
    if (inside) phantom.hidden = true;
  }

  if (buy) {
    const link = ((VX.config && VX.config.links) || []).find((l) => l.id === 'buy');
    if (link && link.url) {
      buy.href = link.url;
      buy.target = '_blank';
      buy.rel = 'noopener noreferrer';
      buy.removeAttribute('aria-disabled');
      buy.classList.add('is-live');
      const note = buy.querySelector('small');
      if (note) note.remove();
    } else {
      buy.classList.add('is-soon');
      buy.addEventListener('click', (e) => e.preventDefault());
    }
  }
})();
