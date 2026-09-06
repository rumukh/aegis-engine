import { Buffer } from 'node:buffer';
import { sin, TAU } from '@aegis/core/math';

const RATE = 22050;

function wav(seconds, sample) {
  const count = Math.round(seconds * RATE);
  const buffer = Buffer.alloc(44 + count * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(RATE, 24);
  buffer.writeUInt32LE(RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(count * 2, 40);
  let state = 0x76a91e23;
  let noise = 0;
  for (let i = 0; i < count; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    noise = noise * 0.86 + (((state >>> 0) / 0xffffffff) * 2 - 1) * 0.14;
    const value = sample(i / RATE, i / count, noise);
    if (!Number.isFinite(value) || Math.abs(value) > 0.96) {
      throw new Error(`Audio exceeds the authored unclipped peak budget at sample ${i}`);
    }
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buffer;
}

const tone = (hz, t) => sin(TAU * hz * t);
const fade = (progress, attack = 0.05) => {
  const remaining = 1 - progress;
  return Math.min(1, progress / attack) * (remaining * remaining);
};

function phrase(frequencies, noteSeconds) {
  const phase = [0];
  for (const frequency of frequencies) phase.push(phase.at(-1) + frequency * noteSeconds);
  return (t) => {
    const note = Math.min(frequencies.length - 1, Math.floor(t / noteSeconds));
    // Pitch changes keep their accumulated phase instead of inserting an audible click.
    return sin(TAU * (phase[note] + frequencies[note] * (t - note * noteSeconds)));
  };
}

const accessTone = phrase([660, 880, 1100], 0.18);
const alertTone = phrase([440, 660], 0.24);

export function audio() {
  return new Map([
    [
      'vault-air.wav',
      wav(
        4,
        (t, p) =>
          (tone(55, t) * 0.12 + tone(110, t) * 0.025 + tone(165, t) * 0.012) *
          (0.85 + tone(0.5, t) * 0.15) *
          Math.min(1, p * 100, (1 - p) * 100),
      ),
    ],
    [
      'pulse-shot.wav',
      wav(0.2, (t, p, noise) => (tone(740 - 1150 * t, t) * 0.48 + noise * 0.45) * fade(p, 0.015)),
    ],
    [
      'armor-hit.wav',
      wav(
        0.26,
        (t, p, noise) =>
          (tone(135, t) * 0.23 + tone(394, t) * 0.12 + noise * 0.48) * fade(p, 0.015),
      ),
    ],
    [
      'guard-alert.wav',
      wav(
        0.48,
        (t, p) =>
          (alertTone(t) * 0.22 + tone(220, t) * 0.08) *
          fade(p, 0.025) *
          (0.6 + tone(12.5, t) * 0.4),
      ),
    ],
    ['access-granted.wav', wav(0.62, (t, p) => accessTone(t) * 0.3 * fade(p, 0.04))],
    [
      'vault-unseal.wav',
      wav(
        0.95,
        (t, p, noise) =>
          (noise * 0.33 + tone(82 + t * 62, t) * 0.21) *
          Math.min(1, p * 12) *
          Math.min(1, (1 - p) * 7),
      ),
    ],
    [
      'route-denied.wav',
      wav(0.24, (t, p) => (tone(174, t) * 0.23 + tone(261, t) * 0.1) * fade(p, 0.04)),
    ],
    [
      'extraction.wav',
      wav(
        1.2,
        (t, p) =>
          (tone(440, t) * 0.12 + tone(660, t) * 0.1 + tone(880, t) * 0.09) *
          Math.min(1, p * 7) *
          (1 - p),
      ),
    ],
  ]);
}
