/* EXAMPLE ONLY — not loaded by index.html.
 *
 * The VIRUS.EXE engine lives outside this repo. To feed real data into the
 * visuals, load a small bridge script BEFORE js/main.js that defines
 * `window.VIRUS_ENGINE_ADAPTER` with this shape. The frontend never computes
 * token logic itself; it only renders what the adapter reports.
 *
 *   window.VIRUS_ENGINE_ADAPTER = {
 *     id: 'engine',
 *     label: 'LIVE',            // shown in the UI badge
 *     live: true,
 *     connect({ onSnapshot, onBurn, onError }) {
 *       // 1) once connected, send the current totals:
 *       onSnapshot({
 *         totalBurned: 12345678,   // number (UI units, already decimals-adjusted)
 *         burnCount: 42,           // optional
 *         stageIndex: 2,           // optional — if the engine owns stages, it wins
 *         events: [                // optional recent history, newest first or any order
 *           { type: 'burn', amount: 1000, time: 1700000000000, tx: 'SIG...' },
 *         ],
 *       });
 *       // 2) for every new burn the engine sees:
 *       onBurn({ amount: 1000, totalBurned: 12346678, time: Date.now(), tx: 'SIG...', stageIndex: 2 });
 *       // 3) on failure (the UI shows an error state with a Retry button):
 *       onError(new Error('feed unavailable'));
 *       // return an optional disconnect function (called on Retry)
 *       return () => {};
 *     },
 *   };
 */
