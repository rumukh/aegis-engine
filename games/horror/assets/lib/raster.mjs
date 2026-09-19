import { Buffer } from 'node:buffer';
import { deflateSync, inflateSync } from 'node:zlib';

export const clamp = (value, lo = 0, hi = 255) => Math.min(hi, Math.max(lo, value));

export function noise(x, y, seed = 7103) {
  let n = Math.imul(x ^ seed, 374761393) + Math.imul(y, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

export class Raster {
  constructor(width, height, color = [0, 0, 0, 255]) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
    this.rect(0, 0, width, height, color);
  }
  pixel(x, y, color) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    for (let c = 0; c < 4; c++) this.data[i + c] = clamp(color[c] ?? 255);
  }
  get(x, y) {
    const i =
      ((((y % this.height) + this.height) % this.height) * this.width +
        (((x % this.width) + this.width) % this.width)) *
      4;
    return [...this.data.subarray(i, i + 4)];
  }
  rect(x, y, width, height, color) {
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(this.height, y + height); py++) {
      for (let px = Math.max(0, Math.floor(x)); px < Math.min(this.width, x + width); px++)
        this.pixel(px, py, color);
    }
  }
  line(x0, y0, x1, y1, color, width = 1) {
    const length = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= length; i++) {
      this.rect(x0 + ((x1 - x0) * i) / length, y0 + ((y1 - y0) * i) / length, width, width, color);
    }
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length);
  out.write(type, 4);
  bytes.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}

export function png(image) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = image.width * 4;
  const rows = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    rows[y * (stride + 1)] = 1;
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      rows[y * (stride + 1) + x + 1] = (image.data[i] - (x >= 4 ? image.data[i - 4] : 0)) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('Material source is not PNG');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const type = bytes[25];
  if (bytes[24] !== 8 || ![2, 6].includes(type) || bytes[28] !== 0)
    throw new Error('PNG source must be non-interlaced 8-bit RGB or RGBA');
  if (width > 8192 || height > 8192) throw new Error('Material source exceeds 8192 pixels');
  const blocks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('Truncated PNG chunk');
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
      throw new Error('PNG chunk CRC mismatch');
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT')
      blocks.push(bytes.subarray(offset + 8, end - 4));
    offset = end;
  }
  const channels = type === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(blocks), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) throw new Error('PNG decompressed length mismatch');
  const decoded = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error(`Unknown PNG filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= channels ? decoded[i - channels] : 0;
      const b = y ? decoded[i - stride] : 0;
      const c = y && x >= channels ? decoded[i - stride - channels] : 0;
      const predictors = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)];
      decoded[i] = (raw[y * (stride + 1) + x + 1] + predictors[filter]) & 255;
    }
  }
  const result = new Raster(width, height);
  for (let i = 0; i < width * height; i++) {
    decoded.copy(result.data, i * 4, i * channels, i * channels + channels);
    if (channels === 3) result.data[i * 4 + 3] = 255;
  }
  return result;
}

export function resample(image, width, height) {
  const output = new Raster(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = (x * image.width) / width,
        sy = (y * image.height) / height;
      const ix = Math.floor(sx),
        iy = Math.floor(sy);
      const samples = [
        image.get(ix, iy),
        image.get(ix + 1, iy),
        image.get(ix, iy + 1),
        image.get(ix + 1, iy + 1),
      ];
      const tx = sx - ix,
        ty = sy - iy;
      output.pixel(
        x,
        y,
        [0, 1, 2, 3].map(
          (c) =>
            samples[0][c] * (1 - tx) * (1 - ty) +
            samples[1][c] * tx * (1 - ty) +
            samples[2][c] * (1 - tx) * ty +
            samples[3][c] * tx * ty,
        ),
      );
    }
  }
  return output;
}

export function seamless(image, border = 48) {
  const source = Buffer.from(image.data);
  const weight = (v, size) => Math.max(0, 1 - Math.min(v, size - 1 - v) / border) / 2;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const wx = weight(x, image.width),
        wy = weight(y, image.height);
      const positions = [
        [x, y],
        [image.width - 1 - x, y],
        [x, image.height - 1 - y],
        [image.width - 1 - x, image.height - 1 - y],
      ];
      const weights = [(1 - wx) * (1 - wy), wx * (1 - wy), (1 - wx) * wy, wx * wy];
      image.pixel(
        x,
        y,
        [0, 1, 2, 3].map((c) =>
          positions.reduce(
            (sum, [px, py], i) => sum + source[(py * image.width + px) * 4 + c] * weights[i],
            0,
          ),
        ),
      );
    }
  }
  return image;
}

export function normalMap(heights, width, height, strength) {
  const output = new Raster(width, height);
  const sample = (x, y) => heights[((y + height) % height) * width + ((x + width) % width)];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (sample(x - 1, y) - sample(x + 1, y)) * strength;
      const dy = (sample(x, y + 1) - sample(x, y - 1)) * strength;
      const length = Math.sqrt(dx * dx + dy * dy + 1);
      output.pixel(x, y, [
        127.5 + (dx * 127.5) / length,
        127.5 + (dy * 127.5) / length,
        127.5 + 127.5 / length,
      ]);
    }
  }
  return output;
}
