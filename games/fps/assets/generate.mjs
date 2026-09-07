// Original Sector Breach assets. Node-only, deterministic, no downloaded art or runtime tooling.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out')) {
  throw new Error('Usage: node games/fps/assets/generate.mjs [--out <directory>]');
}
const OUTPUT = args.length === 2 ? resolve(args[1]) : join(HERE, 'generated');
const SCENE_PATH = join(HERE, '..', 'levels', 'sector-breach.scene.json');
const sceneText = await readFile(SCENE_PATH, 'utf8');
const sourceScene = JSON.parse(sceneText);
const floorplan = sourceScene.resources['fps.floorplan'];
await mkdir(OUTPUT, { recursive: true });

const FONT = {
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['111', '010', '010', '010', '010', '010', '111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['010', '110', '010', '010', '010', '010', '111'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '/': ['00001', '00001', '00010', '00100', '01000', '10000', '10000'],
  '>': ['10000', '01000', '00100', '00010', '00100', '01000', '10000'],
};

class Raster {
  constructor(width, height, color) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
    this.rect(0, 0, width, height, color);
  }
  pixel(x, y, color) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    for (let c = 0; c < 3; c++) this.data[i + c] = Math.max(0, Math.min(255, color[c]));
    this.data[i + 3] = color[3] ?? 255;
  }
  rect(x, y, width, height, color) {
    for (let row = y; row < y + height; row++) {
      for (let col = x; col < x + width; col++) this.pixel(col, row, color);
    }
  }
  text(label, x, y, scale, color) {
    let at = x;
    for (const ch of label) {
      const glyph = FONT[ch];
      if (glyph === undefined) throw new Error(`No original bitmap glyph for "${ch}"`);
      glyph.forEach((row, dy) => {
        [...row].forEach((value, dx) => {
          if (value === '1') this.rect(at + dx * scale, y + dy * scale, scale, scale, color);
        });
      });
      at += (glyph[0].length + 1) * scale;
    }
  }
  noise(amount, seed) {
    let state = seed;
    for (let i = 0; i < this.data.length; i += 4) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const grain = (state % (amount * 2 + 1)) - amount;
      for (let c = 0; c < 3; c++) {
        this.data[i + c] = Math.max(0, Math.min(255, this.data[i + c] + grain));
      }
    }
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function png(raster) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(raster.width, 0);
  header.writeUInt32BE(raster.height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(raster.height * (raster.width * 4 + 1));
  for (let y = 0; y < raster.height; y++) {
    raster.data.copy(
      rows,
      y * (raster.width * 4 + 1) + 1,
      y * raster.width * 4,
      (y + 1) * raster.width * 4,
    );
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const wall = new Raster(512, 512, [111, 131, 141]);
wall.rect(4, 4, 504, 504, [130, 148, 155]);
wall.rect(10, 10, 492, 492, [104, 122, 131]);
wall.rect(20, 20, 472, 354, [163, 176, 177]);
wall.rect(20, 380, 472, 111, [64, 82, 93]);
wall.rect(20, 366, 472, 8, [207, 214, 204]);
wall.rect(26, 30, 5, 324, [194, 200, 194]);
wall.rect(462, 30, 8, 324, [125, 143, 145]);
for (let i = 0; i < 11; i++) {
  wall.rect(45 + i * 38, 401, 23, 5, [18, 31, 41]);
  wall.rect(45 + i * 38, 412, 23, 2, [115, 132, 133]);
}
for (const x of [36, 475]) {
  for (const y of [40, 350, 469]) {
    wall.rect(x - 5, y - 5, 10, 10, [50, 68, 78]);
    wall.rect(x - 3, y - 3, 6, 6, [204, 213, 209]);
    wall.rect(x - 3, y, 6, 1, [75, 86, 92]);
  }
}
wall.text('A-09', 54, 309, 4, [49, 71, 79]);
wall.text('SERVICE', 305, 457, 3, [150, 166, 167]);
wall.noise(3, 614);

const deck = new Raster(512, 512, [43, 60, 72]);
for (let y = 0; y < 512; y += 128) {
  for (let x = 0; x < 512; x += 128) {
    deck.rect(x + 3, y + 3, 122, 122, [61, 79, 90]);
    deck.rect(x + 8, y + 8, 112, 112, [46, 64, 77]);
    for (let stripe = 17; stripe < 110; stripe += 12) {
      deck.rect(x + 16, y + stripe, 96, 3, [89, 106, 110]);
      deck.rect(x + 16, y + stripe + 3, 96, 3, [21, 36, 49]);
    }
    deck.rect(x + 8, y + 8, 4, 4, [145, 159, 161]);
    deck.rect(x + 115, y + 115, 4, 4, [145, 159, 161]);
  }
}
deck.noise(3, 193);

const labels = new Raster(512, 512, [13, 28, 38]);
const labelLines = [
  ['SECTOR 09', 'ORBITAL TRANSIT', [220, 228, 213]],
  ['BREACH LOCK', 'SHOOT PANEL >', [255, 182, 72]],
  ['COOLANT', 'GAP 02M / JUMP', [88, 222, 230]],
  ['EXTRACTION', 'AIRLOCK 07 >', [104, 239, 181]],
  ['KESTREL', 'K-09 SECURITY', [255, 164, 66]],
  ['VAULTLINE', 'V-7 / COIL RIFLE', [187, 219, 229]],
  ['PRESSURE', 'SEALED / 080', [213, 226, 225]],
  ['DANGER', 'THERMAL CONDUIT', [255, 170, 55]],
];
labelLines.forEach(([title, subtitle, color], i) => {
  const y = i * 64;
  labels.rect(0, y, 512, 2, color);
  labels.rect(10, y + 12, 5, 40, color);
  labels.text(title, 30, y + 9, 4, color);
  labels.text(subtitle, 31, y + 44, 2, [153, 179, 187]);
  for (let x = 450; x < 500; x += 8) {
    labels.rect(x, y + 12, 3, 36, color);
  }
});

const hazard = new Raster(128, 128, [225, 151, 37]);
for (let y = 0; y < 128; y++) {
  for (let x = 0; x < 128; x++) {
    if ((x + y) % 64 < 27) hazard.pixel(x, y, [22, 35, 45]);
  }
}
hazard.noise(3, 70);

function normalFrom(raster, scale) {
  const result = new Raster(raster.width, raster.height, [128, 128, 255]);
  const heightAt = (x, y) => {
    const col = (x + raster.width) % raster.width;
    const row = (y + raster.height) % raster.height;
    return raster.data[(row * raster.width + col) * 4] / 255;
  };
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const dx = (heightAt(x - 1, y) - heightAt(x + 1, y)) * scale;
      const dy = (heightAt(x, y - 1) - heightAt(x, y + 1)) * scale;
      const length = Math.sqrt(dx * dx + dy * dy + 1);
      result.pixel(x, y, [
        128 + (dx / length) * 127,
        128 + (dy / length) * 127,
        128 + 127 / length,
      ]);
    }
  }
  return result;
}

const textures = {
  'bulkhead-albedo.png': wall,
  'bulkhead-normal.png': normalFrom(wall, 2),
  'deck-albedo.png': deck,
  'deck-normal.png': normalFrom(deck, 2.3),
  'signage.png': labels,
  'hazard-stripes.png': hazard,
};
const textureBytes = new Map();
for (const [name, raster] of Object.entries(textures)) {
  const bytes = png(raster);
  textureBytes.set(name, bytes);
  await writeFile(join(OUTPUT, name), bytes);
}

const MATERIALS = {
  wall: {
    color: [0.85, 0.9, 0.94, 1],
    metal: 0.3,
    rough: 0.7,
    map: 'bulkhead-albedo.png',
    normal: 'bulkhead-normal.png',
  },
  deck: {
    color: [0.8, 0.87, 0.91, 1],
    metal: 0.65,
    rough: 0.65,
    map: 'deck-albedo.png',
    normal: 'deck-normal.png',
  },
  dark: { color: [0.055, 0.085, 0.115, 1], metal: 0.75, rough: 0.4 },
  edge: { color: [0.27, 0.35, 0.4, 1], metal: 0.8, rough: 0.32 },
  armor: { color: [0.32, 0.36, 0.34, 1], metal: 0.4, rough: 0.44 },
  weapon: { color: [0.095, 0.145, 0.19, 1], metal: 0.7, rough: 0.35 },
  black: { color: [0.016, 0.024, 0.033, 1], metal: 0.15, rough: 0.86 },
  copper: { color: [0.48, 0.22, 0.105, 1], metal: 0.8, rough: 0.34 },
  amber: { color: [0.85, 0.34, 0.035, 1], metal: 0.45, rough: 0.48 },
  hazard: { color: [1, 1, 1, 1], metal: 0.2, rough: 0.65, map: 'hazard-stripes.png' },
  cyan: { color: [0.12, 0.67, 0.74, 1], emission: [0.12, 0.8, 1], metal: 0.25, rough: 0.25 },
  warm: { color: [1, 0.65, 0.18, 1], emission: [1, 0.38, 0.04], metal: 0.15, rough: 0.24 },
  white: { color: [0.74, 0.88, 0.91, 1], emission: [0.64, 0.86, 1], metal: 0.15, rough: 0.25 },
  green: { color: [0.05, 0.8, 0.51, 1], emission: [0.025, 0.72, 0.37], metal: 0.1, rough: 0.3 },
  screen: {
    color: [1, 1, 1, 1],
    emission: [0.55, 0.65, 0.65],
    metal: 0,
    rough: 0.75,
    map: 'signage.png',
  },
  coolant: { color: [0.018, 0.22, 0.28, 1], emission: [0.025, 0.22, 0.3], metal: 0.55, rough: 0.2 },
};

const RING = [
  [1, 0],
  [0.8660254, 0.5],
  [0.5, 0.8660254],
  [0, 1],
  [-0.5, 0.8660254],
  [-0.8660254, 0.5],
  [-1, 0],
  [-0.8660254, -0.5],
  [-0.5, -0.8660254],
  [0, -1],
  [0.5, -0.8660254],
  [0.8660254, -0.5],
];

function normal(a, b, c) {
  const u = b.map((v, i) => v - a[i]);
  const v = c.map((value, i) => value - a[i]);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.sqrt(n.reduce((sum, value) => sum + value * value, 0));
  if (length < 1e-10) throw new Error('Degenerate asset triangle');
  return n.map((value) => value / length);
}

class Model {
  constructor(name) {
    this.name = name;
    this.nodes = [{ name, children: [] }];
    this.geometry = new Map();
    this.animations = [];
  }
  node(name, parent = 0, translation = [0, 0, 0], rotation) {
    const id = this.nodes.length;
    this.nodes.push({ name, translation, ...(rotation ? { rotation } : {}), children: [] });
    this.nodes[parent].children.push(id);
    return id;
  }
  triangle(
    node,
    material,
    a,
    b,
    c,
    uv = [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
  ) {
    let parts = this.geometry.get(node);
    if (!parts) this.geometry.set(node, (parts = new Map()));
    let part = parts.get(material);
    if (!part) parts.set(material, (part = { positions: [], normals: [], uvs: [] }));
    const n = normal(a, b, c);
    part.positions.push(...a, ...b, ...c);
    part.normals.push(...n, ...n, ...n);
    part.uvs.push(...uv.flat());
  }
  quad(
    node,
    material,
    a,
    b,
    c,
    d,
    uv = [
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  ) {
    this.triangle(node, material, a, b, c, uv.slice(0, 3));
    this.triangle(node, material, a, c, d, [uv[0], uv[2], uv[3]]);
  }
  box(node, material, center, size) {
    const [x, y, z] = center;
    const [w, h, d] = size.map((value) => value / 2);
    const p = [
      [x - w, y - h, z - d],
      [x + w, y - h, z - d],
      [x + w, y + h, z - d],
      [x - w, y + h, z - d],
      [x - w, y - h, z + d],
      [x + w, y - h, z + d],
      [x + w, y + h, z + d],
      [x - w, y + h, z + d],
    ];
    const faces = [
      [0, 3, 2, 1],
      [5, 6, 7, 4],
      [1, 2, 6, 5],
      [4, 7, 3, 0],
      [3, 7, 6, 2],
      [4, 0, 1, 5],
    ];
    faces.forEach((face, index) => {
      const uv =
        index < 4
          ? [
              [1, 1],
              [1, 0],
              [0, 0],
              [0, 1],
            ]
          : [
              [0, 0],
              [0, 1],
              [1, 1],
              [1, 0],
            ];
      this.quad(node, material, ...face.map((i) => p[i]), uv);
    });
  }
  bevel(node, material, center, size, inset = 0.05) {
    const [x, y, z] = center;
    const [w, h, d] = size.map((value) => value / 2);
    const b = Math.min(inset, w * 0.45, h * 0.45);
    const section = [
      [-w + b, -h],
      [w - b, -h],
      [w, -h + b],
      [w, h - b],
      [w - b, h],
      [-w + b, h],
      [-w, h - b],
      [-w, -h + b],
    ];
    const front = section.map(([px, py]) => [x + px, y + py, z - d]);
    const back = section.map(([px, py]) => [x + px, y + py, z + d]);
    for (let i = 1; i < 7; i++) {
      this.triangle(node, material, front[0], front[i + 1], front[i]);
      this.triangle(node, material, back[0], back[i], back[i + 1]);
    }
    for (let i = 0; i < 8; i++) {
      const next = (i + 1) % 8;
      this.quad(node, material, front[i], front[next], back[next], back[i]);
    }
  }
  cylinder(node, material, center, radius, length, axis = 1) {
    const other = [0, 1, 2].filter((value) => value !== axis);
    const cap = (sign) => center.map((value, i) => value + (i === axis ? (sign * length) / 2 : 0));
    const ring = (sign) =>
      RING.map(([a, b]) => {
        const p = cap(sign);
        p[other[0]] += a * radius;
        p[other[1]] += b * radius;
        return p;
      });
    const a = ring(-1);
    const b = ring(1);
    for (let i = 0; i < 12; i++) {
      const next = (i + 1) % 12;
      // The X/Z plane has opposite winding from X/Y and Y/Z.
      const order = axis === 1 ? [next, i] : [i, next];
      this.quad(node, material, a[order[0]], a[order[1]], b[order[1]], b[order[0]]);
      this.triangle(node, material, cap(-1), a[order[1]], a[order[0]]);
      this.triangle(node, material, cap(1), b[order[0]], b[order[1]]);
    }
  }
  sign(node, center, width, height, row, facing = 'south') {
    const [x, y, z] = center;
    const uvs = [
      [0, (row + 1) / 8],
      [1, (row + 1) / 8],
      [1, row / 8],
      [0, row / 8],
    ];
    const w = width / 2;
    const h = height / 2;
    if (facing === 'south')
      this.quad(
        node,
        'screen',
        [x + w, y - h, z],
        [x - w, y - h, z],
        [x - w, y + h, z],
        [x + w, y + h, z],
        uvs,
      );
    if (facing === 'west')
      this.quad(
        node,
        'screen',
        [x, y - h, z - w],
        [x, y - h, z + w],
        [x, y + h, z + w],
        [x, y + h, z - w],
        uvs,
      );
    if (facing === 'east')
      this.quad(
        node,
        'screen',
        [x, y - h, z + w],
        [x, y - h, z - w],
        [x, y + h, z - w],
        [x, y + h, z + w],
        uvs,
      );
  }
  animation(name, tracks) {
    this.animations.push({ name, tracks });
  }
  async save(file) {
    const chunks = [];
    let offset = 0;
    const bufferViews = [];
    const accessors = [];
    const putBytes = (bytes, target) => {
      const start = offset;
      chunks.push(bytes);
      const padding = (4 - (bytes.length % 4)) % 4;
      if (padding) chunks.push(Buffer.alloc(padding));
      offset += bytes.length + padding;
      const index = bufferViews.length;
      bufferViews.push({
        buffer: 0,
        byteOffset: start,
        byteLength: bytes.length,
        ...(target ? { target } : {}),
      });
      return index;
    };
    const put = (values, size, target, bounds = false) => {
      const bytes = Buffer.alloc(values.length * 4);
      values.forEach((value, i) => {
        if (!Number.isFinite(value)) throw new Error(`${this.name}: non-finite geometry`);
        bytes.writeFloatLE(value, i * 4);
      });
      const view = putBytes(bytes, target);
      const accessor = {
        bufferView: view,
        componentType: 5126,
        count: values.length / size,
        type: ['SCALAR', 'VEC2', 'VEC3', 'VEC4'][size - 1],
      };
      if (bounds) {
        accessor.min = Array.from({ length: size }, (_, c) =>
          Math.min(...values.filter((_, i) => i % size === c)),
        );
        accessor.max = Array.from({ length: size }, (_, c) =>
          Math.max(...values.filter((_, i) => i % size === c)),
        );
      }
      accessors.push(accessor);
      return accessors.length - 1;
    };
    const used = [...new Set([...this.geometry.values()].flatMap((parts) => [...parts.keys()]))];
    const images = [];
    const glTextures = [];
    const maps = new Map();
    const texture = (name) => {
      if (maps.has(name)) return maps.get(name);
      const index = images.length;
      images.push({ name, mimeType: 'image/png', bufferView: putBytes(textureBytes.get(name)) });
      glTextures.push({ source: index, sampler: 0 });
      maps.set(name, index);
      return index;
    };
    const materials = used.map((name) => {
      const m = MATERIALS[name];
      return {
        name,
        pbrMetallicRoughness: {
          baseColorFactor: m.color,
          metallicFactor: m.metal,
          roughnessFactor: m.rough,
          ...(m.map ? { baseColorTexture: { index: texture(m.map) } } : {}),
        },
        ...(m.normal ? { normalTexture: { index: texture(m.normal), scale: 0.45 } } : {}),
        ...(m.emission ? { emissiveFactor: m.emission } : {}),
        ...(m.emission && m.map ? { emissiveTexture: { index: texture(m.map) } } : {}),
      };
    });
    const meshes = [];
    let triangles = 0;
    let primitives = 0;
    for (const [node, parts] of this.geometry) {
      const mesh = { name: this.nodes[node].name, primitives: [] };
      for (const [material, part] of parts) {
        mesh.primitives.push({
          attributes: {
            POSITION: put(part.positions, 3, 34962, true),
            NORMAL: put(part.normals, 3, 34962),
            TEXCOORD_0: put(part.uvs, 2, 34962),
          },
          material: used.indexOf(material),
          mode: 4,
        });
        triangles += part.positions.length / 9;
        primitives++;
      }
      this.nodes[node].mesh = meshes.length;
      meshes.push(mesh);
    }
    const animations = this.animations.map(({ name, tracks }) => ({
      name,
      samplers: tracks.map((track) => ({
        input: put(track.times, 1, undefined, true),
        output: put(track.values.flat(), track.path === 'rotation' ? 4 : 3),
        interpolation: 'LINEAR',
      })),
      channels: tracks.map((track, index) => ({
        sampler: index,
        target: { node: track.node, path: track.path },
      })),
    }));
    const json = {
      asset: {
        version: '2.0',
        generator: 'Aegis Sector Breach original procedural kit v1',
        copyright: 'Original Aegis project artwork, MIT',
      },
      scene: 0,
      scenes: [{ name: this.name, nodes: [0] }],
      nodes: this.nodes.map(({ children, ...node }) => ({
        ...node,
        ...(children.length ? { children } : {}),
      })),
      meshes,
      materials,
      ...(images.length
        ? {
            images,
            textures: glTextures,
            samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
          }
        : {}),
      ...(animations.length ? { animations } : {}),
      accessors,
      bufferViews,
      buffers: [{ byteLength: offset }],
    };
    let text = Buffer.from(JSON.stringify(json));
    text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 32)]);
    const binary = Buffer.concat(chunks);
    const header = Buffer.alloc(20);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(28 + text.length + binary.length, 8);
    header.writeUInt32LE(text.length, 12);
    header.writeUInt32LE(0x4e4f534a, 16);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binary.length, 0);
    binHeader.writeUInt32LE(0x004e4942, 4);
    const bytes = Buffer.concat([header, text, binHeader, binary]);
    await writeFile(join(OUTPUT, file), bytes);
    return {
      file,
      bytes: bytes.length,
      triangles,
      primitives,
      nodes: this.nodes.length,
      animations: animations.map((a) => ({ name: a.name, channels: a.channels.length })),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
}

function environment() {
  const model = new Model('Sector09_OrbitalFacility');
  const zones = [
    model.node('ArrivalBay'),
    model.node('BreachThroat'),
    model.node('CoolantTransfer'),
    model.node('SecurityAirlock'),
  ];
  const zone = (z) => zones[z < 5.5 ? 0 : z < 9.5 ? 1 : z < 14.5 ? 2 : 3];
  const at = (col, row) => floorplan.legend[floorplan.rows[row]?.[col]];
  for (let row = 0; row < floorplan.height; row++) {
    for (let col = 0; col < floorplan.width; col++) {
      const cell = at(col, row);
      const x = floorplan.origin.x + col;
      const z = floorplan.origin.z + floorplan.height - 1 - row;
      const node = zone(z);
      if (cell.solid && !cell.door) {
        for (const [dc, dr, face] of [
          [0, 1, 'south'],
          [0, -1, 'north'],
          [1, 0, 'east'],
          [-1, 0, 'west'],
        ]) {
          const neighbor = at(col + dc, row + dr);
          if (neighbor === undefined || (neighbor.solid && !neighbor.door)) continue;
          const horizontal = dc !== 0;
          const cx = x + dc * 0.505;
          const cz = z - dr * 0.505;
          // Dress inward into the solid cell, not across the player's collision boundary.
          if (horizontal) {
            model.box(node, 'wall', [cx - dc * 0.026, 1.56, z], [0.05, 3.12, 1]);
            model.box(node, 'wall', [cx - dc * 0.026, 3.715, z], [0.05, 0.33, 1]);
            model.box(node, 'dark', [x + dc * 0.3, 3.335, z], [0.05, 0.43, 1]);
          } else {
            model.box(node, 'wall', [x, 1.94, cz + dr * 0.026], [1, 3.88, 0.05]);
          }
          for (const y of [0.18, 2.75, 3.74]) {
            model.box(
              node,
              'edge',
              [cx - dc * 0.012, y, cz + dr * 0.012],
              horizontal ? [0.024, 0.1, 1] : [1, 0.1, 0.024],
            );
          }
          model.box(
            node,
            'dark',
            [cx - dc * 0.01, 1.9, cz + dr * 0.01],
            horizontal ? [0.022, 3.8, 0.045] : [0.045, 3.8, 0.022],
          );
          if ((col + row) % 2 === 0 && z > 9) {
            model.box(
              node,
              cell.hazard ? 'cyan' : 'warm',
              [cx - dc * 0.009, 2.94, cz + dr * 0.009],
              horizontal ? [0.02, 0.1, 0.64] : [0.64, 0.1, 0.02],
            );
          }
          if (face === 'east' || face === 'west') {
            model.cylinder(node, 'copper', [x + dc * 0.42, 3.32, z], 0.075, 1, 2);
            model.cylinder(node, 'dark', [x + dc * 0.42, 3.32, z], 0.08, 0.075, 2);
          }
        }
        continue;
      }
      model.box(node, cell.hazard ? 'dark' : 'deck', [x, cell.floor - 0.12, z], [1, 0.24, 1]);
      model.box(node, 'dark', [x, 4.1, z], [1, 0.2, 1]);
      if ((col + row) % 3 === 0) model.box(node, 'edge', [x, 3.96, z], [0.045, 0.08, 1]);
      if (cell.hazard) {
        model.box(node, 'coolant', [x, -0.5175, z], [1, 0.035, 1]);
        for (const offset of [-0.29, 0.28]) {
          model.box(node, 'cyan', [x + offset, -0.496, z], [0.015, 0.005, 0.78]);
        }
      }
    }
  }
  // Deep pit walls make the missing deck unmistakable; there is no collision-free fake bridge.
  const pit = zones[2];
  for (const x of [-1.51, 1.51]) model.box(pit, 'wall', [x, -1.5, 12.5], [0.02, 3, 2]);
  for (const z of [11.49, 13.51]) {
    model.box(pit, 'wall', [0, -1.5, z], [3, 3, 0.02]);
    model.box(pit, 'hazard', [0, 0.003, z + (z < 12 ? -0.1 : 0.1)], [3, 0.006, 0.2]);
  }
  for (const x of [-1.25, 1.25]) {
    for (const z of [10.15, 14.2]) {
      model.box(pit, 'dark', [x, 0.065, z], [0.3, 0.13, 0.32]);
      model.box(pit, 'cyan', [x, 0.135, z], [0.2, 0.016, 0.19]);
    }
  }
  // Flush wayfinding: small architectural lights, not a field of arbitrary decorative props.
  for (const z of [1, 3, 9, 10, 14, 15, 17, 19]) {
    const n = zone(z);
    const width = z < 5 || z > 15 ? 2.2 : 0.55;
    for (const x of [-width, width]) {
      model.box(n, 'edge', [x, 3.94, z], [0.28, 0.1, 0.78]);
      model.box(n, z > 10 && z < 15 ? 'cyan' : 'white', [x, 3.88, z], [0.18, 0.014, 0.66]);
    }
  }
  model.sign(zones[0], [0, 3.05, 5.488], 3.6, 0.45, 0);
  model.sign(zones[0], [4.488, 2.95, 2], 2.8, 0.35, 1, 'west');
  model.sign(zones[2], [0, 3.4, 11.48], 2.8, 0.35, 2);
  model.sign(zones[3], [0, 3.05, 19.488], 3.5, 0.44, 3);
  for (const x of [-3.5, 3.5]) {
    model.bevel(zones[3], 'dark', [x, 1.5, 19.53], [1.3, 3, 0.1], 0.12);
    for (let y = 0.5; y < 2.8; y += 0.4) {
      model.box(zones[3], 'edge', [x, y, 19.47], [0.95, 0.22, 0.03]);
      model.box(zones[3], 'cyan', [x + 0.35, y, 19.443], [0.055, 0.075, 0.012]);
    }
  }
  // Arrival-bay service stacks occupy the already-solid upper wall, never walkable floor.
  for (const x of [-2.8, 2.8]) {
    model.bevel(zones[0], 'dark', [x, 1.48, 5.52], [1.25, 2.65, 0.09], 0.1);
    for (const y of [0.6, 1.4, 2.2]) {
      model.box(zones[0], 'edge', [x, y, 5.463], [1.05, 0.55, 0.02]);
      model.box(zones[0], 'warm', [x + 0.39, y, 5.445], [0.04, 0.34, 0.02]);
    }
  }
  return model;
}

function robot() {
  const m = new Model('Kestrel_K09_SecurityRobot');
  const body = m.node('Chassis', 0, [0, 1.1, 0]);
  m.bevel(body, 'dark', [0, 0.04, 0], [0.43, 0.53, 0.37], 0.08);
  m.bevel(body, 'armor', [0, 0.19, -0.08], [0.58, 0.5, 0.4], 0.12);
  m.bevel(body, 'edge', [0, -0.1, -0.05], [0.36, 0.24, 0.43], 0.045);
  m.box(body, 'amber', [0, 0.27, -0.285], [0.34, 0.055, 0.015]);
  m.box(body, 'warm', [0, 0.1, -0.287], [0.08, 0.085, 0.018]);
  m.cylinder(body, 'dark', [0, -0.22, 0], 0.16, 0.15);
  m.bevel(body, 'armor', [0, -0.32, 0], [0.4, 0.21, 0.29], 0.045);
  for (const x of [-0.12, 0.12]) m.cylinder(body, 'copper', [x, 0.03, 0.24], 0.038, 0.39);
  const neck = m.node('Neck', body, [0, 0.48, 0]);
  m.cylinder(neck, 'edge', [0, 0.025, 0], 0.095, 0.15);
  const head = m.node('OpticHead', neck, [0, 0.14, -0.015]);
  m.bevel(head, 'dark', [0, 0.035, 0], [0.43, 0.29, 0.32], 0.065);
  m.bevel(head, 'armor', [0, 0.095, 0.02], [0.45, 0.19, 0.33], 0.055);
  m.bevel(head, 'black', [0, 0.025, -0.173], [0.36, 0.115, 0.032], 0.025);
  m.box(head, 'warm', [0, 0.037, -0.192], [0.26, 0.027, 0.016]);
  m.box(head, 'warm', [0.1, 0.015, -0.193], [0.032, 0.073, 0.019]);
  m.cylinder(head, 'edge', [-0.23, 0.03, 0], 0.07, 0.04, 0);
  const leftLeg = m.node('Leg_L', 0, [-0.18, 0.78, 0]);
  const rightLeg = m.node('Leg_R', 0, [0.18, 0.78, 0.03]);
  for (const leg of [leftLeg, rightLeg]) {
    m.cylinder(leg, 'dark', [0, -0.05, 0], 0.095, 0.24, 0);
    m.bevel(leg, 'armor', [0, -0.18, 0], [0.2, 0.34, 0.24], 0.055);
    m.cylinder(leg, 'edge', [0, -0.36, -0.005], 0.085, 0.235, 0);
    m.bevel(leg, 'dark', [0, -0.53, 0.02], [0.15, 0.32, 0.18], 0.032);
    m.bevel(leg, 'armor', [0, -0.53, -0.085], [0.21, 0.3, 0.09], 0.035);
    m.cylinder(leg, 'copper', [0.09, -0.54, 0.09], 0.021, 0.29);
    m.bevel(leg, 'dark', [0, -0.715, -0.07], [0.25, 0.13, 0.4], 0.035);
    m.box(leg, 'edge', [0, -0.723, -0.195], [0.23, 0.08, 0.09]);
  }
  const leftArm = m.node('Arm_L', body, [-0.31, 0.27, 0]);
  const rightArm = m.node('Arm_R', body, [0.31, 0.27, 0]);
  for (const arm of [leftArm, rightArm]) {
    m.cylinder(arm, 'edge', [0, 0, 0], 0.085, 0.14, 0);
    m.bevel(arm, 'armor', [0, -0.09, 0.005], [0.16, 0.23, 0.28], 0.042);
    m.cylinder(arm, 'dark', [0, -0.24, -0.025], 0.055, 0.16, 0);
    m.bevel(arm, 'dark', [0, -0.25, -0.15], [0.15, 0.16, 0.32], 0.035);
    m.box(arm, 'amber', [0, -0.21, -0.13], [0.155, 0.07, 0.19]);
  }
  m.cylinder(rightArm, 'edge', [0, -0.23, -0.33], 0.07, 0.25, 2);
  m.cylinder(rightArm, 'black', [0, -0.23, -0.465], 0.051, 0.03, 2);
  m.node('EnemyMuzzle', rightArm, [0, -0.23, -0.487]);
  m.sign(body, [0, 0.365, -0.284], 0.29, 0.036, 4);
  m.animation('SentinelIdle', [
    {
      node: head,
      path: 'translation',
      times: [0, 1.1, 2.2],
      values: [
        [0, 0.14, -0.015],
        [0, 0.147, -0.015],
        [0, 0.14, -0.015],
      ],
    },
    {
      node: leftArm,
      path: 'translation',
      times: [0, 1.1, 2.2],
      values: [
        [-0.31, 0.27, 0],
        [-0.31, 0.278, 0],
        [-0.31, 0.27, 0],
      ],
    },
  ]);
  m.animation('ReturnFire', [
    {
      node: rightArm,
      path: 'translation',
      times: [0, 0.04, 0.18],
      values: [
        [0.31, 0.27, 0],
        [0.31, 0.285, 0.07],
        [0.31, 0.27, 0],
      ],
    },
  ]);
  const shutdown = [
    {
      node: body,
      path: 'translation',
      times: [0, 0.2, 0.55],
      values: [
        [0, 1.1, 0],
        [0, 0.92, 0.02],
        [0, 0.66, -0.02],
      ],
    },
    {
      node: body,
      path: 'rotation',
      times: [0, 0.2, 0.55],
      values: [
        [0, 0, 0, 1],
        [0.08, 0, 0, 0.996795],
        [0.21, 0, 0, 0.977701],
      ],
    },
    {
      node: head,
      path: 'rotation',
      times: [0, 0.18, 0.55],
      values: [
        [0, 0, 0, 1],
        [0.12, 0, 0, 0.992774],
        [0.24, 0, 0, 0.970773],
      ],
    },
  ];
  m.animation('Shutdown', shutdown);
  // A dead snapshot can arrive without its event; do not loop the collapse from that state.
  m.animation(
    'Offline',
    shutdown.map(({ node, path, values }) => ({
      node,
      path,
      times: [0, 1],
      values: [values.at(-1), values.at(-1)],
    })),
  );
  return m;
}

function weapon() {
  const m = new Model('Vaultline_V7_CoilRifle');
  const gun = m.node('WeaponBody');
  // Camera-local metres: muzzle points -Z, with no offset baked into the attachment root.
  m.bevel(gun, 'dark', [0, 0, 0], [0.17, 0.19, 0.57], 0.035);
  m.bevel(gun, 'weapon', [0, 0.053, -0.04], [0.19, 0.13, 0.49], 0.04);
  m.bevel(gun, 'edge', [0, -0.025, -0.33], [0.145, 0.115, 0.21], 0.025);
  m.cylinder(gun, 'dark', [0, 0.008, -0.46], 0.054, 0.23, 2);
  m.cylinder(gun, 'edge', [0, 0.008, -0.54], 0.071, 0.055, 2);
  m.cylinder(gun, 'black', [0, 0.008, -0.573], 0.044, 0.016, 2);
  for (const z of [-0.26, -0.34, -0.42]) {
    m.box(gun, 'copper', [0, 0.044, z], [0.15, 0.035, 0.022]);
    m.box(gun, 'cyan', [0.076, 0.02, z], [0.01, 0.033, 0.028]);
  }
  m.bevel(gun, 'black', [0, -0.12, 0.1], [0.105, 0.2, 0.14], 0.027);
  m.bevel(gun, 'dark', [0, -0.135, -0.095], [0.112, 0.22, 0.18], 0.025);
  m.box(gun, 'amber', [0, -0.234, -0.095], [0.12, 0.027, 0.16]);
  m.bevel(gun, 'weapon', [0, -0.015, 0.33], [0.14, 0.17, 0.24], 0.035);
  m.box(gun, 'black', [0, -0.015, 0.465], [0.16, 0.18, 0.035]);
  const sight = m.node('ReflexSight', gun, [0, 0.13, 0.075]);
  m.bevel(sight, 'dark', [0, 0, 0], [0.125, 0.07, 0.145], 0.017);
  m.box(sight, 'edge', [-0.052, 0.06, -0.035], [0.018, 0.12, 0.023]);
  m.box(sight, 'edge', [0.052, 0.06, -0.035], [0.018, 0.12, 0.023]);
  m.box(sight, 'edge', [0, 0.116, -0.035], [0.12, 0.016, 0.023]);
  m.box(sight, 'cyan', [0, 0.018, 0.061], [0.035, 0.012, 0.008]);
  m.box(gun, 'cyan', [0.099, 0.039, 0.16], [0.008, 0.027, 0.055]);
  m.sign(gun, [0.099, 0.025, 0.045], 0.17, 0.022, 5, 'east');
  const bolt = m.node('ChargeBolt', gun, [0.098, 0.042, 0.005]);
  m.box(bolt, 'edge', [0, 0, 0], [0.024, 0.025, 0.078]);
  const hands = m.node('PressureSuitArms');
  m.bevel(hands, 'black', [0, -0.155, 0.115], [0.13, 0.12, 0.14], 0.038);
  m.bevel(hands, 'armor', [0.06, -0.29, 0.27], [0.18, 0.17, 0.35], 0.04);
  m.bevel(hands, 'dark', [0.1, -0.4, 0.41], [0.21, 0.19, 0.27], 0.04);
  m.bevel(hands, 'black', [-0.055, -0.1, -0.27], [0.19, 0.1, 0.17], 0.027);
  m.bevel(hands, 'armor', [-0.185, -0.21, -0.095], [0.16, 0.17, 0.39], 0.045);
  m.bevel(hands, 'dark', [-0.24, -0.29, 0.14], [0.2, 0.2, 0.28], 0.047);
  m.box(hands, 'amber', [-0.18, -0.148, -0.12], [0.17, 0.029, 0.07]);
  m.node('Muzzle', gun, [0, 0.008, -0.589]);
  m.animation('Fire', [
    {
      node: gun,
      path: 'translation',
      times: [0, 0.035, 0.09, 0.18],
      values: [
        [0, 0, 0],
        [0, 0.012, 0.06],
        [0, 0.004, 0.022],
        [0, 0, 0],
      ],
    },
    {
      node: bolt,
      path: 'translation',
      times: [0, 0.035, 0.11, 0.18],
      values: [
        [0.098, 0.042, 0.005],
        [0.098, 0.042, 0.055],
        [0.098, 0.042, 0.025],
        [0.098, 0.042, 0.005],
      ],
    },
  ]);
  return m;
}

function door() {
  const m = new Model('PressureSeal_BlastDoor');
  // Cell-centred origin; closed leaves fill the authoritative 1 x 4 x 1 door cell.
  const leaf = m.node('DoorLeaf');
  m.box(leaf, 'dark', [0, 2, 0], [1, 4, 0.9]);
  for (const z of [-0.461, 0.461]) {
    m.bevel(leaf, 'armor', [0, 1.95, z], [0.87, 3.63, 0.028], 0.11);
    m.box(leaf, 'dark', [0, 1.95, z + (z < 0 ? -0.02 : 0.02)], [0.035, 3.2, 0.02]);
    for (const x of [-0.33, 0.33])
      m.box(leaf, 'edge', [x, 1.8, z + (z < 0 ? -0.02 : 0.02)], [0.055, 2.7, 0.018]);
    m.box(leaf, 'hazard', [0, 0.26, z + (z < 0 ? -0.027 : 0.027)], [0.81, 0.22, 0.012]);
    m.box(leaf, 'warm', [0, 2.65, z + (z < 0 ? -0.027 : 0.027)], [0.5, 0.045, 0.013]);
  }
  m.sign(leaf, [0, 2.32, -0.499], 0.73, 0.093, 6);
  m.animation('Open', [
    {
      node: leaf,
      path: 'translation',
      times: [0, 0.15, 0.55, 0.8],
      values: [
        [0, 0, 0],
        [0, 0.2, 0],
        [0, 3.8, 0],
        [0, 4.1, 0],
      ],
    },
  ]);
  return m;
}

function panel() {
  const m = new Model('BreachLock_Panel');
  // This panel is viewed from the west. It occupies the existing box, not the wall behind it.
  m.box(0, 'dark', [0.035, 1.6, 0], [0.53, 1.6, 1.2]);
  m.bevel(0, 'edge', [-0.25, 1.6, 0], [0.04, 1.48, 1.07], 0.035);
  m.box(0, 'black', [-0.278, 1.75, 0], [0.016, 0.83, 0.9]);
  m.sign(0, [-0.29, 1.94, 0], 0.86, 0.11, 1, 'west');
  const indicator = m.node('LockIndicator', 0, [0, 1.51, 0]);
  m.box(indicator, 'amber', [-0.289, 0, 0], [0.012, 0.26, 0.29]);
  m.box(indicator, 'warm', [-0.297, 0, 0], [0.006, 0.18, 0.2]);
  for (const z of [-0.4, 0.4]) m.box(0, 'hazard', [-0.28, 1.05, z], [0.018, 0.22, 0.13]);
  const status = m.node('LockStatus', 0, [0, 1.25, 0]);
  m.nodes[status].scale = [0, 0, 0];
  m.box(status, 'green', [-0.292, 0, 0], [0.013, 0.04, 0.54]);
  m.animation('Unlock', [
    {
      node: indicator,
      path: 'scale',
      times: [0, 0.2],
      values: [
        [1, 1, 1],
        [0, 0, 0],
      ],
    },
    {
      node: status,
      path: 'scale',
      times: [0, 0.2],
      values: [
        [0, 0, 0],
        [1, 1, 1],
      ],
    },
  ]);
  return m;
}

function extraction() {
  const m = new Model('Extraction_Airlock07');
  // Floor markings are only a few millimetres high. No decorative obstacle in the trigger.
  m.box(0, 'dark', [0, 0.007, 0], [3.6, 0.014, 1.85]);
  for (const x of [-1.74, 1.74]) m.box(0, 'green', [x, 0.017, 0], [0.055, 0.006, 1.8]);
  for (const z of [-0.88, 0.88]) m.box(0, 'green', [0, 0.017, z], [3.5, 0.006, 0.055]);
  for (let i = 0; i < 5; i++) {
    const z = -0.6 + i * 0.25;
    m.box(0, 'armor', [-0.25, 0.017, z], [0.29, 0.005, 0.04]);
    m.box(0, 'armor', [0.25, 0.017, z], [0.29, 0.005, 0.04]);
  }
  return m;
}

function wave(phase) {
  const triangle = 1 - 4 * Math.abs(phase - Math.floor(phase) - 0.5);
  return triangle * (1.5 - 0.5 * triangle * triangle);
}

async function sound(file, seconds, sample) {
  const rate = 22050;
  const count = Math.round(rate * seconds);
  const bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(count * 2, 40);
  let state = 0x5ec709;
  let low = 0;
  let peak = 0;
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const noise = (state / 0xffffffff) * 2 - 1;
    low += (noise - low) * 0.08;
    const t = i / rate;
    const edge = Math.min(1, t * 500, (seconds - t) * 150);
    const value = sample(t, noise, low) * edge;
    if (Math.abs(value) > 0.95) throw new Error(`${file}: audio peak exceeds authored headroom`);
    peak = Math.max(peak, Math.abs(value));
    bytes.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  await writeFile(join(OUTPUT, file), bytes);
  return {
    file,
    seconds,
    sampleRate: rate,
    channels: 1,
    peak,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

const audio = [];
audio.push(
  await sound(
    'station-air.wav',
    4,
    (t, _noise, low) =>
      0.06 * wave(t * 60) + 0.025 * wave(t * 120) + 0.015 * wave(t * 240) + low * 0.13,
  ),
);
audio.push(
  await sound('coil-shot.wav', 0.28, (t, noise, low) => {
    const tail = 1 - t / 0.28;
    const punch = Math.max(0, 1 - t / 0.045);
    return (
      noise * punch * punch * 0.4 +
      low * tail * tail * 0.24 +
      wave(t * (150 - t * 150)) * tail * tail * 0.32
    );
  }),
);
audio.push(
  await sound('pressure-open.wav', 0.95, (t, noise, low) => {
    const ramp = Math.min(1, t * 18, (0.95 - t) * 7);
    return ramp * (low * 0.36 + noise * 0.025 + wave(t * (58 + t * 12)) * 0.11);
  }),
);
audio.push(
  await sound('armor-impact.wav', 0.24, (t, noise) => {
    const tail = 1 - t / 0.24;
    return tail * tail * (wave(t * 790) * 0.16 + wave(t * 1130) * 0.08 + noise * 0.25);
  }),
);
audio.push(
  await sound('suit-impact.wav', 0.34, (t, _noise, low) => {
    const tail = 1 - t / 0.34;
    return tail * tail * (wave(t * 75) * 0.26 + low * 0.6);
  }),
);
audio.push(
  await sound('sentry-shutdown.wav', 0.6, (t, noise, low) => {
    const tail = 1 - t / 0.6;
    return tail * tail * (wave(t * (240 - t * 180)) * 0.2 + low * 0.25 + noise * 0.03);
  }),
);
audio.push(
  await sound('airlock-ready.wav', 0.9, (t) => {
    const note = t < 0.25 ? 440 : t < 0.5 ? 550 : 660;
    const tail = Math.min(1, t * 40, (0.9 - t) * 5);
    return tail * (wave(t * note) * 0.12 + wave(t * note * 2) * 0.025);
  }),
);

const assets = [];
for (const [file, model] of [
  ['orbital-facility.glb', environment()],
  ['kestrel-security.glb', robot()],
  ['vaultline-rifle.glb', weapon()],
  ['blast-door.glb', door()],
  ['breach-panel.glb', panel()],
  ['extraction-pad.glb', extraction()],
]) {
  assets.push(await model.save(file));
}
const manifest = {
  format: 'aegis-original-assets/1',
  generator: 'games/fps/assets/generate.mjs',
  license: 'MIT',
  sceneSha256: createHash('sha256').update(JSON.stringify(sourceScene)).digest('hex'),
  coordinates:
    'Y up; metres; facility uses the unchanged FPS collision grid; weapon points camera-local -Z.',
  assets,
  audio,
  textures: [...textureBytes].map(([file, bytes]) => ({
    file,
    width: textures[file].width,
    height: textures[file].height,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })),
};
await writeFile(join(OUTPUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(
  `${assets.map((a) => `${a.file}: ${a.triangles} triangles, ${a.primitives} primitives, ${a.bytes} bytes`).join('\n')}\n`,
);
