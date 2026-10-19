/* Engine connection.
 *
 * The VIRUS.EXE engine feeds the visuals through `window.VIRUS_ENGINE_ADAPTER`
 * (contract: js/adapters/live-adapter.example.js). The bridge script may load
 * before or after this file: until it is present the UI shows a clean
 * "linking to engine" state, then connects as soon as it appears (or when
 * the page dispatches a `virus:engine-ready` event).
 */
(function () {
  'use strict';
  const VX = window.VX;
  const store = () => VX.store;
  let adapter = null;
  let disconnect = null;
  let poll = 0;

  const found = () => {
    const a = window.VIRUS_ENGINE_ADAPTER;
    return a && typeof a.connect === 'function' ? a : null;
  };

  function waitForEngine() {
    store().setSource({ id: 'engine', label: 'LINKING', live: false, description: 'Waiting for the VIRUS.EXE engine feed.' });
    store().setStatus('loading');
    clearInterval(poll);
    poll = setInterval(() => found() && connect(), 1000);
  }

  function connect() {
    adapter = found();
    if (!adapter) return waitForEngine();
    clearInterval(poll);
    store().setSource({
      id: adapter.id || 'engine',
      label: adapter.label || 'LIVE',
      live: true,
      description: adapter.description || 'Live VIRUS.EXE engine feed.',
    });
    store().setStatus('loading');
    try {
      disconnect = adapter.connect({
        onSnapshot: (s) => store().applySnapshot(s),
        onBurn: (b) => store().applyBurn(b),
        onError: (e) => store().setStatus('error', e),
      });
    } catch (e) {
      store().setStatus('error', e);
    }
  }

  function reconnect() {
    if (typeof disconnect === 'function') {
      try {
        disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    disconnect = null;
    connect();
  }

  window.addEventListener('virus:engine-ready', () => !adapter && connect());

  VX.source = {
    connect,
    reconnect,
    get adapter() {
      return adapter;
    },
  };
})();
