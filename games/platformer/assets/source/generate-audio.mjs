import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { argv } from 'node:process';
import { URL, pathToFileURL } from 'node:url';

const sampleRate = 22050;
const args = argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out'))
  throw new Error('Usage: node generate-audio.mjs [--out <directory>]');
const root =
  args.length === 0 ? new URL('../', import.meta.url) : pathToFileURL(resolve(args[1]) + sep);

function noise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2147483648 - 1;
  };
}

function sine(phase) {
  const x = (phase - Math.floor(phase)) * 2 - 1;
  const y = 4 * x * (1 - Math.abs(x));
  return 0.225 * (y * Math.abs(y) - y) + y;
}

function envelope(t, duration, attack = 0.008) {
  if (t < 0 || t >= duration) return 0;
  const release = 1 - t / duration;
  return Math.min(1, t / attack) * release * release;
}

function tone(t, frequency, duration, strength = 1, start = 0) {
  const local = t - start;
  return sine(local * frequency) * envelope(local, duration) * strength;
}

function wave(duration, sample) {
  const length = Math.round(sampleRate * duration);
  const bytes = Buffer.alloc(44 + length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) {
    const value = sample(i / sampleRate, i, length);
    bytes.writeInt16LE(Math.round(Math.max(-0.95, Math.min(0.95, value)) * 32767), 44 + i * 2);
  }
  return bytes;
}

const landingNoise = noise(0x4731);
const stompNoise = noise(0x7512);
const windNoise = noise(0x73991);
let breeze = 0;
let rumble = 0;

const outputs = new Map([
  [
    'jump.wav',
    wave(
      0.23,
      (t) => sine(t * 410 + t * t * 1400) * envelope(t, 0.23) * 0.2 + tone(t, 960, 0.07, 0.055),
    ),
  ],
  [
    'landing.wav',
    wave(
      0.22,
      (t) =>
        landingNoise() * envelope(t, 0.12) * 0.17 +
        sine(t * 86 - t * t * 60) * envelope(t, 0.22) * 0.22,
    ),
  ],
  [
    'stomp.wav',
    wave(
      0.38,
      (t) =>
        stompNoise() * envelope(t, 0.09) * 0.15 +
        tone(t, 196, 0.2, 0.25) +
        tone(t, 784, 0.25, 0.12, 0.025) +
        tone(t, 1176, 0.25, 0.065, 0.045),
    ),
  ],
  [
    'ferry.wav',
    wave(
      0.65,
      (t) =>
        tone(t, 147, 0.18, 0.12) +
        tone(t, 392, 0.56, 0.09, 0.025) +
        tone(t, 588, 0.48, 0.075, 0.12) +
        tone(t, 784, 0.32, 0.055, 0.25),
    ),
  ],
  [
    'beacon.wav',
    wave(
      1.8,
      (t) =>
        tone(t, 392, 0.8, 0.1) +
        tone(t, 493.88, 0.95, 0.1, 0.14) +
        tone(t, 587.33, 1.05, 0.1, 0.28) +
        tone(t, 784, 1.2, 0.12, 0.46) +
        tone(t, 196, 1.65, 0.085, 0.14),
    ),
  ],
  [
    'fall.wav',
    wave(
      0.6,
      (t) => sine(t * 290 - t * t * 120) * envelope(t, 0.6) * 0.13 + tone(t, 92, 0.4, 0.13, 0.05),
    ),
  ],
  [
    'canyon-air.wav',
    wave(12, (t, i, length) => {
      breeze += (windNoise() - breeze) * 0.018;
      rumble += (breeze - rumble) * 0.007;
      const edge = Math.min(1, i / 2205, (length - 1 - i) / 2205);
      const swell = 0.65 + sine(t / 12) * 0.1 + sine(t / 4) * 0.12;
      return (
        (breeze * 0.24 + rumble * 0.65) * swell * edge +
        (sine(t * 55) * 0.018 + sine(t * 110) * 0.006) * edge
      );
    }),
  ],
]);

await mkdir(root, { recursive: true });
for (const [name, content] of outputs) await writeFile(new URL(name, root), content);
