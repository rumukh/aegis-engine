import { Buffer } from 'node:buffer';

/** Original small synthetic pulse fixtures, not voice or finished game music. */
export function atmosphereWav(periodSeconds) {
  const sampleRate = 22050;
  const frames = sampleRate * periodSeconds;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF');
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
  bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++) {
    const time = frame / sampleRate;
    const beat = Math.floor((time * 4) / periodSeconds);
    const within = time - (beat * periodSeconds) / 4;
    const envelope = Math.max(0, 1 - within / 0.25) * Math.min(1, within / 0.02);
    const pitch = [220, 330, 275, 330][beat];
    const sample = Math.sin(2 * Math.PI * pitch * time) * envelope * 0.05;
    bytes.writeInt16LE(Math.round(sample * 32767), 44 + frame * 2);
  }
  return bytes;
}
