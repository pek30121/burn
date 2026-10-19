# VIRUS.EXE — Windows 98 graphic refit (paint only)

The site keeps its desktop, monsters, infection, popups, mutations, CRT, boot and BURN window **exactly as they behave**. The refit is one extra stylesheet loaded last, `web/virus/css/win98.css`, plus one small markup change (the corruption-map legend) and the preview-only DEMO label.

## The rule, and how it is enforced
Nothing may change the size, position, stacking, opening/closing, order, count, speed or behaviour of any window or popup, nor the layout of what lives inside them. `windows.js` and `popups.js` (and every other `.js` of the site) are untouched. Only paint changes: box-shadow, background, colour, text-shadow, cursor, scroll bars, absolutely positioned decorations. Padding is used only on icon `<img>` together with `box-sizing: border-box` (the box stays identical, the drawn pixels snap to an integer scale).
* `tests/virus-geometry.test.ts` + `tests/fixtures/virus-geometry.json`: golden capture taken **before** the refit. It opens all ten windows and seven popup variants (seeded placement, ambient popups frozen) at **375, 390, 430, 768, 1280 and 1440 px** and compares every window/popup rectangle, title bar, controls, body, buttons and z-order, the desktop box and the two layers. Any 1 px drift fails (it was verified to fail on a one-line padding change). Re-capture only for a reviewed change: `UPDATE_VIRUS_GEOMETRY=1 node --test tests/virus-geometry.test.ts`.
* `tests/virus-visual.test.ts`: the stylesheet declares no layout property outside a short reviewed list (none on windows/popups or their content); the refit is applied at the six widths; the seven forms, their mutations and mutation popups, the Start menu and the BURN window still work.

## What changed (visible)
| Area | Before | After |
|---|---|---|
| Window / menu frame | white-first bevel | real Windows 98 frame: light grey + white inside on top-left, black + dark grey on bottom-right (`--bevel-win`) |
| Greys | `#c3c3c3` face | the real `#c0c0c0` / `#dfdfdf` / `#808080` / `#0a0a0a` |
| Push buttons | tinted hover, grey pressed | no hover tint (like Win98), pressed edge black-outside / grey-inside (`--bevel-press`), real disabled text |
| Window controls (minimize, maximize, close) | rotated CSS lines | crisp pixel glyphs (same 24x22 / 34x30 boxes, 2x glyphs on iPhone), glyph shifts 1 px when pressed |
| Inactive title bar | `#7b7b7b -> #b4b4b4` | `#808080 -> #c0c0c0`, system-grey text |
| Task bar | flat buttons | the top window's button is pressed and dithered; etched grips after Start; thin sunken notification area |
| Start menu | 24 px icons | 32 px (2x) icons, same row height (36 px) and size |
| Icons | 16x16 art shown at 18, 20, 22, 24, 34, 36, 40, 56 px (uneven pixels) | every icon drawn at 16 / 32 / 48 px; boxes unchanged |
| Gauges | text unreadable over dark stripes | hard 1 px white outline around the figure |
| Mutation Lab | cards of unequal height; dim CURRENT | equal heights per row; CURRENT is a solid badge; LOCKED brighter |
| Corruption legend | swatch could be orphaned at a line end | each swatch stays with its word |
| Pointers (desktop mouse only) | browser defaults | Windows arrow, hand, hourglass during a mutation (iPhone unaffected) |
| Scroll bars (inside windows/lists, Chromium/Safari desktop) | native | Win98 bars with arrow buttons and dithered track; the page scroll bar is left alone |
| Selection | browser blue | system navy |

Kept as artistic choices (intentional): hard offset shadows under windows, the CRT/scanlines, the pixel UI fonts, the large task bar, the stage-driven title-bar colours, the popups floating over windows.

## Preview only
In `npm run virus:preview` the status badge, boot line and System Monitor say **DEMO** instead of `LIVE (UNVERIFIED)`. It is done by the preview layer (`web/virus-preview/demo.js`) wrapping `setSource`; the production bridge and its real states (`LIVE`, `LIVE (UNVERIFIED)`, `INDEXING`, `DELAYED`, `RECONNECTING`, `NO TOKEN YET`, `MISMATCH`) are untouched.

## Abandoned / not done on purpose
* Menu bars, resize grips or extra buttons: they would suggest features that do not exist.
* Changing window sizes to fit content on iPhone, moving popups away from title bars, or throttling the storms: forbidden by the brief.
* A bitmap "MS Sans Serif" UI font: changes every text width, hence window heights; it also needs a licence check.
* Styling the page-level scroll bar: on macOS it would shrink the viewport and move the windows.
