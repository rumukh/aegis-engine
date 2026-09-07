import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { format } from 'prettier';

const root = new URL('../', import.meta.url);
const ink = '#101f2b';
const slate = '#284652';
const teal = '#3c6b70';
const brass = '#d3a763';
const cream = '#f4d3a1';
const signal = '#a5f3e0';
const coral = '#e76448';

const path = (d, fill, stroke = 'none', width = 1, extra = '') =>
  `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round" ${extra}/>`;
const rect = (x, y, w, h, fill, r = 0, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${extra}/>`;
const circle = (x, y, r, fill, extra = '') =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" ${extra}/>`;
const ellipse = (x, y, rx, ry, fill, extra = '') =>
  `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" ${extra}/>`;
const group = (transform, body, extra = '') => `<g transform="${transform}" ${extra}>${body}</g>`;
const line = (x1, y1, x2, y2, color, width = 1, extra = '') =>
  `<path d="M${x1} ${y1}L${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" ${extra}/>`;
const svg = (width, height, body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs}</defs>${body}</svg>\n`;

const gradients = `
  <linearGradient id="coat" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#81a19a"/><stop offset=".5" stop-color="${teal}"/><stop offset="1" stop-color="${slate}"/></linearGradient>
  <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#e7c98e"/><stop offset=".3" stop-color="${brass}"/><stop offset="1" stop-color="#82603b"/></linearGradient>
  <linearGradient id="rock" x1="0" y1="0" x2=".5" y2="1"><stop stop-color="#385968"/><stop offset=".42" stop-color="#253e4b"/><stop offset="1" stop-color="#142936"/></linearGradient>
  <linearGradient id="lava" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff0ae"/><stop offset=".13" stop-color="#ffb34e"/><stop offset=".35" stop-color="${coral}"/><stop offset="1" stop-color="#6b2530"/></linearGradient>
  <radialGradient id="glow"><stop stop-color="#e2fff0" stop-opacity=".85"/><stop offset=".25" stop-color="${signal}" stop-opacity=".38"/><stop offset="1" stop-color="${signal}" stop-opacity="0"/></radialGradient>
  <radialGradient id="ember"><stop stop-color="#fff4bc" stop-opacity=".9"/><stop offset=".2" stop-color="#ffb553" stop-opacity=".5"/><stop offset="1" stop-color="${coral}" stop-opacity="0"/></radialGradient>
`;

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function grain(width, height, count, seed, color, opacity = 0.15) {
  const next = random(seed);
  let body = '';
  for (let i = 0; i < count; i++) {
    const x = Math.floor(next() * width);
    const y = Math.floor(next() * height);
    const length = 1 + Math.floor(next() * 7);
    body += rect(x, y, length, 1, color, 0, `opacity="${opacity}"`);
  }
  return body;
}

function bolt(x, y, size = 3) {
  return (
    circle(x, y, size + 1, ink) +
    circle(x, y - 0.6, size, brass) +
    line(x - 1, y, x + 1, y, '#6a5138')
  );
}

function boot(angle, x, y, back = false) {
  const limb = [
    path(
      'M-8 -58L9 -58L8 -13L13 -8L22 -7L23 1L-11 1L-11 -11Z',
      back ? '#263d4a' : '#36525c',
      ink,
      3,
    ),
    rect(-9, -14, 20, 13, back ? '#806344' : '#c3935e', 3),
    path('M-10 -5L12 -5L19 -3L22 2L-11 2Z', ink),
    rect(-7, -27, 14, 5, back ? '#506467' : '#78908a', 2),
    line(-5, -11, 7, -11, cream, 2),
  ].join('');
  return group(`translate(${x} ${y}) rotate(${angle} 0 -55)`, limb);
}

function arm(angle, back = false) {
  const limb = [
    path('M-9 -99Q-18 -94 -13 -76L-8 -60L6 -62L4 -81L8 -98Z', back ? '#2c535d' : '#65928b', ink, 3),
    rect(-10, -68, 17, 8, brass, 3),
    path('M-10 -60Q-12 -50 -3 -47L7 -50L7 -59Z', '#303c43', ink, 2),
    line(-4, -57, 2, -57, '#a8a19a', 2),
  ].join('');
  return group(`rotate(${angle} 0 -99)`, limb);
}

function engineer(pose) {
  const {
    left = 0,
    right = 0,
    armLeft = 0,
    armRight = 0,
    bob = 0,
    tilt = 0,
    scarf = 0,
    celebrate = false,
    hurt = false,
  } = pose;
  const body = [
    group('translate(-17 0)', arm(armLeft, true)),
    boot(left, -10, 0, true),
    path('M-26 -107L-39 -103L-40 -65L-29 -57L-22 -72Z', '#263d4a', ink, 3),
    rect(-38, -104, 13, 35, brass, 4),
    rect(-36, -98, 9, 20, '#547578', 2),
    line(-37, -93, -28, -93, signal, 2),
    line(-35, -88, -28, -88, '#18333b', 2),
    path('M-34 -106L-34 -116L-29 -118L-24 -112', 'none', brass, 4),
    boot(right, 9, 0),
    path('M-22 -105Q-5 -116 17 -106L24 -59Q4 -47 -25 -57L-21 -78Z', 'url(#coat)', ink, 3),
    path('M-19 -104L-14 -82L-12 -56L-20 -57L-24 -80Z', '#91aea0', 'none', 1, 'opacity=".7"'),
    rect(-25, -63, 48, 8, '#b88c55', 2),
    rect(-1, -64, 10, 10, ink, 1),
    rect(1, -62, 6, 6, cream, 1),
    rect(-8, -94, 19, 15, '#2c5158', 3, `stroke="${ink}" stroke-width="2"`),
    line(-5, -89, 8, -89, signal, 2),
    circle(7, -90, 2, signal),
    path(
      `M-15 -114Q-31 ${-120 + scarf} -49 ${-113 + scarf}L-63 ${-118 + scarf}L-55 ${-103 + scarf}L-44 ${-108 + scarf}L-17 -108Z`,
      coral,
      ink,
      2,
    ),
    path('M-18 -114Q1 -121 20 -112L18 -103Q0 -107 -18 -106Z', '#f08956', ink, 2),
    group('translate(14 0)', arm(armRight)),
    path('M-12 -141Q10 -151 26 -131L22 -111L-6 -111L-17 -124Z', '#e1b182', ink, 3),
    path('M15 -133L25 -130L29 -122L22 -119L23 -112L9 -113Z', '#f4d3a1'),
    path('M-21 -133Q-23 -158 0 -163Q23 -164 31 -140L27 -131Z', 'url(#metal)', ink, 3),
    path('M-10 -156Q1 -161 9 -157L14 -138L-4 -138Z', '#f7d699'),
    path('M-27 -138Q4 -145 33 -137L35 -130Q1 -133 -25 -129Z', brass, ink, 3),
    rect(-12, -129, 39, 17, '#17333d', 6, `stroke="${ink}" stroke-width="3"`),
    rect(4, -127, 18, 12, hurt ? '#f0bd97' : signal, 5),
    path('M6 -126L19 -126L9 -117L6 -117Z', '#effff0', 'none', 1, 'opacity=".8"'),
    circle(-12, -121, 6, '#a07542', `stroke="${ink}" stroke-width="2"`),
    circle(-12, -121, 2.5, cream),
    rect(-1, -153, 8, 9, ink, 2),
    rect(0, -151, 6, 5, signal, 1),
  ].join('');
  return (
    group(`translate(80 ${178 + bob}) rotate(${tilt} 0 -60)`, body) +
    (celebrate ? path('M115 23L118 12L121 23L132 26L121 29L118 40L115 29L104 26Z', cream) : '')
  );
}

const engineerPoses = [
  { name: 'idle-0' },
  { name: 'idle-1', bob: -1, scarf: -2 },
  { name: 'run-0', left: -35, right: 40, armLeft: 38, armRight: -28, tilt: 8, scarf: -5 },
  { name: 'run-1', left: -17, right: 24, armLeft: 20, armRight: -17, tilt: 8, bob: -4, scarf: -3 },
  { name: 'run-2', left: 9, right: -5, armLeft: -5, armRight: 5, tilt: 8, bob: -7, scarf: -4 },
  { name: 'run-3', left: 40, right: -35, armLeft: -28, armRight: 38, tilt: 8, scarf: -6 },
  { name: 'run-4', left: 24, right: -17, armLeft: -17, armRight: 20, tilt: 8, bob: -4, scarf: -4 },
  { name: 'run-5', left: -5, right: 9, armLeft: 5, armRight: -5, tilt: 8, bob: -7, scarf: -3 },
  { name: 'jump', left: -25, right: 35, armLeft: 90, armRight: -70, tilt: -5, bob: -4, scarf: 7 },
  { name: 'fall', left: 18, right: -12, armLeft: 75, armRight: -60, tilt: 6, scarf: -8 },
  { name: 'land', left: -28, right: 27, armLeft: 35, armRight: -25, bob: 7, tilt: 8, scarf: -4 },
  { name: 'win-0', left: -9, right: 9, armLeft: 145, armRight: -155, bob: -4, celebrate: true },
  {
    name: 'win-1',
    left: -18,
    right: 18,
    armLeft: 158,
    armRight: -140,
    bob: -9,
    scarf: -6,
    celebrate: true,
  },
  {
    name: 'win-2',
    left: -9,
    right: 9,
    armLeft: 145,
    armRight: -155,
    bob: -4,
    scarf: 2,
    celebrate: true,
  },
  { name: 'hurt', left: 20, right: -25, armLeft: 60, armRight: -90, tilt: -18, hurt: true },
  { name: 'rest', left: -8, right: 8, armLeft: 5, armRight: -5, bob: 2 },
];

function atlas(columns, width, height, frames, draw) {
  return frames
    .map((frame, index) =>
      group(
        `translate(${(index % columns) * width} ${Math.floor(index / columns) * height})`,
        draw(frame, index),
      ),
    )
    .join('');
}

function critter(frame) {
  const step = frame % 4;
  const shift = [0, 4, 0, -4][step];
  const body = [
    ellipse(66, 109, 43, 8, ink, 'opacity=".23"'),
    path(
      `M37 82L${24 + shift} 99L${35 + shift} 102M55 88L${48 - shift} 107L${59 - shift} 107M83 88L${91 + shift} 106L${102 + shift} 106M100 80L${113 - shift} 96L${122 - shift} 96`,
      'none',
      ink,
      7,
    ),
    path('M20 72L10 66L6 55L19 59L30 66', '#b45847', ink, 3),
    path('M22 80Q13 50 47 35Q81 16 105 48L111 76Q72 95 22 80Z', '#7c4044', ink, 3),
    path('M25 59Q41 31 68 30Q100 30 105 62L81 78L44 76Z', coral, ink, 3),
    path('M31 54L43 42L49 68L38 70ZM58 33L74 31L73 70L57 72ZM86 36L98 47L95 65L82 70Z', '#b5463e'),
    path('M28 57Q62 44 100 56', 'none', '#ffbb79', 2),
    path('M24 72L40 84L77 89L101 78L106 63L94 58L75 65L47 66Z', '#39464c', ink, 3),
    path('M82 65L96 59L110 66L115 81L102 89L81 83Z', '#557471', ink, 3),
    ellipse(103, 72, 8, 10, ink),
    ellipse(104, 71, 4, 6, '#ffe5a5'),
    circle(105, 69, 1.5, '#ffffff'),
    path('M108 82L120 80L115 87L106 88', ink),
    path('M86 56L82 45L85 38M97 56L101 44L108 40', 'none', ink, 3),
    circle(84, 37, 3, brass),
    circle(110, 39, 3, brass),
    circle(43, 50, 3, '#ffc186'),
    circle(66, 40, 2.5, '#ffc186'),
    circle(89, 48, 2.5, '#ffc186'),
  ].join('');
  return frame === 4 ? group('translate(0 80) scale(1 .32)', body) : body;
}

function rockTile(index) {
  const next = random(300 + index);
  let body = rect(0, 0, 128, 128, 'url(#rock)');
  const strata = [
    ['M0 12L32 8L66 18L106 7L128 11L128 32L91 38L41 28L0 37Z', '#3b5e69'],
    ['M0 44L36 38L75 48L115 33L128 38L128 76L83 66L44 79L0 66Z', '#2f4e5c'],
    ['M0 86L37 75L79 87L128 74L128 112L91 110L61 122L0 114Z', '#244351'],
  ];
  for (const [d, color] of strata) body += path(d, color);
  body += path(
    'M0 33L32 27L53 33L76 30L103 36L128 29M0 74L34 70L49 76L91 66L128 73M15 128L28 99L22 80M83 68L77 44L85 33M106 128L98 111L106 95',
    'none',
    '#102936',
    2,
  );
  for (let i = 0; i < 15; i++) {
    const x = Math.round(next() * 110);
    const y = Math.round(next() * 112);
    const length = Math.round(5 + next() * 16);
    body += path(
      `M${x} ${y}L${x + length} ${y - 3}L${x + length - 3} ${y + 2}L${x + 2} ${y + 4}Z`,
      i % 3 === 0 ? '#8b8970' : '#56717a',
      'none',
      1,
      'opacity=".32"',
    );
  }
  body += grain(128, 128, 140, 2000 + index, '#92a9a0', 0.11);
  return body;
}

function terrainCell(index) {
  if (index < 4) return rockTile(index);
  if (index === 4) {
    return (
      rockTile(4) +
      path('M0 0L128 0L128 16L112 18L88 13L65 18L44 13L23 16L0 11Z', '#98a08b') +
      rect(0, 0, 128, 5, '#d7c8a1') +
      path('M0 6L24 8L31 5L54 9L76 5L89 10L114 7L128 10', 'none', '#697f77', 2) +
      path('M4 17L8 31L12 15M48 18L51 27L57 18M94 18L97 29L102 17', 'none', '#445f60', 3)
    );
  }
  if (index === 5) {
    return (
      rect(0, 0, 128, 128, '#19313f') +
      rect(0, 0, 128, 9, brass) +
      rect(0, 9, 128, 10, '#426472') +
      rect(0, 20, 128, 7, ink) +
      path(
        'M0 28L32 49L0 70M32 49L64 28L64 70ZM64 28L96 49L64 70M96 49L128 28L128 70Z',
        'none',
        '#426774',
        8,
      ) +
      rect(0, 72, 128, 8, '#55787e') +
      [8, 40, 72, 104].map((x) => bolt(x, 13)).join('') +
      grain(128, 128, 190, 733, brass, 0.13)
    );
  }
  if (index === 6) {
    return (
      [0, 1, 2, 3]
        .map((i) => {
          const x = i * 32;
          return (
            path(`M${x + 1} 126L${x + 15} ${i % 2 ? 19 : 5}L${x + 31} 126Z`, '#89969a', ink, 2) +
            path(
              `M${x + 15} ${i % 2 ? 19 : 5}L${x + 17} 115L${x + 28} 126L${x + 31} 126Z`,
              '#38515d',
            ) +
            path(`M${x + 9} 75L${x + 15} ${i % 2 ? 22 : 8}L${x + 15} 89Z`, cream)
          );
        })
        .join('') +
      rect(0, 116, 128, 12, '#253b45') +
      rect(0, 116, 128, 3, coral)
    );
  }
  if (index === 7) {
    return (
      rect(0, 0, 128, 128, 'url(#lava)') +
      path('M0 10Q16 0 32 10T64 10T96 10T128 10', 'none', '#fff0b0', 5) +
      path('M-3 55L27 41L48 55L72 36L103 54L133 39L135 66L95 78L70 63L38 81L0 71Z', '#962f32') +
      path('M0 94L29 85L41 97L70 80L88 100L128 85L128 128L0 128Z', '#522d37') +
      path('M10 53L26 47L34 51M55 49L72 41L85 50M89 92L111 87', 'none', '#ffcb71', 3) +
      circle(24, 23, 3, '#fff2b6') +
      ellipse(91, 29, 6, 2, '#fff2b6')
    );
  }
  if (index === 8) {
    return (
      rect(0, 0, 128, 128, '#182f3e') +
      path('M8 8L120 8L120 120L8 120Z', '#365761', ink, 5) +
      path('M14 16L111 16L111 52L91 59L14 56Z', '#59777a') +
      rect(18, 28, 44, 8, brass) +
      [22, 44, 66, 88].map((y) => rect(78, y + 2, 21, 7, ink, 2)).join('') +
      [16, 112].flatMap((x) => [16, 112].map((y) => bolt(x, y))).join('') +
      grain(128, 128, 260, 332, '#bec2a2', 0.18)
    );
  }
  if (index === 9) {
    return (
      rect(0, 0, 128, 128, '#2b454e') +
      [0, 32, 64, 96, 128]
        .map((x) => path(`M${x - 32} 0L${x - 5} 0L${x + 123} 128L${x + 96} 128Z`, brass))
        .join('') +
      rect(0, 0, 128, 7, '#142734') +
      rect(0, 121, 128, 7, '#142734') +
      grain(128, 128, 350, 755, '#101f2b', 0.28)
    );
  }
  if (index === 10) {
    return (
      rect(0, 0, 128, 128, '#213b48') +
      path(
        'M0 13L128 13M0 43L128 43M0 73L128 73M0 103L128 103M28 0L28 128M68 0L68 128M108 0L108 128',
        'none',
        '#44616a',
        3,
      ) +
      path(
        'M0 18L128 18M0 48L128 48M0 78L128 78M0 108L128 108M31 0L31 128M71 0L71 128M111 0L111 128',
        'none',
        '#122a37',
        4,
      )
    );
  }
  return (
    rect(0, 0, 128, 128, '#d3a763') +
    rect(8, 8, 112, 112, '#173540', 7) +
    path('M28 54L63 26L99 54L81 54L81 90L45 90L45 54Z', cream) +
    circle(21, 107, 3, '#7d9b8e') +
    circle(108, 107, 3, '#7d9b8e')
  );
}

function ferry() {
  let body = [
    ellipse(256, 151, 229, 22, '#061721', 'opacity=".32"'),
    path('M18 38L493 38L504 64L480 121L35 121L8 66Z', '#27424e', ink, 5),
    rect(17, 35, 478, 17, 'url(#metal)', 4, `stroke="${ink}" stroke-width="3"`),
    rect(22, 40, 468, 4, cream, 2),
    rect(26, 54, 461, 17, '#52747a', 2),
    path('M39 77L472 77L451 109L59 109Z', '#142e3c', ink, 3),
    [61, 145, 229, 313, 397]
      .map((x) => path(`M${x} 107L${x + 42} 78L${x + 82} 107`, 'none', '#5a7d80', 7))
      .join(''),
    rect(39, 118, 436, 12, '#66858a', 2, `stroke="${ink}" stroke-width="3"`),
    rect(36, 120, 440, 3, '#a7b5a6', 1),
    [62, 194, 326, 450].map((x) => bolt(x, 60, 4)).join(''),
    [80, 430]
      .map(
        (x) =>
          circle(x, 117, 29, ink) +
          circle(x, 116, 23, '#52737a') +
          circle(x, 116, 16, '#1c3644') +
          circle(x, 115, 8, brass) +
          path(`M${x - 15} 114L${x + 15} 114M${x} 101L${x} 131`, 'none', '#73908d', 3),
      )
      .join(''),
    rect(190, 84, 132, 21, ink, 5),
    rect(201, 91, 110, 6, '#9ce8d0', 2),
    rect(218, 89, 13, 10, '#edf8d7', 2),
    path('M20 26L20 9L30 9L30 28M483 26L483 9L492 9L492 28', 'none', '#557f86', 6),
    circle(25, 9, 6, signal) + circle(488, 9, 6, signal),
    rect(27, 29, 466, 6, '#192f3b', 1),
  ].join('');
  for (let x = 39; x < 470; x += 24) body += line(x, 30, x + 10, 33, '#8d9c91', 2);
  return body;
}

function beacon(active) {
  return [
    active ? ellipse(132, 94, 83, 83, 'url(#glow)') : '',
    path('M47 294L208 294L224 314L224 329L30 329L30 314Z', '#365c66', ink, 5),
    rect(47, 284, 161, 15, brass, 3),
    rect(60, 265, 136, 22, '#1a343f', 3, `stroke="${ink}" stroke-width="4"`),
    path('M99 113L150 113L157 263L93 263Z', '#315963', ink, 5),
    path('M102 126L115 122L114 251L103 257Z', '#689592'),
    rect(111, 145, 28, 84, '#132d37', 5),
    rect(119, 151, 11, 67, active ? signal : '#728c7f', 3),
    path('M85 49L166 49L174 105L155 130L96 130L77 105Z', '#345763', ink, 5),
    path('M90 61L158 61L162 100L151 114L99 114L87 99Z', active ? '#aff1d4' : '#476f72', ink, 3),
    path(
      'M96 66L114 66L105 106L95 101Z',
      '#edffcf',
      'none',
      1,
      `opacity="${active ? '.8' : '.15'}"`,
    ),
    path('M82 50L93 32L159 32L172 50Z', 'url(#metal)', ink, 4),
    path('M110 30L110 12L143 12L143 30', '#59767a', ink, 3),
    path('M102 12L149 12L146 5L106 5Z', cream, ink, 3),
    path('M101 119L153 119L147 131L106 131Z', brass, ink, 3),
    path('M155 153L204 134L199 193L154 203Z', '#d99351', ink, 3),
    path('M166 159L191 151L188 179L164 188Z', '#254752'),
    path('M174 161L174 178M168 174L180 165', 'none', cream, 3),
    [72, 186].map((x) => bolt(x, 291, 4)).join(''),
    path('M77 258L65 225L70 195M173 258L184 216L182 191', 'none', brass, 4),
  ].join('');
}

function machinery(index) {
  if (index === 0) {
    return (
      path('M27 233L53 217L153 217L177 233L177 248L27 248Z', '#203943', ink, 4) +
      rect(69, 76, 20, 149, '#47656b', 3, `stroke="${ink}" stroke-width="3"`) +
      path('M71 136L146 158L146 169L71 151Z', brass, ink, 3) +
      path('M88 86L43 51L55 38L98 72Z', '#587e80', ink, 3) +
      circle(96, 80, 50, ink) +
      circle(96, 80, 44, '#456872') +
      circle(96, 80, 34, '#1e3b48') +
      [0, 60, 120, 180, 240, 300]
        .map((angle) =>
          group(`rotate(${angle} 96 80)`, path('M96 76L85 50L100 40L112 68Z', '#82a098')),
        )
        .join('') +
      circle(96, 80, 13, 'url(#metal)', `stroke="${ink}" stroke-width="3"`) +
      path('M113 211L123 140L144 145L153 212Z', '#41646d', ink, 3) +
      rect(118, 174, 30, 11, brass, 2) +
      grain(192, 256, 160, 146, brass, 0.1)
    );
  }
  if (index === 1) {
    return (
      path('M22 232L151 232L166 248L13 248Z', '#1c3541', ink, 3) +
      rect(43, 90, 99, 138, '#365860', 9, `stroke="${ink}" stroke-width="4"`) +
      path('M37 100L42 76L141 76L147 100Z', brass, ink, 4) +
      rect(51, 112, 80, 72, '#1c3541', 4) +
      [0, 1, 2, 3].map((i) => rect(60, 121 + i * 15, 62, 6, '#6b8b89', 2)).join('') +
      rect(62, 196, 55, 20, '#cf9555', 2) +
      path('M78 200L101 200L101 204L83 204L83 211L78 211Z', '#1b3742') +
      path('M82 75L82 22L120 22L120 11', 'none', ink, 15) +
      path('M82 75L82 22L120 22L120 11', 'none', '#75918c', 8) +
      path('M42 212L26 190L28 126L39 113', 'none', brass, 6) +
      circle(88, 89, 6, ink) +
      circle(88, 89, 3, signal) +
      bolt(56, 103) +
      bolt(128, 103)
    );
  }
  if (index === 2) {
    return (
      rect(89, 29, 12, 215, '#566d6c', 1, `stroke="${ink}" stroke-width="3"`) +
      path('M24 50L149 50L175 83L149 116L24 116Z', '#cc9f5c', ink, 5) +
      path('M35 61L143 61L160 83L143 105L35 105Z', '#254854') +
      path('M64 75L103 75L103 66L124 83L103 99L103 90L64 90Z', cream) +
      path('M54 162L143 162L151 200L47 200Z', '#436770', ink, 4) +
      path('M91 170L74 191L109 191Z', brass, ink, 2) +
      line(92, 178, 92, 184, ink, 3) +
      circle(92, 188, 1, ink) +
      bolt(39, 83, 3) +
      bolt(143, 83, 3)
    );
  }
  return (
    path('M11 232L181 232L181 248L11 248Z', '#152e3d', ink, 3) +
    path('M34 232L34 54L54 38L54 232M138 232L138 38L158 54L158 232', '#3b5f68', ink, 4) +
    path('M37 63L155 63L155 40L37 40Z', brass, ink, 4) +
    path('M54 75L136 211M136 75L54 211', 'none', '#3b5b65', 10) +
    rect(29, 101, 24, 23, brass, 3) +
    rect(138, 169, 24, 23, brass, 3) +
    path('M52 27Q96 -4 141 27', 'none', '#91aa9f', 5) +
    path('M50 28L141 28', 'none', '#254b57', 3)
  );
}

function midground() {
  let body = path(
    'M0 393L45 346L125 360L151 241L207 228L255 271L272 160L332 150L370 216L403 317L460 336L499 252L561 224L597 298L648 285L693 204L757 196L798 322L861 352L914 251L983 245L1010 350L1080 344L1120 189L1190 167L1236 214L1280 363L1335 378L1377 250L1431 267L1460 393L1536 371L1536 640L0 640Z',
    '#294b58',
  );
  body += path(
    'M126 361L155 250L192 248L170 480L139 523ZM274 170L298 158L295 470L261 551ZM500 260L548 231L529 435L486 490ZM696 212L733 204L714 520L669 575ZM920 266L956 252L941 425L902 519ZM1128 199L1170 176L1152 503L1099 540ZM1385 267L1416 277L1410 540L1376 568Z',
    '#476b70',
    'none',
    1,
    'opacity=".6"',
  );
  body += path(
    'M-10 431L184 420L305 438L516 390L746 409L950 367L1191 397L1550 371',
    'none',
    '#92a598',
    3,
    'opacity=".55"',
  );
  body += path(
    'M-10 439L184 428L305 446L516 398L746 417L950 375L1191 405L1550 379',
    'none',
    '#193b4b',
    8,
  );
  for (const [x, y] of [
    [188, 285],
    [436, 361],
    [870, 358],
    [1313, 374],
  ]) {
    body += group(`translate(${x} ${y}) scale(.62)`, machinery(3));
  }
  body += path(
    'M198 301Q435 369 443 381M443 381Q662 488 879 377M879 377Q1105 450 1318 392',
    'none',
    '#22414f',
    3,
  );
  body += grain(1536, 640, 1800, 1893, '#78918a', 0.06);
  return body;
}

function foreground() {
  let body = path(
    'M0 403L30 387L84 409L126 383L162 418L212 403L261 421L306 399L349 416L411 405L450 428L498 420L529 401L592 428L650 412L692 435L742 424L806 403L852 422L906 409L955 428L1007 414L1062 429L1108 402L1167 418L1230 397L1276 422L1340 407L1390 426L1446 403L1492 419L1536 400L1536 512L0 512Z',
    '#102635',
  );
  for (const x of [75, 310, 670, 1100, 1470]) {
    body += path(
      `M${x} 440Q${x - 12} 372 ${x + 4} 319M${x} 401Q${x - 17} 360 ${x - 41} 357M${x} 382Q${x + 26} 341 ${x + 40} 344`,
      'none',
      '#142e3b',
      6,
    );
    body += path(
      `M${x - 8} 389Q${x - 59} 358 ${x - 45} 331Q${x - 22} 341 ${x - 8} 389M${x + 5} 367Q${x + 44} 338 ${x + 55} 322Q${x + 71} 352 ${x + 5} 367`,
      '#193544',
    );
  }
  body += path('M0 324Q320 424 768 367Q1180 330 1536 300', 'none', '#0b1f2c', 7);
  return body;
}

function effect(index) {
  if (index < 4) {
    const amount = index + 1;
    const opacity = [0.95, 0.7, 0.4, 0.16][index];
    return group(
      'translate(64 80)',
      [
        ellipse(0, 20, 19 + amount * 8, 4, '#101f2b', 'opacity=".18"'),
        ellipse(-15 - amount * 6, 7 - amount * 3, 8 + amount * 3, 7 + amount * 2, cream),
        ellipse(16 + amount * 5, 7 - amount * 3, 7 + amount * 3, 5 + amount * 2, '#c2b397'),
        ellipse(-2, -2 - amount * 3, 9 + amount * 2, 7 + amount * 3, '#e7d6af'),
        path(
          `M-14 0L${-25 - amount * 7} ${-19 - amount * 3}M14 1L${28 + amount * 5} ${-16 - amount * 3}`,
          'none',
          cream,
          3,
        ),
      ].join(''),
      `opacity="${opacity}"`,
    );
  }
  if (index === 4) return circle(64, 64, 60, 'url(#glow)');
  if (index === 5) return circle(64, 64, 62, 'url(#ember)');
  if (index === 6) {
    return (
      path(
        'M64 3L73 48L105 22L81 56L125 64L79 74L105 106L73 83L64 125L54 81L22 106L47 73L3 64L46 55L23 23L55 46Z',
        '#ffd58b',
      ) + path('M64 35L71 57L94 64L70 71L64 97L57 71L33 64L57 56Z', '#fff7ce')
    );
  }
  return path('M64 14L73 49L108 58L76 70L67 112L56 77L18 66L52 54Z', signal);
}

const terrainNames = [
  'rock-0',
  'rock-1',
  'rock-2',
  'rock-3',
  'edge',
  'girder',
  'spikes',
  'lava',
  'panel',
  'warning',
  'grating',
  'waypoint',
];

const outputs = new Map([
  ['engineer.svg', svg(1280, 384, atlas(8, 160, 192, engineerPoses, engineer), gradients)],
  ['critter.svg', svg(640, 128, atlas(5, 128, 128, [0, 1, 2, 3, 4], critter), gradients)],
  [
    'terrain.svg',
    svg(
      512,
      384,
      atlas(
        4,
        128,
        128,
        Array.from({ length: 12 }, (_, i) => i),
        terrainCell,
      ),
      gradients,
    ),
  ],
  ['ferry.svg', svg(512, 192, ferry(), gradients)],
  ['beacon.svg', svg(512, 352, atlas(2, 256, 352, [false, true], beacon), gradients)],
  ['machinery.svg', svg(768, 256, atlas(4, 192, 256, [0, 1, 2, 3], machinery), gradients)],
  ['midground.svg', svg(1536, 640, midground(), gradients)],
  ['foreground.svg', svg(1536, 512, foreground())],
  [
    'effects.svg',
    svg(
      1024,
      128,
      atlas(
        8,
        128,
        128,
        Array.from({ length: 8 }, (_, i) => i),
        effect,
      ),
      gradients,
    ),
  ],
]);

for (const [index, name] of terrainNames.entries()) {
  outputs.set(`terrain-${name}.svg`, svg(128, 128, terrainCell(index), gradients));
}

const frames = (names, columns, width, height) =>
  Object.fromEntries(
    names.map((name, index) => [
      name,
      { x: (index % columns) * width, y: Math.floor(index / columns) * height, width, height },
    ]),
  );

const manifest = {
  version: 1,
  coordinates:
    'Top-left pixel coordinates; dimensions include transparent padding. No rotation or trimming.',
  textures: {
    engineer: {
      file: 'engineer.svg',
      width: 1280,
      height: 384,
      frameWidth: 160,
      frameHeight: 192,
      columns: 8,
      anchor: { x: 80, y: 178 },
      frames: frames(
        engineerPoses.map((pose) => pose.name),
        8,
        160,
        192,
      ),
      animations: {
        idle: [0, 1],
        run: [2, 3, 4, 5, 6, 7],
        jump: [8],
        fall: [9],
        land: [10],
        win: [11, 12, 13],
        hurt: [14],
        rest: [15],
      },
    },
    critter: {
      file: 'critter.svg',
      width: 640,
      height: 128,
      frameWidth: 128,
      frameHeight: 128,
      columns: 5,
      anchor: { x: 64, y: 110 },
      frames: frames(['walk-0', 'walk-1', 'walk-2', 'walk-3', 'stomped'], 5, 128, 128),
    },
    terrain: {
      file: 'terrain.svg',
      width: 512,
      height: 384,
      frameWidth: 128,
      frameHeight: 128,
      columns: 4,
      frames: frames(terrainNames, 4, 128, 128),
      standalone: Object.fromEntries(terrainNames.map((name) => [name, `terrain-${name}.svg`])),
    },
    ferry: { file: 'ferry.svg', width: 512, height: 192, deck: { left: 17, top: 35, right: 495 } },
    beacon: {
      file: 'beacon.svg',
      width: 512,
      height: 352,
      frameWidth: 256,
      frameHeight: 352,
      columns: 2,
      frames: frames(['idle', 'active'], 2, 256, 352),
    },
    machinery: {
      file: 'machinery.svg',
      width: 768,
      height: 256,
      frameWidth: 192,
      frameHeight: 256,
      columns: 4,
      frames: frames(['turbine', 'compressor', 'direction', 'gantry'], 4, 192, 256),
    },
    midground: { file: 'midground.svg', width: 1536, height: 640 },
    foreground: { file: 'foreground.svg', width: 1536, height: 512 },
    effects: {
      file: 'effects.svg',
      width: 1024,
      height: 128,
      frameWidth: 128,
      frameHeight: 128,
      columns: 8,
      frames: frames(
        ['dust-0', 'dust-1', 'dust-2', 'dust-3', 'signal-glow', 'ember-glow', 'impact', 'spark'],
        8,
        128,
        128,
      ),
    },
  },
};
outputs.set(
  'atlas.json',
  await format(JSON.stringify(manifest), { parser: 'json', printWidth: 100, tabWidth: 2 }),
);

await mkdir(root, { recursive: true });
for (const [name, content] of outputs) await writeFile(new URL(name, root), content, 'utf8');

const previews = [...outputs.keys()].filter(
  (name) => name.endsWith('.svg') && !name.startsWith('terrain-'),
);
await writeFile(
  new URL('contact-sheet.html', root),
  await format(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Coyote Gap original asset sheet</title>
<style>body{margin:0;padding:36px;background:#10202d;color:#f4d3a1;font:15px system-ui}h1{letter-spacing:.08em;font-size:24px}h2{font-size:12px;letter-spacing:.12em;text-transform:uppercase}section{margin:32px 0}img{display:block;max-width:100%;height:auto;background:linear-gradient(135deg,#29414c,#1e3340);border:1px solid #49616a}p{color:#92b0ad;max-width:760px}</style></head>
<body><h1>COYOTE GAP / THE AMBER TRAVERSE</h1><p>Original expedition-engineer, furnace beetle and cliffside machinery. All geometry is illustrative, view-only, and separate from the authoritative collision grid.</p>
${previews.map((name) => `<section><h2>${name}</h2><img src="${name}" alt="${name.replace('.svg', '')} original asset sheet"></section>`).join('\n')}
</body></html>\n`,
    { parser: 'html', printWidth: 100, tabWidth: 2 },
  ),
  'utf8',
);
