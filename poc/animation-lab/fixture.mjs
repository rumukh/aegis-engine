/**
 * Original, rights-clear placeholder art and audio for the animation lab (ANIM-07 reference
 * fixture). Everything is drawn procedurally here, so the repository carries no third-party art:
 * five avatar species with identical part IDs, a tint-masked scarf with a badge anchor, hats, a
 * 2560x1600 background and a synthetic "babble" voice line with its mouth-cue track.
 *
 * `generateFixture()` returns `{ files: Map<relativePath, Buffer> }`; the authored JSON (rigs,
 * clips, cutscene) lives in `documents/` beside this file and refers to the atlases by ID.
 */
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** Encode straight-alpha RGBA as PNG (deterministic: fixed zlib level). */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** A small anti-aliased canvas: shapes are filled with 4x4 supersampled coverage. */
class Raster {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
  }
  blend(x, y, [r, g, b], alpha) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || alpha <= 0) return;
    const i = (y * this.width + x) * 4;
    const da = this.data[i + 3] / 255;
    const oa = alpha + da * (1 - alpha);
    for (const [k, value] of [r, g, b].entries())
      this.data[i + k] = Math.round((value * alpha + this.data[i + k] * da * (1 - alpha)) / oa);
    this.data[i + 3] = Math.round(oa * 255);
  }
  /** Fill where `inside(px, py)` holds, within the bounding box. */
  fill(box, color, inside, opacity = 1) {
    const rgb = parse(color);
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(this.width, Math.ceil(box.x + box.w));
    const y1 = Math.min(this.height, Math.ceil(box.y + box.h));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        let hits = 0;
        for (let sy = 0; sy < 4; sy++)
          for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits++;
        if (hits) this.blend(x, y, rgb, (hits / 16) * opacity);
      }
  }
  ellipse(cx, cy, rx, ry, color, opacity = 1) {
    const box = { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 };
    this.fill(box, color, (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1, opacity);
  }
  rect(x, y, w, h, color, opacity = 1) {
    const inside = (px, py) => px >= x && px < x + w && py >= y && py < y + h;
    this.fill({ x, y, w, h }, color, inside, opacity);
  }
  capsule(x, y, w, h, color) {
    const r = w / 2;
    this.fill({ x, y, w, h }, color, (px, py) => {
      const cy = Math.min(Math.max(py, y + r), y + h - r);
      return (px - (x + r)) ** 2 + (py - cy) ** 2 <= r * r;
    });
  }
  polygon(points, color, opacity = 1) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const box = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
    const inside = (px, py) => {
      let hit = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    this.fill(box, color, inside, opacity);
  }
  line(x0, y0, x1, y1, width, color) {
    const length = Math.hypot(x1 - x0, y1 - y0) || 1;
    const box = {
      x: Math.min(x0, x1) - width,
      y: Math.min(y0, y1) - width,
      w: Math.abs(x1 - x0) + width * 2,
      h: Math.abs(y1 - y0) + width * 2,
    };
    this.fill(box, color, (px, py) => {
      const t = Math.max(
        0,
        Math.min(1, ((px - x0) * (x1 - x0) + (py - y0) * (y1 - y0)) / length ** 2),
      );
      return Math.hypot(px - (x0 + t * (x1 - x0)), py - (y0 + t * (y1 - y0))) <= width / 2;
    });
  }
}

/** Shelf-pack frames into an atlas with 2 px transparent padding; draw each with its recipe. */
function atlas(id, size, frames) {
  const raster = new Raster(size, size);
  const json = { format: 'aegis-atlas/1', id, image: `${id}.png`, width: size, height: size };
  json.frames = {};
  let x = 2;
  let y = 2;
  let shelf = 0;
  for (const [name, w, h, draw] of frames) {
    if (x + w + 2 > size) {
      x = 2;
      y += shelf + 4;
      shelf = 0;
    }
    if (y + h + 2 > size) throw new Error(`Atlas ${id} overflow at ${name}`);
    json.frames[name] = { x, y, w, h };
    draw(raster, x, y, w, h);
    x += w + 4;
    shelf = Math.max(shelf, h);
  }
  // Crop unused rows: decoded memory is width x height x 4, so empty atlas space is not free.
  const height = Math.min(size, Math.ceil((y + shelf + 2) / 64) * 64);
  json.height = height;
  return { json, png: encodePng(size, height, raster.data.subarray(0, size * height * 4)) };
}

export const SPECIES = {
  fox: { fur: '#e07b39', light: '#f6dcc0', dark: '#7a3b14', ears: 'pointy', tail: 'bushy' },
  cat: { fur: '#8d99a6', light: '#e3e7ea', dark: '#3f4954', ears: 'pointy', tail: 'thin' },
  rabbit: { fur: '#efe6da', light: '#fff9f1', dark: '#8b7d6b', ears: 'long', tail: 'puff' },
  bear: { fur: '#9a6a43', light: '#d9b48f', dark: '#4a2f1a', ears: 'round', tail: 'puff' },
  hedgehog: { fur: '#a58a6a', light: '#ecd9bd', dark: '#4e3a26', ears: 'round', tail: 'spiky' },
};
export const MOUTHS = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

const OPEN = { X: 0, A: 0, B: 0.25, C: 0.55, D: 0.95, E: 0.6, F: 0.5, G: 0.2, H: 0.5 };
const WIDE = { X: 0.6, A: 0.55, B: 0.6, C: 0.62, D: 0.66, E: 0.48, F: 0.3, G: 0.55, H: 0.6 };
function mouth(shape, dark) {
  return (r, x, y, w, h) => {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const open = OPEN[shape];
    const width = w * WIDE[shape];
    if (!open) {
      r.line(cx - width / 2, cy, cx + width / 2, cy, shape === 'A' ? 5 : 3.5, dark);
      return;
    }
    r.ellipse(cx, cy, width / 2, (h * open) / 2, dark);
    if (shape === 'G') r.rect(cx - width / 3, cy - (h * open) / 2, width / 1.5, 4, '#ffffff');
    if (shape === 'H') r.ellipse(cx, cy + (h * open) / 6, width / 4, (h * open) / 5, '#e58f9a');
    if (shape === 'D' || shape === 'C')
      r.ellipse(cx, cy + (h * open) / 4, width / 3, (h * open) / 5, '#e58f9a');
  };
}

function speciesAtlas(name) {
  const s = SPECIES[name];
  const head = (r, x, y, w, h) => {
    if (name === 'hedgehog')
      for (let i = 0; i < 9; i++) {
        const a = Math.PI * (1.05 + (i / 8) * 0.9);
        const at = (radius, angle, ry) => [
          x + w / 2 + Math.cos(angle) * radius,
          y + h / 2 + Math.sin(angle) * ry,
        ];
        r.polygon([at(70, a, 60), at(108, a, 98), at(70, a + 0.2, 60)], s.dark);
      }
    r.ellipse(x + w / 2, y + h / 2, w / 2 - 14, h / 2 - 8, s.fur);
    r.ellipse(x + w / 2, y + h * 0.66, w / 4, h / 5, s.light);
    r.ellipse(x + w / 2, y + h * 0.56, 12, 9, s.dark);
  };
  const ear = (r, x, y, w, h) => {
    if (s.ears === 'pointy') {
      r.polygon(
        [
          [x + 4, y + h - 2],
          [x + w / 2, y + 2],
          [x + w - 4, y + h - 2],
        ],
        s.fur,
      );
      r.polygon(
        [
          [x + 18, y + h - 8],
          [x + w / 2, y + 26],
          [x + w - 18, y + h - 8],
        ],
        s.light,
      );
    } else if (s.ears === 'long') {
      r.ellipse(x + w / 2, y + h / 2, w / 2 - 4, h / 2 - 2, s.fur);
      r.ellipse(x + w / 2, y + h / 2 + 6, w / 4, h / 2 - 22, '#f2c4c8');
    } else {
      r.ellipse(x + w / 2, y + h - w / 2, w / 2 - 2, w / 2 - 2, s.fur);
      r.ellipse(x + w / 2, y + h - w / 2, w / 4, w / 4, s.light);
    }
  };
  const tail = (r, x, y, w, h) => {
    if (s.tail === 'bushy') {
      r.ellipse(x + w / 2, y + h / 2, w / 2 - 4, h / 2 - 4, s.fur);
      r.ellipse(x + w / 2, y + 26, w / 3, 22, s.light);
    } else if (s.tail === 'thin') r.line(x + w / 2, y + h - 8, x + w / 2 + 18, y + 10, 18, s.fur);
    else if (s.tail === 'spiky')
      r.polygon(
        [
          [x + 10, y + h - 10],
          [x + w / 2, y + 20],
          [x + w - 10, y + h - 10],
        ],
        s.dark,
      );
    else r.ellipse(x + w / 2, y + h - 40, 34, 34, s.light);
  };
  const eyes = (state) => (r, x, y, w, h) => {
    for (const cx of [x + 32, x + w - 32]) {
      if (state === 'open') {
        r.ellipse(cx, y + h / 2, 15, 19, '#ffffff');
        r.ellipse(cx, y + h / 2 + 2, 9, 12, '#1c1f24');
      } else if (state === 'half') {
        r.ellipse(cx, y + h / 2 + 4, 15, 9, '#ffffff');
        r.ellipse(cx, y + h / 2 + 6, 9, 6, '#1c1f24');
        r.line(cx - 16, y + h / 2 - 2, cx + 16, y + h / 2 - 2, 4, s.dark);
      } else r.line(cx - 15, y + h / 2 + 4, cx + 15, y + h / 2 + 4, 4, '#1c1f24');
    }
  };
  const brows = (lift, tilt) => (r, x, y, w, h) => {
    r.line(x + 14, y + h / 2 + lift + tilt, x + 52, y + h / 2 + lift - tilt, 6, s.dark);
    r.line(x + w - 52, y + h / 2 + lift - tilt, x + w - 14, y + h / 2 + lift + tilt, 6, s.dark);
  };
  const frames = [
    [
      'body',
      200,
      260,
      (r, x, y, w, h) => {
        r.ellipse(x + w / 2, y + h / 2, w / 2 - 2, h / 2 - 2, s.fur);
        r.ellipse(x + w / 2, y + h * 0.6, w / 3, h / 3, s.light);
      },
    ],
    ['head', 220, 200, head],
    ['ear', 70, s.ears === 'long' ? 170 : 110, ear],
    ['tail', 90, 170, tail],
    ['arm', 56, 140, (r, x, y, w, h) => r.capsule(x + 2, y + 2, w - 4, h - 4, s.fur)],
    ['leg', 64, 110, (r, x, y, w, h) => r.capsule(x + 2, y + 2, w - 4, h - 4, s.dark)],
    ['eyes.open', 130, 44, eyes('open')],
    ['eyes.half', 130, 44, eyes('half')],
    ['eyes.closed', 130, 44, eyes('closed')],
    ['brows.neutral', 140, 34, brows(0, 0)],
    ['brows.up', 140, 34, brows(-8, 0)],
    ['brows.worried', 140, 34, brows(0, 8)],
    ...MOUTHS.map((shape) => [`mouth.${shape}`, 70, 46, mouth(shape, '#5a1d22')]),
  ];
  return atlas(`avatar.${name}.atlas`, 1024, frames);
}

function scarfAtlas() {
  // Light neutral grey with grey shading: the multiply tint gives the palette colour range.
  const grey = (r, x, y, w, h, stripes) => {
    r.rect(x + 2, y + 2, w - 4, h - 4, '#e8e8e8');
    for (let i = 0; i < stripes; i++) r.rect(x + 2, y + 8 + i * 18, w - 4, 6, '#bdbdbd');
  };
  const mask = (r, x, y, w, h) => r.rect(x + 2, y + 2, w - 4, h - 4, '#ffffff');
  const knot = (color) => (r, x, y, w, h) =>
    r.ellipse(x + w / 2, y + h / 2, w / 2 - 3, h / 2 - 3, color);
  return atlas('acc.scarf.atlas', 512, [
    [
      'wrap',
      250,
      64,
      (r, x, y, w, h) => {
        grey(r, x, y, w, h, 3);
        // A gold hem outside the mask keeps its colour under every tint.
        r.rect(x + 2, y + h - 10, w - 4, 6, '#f2d36b');
      },
    ],
    ['wrap.mask', 250, 64, (r, x, y, w, h) => mask(r, x, y, w, h - 10)],
    ['tail', 60, 140, (r, x, y, w, h) => grey(r, x, y, w, h, 6)],
    ['tail.mask', 60, 140, mask],
    ['knot', 60, 60, knot('#d6d6d6')],
    ['knot.mask', 60, 60, knot('#ffffff')],
  ]);
}

function hatsAtlas() {
  const star = (r, x, y, w, h) => {
    const points = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const radius = i % 2 ? w * 0.2 : w / 2 - 2;
      points.push([x + w / 2 + Math.cos(a) * radius, y + h / 2 + Math.sin(a) * radius]);
    }
    r.polygon(points, '#f5c518');
  };
  const detective = (brim, crown, band) => (r, x, y, w, h) => {
    r.ellipse(x + w / 2, y + h - 22, w / 2 - 4, 20, brim);
    r.ellipse(x + w / 2, y + h / 2, w / 3, h / 2 - 12, crown);
    r.rect(x + w / 6, y + h - 46, (w * 2) / 3, 12, band);
  };
  return atlas('acc.hats.atlas', 1024, [
    ['detective.brown', 260, 130, detective('#6b4a2b', '#7d5834', '#3b2817')],
    ['detective.grey', 260, 130, detective('#5b6066', '#6c7279', '#2c3034')],
    [
      'beret',
      220,
      100,
      (r, x, y, w, h) => {
        r.ellipse(x + w / 2, y + h / 2 + 8, w / 2 - 4, h / 2 - 12, '#2f4f8f');
        r.rect(x + w / 2 - 5, y + 4, 10, 18, '#2f4f8f');
      },
    ],
    [
      'cap',
      240,
      110,
      (r, x, y, w, h) => {
        r.ellipse(x + w / 2 - 20, y + h / 2 + 10, w / 2 - 40, h / 2 - 14, '#b23b3b');
        r.ellipse(x + w - 56, y + h - 22, 52, 14, '#8f2e2e');
      },
    ],
    ['badge', 52, 52, star],
  ]);
}

function backgroundPng() {
  const width = 2560;
  const height = 1600;
  const r = new Raster(width, height);
  const top = [44, 58, 92];
  const bottom = [92, 70, 60];
  for (let y = 0; y < 1180; y++) {
    const t = y / height;
    const hex =
      '#' +
      top
        .map((c, i) => Math.round(c + (bottom[i] - c) * t))
        .map((c) => c.toString(16).padStart(2, '0'))
        .join('');
    for (let x = 0; x < width; x++) r.blend(x, y, parse(hex), 1);
  }
  r.rect(0, 1180, width, 420, '#6b4f3a');
  r.rect(0, 1170, width, 14, '#4a3526');
  r.rect(1500, 260, 620, 520, '#1d2944');
  r.ellipse(1810, 420, 70, 70, '#f6f0c8');
  r.rect(1490, 250, 640, 16, '#3a2a1e');
  r.rect(1490, 776, 640, 16, '#3a2a1e');
  r.rect(1802, 260, 16, 520, '#3a2a1e');
  r.rect(330, 700, 520, 480, '#8a5a3a');
  r.rect(310, 680, 560, 30, '#5e3d26');
  const books = ['#b6623f', '#3f7a6b', '#c49a3f', '#5b4a8a'];
  for (let i = 0; i < 4; i++) r.rect(360 + i * 120, 760, 90, 140, books[i]);
  // Corner marks of the centred 2100x1440 safe area.
  for (const [x, y] of [
    [230, 80],
    [2330, 80],
    [230, 1520],
    [2330, 1520],
  ])
    r.ellipse(x, y, 6, 6, '#ffffff', 0.35);
  return encodePng(width, height, r.data);
}

/** Syllables of the babble line: [start, end, open shape]. Times in seconds. */
export const BABBLE = [
  [0.18, 0.36, 'C'],
  [0.42, 0.58, 'D'],
  [0.64, 0.8, 'E'],
  [0.9, 1.1, 'B'],
  [1.18, 1.36, 'F'],
  [1.42, 1.62, 'D'],
  [1.86, 2.04, 'C'],
  [2.1, 2.3, 'G'],
  [2.36, 2.56, 'E'],
  [2.62, 2.84, 'D'],
];
export const BABBLE_DURATION = 3.2;

/** Mono 16-bit PCM WAV. */
export function wav(samples, rate) {
  const output = Buffer.alloc(44 + samples.length * 2);
  output.write('RIFF');
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(rate, 24);
  output.writeUInt32LE(rate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36);
  output.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, i) =>
    output.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(value * 32767))), 44 + i * 2),
  );
  return output;
}

const PITCH = { B: 180, C: 210, D: 230, E: 200, F: 170, G: 190 };
export function babbleWav(rate = 22_050) {
  const samples = new Float32Array(Math.round(BABBLE_DURATION * rate));
  for (const [start, end, shape] of BABBLE) {
    const pitch = PITCH[shape] ?? 200;
    for (let i = Math.round(start * rate); i < Math.round(end * rate); i++) {
      const t = i / rate;
      const envelope = Math.sin((Math.PI * (t - start)) / (end - start)) ** 0.6;
      const tone =
        Math.sin(2 * Math.PI * pitch * t) +
        0.4 * Math.sin(4 * Math.PI * pitch * t) +
        0.2 * Math.sin(6 * Math.PI * pitch * t);
      samples[i] = 0.35 * envelope * tone;
    }
  }
  return wav(samples, rate);
}

const ms = (value) => Math.round(value * 1000) / 1000;
export function babbleCues(line = 'lab.babble') {
  const cues = [{ t: 0, s: 'X' }];
  for (const [start, end, shape] of BABBLE)
    cues.push(
      { t: start, s: 'B' },
      { t: ms(start + 0.05), s: shape },
      { t: ms(end - 0.03), s: 'A' },
      { t: end, s: 'X' },
    );
  return { format: 'aegis-cues/1', line, revision: '1', duration: BABBLE_DURATION, cues };
}

export function generateFixture() {
  const files = new Map();
  const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  for (const make of [
    ...Object.keys(SPECIES).map((name) => () => speciesAtlas(name)),
    scarfAtlas,
    hatsAtlas,
  ]) {
    const result = make();
    files.set(`${result.json.id}.json`, json(result.json));
    files.set(result.json.image, result.png);
  }
  for (const document of documents()) files.set(`${document.id}.json`, json(document));
  files.set('bg.office.png', backgroundPng());
  files.set('lab.babble.wav', babbleWav());
  files.set('lab.babble.cues.json', json(babbleCues()));
  return { files };
}

export const SCARF_COLORS = {
  red: '#c8553d',
  blue: '#2f6fb3',
  green: '#3f8f5a',
  yellow: '#e2b33b',
  purple: '#7b4fa8',
  pink: '#e07aa5',
};
export const HATS = ['acc.hat.detective', 'acc.hat.beret', 'acc.hat.cap'];

/** Authored documents: rigs, accessories, clips and the reference cutscene. */
export function documents() {
  const rig = (name) => {
    const atlas = `avatar.${name}.atlas`;
    const f = (frame) => `${atlas}#${frame}`;
    const earHeight = SPECIES[name].ears === 'long' ? 170 : 110;
    const variants = (prefix, names) =>
      Object.fromEntries(names.map((item) => [item, f(`${prefix}.${item}`)]));
    return {
      format: 'aegis-rig/1',
      id: `avatar.${name}`,
      revision: '1',
      atlases: [atlas],
      origin: { x: 0, y: 0 },
      bounds: { x: -170, y: -720, width: 340, height: 730 },
      parts: [
        {
          id: 'body',
          frame: f('body'),
          pivot: { x: 100, y: 255 },
          position: { x: 0, y: -90 },
          z: 10,
        },
        {
          id: 'leg.l',
          parent: 'body',
          frame: f('leg'),
          pivot: { x: 32, y: 12 },
          position: { x: -45, y: -30 },
          z: 5,
        },
        {
          id: 'leg.r',
          parent: 'body',
          frame: f('leg'),
          pivot: { x: 32, y: 12 },
          position: { x: 45, y: -30 },
          z: 6,
        },
        {
          id: 'tail',
          parent: 'body',
          frame: f('tail'),
          pivot: { x: 20, y: 160 },
          position: { x: 75, y: -50 },
          rotation: 20,
          z: 2,
        },
        {
          id: 'arm.l',
          parent: 'body',
          frame: f('arm'),
          pivot: { x: 28, y: 14 },
          position: { x: -88, y: -205 },
          rotation: 12,
          z: 14,
        },
        {
          id: 'head',
          parent: 'body',
          frame: f('head'),
          pivot: { x: 110, y: 185 },
          position: { x: 0, y: -225 },
          z: 20,
        },
        {
          id: 'ear.l',
          parent: 'head',
          frame: f('ear'),
          pivot: { x: 35, y: earHeight - 6 },
          position: { x: -62, y: -150 },
          rotation: -14,
          z: 18,
        },
        {
          id: 'ear.r',
          parent: 'head',
          frame: f('ear'),
          pivot: { x: 35, y: earHeight - 6 },
          position: { x: 62, y: -150 },
          rotation: 14,
          z: 19,
        },
        {
          id: 'eyes',
          parent: 'head',
          variants: variants('eyes', ['open', 'half', 'closed']),
          variant: 'open',
          pivot: { x: 65, y: 22 },
          position: { x: 0, y: -105 },
          z: 21,
        },
        {
          id: 'brows',
          parent: 'head',
          variants: variants('brows', ['neutral', 'up', 'worried']),
          variant: 'neutral',
          pivot: { x: 70, y: 17 },
          position: { x: 0, y: -140 },
          z: 22,
        },
        {
          id: 'mouth',
          parent: 'head',
          variants: variants('mouth', MOUTHS),
          variant: 'X',
          pivot: { x: 35, y: 23 },
          position: { x: 0, y: -28 },
          z: 23,
        },
        {
          id: 'arm.r',
          parent: 'body',
          frame: f('arm'),
          pivot: { x: 28, y: 14 },
          position: { x: 88, y: -205 },
          rotation: -12,
          z: 26,
        },
      ],
      roles: {
        mouth: 'mouth',
        eyes: 'eyes',
        brows: 'brows',
        head: 'head',
        lookAt: 'head',
        body: 'body',
      },
      expressions: {
        neutral: { brows: 'neutral', eyes: 'open' },
        happy: { brows: 'up' },
        worried: { brows: 'worried' },
        surprised: { brows: 'up', eyes: 'open' },
        sleepy: { eyes: 'half', brows: 'neutral' },
      },
      slots: {
        scarf: { parent: 'body', position: { x: 0, y: -232 }, z: 24 },
        hat: { parent: 'head', position: { x: 0, y: -165 }, z: 30 },
      },
      tints: { scarf: { default: SCARF_COLORS.red } },
      emotes: {
        joy: { expression: 'happy', clip: 'hop.small' },
        surprise: { expression: 'surprised', clip: 'startle' },
        think: { expression: 'worried', clip: 'think' },
      },
    };
  };
  const scarf = {
    format: 'aegis-rig/1',
    id: 'acc.scarf.long',
    revision: '1',
    atlases: ['acc.scarf.atlas'],
    parts: [
      {
        id: 'scarf.wrap',
        frame: 'acc.scarf.atlas#wrap',
        pivot: { x: 125, y: 32 },
        position: { x: 0, y: 0 },
        z: 1,
        tint: { channel: 'scarf', mask: 'acc.scarf.atlas#wrap.mask' },
      },
      {
        id: 'scarf.tail',
        parent: 'scarf.wrap',
        frame: 'acc.scarf.atlas#tail',
        pivot: { x: 30, y: 8 },
        position: { x: 55, y: 20 },
        rotation: -6,
        z: 0,
        tint: { channel: 'scarf', mask: 'acc.scarf.atlas#tail.mask' },
      },
      {
        id: 'scarf.knot',
        parent: 'scarf.wrap',
        frame: 'acc.scarf.atlas#knot',
        pivot: { x: 30, y: 30 },
        position: { x: 50, y: 14 },
        z: 2,
        tint: { channel: 'scarf', mask: 'acc.scarf.atlas#knot.mask' },
      },
    ],
    tints: { scarf: { default: SCARF_COLORS.red } },
    anchors: { badge: { part: 'scarf.knot', x: 30, y: 30 } },
  };
  const hat = (id, frame, variants) => ({
    format: 'aegis-rig/1',
    id,
    revision: '1',
    atlases: ['acc.hats.atlas'],
    parts: [
      variants
        ? {
            id: 'hat',
            variants,
            variant: Object.keys(variants)[0],
            pivot: { x: 130, y: 118 },
            position: { x: 0, y: 0 },
            z: 0,
          }
        : {
            id: 'hat',
            frame,
            pivot: { x: frame.endsWith('beret') ? 110 : 120, y: 92 },
            position: { x: 0, y: 0 },
            z: 0,
          },
    ],
  });
  const badge = {
    format: 'aegis-rig/1',
    id: 'acc.badge',
    revision: '1',
    atlases: ['acc.hats.atlas'],
    parts: [
      {
        id: 'badge',
        frame: 'acc.hats.atlas#badge',
        pivot: { x: 26, y: 26 },
        position: { x: 0, y: 0 },
        z: 0,
      },
    ],
  };
  const clip = (id, duration, tracks, extra = {}) => ({
    format: 'aegis-clip/1',
    id,
    duration,
    tracks,
    ...extra,
  });
  const keys = (...pairs) => pairs.map(([t, v, ease]) => ({ t, v, ...(ease ? { ease } : {}) }));
  const clips = [
    clip(
      'wave',
      1.4,
      [
        {
          part: 'arm.r',
          property: 'rotation',
          keys: keys(
            [0, 0, 'easeOutCubic'],
            [0.3, -150, 'easeInOutSine'],
            [0.55, -120, 'easeInOutSine'],
            [0.8, -150, 'easeInOutSine'],
            [1.05, -120, 'easeInOutSine'],
            [1.4, 0],
          ),
        },
        {
          part: 'head',
          property: 'rotation',
          keys: keys([0, 0, 'easeInOutSine'], [0.5, 5, 'easeInOutSine'], [1.4, 0]),
        },
      ],
      { events: [{ t: 0.3, name: 'wave.peak' }] },
    ),
    clip('nod', 0.8, [
      {
        part: 'head',
        property: 'rotation',
        keys: keys(
          [0, 0, 'easeInOutSine'],
          [0.2, 6, 'easeInOutSine'],
          [0.4, -2, 'easeInOutSine'],
          [0.6, 5, 'easeInOutSine'],
          [0.8, 0],
        ),
      },
    ]),
    clip('hop.small', 0.5, [
      {
        part: 'body',
        property: 'y',
        keys: keys(
          [0, 0, 'easeOutQuad'],
          [0.22, -46, 'easeInQuad'],
          [0.44, 0, 'easeOutQuad'],
          [0.5, 0],
        ),
      },
      {
        part: 'body',
        property: 'scaleY',
        keys: keys(
          [0, 1],
          [0.05, 0.94, 'easeOutQuad'],
          [0.15, 1.04],
          [0.44, 1, 'easeOutQuad'],
          [0.47, 0.95],
          [0.5, 1],
        ),
      },
    ]),
    clip('startle', 0.6, [
      {
        part: 'body',
        property: 'y',
        keys: keys([0, 0, 'easeOutBack'], [0.15, -18, 'easeInOutSine'], [0.6, 0]),
      },
      {
        part: 'arm.l',
        property: 'rotation',
        keys: keys([0, 0, 'easeOutBack'], [0.15, 50, 'easeInOutSine'], [0.6, 0]),
      },
      {
        part: 'arm.r',
        property: 'rotation',
        keys: keys([0, 0, 'easeOutBack'], [0.15, -50, 'easeInOutSine'], [0.6, 0]),
      },
    ]),
    clip('think', 1.6, [
      {
        part: 'head',
        property: 'rotation',
        keys: keys([0, 0, 'easeInOutSine'], [0.4, -8], [1.2, -8, 'easeInOutSine'], [1.6, 0]),
      },
      {
        part: 'arm.r',
        property: 'rotation',
        keys: keys([0, 0, 'easeInOutSine'], [0.4, -125], [1.2, -125, 'easeInOutSine'], [1.6, 0]),
      },
    ]),
    clip(
      'sway',
      2.4,
      [
        {
          part: 'body',
          property: 'rotation',
          keys: keys(
            [0, 0, 'easeInOutSine'],
            [0.6, 2, 'easeInOutSine'],
            [1.8, -2, 'easeInOutSine'],
            [2.4, 0],
          ),
        },
        {
          part: 'tail',
          property: 'rotation',
          keys: keys([0, 0, 'easeInOutSine'], [1.2, 12, 'easeInOutSine'], [2.4, 0]),
        },
      ],
      { loop: true, blend: 'additive' },
    ),
  ];
  const cutscene = {
    format: 'aegis-cutscene/1',
    id: 'lab.intro',
    revision: '1',
    cast: {
      guide: {
        rig: 'avatar.cat',
        tints: { scarf: SCARF_COLORS.green },
        accessories: [{ slot: 'hat', rig: 'acc.hat.beret' }],
      },
      player: { role: 'avatar' },
    },
    steps: [
      { op: 'background', asset: 'bg.office', comfort: { asset: 'bg.office' } },
      { op: 'camera', preset: 'wide', cut: true },
      { op: 'enter', actor: 'guide', from: 'left', to: { x: 900, y: 1400 }, duration: 1.4 },
      {
        op: 'enter',
        actor: 'player',
        from: 'right',
        to: { x: 1660, y: 1400 },
        duration: 1.4,
        wait: false,
      },
      { op: 'emote', actor: 'guide', emote: 'joy' },
      { op: 'line', actor: 'guide', line: 'lab.babble' },
      { op: 'marker', id: 'met' },
      { op: 'camera', to: { x: 1280, y: 980, zoom: 1.35 }, duration: 1.6, ease: 'easeInOutSine' },
      { op: 'pose', actor: 'player', expression: 'happy', clip: 'wave' },
      { op: 'effect', effect: 'sparkles', at: { x: 1660, y: 900 }, duration: 1.2, wait: false },
      { op: 'line', actor: 'player', line: 'lab.babble' },
      { op: 'camera', preset: 'wide', duration: 1.2 },
      { op: 'exit', actor: 'guide', to: 'left', duration: 1.2 },
    ],
  };
  return [
    ...Object.keys(SPECIES).map(rig),
    scarf,
    hat('acc.hat.detective', undefined, {
      brown: 'acc.hats.atlas#detective.brown',
      grey: 'acc.hats.atlas#detective.grey',
    }),
    hat('acc.hat.beret', 'acc.hats.atlas#beret'),
    hat('acc.hat.cap', 'acc.hats.atlas#cap'),
    badge,
    ...clips,
    cutscene,
  ];
}
