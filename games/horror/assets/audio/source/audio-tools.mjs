import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';

export const SAMPLE_RATE = 48000;

export function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} exited ${result.status}: ${result.stderr?.toString()}`);
  }
  return result;
}

export async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

export function decode(path, channels, filters = []) {
  const output = command('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-i',
    path,
    ...(filters.length ? ['-af', filters.join(',')] : []),
    '-ac',
    String(channels),
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    'f32le',
    'pipe:1',
  ]).stdout;
  if (!output.length || output.length % (channels * 4)) {
    throw new Error(`Empty or partial PCM frame from ${path}`);
  }
  const samples = new Float32Array(output.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = output.readFloatLE(i * 4);
  assertSamples(samples);
  return samples;
}

export function assertSamples(samples) {
  if (!samples.length) throw new Error('Audio must contain samples');
  let peak = 0;
  for (const value of samples) {
    if (!Number.isFinite(value)) throw new Error('Non-finite audio sample');
    peak = Math.max(peak, Math.abs(value));
  }
  if (peak < 0.000001) throw new Error('Audio is effectively silent');
  return peak;
}

export function crossfadeLoop(samples, channels, overlapFrames) {
  const frames = samples.length / channels;
  if (
    !Number.isInteger(frames) ||
    !Number.isInteger(overlapFrames) ||
    overlapFrames < 2 ||
    overlapFrames * 2 >= frames
  ) {
    throw new Error('Loop requires integral frames and an overlap shorter than half the source');
  }
  const middle = samples.slice(overlapFrames * channels, (frames - overlapFrames) * channels);
  const output = new Float32Array((frames - overlapFrames) * channels);
  output.set(middle);
  for (let frame = 0; frame < overlapFrames; frame++) {
    const progress = frame / (overlapFrames - 1);
    const tailGain = Math.sqrt(1 - progress);
    const headGain = Math.sqrt(progress);
    for (let channel = 0; channel < channels; channel++) {
      const tail = samples[(frames - overlapFrames + frame) * channels + channel];
      const head = samples[frame * channels + channel];
      output[middle.length + frame * channels + channel] = tail * tailGain + head * headGain;
    }
  }
  return output;
}

export function fadeEdges(samples, channels, attackFrames, releaseFrames) {
  const frames = samples.length / channels;
  if (
    !Number.isInteger(frames) ||
    attackFrames < 2 ||
    releaseFrames < 2 ||
    attackFrames + releaseFrames > frames
  ) {
    throw new Error('Invalid one-shot fades');
  }
  const output = samples.slice();
  for (let frame = 0; frame < frames; frame++) {
    const gain = Math.min(
      1,
      frame / (attackFrames - 1),
      (frames - frame - 1) / (releaseFrames - 1),
    );
    for (let channel = 0; channel < channels; channel++) {
      output[frame * channels + channel] *= gain;
    }
  }
  return output;
}

export function floatWav(samples, channels, sampleRate = SAMPLE_RATE) {
  assertSamples(samples);
  if (!Number.isInteger(samples.length / channels)) throw new Error('Partial WAV frame');
  const output = Buffer.alloc(44 + samples.length * 4);
  output.write('RIFF', 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(3, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * channels * 4, 28);
  output.writeUInt16LE(channels * 4, 32);
  output.writeUInt16LE(32, 34);
  output.write('data', 36);
  output.writeUInt32LE(samples.length * 4, 40);
  for (let i = 0; i < samples.length; i++) output.writeFloatLE(samples[i], 44 + i * 4);
  return output;
}

export function measure(path) {
  const result = command('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    path,
    '-af',
    'silencedetect=noise=-60dB:d=0.25,loudnorm=I=-24:TP=-6:LRA=8:print_format=json',
    '-f',
    'null',
    '-',
  ]);
  const text = result.stderr.toString();
  const match = text.match(/\{\s*"input_i"[\s\S]*?\}/);
  if (!match) throw new Error(`Missing loudness analysis for ${path}`);
  const analysis = JSON.parse(match[0]);
  const integrated = Number(analysis.input_i);
  const truePeak = Number(analysis.input_tp);
  if (!Number.isFinite(truePeak)) throw new Error(`Invalid true peak for ${path}`);
  const probe = JSON.parse(
    command('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size:stream=codec_name,sample_rate,channels',
      '-of',
      'json',
      path,
    ]).stdout.toString(),
  );
  return {
    durationSeconds: Number(probe.format.duration),
    bytes: Number(probe.format.size),
    codec: probe.streams[0].codec_name,
    sampleRate: Number(probe.streams[0].sample_rate),
    channels: probe.streams[0].channels,
    integratedLufs: Number.isFinite(integrated) ? integrated : null,
    truePeakDbtp: truePeak,
    loudnessRangeLu: Number(analysis.input_lra),
    silenceCandidates: [...text.matchAll(/silence_(start|end): ([\d.]+)/g)].map((entry) => ({
      boundary: entry[1],
      seconds: Number(entry[2]),
    })),
  };
}
