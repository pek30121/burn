/* VIRUS.EXE — visual configuration.
 * Everything here is presentation: names, copy, colors and the burn amounts
 * at which the *visual* forms change. The thresholds are CUMULATIVE TOKENS BURNED AND FINALIZED
 * (whole tokens), never market cap, price or visitors. They are sized for a small community
 * project on a reference supply of 1,000,000,000 tokens (Pump.fun standard, to be confirmed
 * when the mint exists): 0 / 0.001% / 0.005% / 0.015% / 0.04% / 0.1% / 0.25%.
 * The engine project "virus" (deploy/projects.mainnet.json) is the source of truth: at connection
 * the bridge replaces these values with the engine's, and refuses to go live if the ids differ. */
(function () {
  'use strict';
  const VX = (window.VX = window.VX || {});

  VX.config = {
    token: {
      name: 'VIRUS.EXE',
      ticker: '$VIRUS',
      chain: 'Solana',
      contract: null, // mint address: filled in once the token exists (null renders "Coming soon")
      image: 'assets/token/virus-logo-512.png', // token logo (1024px versions in assets/token/)
    },

    // url: null renders a disabled "Coming soon" button. Never put placeholder URLs here.
    links: [
      { id: 'buy', label: 'Buy $VIRUS', icon: 'coin', url: null },
      { id: 'chart', label: 'Chart', icon: 'monitor', url: null },
      { id: 'x', label: 'X / Twitter', icon: 'exe', url: null },
      { id: 'telegram', label: 'Telegram', icon: 'log', url: null },
    ],

    explorerTxUrl: 'https://solscan.io/tx/{tx}',

    stages: [
      {
        id: 'dormant', name: 'Dormant File', threshold: 0,
        blurb: 'A harmless-looking file. Sleeping. Probably fine.',
        traits: ['1 closed eye', 'pretends to be a .txt', 'threat level: allegedly zero'],
        theme: { accent: '#39ff14', accent2: '#ff2bd6', desk: '#0b7676', desk2: '#064848', titleA: '#000080', titleB: '#1084d0' },
      },
      {
        id: 'seed', name: 'Glitch Seed', threshold: 10_000,
        blurb: 'The first burns woke it up. One eye, unstable pixels, a lot of curiosity.',
        traits: ['1 eye', 'unstable pixels', 'learns to crawl'],
        theme: { accent: '#5cff3a', accent2: '#ff2bd6', desk: '#0a6d68', desk2: '#053f3c', titleA: '#000080', titleB: '#1f8f6a' },
      },
      {
        id: 'bug', name: 'Bug Form', threshold: 50_000,
        blurb: 'Six legs, two eyes. It has started chewing on desktop icons.',
        traits: ['6 legs', 'antennae', 'corrupts files on touch'],
        theme: { accent: '#2fe08a', accent2: '#ffd400', desk: '#0b5a4c', desk2: '#04302a', titleA: '#003d2a', titleB: '#14a36a' },
      },
      {
        id: 'parasite', name: 'Parasite Form', threshold: 150_000,
        blurb: 'Latches onto open windows and drinks their pixels.',
        traits: ['tentacles', '3 eyes', 'window hopping'],
        theme: { accent: '#b07cff', accent2: '#7cff4f', desk: '#2a1d4f', desk2: '#140b2c', titleA: '#2b0a6b', titleB: '#8a4dff' },
      },
      {
        id: 'worm', name: 'Worm Form', threshold: 400_000,
        blurb: 'Self-replicating. Tunnels through the file system and spawns popup storms.',
        traits: ['segmented body', 'teeth', 'popup storms'],
        theme: { accent: '#ff8a3d', accent2: '#7cff4f', desk: '#3d1a10', desk2: '#1e0905', titleA: '#5a1a00', titleB: '#e0601f' },
      },
      {
        id: 'overmind', name: 'Overmind', threshold: 1_000_000,
        blurb: 'It thinks now. Mostly about you, and about more burns.',
        traits: ['psychic brain', '5 eyes', 'controls the taskbar'],
        theme: { accent: '#ff3fdc', accent2: '#39ff14', desk: '#330a33', desk2: '#170317', titleA: '#5c005a', titleB: '#ff2bd6' },
      },
      {
        id: 'god', name: 'System God', threshold: 2_500_000,
        blurb: 'Full takeover. The operating system belongs to the virus now.',
        traits: ['crown of root access', '7 eyes', 'total corruption'],
        theme: { accent: '#ff2a48', accent2: '#39ff14', desk: '#2a030b', desk2: '#0d0003', titleA: '#5a0010', titleB: '#ff2a48' },
      },
    ],
  };
})();
