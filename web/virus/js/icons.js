/* 16x16 pixel icons, drawn from character maps into data URLs. */
(function () {
  'use strict';
  const VX = window.VX;

  const PAL = {
    k: '#000000', w: '#ffffff', g: '#c3c3c3', d: '#808080', b: '#0000a8', B: '#3a8cff',
    y: '#ffd400', Y: '#b08800', G: '#39ff14', D: '#0b7a1a', r: '#e0182d', o: '#ff8a00',
    p: '#ff2bd6', c: '#00c8e0', t: '#008080',
  };

  const MAPS = {
    computer: [
      '................', '..kkkkkkkkkkkk..', '..kggggggggggk..', '..kgkkkkkkkkgk..', '..kgkbbbbbbkgk..',
      '..kgkbBbbbbkgk..', '..kgkbbbbbbkgk..', '..kgkbbbbbbkgk..', '..kgkkkkkkkkgk..', '..kggggggggGgk..',
      '..kkkkkkkkkkkk..', '.....kggggk.....', '...kkkkkkkkkk...', '..kggggggggggk..', '..kddddddddddk..', '..kkkkkkkkkkkk..',
    ],
    folder: [
      '................', '................', '.kkkkkk.........', '.kyyyyyk........', '.kyyyyyykkkkkkk.',
      '.kyyyyyyyyyyyyk.', '.kYYYYYYYYYYYYk.', '.kyyyyyyyyyyyyk.', '.kyyyyyyyyyyyyk.', '.kyyyyyyyyyyyyk.',
      '.kyyyyyyyyyyyyk.', '.kyyyyyyyyyyyyk.', '.kYYYYYYYYYYYYk.', '.kkkkkkkkkkkkkk.', '................', '................',
    ],
    txt: [
      '................', '...kkkkkkkkk....', '...kwwwwwwwkk...', '...kwwwwwwwkwk..', '...kwkkkkwwkkkk.',
      '...kwwwwwwwwwwk.', '...kwkkkkkkkwwk.', '...kwwwwwwwwwwk.', '...kwkkkkkkwwwk.', '...kwwwwwwwwwwk.',
      '...kwkkkkkkkkwk.', '...kwwwwwwwwwwk.', '...kwkkkkkwwwwk.', '...kwwwwwwwwwwk.', '...kkkkkkkkkkkk.', '................',
    ],
    log: [
      '................', '.kkkkkkkkkkkkkk.', '.kbbbbbbbbbbgbk.', '.kggggggggggggk.', '.kgkkkkkkkkkkgk.',
      '.kgkGkkkkkkkkgk.', '.kgkkGkkkkkkkgk.', '.kgkGkkGGGkkkgk.', '.kgkkkkkkkkkkgk.', '.kgkGGGkGGkkkgk.',
      '.kgkkkkkkkkkkgk.', '.kgkGGkGGGGkkgk.', '.kgkkkkkkkkkkgk.', '.kggggggggggggk.', '.kkkkkkkkkkkkkk.', '................',
    ],
    lab: [
      '................', '.....kkkkkk.....', '.....kwwwwk.....', '......kggk......', '......kwwk......',
      '......kwwk......', '.....kwwwwk.....', '....kwwwwwwk....', '...kwGGGGGGwk...', '..kwGGDGGGGGwk..',
      '..kGGGGGGDGGGk..', '.kGGGDGGGGGGGGk.', '.kGGGGGGGGDGGGk.', '.kDDDDDDDDDDDDk.', '..kkkkkkkkkkkk..', '................',
    ],
    monitor: [
      '................', '.kkkkkkkkkkkkkk.', '.kbbbbbbbbbbbbk.', '.kggggggggggggk.', '.kgkkkkkkkkkkgk.',
      '.kgkkkkkkkkGkgk.', '.kgkkkkkkkGkkgk.', '.kgkkGkkkGkkkgk.', '.kgkGkGkGkkkkgk.', '.kgGkkkGkkkkkgk.',
      '.kgkkkkkkkkkkgk.', '.kgkrrkGGkyykgk.', '.kgkkkkkkkkkkgk.', '.kggggggggggggk.', '.kkkkkkkkkkkkkk.', '................',
    ],
    coin: [
      '................', '.....kkkkkk.....', '...kkyyyyyykk...', '..kyyyyyyyyyYk..', '..kyyyykkyyyYk..',
      '.kyyyykkkkyyyYk.', '.kyyykkyyyyyyYk.', '.kyyyykkkyyyyYk.', '.kyyyyyykkkyyYk.', '.kyyyyyyyykkyYk.',
      '.kyyyykkkkkyyYk.', '..kyyyykkyyyYk..', '..kYyyyyyyyYYk..', '...kkYYYYYYkk...', '.....kkkkkk.....', '................',
    ],
    bin: [
      '................', '......kkkk......', '..kkkkkkkkkkkk..', '..kddddddddddk..', '..kkkkkkkkkkkk..',
      '...kggggggggk...', '...kgdgGGgdgk...', '...kgdGGGGdgk...', '...kgdgGGgdgk...', '...kgdGgGGdgk...',
      '...kgdGGgGdgk...', '...kgdgGGgdgk...', '...kgdggggdgk...', '...kggggggggk...', '....kkkkkkkk....', '................',
    ],
    settings: [
      '................', '.kkkkkkkkkkkkkk.', '.kbbbbbbbbbbbbk.', '.kggggggggggggk.', '.kggdgggdggdggk.',
      '.kggdggyyygdggk.', '.kggdggyyygdggk.', '.kggdgggdggdggk.', '.kggdgggdggdggk.', '.kgrrrggdggdggk.',
      '.kgrrrggdggdggk.', '.kggdgggdgGGGgk.', '.kggdgggdgGGGgk.', '.kggdgggdggdggk.', '.kkkkkkkkkkkkkk.', '................',
    ],
    burnfile: [
      '................', '..kkkkkkkk......', '..kwwwwwwkk.....', '..kwwwwwwkwk....', '..kwkkkkwkkkk...',
      '..kwwwwwwwwwk...', '..kwkkkkkkwwk...', '..kwwwwrwwwwk...', '..kwwwrorwwwk...', '..kwwrooorwwk...',
      '..kwwroyorwwk...', '..kwroyyyorwk...', '..kwroyyyorwk...', '..kwwrrrrrwwk...', '..kkkkkkkkkkk...', '................',
    ],
    virus: [
      '................', '......G..G......', '...G..kkkk..G...', '....kkGGGGkk....', '...kGGGGGGGGk...',
      '..kGGwwGGwwGGk..', '.GkGGwkGGwkGGkG.', '..kGGGGGGGGGGk..', '..kGGkGGGGkGGk..', '..kGGGkkkkGGGk..',
      '...kGGGGGGGGk...', '....kkGGGGkk....', '...G..kkkk..G...', '......G..G......', '................', '................',
    ],
    exe: [
      '................', '.kkkkkkkkkkkkkk.', '.kbbbbbbbbbbwbk.', '.kkkkkkkkkkkkkk.', '.kwwwwwwwwwwwwk.',
      '.kwwwwwwwwwwwwk.', '.kwwwwkkkkwwwwk.', '.kwwwkGGGGkwwwk.', '.kwwkGwGGwGkwwk.', '.kwwkGGGGGGkwwk.',
      '.kwwkGkkkkGkwwk.', '.kwwwkGGGGkwwwk.', '.kwwwwkkkkwwwwk.', '.kwwwwwwwwwwwwk.', '.kkkkkkkkkkkkkk.', '................',
    ],
    demo: [
      '................', '......kkk.......', '.....krrrk......', '.....krwrk......', '.....krrrk......',
      '......kdk.......', '......kdk.......', '......kdk.......', '..kkkkkdkkkkkk..', '.kggggggggggrgk.',
      '.kgyggggggrrrgk.', '.kggggggggggrgk.', '.kddddddddddddk.', '.kkkkkkkkkkkkkk.', '................', '................',
    ],
    drive: [
      '................', '................', '................', '................', '.kkkkkkkkkkkkkk.',
      '.kggggggggggggk.', '.kgwwwwwwwwwwdk.', '.kggggggggggggk.', '.kgggggggggGGgk.', '.kddddddddddddk.',
      '.kkkkkkkkkkkkkk.', '................', '................', '................', '................', '................',
    ],
    floppy: [
      '................', '.kkkkkkkkkkkkk..', '.kbbkwwwwwwkbbk.', '.kbbkwwwkwwkbbk.', '.kbbkwwwkwwkbbk.',
      '.kbbkwwwwwwkbbk.', '.kbbbkkkkkkbbbk.', '.kbbbbbbbbbbbbk.', '.kbbwwwwwwwwbbk.', '.kbbwkkkkkkwbbk.',
      '.kbbwwwwwwwwbbk.', '.kbbwkkkkkwwbbk.', '.kbbwwwwwwwwbbk.', '.kbbwwwwwwwwbbk.', '.kkkkkkkkkkkkkk.', '................',
    ],
    cd: [
      '................', '.....kkkkkk.....', '...kkcccccckk...', '..kccwwccccppk..', '..kcwwcccccppk..',
      '.kcwwcccccpppyk.', '.kccccckkcppyyk.', '.kcccckwwkpyyyk.', '.kcccckwwkyyyyk.', '.kccccckkyyyyyk.',
      '.kccccccyyyyyyk.', '..kccccyyyyyyk..', '..kcccyyyyyyyk..', '...kkyyyyyykk...', '.....kkkkkk.....', '................',
    ],
    image: [
      '................', '.kkkkkkkkkkkkkk.', '.kccccccccccyyk.', '.kcccccccccyyyk.', '.kccwwwccccyyck.',
      '.kcwwwwwcccccck.', '.kcccccccccccck.', '.kcccccDDccccck.', '.kccccDDDDcccck.', '.kcccDDDDDDccDk.',
      '.kccDDDDDDDDDDk.', '.kcDDDDDDDDDDDk.', '.kDDDDDDDDDDDDk.', '.kkkkkkkkkkkkkk.', '................', '................',
    ],
    doc: [
      '................', '..kkkkkkkk......', '..kwwwwwwkk.....', '..kwwwwwwkwk....', '..kwwwwwwkkkk...',
      '..kbbbbbbbbwk...', '..kbwbwbwbbwk...', '..kbwbwbwbbwk...', '..kbbwbwbbbwk...', '..kbbbbbbbbwk...',
      '..kwkkkkkkwwk...', '..kwwwwwwwwwk...', '..kwkkkkkwwwk...', '..kwwwwwwwwwk...', '..kkkkkkkkkkk...', '................',
    ],
    xls: [
      '................', '..kkkkkkkk......', '..kwwwwwwkk.....', '..kwwwwwwkwk....', '..kwwwwwwkkkk...',
      '..kDDDDDDDDDk...', '..kDwwDwwDwDk...', '..kDDDDDDDDDk...', '..kDwwDwwDwDk...', '..kDDDDDDDDDk...',
      '..kDwwDwwDwDk...', '..kDDDDDDDDDk...', '..kDwwDwwDwDk...', '..kwwwwwwwwwk...', '..kkkkkkkkkkk...', '................',
    ],
    error: [
      '................', '.....rrrrrr.....', '...rrrrrrrrrr...', '..rrrrrrrrrrrr..', '..rrrwrrrrwrrr..',
      '.rrrrwwrrwwrrrr.', '.rrrrrwwwwrrrrr.', '.rrrrrrwwrrrrrr.', '.rrrrrwwwwrrrrr.', '.rrrrwwrrwwrrrr.',
      '..rrrwrrrrwrrr..', '..rrrrrrrrrrrr..', '...rrrrrrrrrr...', '.....rrrrrr.....', '................', '................',
    ],
    warn: [
      '................', '.......kk.......', '......kyyk......', '......kyyk......', '.....kyyyyk.....',
      '.....kykkyk.....', '....kyykkyyk....', '....kyykkyyk....', '...kyyykkyyyk...', '...kyyykkyyyk...',
      '..kyyyyyyyyyyk..', '..kyyyykkyyyyk..', '.kyyyyykkyyyyyk.', '.kyyyyyyyyyyyyk.', '.kkkkkkkkkkkkkk.', '................',
    ],
    info: [
      '................', '.....bbbbbb.....', '...bbbbbbbbbb...', '..bbbbbwwbbbbb..', '..bbbbbwwbbbbb..',
      '.bbbbbbbbbbbbbb.', '.bbbbbwwwbbbbbb.', '.bbbbbbwwbbbbbb.', '.bbbbbbwwbbbbbb.', '.bbbbbbwwbbbbbb.',
      '..bbbbbwwbbbbb..', '..bbbbwwwwbbbb..', '...bbbbbbbbbb...', '.....bbbbbb.....', '................', '................',
    ],
    speaker: [
      '................', '................', '.......kk.......', '......kwk...k...', '.....kwwk....k..',
      '.kkkkwwwk.k...k.', '.kwwwwwwk..k..k.', '.kwwwwwwk..k..k.', '.kwwwwwwk..k..k.', '.kkkkwwwk.k...k.',
      '.....kwwk....k..', '......kwk...k...', '.......kk.......', '................', '................', '................',
    ],
    mute: [
      '................', '................', '.......kk.......', '......kwk.......', '.....kwwk.r...r.',
      '.kkkkwwwk..r.r..', '.kwwwwwwk...r...', '.kwwwwwwk..r.r..', '.kwwwwwwk.r...r.', '.kkkkwwwk.......',
      '.....kwwk.......', '......kwk.......', '.......kk.......', '................', '................', '................',
    ],
  };

  const urls = {};

  function url(name) {
    if (urls[name]) return urls[name];
    const map = MAPS[name] || MAPS.exe;
    const cv = document.createElement('canvas');
    cv.width = 16;
    cv.height = 16;
    const ctx = cv.getContext('2d');
    map.forEach((row, y) => {
      for (let x = 0; x < 16; x++) {
        const ch = row[x];
        if (!ch || ch === '.') continue;
        ctx.fillStyle = PAL[ch] || '#ff00ff';
        ctx.fillRect(x, y, 1, 1);
      }
    });
    return (urls[name] = cv.toDataURL());
  }

  function hydrate(root) {
    (root || document).querySelectorAll('img[data-icon]').forEach((img) => {
      img.src = url(img.dataset.icon);
      if (!img.hasAttribute('alt')) img.alt = '';
    });
  }

  VX.icons = { url, hydrate, has: (n) => !!MAPS[n] };
})();
