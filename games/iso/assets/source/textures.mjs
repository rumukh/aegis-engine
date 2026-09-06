import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';

const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  I: ['111', '010', '010', '010', '010', '010', '111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  0: ['01110', '10011', '10101', '10101', '11001', '10001', '01110'],
  1: ['010', '110', '010', '010', '010', '010', '111'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['10010', '10010', '10010', '11111', '00010', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '-': ['000', '000', '000', '111', '000', '000', '000'],
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
};

function color(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const label = Buffer.from(type);
  const header = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  crc.writeUInt32BE(crc32(Buffer.concat([label, bytes])));
  return Buffer.concat([header, label, bytes, crc]);
}

class Raster {
  constructor(width, height, background) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 3);
    this.rect(0, 0, width, height, background);
  }

  rect(x, y, width, height, tint) {
    const rgb = typeof tint === 'string' ? color(tint) : tint;
    for (
      let py = Math.max(0, Math.floor(y));
      py < Math.min(this.height, Math.ceil(y + height));
      py++
    ) {
      for (
        let px = Math.max(0, Math.floor(x));
        px < Math.min(this.width, Math.ceil(x + width));
        px++
      ) {
        for (let c = 0; c < 3; c++) this.pixels[(py * this.width + px) * 3 + c] = rgb[c];
      }
    }
    return this;
  }

  line(x0, y0, x1, y1, thickness, tint) {
    const distance = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= distance; i++) {
      const t = i / distance;
      this.rect(
        Math.round(x0 + (x1 - x0) * t),
        Math.round(y0 + (y1 - y0) * t),
        thickness,
        thickness,
        tint,
      );
    }
    return this;
  }

  text(text, x, y, scale, tint) {
    let cursor = x;
    for (const letter of text) {
      const glyph = FONT[letter];
      if (!glyph) throw new Error(`No original pixel glyph authored for "${letter}"`);
      glyph.forEach((row, py) =>
        [...row].forEach((pixel, px) => {
          if (pixel === '1') this.rect(cursor + px * scale, y + py * scale, scale, scale, tint);
        }),
      );
      cursor += (glyph[0].length + 1) * scale;
    }
    return this;
  }

  grain(amount) {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const hash = (Math.imul(x + 11, 374761393) ^ Math.imul(y + 37, 668265263)) >>> 0;
        const shift = (hash % (amount * 2 + 1)) - amount;
        for (let c = 0; c < 3; c++) {
          const index = (y * this.width + x) * 3 + c;
          this.pixels[index] = Math.min(255, Math.max(0, this.pixels[index] + shift));
        }
      }
    }
    return this;
  }

  png() {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8;
    header[9] = 2;
    const rows = Buffer.alloc(this.height * (this.width * 3 + 1));
    for (let y = 0; y < this.height; y++) {
      this.pixels.copy(
        rows,
        y * (this.width * 3 + 1) + 1,
        y * this.width * 3,
        (y + 1) * this.width * 3,
      );
    }
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

function deck() {
  const r = new Raster(256, 256, '#111e2b');
  r.rect(4, 4, 248, 248, '#526572').rect(7, 7, 242, 242, '#304351');
  r.rect(17, 17, 222, 222, '#3b505e').rect(20, 20, 216, 216, '#344957');
  r.rect(23, 24, 210, 1, '#617581').rect(23, 232, 210, 2, '#1c2e3c');
  for (let y = 176; y < 212; y += 6) r.rect(45, y, 166, 2, '#213644');
  for (const [x, y] of [
    [12, 12],
    [238, 12],
    [12, 238],
    [238, 238],
  ]) {
    r.rect(x - 2, y - 2, 8, 8, '#172936').rect(x, y, 4, 4, '#8c9aa2');
  }
  r.rect(26, 36, 4, 52, '#728992').text('07', 38, 38, 2, '#8d9da5');
  r.line(191, 41, 211, 61, 2, '#80929a').line(191, 61, 211, 41, 2, '#80929a');
  return r.grain(2).png();
}

function wall() {
  const r = new Raster(256, 256, '#172b38');
  r.rect(4, 4, 248, 248, '#748b96').rect(8, 8, 240, 240, '#4b6574');
  r.rect(20, 20, 216, 216, '#577480').rect(24, 25, 208, 2, '#9cb0b5');
  r.rect(24, 227, 208, 4, '#2e4655');
  for (let y = 52; y < 183; y += 13) {
    r.rect(42, y, 172, 7, '#253d4c').rect(45, y + 7, 166, 2, '#6f8994');
  }
  r.rect(30, 197, 58, 12, '#1c3443').text('A-07', 34, 199, 1, '#95a9ad');
  r.rect(191, 197, 22, 3, '#7dc1cc').rect(191, 204, 12, 3, '#47818f');
  return r.grain(2).png();
}

function server(emission) {
  const r = new Raster(256, 512, emission ? '#000000' : '#101f2b');
  if (!emission) {
    r.rect(7, 5, 6, 502, '#8ca2ac').rect(243, 5, 6, 502, '#8ca2ac');
    r.text('VLT / 07', 30, 14, 2, '#9cb9c0');
  }
  for (let bay = 0; bay < 7; bay++) {
    const y = 46 + bay * 62;
    if (!emission) {
      r.rect(19, y, 218, 55, '#263c4b').rect(22, y + 2, 212, 2, '#68818b');
      r.rect(28, y + 8, 15, 36, '#111f2c').rect(216, y + 8, 13, 36, '#111f2c');
      for (let vent = 0; vent < 8; vent++) r.rect(59 + vent * 15, y + 12, 7, 22, '#101e2a');
      r.text(`0${bay + 1}`, 45, y + 42, 1, '#819da8');
    }
    r.rect(188, y + 40, 8, 4, bay === 3 ? '#dca658' : '#74e4df');
    r.rect(202, y + 40, 8, 4, '#367d92');
  }
  return (emission ? r : r.grain(1)).png();
}

function terminal(active) {
  const r = new Raster(256, 256, '#091f2c');
  r.rect(6, 6, 244, 244, '#467787').rect(9, 9, 238, 238, '#0c2b3a');
  for (let x = 16; x < 244; x += 16) r.rect(x, 52, 1, 145, '#163e4b');
  for (let y = 52; y < 201; y += 16) r.rect(16, y, 228, 1, '#163e4b');
  const light = active ? '#83efcd' : '#edbd69';
  r.text('ACCESS', 20, 20, 3, '#9ad3d4').text('CONTROL / 07', 20, 46, 1, '#77a8b7');
  r.rect(24, 79, 208, 3, light);
  r.text(active ? 'SEAL OPEN' : 'SEAL LOCK', 28, 96, 2, light);
  for (let i = 0; i < 8; i++) {
    const height = [14, 22, 16, 40, 31, 21, 38, 28][i];
    r.rect(31 + i * 25, 178 - height, 12, height, i < 5 ? '#428e9b' : light);
  }
  r.text(active ? 'ROUTE / EXIT' : 'VAULT / 01', 25, 202, 2, '#9dcbd0');
  r.rect(24, 230, active ? 208 : 68, 4, light);
  return r.png();
}

export function textures() {
  return new Map([
    ['deck-panel.png', deck()],
    ['partition-panel.png', wall()],
    ['server-face.png', server(false)],
    ['server-emission.png', server(true)],
    ['terminal-locked.png', terminal(false)],
    ['terminal-active.png', terminal(true)],
  ]);
}
