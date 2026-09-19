import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Raster, clamp, decodePng, noise, normalMap, png, resample, seamless } from './raster.mjs';
import { ringDensity } from './optical-surfaces.mjs';

const GLYPHS = {
  A: '01110/10001/10001/11111/10001/10001/10001',
  B: '11110/10001/10001/11110/10001/10001/11110',
  C: '01111/10000/10000/10000/10000/10000/01111',
  D: '11110/10001/10001/10001/10001/10001/11110',
  E: '11111/10000/10000/11110/10000/10000/11111',
  F: '11111/10000/10000/11110/10000/10000/10000',
  G: '01111/10000/10000/10111/10001/10001/01111',
  H: '10001/10001/10001/11111/10001/10001/10001',
  I: '111/010/010/010/010/010/111',
  J: '00111/00010/00010/00010/00010/10010/01100',
  K: '10001/10010/10100/11000/10100/10010/10001',
  L: '10000/10000/10000/10000/10000/10000/11111',
  M: '10001/11011/10101/10101/10001/10001/10001',
  N: '10001/11001/10101/10011/10001/10001/10001',
  O: '01110/10001/10001/10001/10001/10001/01110',
  P: '11110/10001/10001/11110/10000/10000/10000',
  Q: '01110/10001/10001/10001/10101/10010/01101',
  R: '11110/10001/10001/11110/10100/10010/10001',
  S: '01111/10000/10000/01110/00001/00001/11110',
  T: '11111/00100/00100/00100/00100/00100/00100',
  U: '10001/10001/10001/10001/10001/10001/01110',
  V: '10001/10001/10001/10001/10001/01010/00100',
  W: '10001/10001/10001/10101/10101/11011/10001',
  X: '10001/10001/01010/00100/01010/10001/10001',
  Y: '10001/10001/01010/00100/00100/00100/00100',
  Z: '11111/00001/00010/00100/01000/10000/11111',
  0: '01110/10001/10011/10101/11001/10001/01110',
  1: '00100/01100/00100/00100/00100/00100/01110',
  2: '01110/10001/00001/00010/00100/01000/11111',
  3: '11110/00001/00001/01110/00001/00001/11110',
  4: '00010/00110/01010/10010/11111/00010/00010',
  5: '11111/10000/10000/11110/00001/00001/11110',
  6: '01110/10000/10000/11110/10001/10001/01110',
  7: '11111/00001/00010/00100/01000/01000/01000',
  8: '01110/10001/10001/01110/10001/10001/01110',
  9: '01110/10001/10001/01111/00001/00001/01110',
  ' ': '000/000/000/000/000/000/000',
  '-': '000/000/000/111/000/000/000',
  '/': '00001/00001/00010/00100/01000/10000/10000',
  ':': '0/1/1/0/1/1/0',
  '>': '100/010/001/000/001/010/100',
  '+': '00000/00100/00100/11111/00100/00100/00000',
  '.': '0/0/0/0/0/1/1',
};

function text(image, label, x, y, scale, color) {
  let at = x;
  for (const char of label) {
    const glyph = GLYPHS[char];
    if (!glyph) throw new Error(`Unsupported authored decal glyph ${char}`);
    const rows = glyph.split('/');
    rows.forEach((row, dy) =>
      [...row].forEach((on, dx) => {
        if (on === '1') image.rect(at + dx * scale, y + dy * scale, scale, scale, color);
      }),
    );
    at += (rows[0].length + 1) * scale;
  }
}

export const LABELS = [
  ['NULL MERIDIAN', 'ORBITAL RESEARCH / RESCUE STATION   NM-07', 'ivory'],
  ['01 / INGRESS', 'DOCKING COLLAR   /   VERIFY PRESSURE BEFORE RELEASE', 'ivory'],
  ['02 / MAINTENANCE', 'SERVICE ACCESS   /   AUXILIARY POWER BUS', 'ochre'],
  ['03 / POWER GALLERY', 'CAUTION   /   ISOLATE SUPPLY BEFORE OPENING', 'ochre'],
  ['04 / INFIRMARY', 'TRIAGE RECORDS   /   MEDICAL SUPPORT', 'ivory'],
  ['05 / ARCHIVE', 'RECORDER STORAGE   /   CHAIN OF CUSTODY', 'ivory'],
  ['06 / OBSERVATION', 'NORTH GALLERY   /   EXTERNAL COMMUNICATIONS', 'ivory'],
  ['07 / EVACUATION', 'RESCUE CAPSULE   /   AUTHORIZATION REQUIRED', 'ochre'],
  ['PRESSURE BULKHEAD', 'KEEP CLEAR   /   03.00 M   /   MANUAL RELEASE', 'ochre'],
  ['AUXILIARY FUSE', 'NM-7   /   CERAMIC LINK   /   480 V', 'ochre'],
  ['COOLANT RETURN', 'ISOLATE   /   ROTATE CLOCKWISE   /   LINE C-04', 'ochre'],
  ['RESCUE DIVISION', 'R-09   /   PRESSURE SYSTEM   /   NO RESPONSE', 'ivory'],
  ['AUX BUS / OFFLINE', 'MANUAL OVERRIDE   /   FAULT 07   /   LOCAL CONTROL', 'screen'],
  ['RECORDER / LOCKED', 'LAST SIGNAL   04:17   /   CREW COUNT   00', 'screen'],
  ['UPLINK / STANDBY', 'MERIDIAN RELAY   /   READY TO TRANSMIT', 'screen'],
  ['SEAL / RELEASE', 'EVACUATION CONTROL   /   LOCAL AUTHORITY', 'screen'],
];

export async function cookTextures(source, output) {
  const inventory = [];
  const write = async (file, image, recipe) => {
    const bytes = png(image);
    await writeFile(join(output, file), bytes);
    inventory.push({ file, width: image.width, height: image.height, bytes: bytes.length, recipe });
  };
  for (const [name, size, roughness, metalness, strength] of [
    ['ceramic', 2048, 0.63, 0.02, 0.23],
    ['graphite', 1024, 0.73, 0.16, 0.12],
  ]) {
    const original = decodePng(await readFile(join(source, `${name}-albedo.azure.png`)));
    const albedo = seamless(resample(original, size, size), Math.round(size / 16));
    const height = new Float32Array(size * size);
    const orm = new Raster(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const luminance = (albedo.data[i] + albedo.data[i + 1] + albedo.data[i + 2]) / 765;
        const grain = noise(x % (size - 1), y % (size - 1)) - 0.5;
        height[y * size + x] = luminance * 0.14 + grain * 0.01;
        orm.pixel(x, y, [
          255,
          clamp((roughness + (0.5 - luminance) * 0.1 + grain * 0.035) * 255),
          metalness * 255,
        ]);
      }
    }
    await write(
      `${name}-basecolor.png`,
      albedo,
      `Azure source ${original.width}x${original.height}; bilinear ${size}px cook and symmetric edge crossfade; no perspective source.`,
    );
    await write(
      `${name}-normal.png`,
      resample(normalMap(height, size, size, strength * 12), 1024, 1024),
      '1024px heuristic microheight from weak albedo luminance plus seeded micrograin; authored approximation, not measured photogrammetric normals.',
    );
    await write(
      `${name}-orm.png`,
      resample(orm, 1024, 1024),
      `1024px linear RGB: R=1 (no baked geometric AO), G=authored roughness around ${roughness}, B=authored metalness ${metalness}; neither measured nor AI-predicted PBR.`,
    );
  }

  const deck = new Raster(1024, 1024);
  const deckOrm = new Raster(1024, 1024);
  const heights = new Float32Array(1024 * 1024);
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      const grain = noise(x % 1023, y % 1023, 493) - 0.5;
      const diamond =
        Math.abs(((x + y) % 96) - 48) < 4 && Math.abs(((x - y + 2048) % 160) - 80) < 30;
      const groove = x % 512 < 5 || y % 512 < 5;
      const value = groove ? 32 : diamond ? 111 + grain * 8 : 76 + grain * 10;
      deck.pixel(x, y, [value * 0.92, value, value * 1.02]);
      deckOrm.pixel(x, y, [groove ? 175 : 255, diamond ? 110 : 170 + grain * 14, 215]);
      heights[y * 1024 + x] = groove ? 0 : diamond ? 0.6 : 0.3 + grain * 0.015;
    }
  }
  await write(
    'deck-basecolor.png',
    seamless(deck, 12),
    'Original seeded non-slip machined metal pattern, 1m tile; no external art.',
  );
  await write(
    'deck-orm.png',
    seamless(deckOrm, 12),
    'Authored contact/groove occlusion, roughness and metalness; linear ORM.',
  );
  await write(
    'deck-normal.png',
    normalMap(heights, 1024, 1024, 1.4),
    'Normal differentiated from authored stamped deck heightfield, OpenGL +Y convention.',
  );

  const labels = new Raster(2048, 2048, [20, 24, 25]);
  for (const [index, [title, subtitle, palette]] of LABELS.entries()) {
    const top = index * 128;
    const light =
      palette === 'ochre'
        ? [187, 153, 84]
        : palette === 'screen'
          ? [129, 188, 166]
          : [207, 208, 190];
    const dark = palette === 'screen' ? [13, 30, 29] : [27, 31, 30];
    labels.rect(0, top, 2048, 128, dark);
    labels.rect(16, top + 12, 9, 101, light);
    labels.rect(16, top + 9, 2015, 2, light);
    text(labels, title, 52, top + 23, 7, light);
    text(
      labels,
      subtitle,
      54,
      top + 88,
      3,
      light.map((v) => v * 0.75),
    );
    for (let x = 1840; x < 2005; x += 9)
      labels.rect(x, top + 30, noise(x, index) > 0.55 ? 5 : 2, 45, light);
    text(labels, `NM-${String(index).padStart(2, '0')}`, 1828, top + 89, 3, light);
    for (let x = 0; x < 2048; x++) {
      for (let y = top; y < top + 128; y++) {
        const i = (y * 2048 + x) * 4;
        const wear = noise(x, y, 1833);
        const amount = wear < 0.008 ? 0.65 : 0.95 + wear * 0.05;
        for (let c = 0; c < 3; c++) labels.data[i + c] *= amount;
      }
    }
    if (palette === 'screen') {
      for (let y = top + 3; y < top + 128; y += 4) {
        for (let x = 0; x < 2048; x++) {
          const i = (y * 2048 + x) * 4;
          for (let c = 0; c < 3; c++) labels.data[i + c] *= 0.83;
        }
      }
    }
  }
  await write(
    'labels.png',
    labels,
    'Original deterministic stencil/CRT decal atlas, 16 horizontal rows, exact readable text; seeded wear. Opaque physical label plaques, not concept art.',
  );

  const panels = new Raster(1024, 1024, [12, 28, 27]);
  const panelLabels = [
    ['DOCKING RECORD', 'NM-07 / INGRESS', 'ACCESS LOCAL LOG'],
    ['AUXILIARY POWER', 'CIRCUITS / A B C', 'SELECT LOCAL BUS'],
    ['MEDICAL ARCHIVE', 'TRIAGE / VOICE LOG', 'RECORDING CONTROL'],
    ['RECORDER DOCK', 'FLIGHT DATA / R-09', 'RECOVER MODULE'],
    ['COOLANT RETURN', 'MANIFOLD / C-04', 'ISOLATION CONTROL'],
    ['RELAY UPLINK', 'MERIDIAN / LONG RANGE', 'TRANSMITTER CONTROL'],
    ['RESCUE CAPSULE', 'PRESSURE / LOCAL', 'DEPARTURE CONTROL'],
    ['SERVICE RECORD', 'NM-07 / MAINTENANCE', 'LOCAL DIAGNOSTICS'],
  ];
  panelLabels.forEach(([title, subtitle, footer], tile) => {
    const x = (tile % 2) * 512,
      y = Math.floor(tile / 2) * 256;
    const ink = [118, 175, 153],
      dim = [52, 101, 89];
    text(panels, title, x + 20, y + 18, 4, ink);
    text(panels, subtitle, x + 22, y + 58, 2, ink);
    panels.rect(x + 20, y + 84, 470, 2, dim);
    for (let col = 0; col < 6; col++) panels.rect(x + 25 + col * 85, y + 100, 1, 87, [23, 50, 43]);
    for (let row = 0; row < 4; row++) panels.rect(x + 24, y + 103 + row * 25, 463, 1, [23, 50, 43]);
    for (let i = 0; i < 7; i++) {
      const bx = x + 30 + i * 65,
        value = 20 + noise(i, tile, 401) * 51;
      panels.rect(bx, y + 178 - value, 28, value, dim);
      panels.rect(bx, y + 178 - value, 28, 2, ink);
    }
    text(panels, footer, x + 22, y + 218, 3, ink);
    for (let py = y; py < y + 256; py += 3) {
      for (let px = x; px < x + 512; px++) {
        const offset = (py * 1024 + px) * 4;
        for (let c = 0; c < 3; c++) panels.data[offset + c] *= 0.82;
      }
    }
  });
  await write(
    'crt-panels.png',
    panels,
    'Original eight 512x256 instrument identity/control displays with exact text and restrained CRT scanlines. Static equipment labeling, not authoritative live mission status.',
  );

  for (const kind of ['textile', 'shell']) {
    const base = new Raster(1024, 1024);
    const orm = new Raster(1024, 1024);
    const height = new Float32Array(1024 * 1024);
    const ceramicSource =
      kind === 'shell' ? decodePng(await readFile(join(source, 'ceramic-albedo.azure.png'))) : null;
    for (let y = 0; y < 1024; y++) {
      for (let x = 0; x < 1024; x++) {
        const fine = noise(x, y, 701) - 0.5;
        if (kind === 'textile') {
          const warp = Math.cos((x / 3) * Math.PI) * 0.5 + Math.cos((y / 4) * Math.PI) * 0.5;
          const diagonal = (Math.floor(x / 5) + Math.floor(y / 5)) % 4 < 2 ? 1 : -1;
          const crease = Math.sin(y / 37 + Math.sin(x / 140) * 0.4) * 0.012;
          const value = 74 + warp * 3.2 + diagonal * 1.7 + fine * 3.5;
          base.pixel(x, y, [value * 0.96, value, value * 0.93]);
          orm.pixel(x, y, [255, 221 + warp * 3 + fine * 4, 0]);
          height[y * 1024 + x] = warp * 0.037 + diagonal * 0.021 + crease;
        } else {
          const sourcePixel = ceramicSource.get(x, y);
          const edge = Math.min(x, y, 1023 - x, 1023 - y);
          const chip =
            edge < 6 + noise(Math.floor(x / 31), Math.floor(y / 37), 88) * 23 &&
            noise(Math.floor(x / 17), Math.floor(y / 19), 888) > 0.6 &&
            noise(x, y, 818) > 0.12;
          const score =
            (x + Math.floor(y * 0.32)) % 167 < 2 &&
            noise(Math.floor(y / 30), Math.floor(x / 80), 413) > 0.79;
          const dust = Math.max(0, 1 - edge / 80) * 0.095;
          base.pixel(
            x,
            y,
            chip
              ? [86 + fine * 13, 87 + fine * 13, 81 + fine * 12]
              : sourcePixel
                  .slice(0, 3)
                  .map(
                    (value, channel) =>
                      value * (0.79 - dust - (score ? 0.14 : 0)) + (channel === 0 ? 2 : 0),
                  ),
          );
          orm.pixel(x, y, [
            255 - dust * 120,
            chip ? 129 + fine * 10 : 179 + fine * 8,
            chip ? 92 : 5,
          ]);
          height[y * 1024 + x] = chip ? -0.09 : score ? -0.043 : fine * 0.008;
        }
      }
    }
    await write(
      `suit-${kind}-basecolor.png`,
      base,
      kind === 'textile'
        ? 'Original directional twill weave, restrained grey-olive pressure textile; no external art.'
        : 'Azure ceramic source derivative with hand-authored directional scoring, panel-edge chipping and dust; UVs matched to authored hard-shell outlines, not uniform mottling.',
    );
    await write(
      `suit-${kind}-normal.png`,
      normalMap(height, 1024, 1024, kind === 'textile' ? 2.2 : 1.1),
      'Differentiated authored relative heightfield, artistic OpenGL normal approximation, not recovered measured material.',
    );
    await write(
      `suit-${kind}-orm.png`,
      orm,
      'Authored linear ORM. Pressure weave high roughness/nonmetal; ceramic-composite shell has rough painted face and small semi-metal substrate chips. Artistic parameters, not measured.',
    );
  }

  const badges = new Raster(512, 512, [42, 46, 41]);
  [
    ['RESCUE / R-09', 'PRESSURE SYSTEM'],
    ['NM-07 / EVA', 'MERIDIAN / SERVICE'],
    ['AIR / RETURN', 'C-04 / MANUAL'],
    ['FIELD SUPPORT', 'ORBITAL / RESCUE'],
  ].forEach(([title, subtitle], row) => {
    const y = row * 128;
    badges.rect(12, y + 10, 488, 2, [132, 135, 120]);
    badges.rect(12, y + 115, 488, 2, [132, 135, 120]);
    text(badges, title, 26, y + 26, 5, [195, 195, 178]);
    text(badges, subtitle, 27, y + 84, 3, [141, 146, 131]);
  });
  for (let y = 0; y < 512; y++)
    for (let x = 0; x < 512; x++) {
      const i = (y * 512 + x) * 4;
      const wear = noise(x, y, 195) > 0.995 ? 0.5 : 0.91 + noise(x, y, 49) * 0.09;
      for (let c = 0; c < 3; c++) badges.data[i + c] *= wear;
    }
  await write(
    'rescue-badges.png',
    badges,
    'Original purpose-sized4:1 rescue garment patches, exact stencil text and seeded thread wear; no compressed station-sign typography.',
  );

  const cloudSource = decodePng(await readFile(join(source, 'planet-clouds.azure.png')));
  const clouds = seamless(resample(cloudSource, 2048, 1024), 64);
  const planet = new Raster(2048, 1024);
  for (let y = 0; y < 1024; y++) {
    const latitude = (y / 1023) * Math.PI;
    for (let x = 0; x < 2048; x++) {
      const longitude = (x / 2047) * Math.PI * 2;
      const day =
        0.025 + 0.975 * Math.sqrt(Math.max(0, Math.cos(longitude - 2.7) * Math.sin(latitude)));
      planet.pixel(
        x,
        y,
        clouds
          .get(x, y)
          .slice(0, 3)
          .map((value) => value * day),
      );
    }
  }
  await write(
    'planet-bands.png',
    planet,
    'Azure original1536x1024 neutral cloud source remapped2048x1024, seam crossfade and explicit authored day-night illumination; used on a real distant sphere mesh, not a room wallpaper or measured astronomical albedo.',
  );

  const reflection = new Raster(1024, 512);
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 1024; x++) {
      const angle = (x / 1023) * Math.PI * 2;
      const up = y / 511;
      const warm =
        Math.max(0, Math.cos(angle - 0.4)) ** 18 * Math.max(0, 1 - Math.abs(up - 0.32) * 9);
      const cold =
        Math.max(0, Math.cos(angle - 3.1)) ** 6 * Math.max(0, 1 - Math.abs(up - 0.5) * 5);
      const ceiling = Math.max(0, 1 - Math.abs(up - 0.2) * 4) * 12;
      reflection.pixel(x, y, [
        30 + ceiling + warm * 112 + cold * 24,
        33 + ceiling + warm * 90 + cold * 33,
        34 + ceiling + warm * 58 + cold * 40,
      ]);
    }
  }
  await write(
    'station-reflection.png',
    reflection,
    'Original authored LDR equirectangular reflection field, broad warm practical and cold window lobes; not HDR or a captured environment.',
  );
  await write(
    'ring-density.png',
    ringDensity(),
    'Original deterministic512x4 radial RGBA density: muted warm-grey RGB, low-contrast continuous alpha with two broad troughs and feathered edges. No generation, new imagery, opaque strip gaps, tilt or celestial reframing.',
  );
  return inventory;
}

export const MATERIALS = {
  hull: { color: [0.012, 0.016, 0.017, 1], rough: 0.95, metal: 0 },
  ceramic: {
    tile: 1.8,
    map: 'ceramic-basecolor.png',
    normal: 'ceramic-normal.png',
    orm: 'ceramic-orm.png',
    metal: 1,
    normalScale: 0.4,
  },
  graphite: {
    tile: 1,
    map: 'graphite-basecolor.png',
    normal: 'graphite-normal.png',
    orm: 'graphite-orm.png',
    metal: 1,
    normalScale: 0.35,
  },
  deck: {
    tile: 1,
    map: 'deck-basecolor.png',
    normal: 'deck-normal.png',
    orm: 'deck-orm.png',
    metal: 1,
    normalScale: 0.36,
  },
  steel: { color: [0.26, 0.29, 0.3, 1], metal: 0.84, rough: 0.38 },
  satin: { color: [0.51, 0.53, 0.5, 1], metal: 0.68, rough: 0.48 },
  rubber: { color: [0.026, 0.031, 0.032, 1], metal: 0.02, rough: 0.87 },
  ochre: { color: [0.42, 0.28, 0.105, 1], metal: 0.22, rough: 0.68 },
  copper: { color: [0.2, 0.09, 0.045, 1], metal: 0.85, rough: 0.43 },
  visor: { color: [0.009, 0.016, 0.018, 1], metal: 0.45, rough: 0.16 },
  'rescue-visor': { color: [0.006, 0.012, 0.014, 1], metal: 0.08, rough: 0.42 },
  fabric: {
    tile: 0.4,
    map: 'graphite-basecolor.png',
    color: [0.53, 0.5, 0.43, 1],
    normal: 'graphite-normal.png',
    rough: 0.96,
    metal: 0,
  },
  'suit-textile': {
    map: 'suit-textile-basecolor.png',
    normal: 'suit-textile-normal.png',
    orm: 'suit-textile-orm.png',
    metal: 1,
    rough: 1,
    normalScale: 0.42,
  },
  'suit-shell': {
    map: 'suit-shell-basecolor.png',
    normal: 'suit-shell-normal.png',
    orm: 'suit-shell-orm.png',
    metal: 1,
    rough: 1,
    normalScale: 0.35,
  },
  'shell-edge': { color: [0.2, 0.21, 0.19, 1], rough: 0.73, metal: 0.22 },
  badge: { map: 'rescue-badges.png', rough: 0.9, metal: 0 },
  padding: {
    color: [0.29, 0.32, 0.28, 1],
    normal: 'suit-textile-normal.png',
    normalScale: 0.3,
    rough: 0.94,
    metal: 0,
  },
  labels: { map: 'labels.png', rough: 0.79, metal: 0 },
  screen: {
    map: 'labels.png',
    emissiveMap: 'labels.png',
    emission: [0.65, 0.8, 0.72],
    rough: 0.34,
  },
  panel: {
    map: 'crt-panels.png',
    emissiveMap: 'crt-panels.png',
    emission: [0.55, 0.67, 0.59],
    rough: 0.3,
    metal: 0,
  },
  teal: { color: [0.22, 0.36, 0.32, 1], emission: [0.25, 0.5, 0.39], rough: 0.4 },
  warm: { color: [0.87, 0.74, 0.49, 1], emission: [1, 0.72, 0.4], rough: 0.62 },
  red: { color: [0.31, 0.035, 0.017, 1], emission: [0.55, 0.034, 0.013], rough: 0.6 },
  planet: { map: 'planet-bands.png', unlit: true },
  'ring-density': { map: 'ring-density.png', unlit: true, double: true, alpha: 'BLEND' },
  star: { color: [0.6, 0.66, 0.7, 1], unlit: true },
};
