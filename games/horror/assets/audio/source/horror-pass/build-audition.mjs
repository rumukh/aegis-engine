import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { argv } from 'node:process';
import assert from 'node:assert/strict';
import {
  SAMPLE_RATE,
  command,
  decode,
  fadeEdges,
  floatWav,
  measure,
  sha256,
} from '../audio-tools.mjs';

const [nativeDirectory, outputDirectory, editPath] = argv.slice(2);
if (!nativeDirectory || !outputDirectory || !editPath) {
  throw new Error('Usage: node build-audition.mjs <native-dir> <new-output-dir> <edits.json>');
}
const baseline = resolve(import.meta.dirname, '..', '..', 'runtime');
const edits = JSON.parse(await readFile(editPath, 'utf8'));
assert.equal(edits.cues.length, 3, 'First gate contains exactly three representative cues');
await mkdir(outputDirectory);
const cues = [];
for (const edit of edits.cues) {
  const native = join(nativeDirectory, edit.source);
  const metadata = JSON.parse(await readFile(native.replace(/\.wav$/, '.json'), 'utf8'));
  assert.equal(await sha256(native), metadata.sha256, edit.id);
  const filtered = decode(native, 1, [
    `atrim=start=${edit.startSeconds}:end=${edit.endSeconds}`,
    'asetpts=PTS-STARTPTS',
    'highpass=f=85',
    'lowpass=f=7400',
    'acompressor=threshold=0.04:ratio=2:attack=6:release=180:knee=3:makeup=1',
  ]);
  assert.equal(filtered.length, Math.round((edit.endSeconds - edit.startSeconds) * SAMPLE_RATE));
  const samples = fadeEdges(
    filtered,
    1,
    Math.round(edit.attackSeconds * SAMPLE_RATE),
    Math.round(edit.releaseSeconds * SAMPLE_RATE),
  );
  const scratch = join(outputDirectory, `${edit.id}.wav`);
  const master = join(outputDirectory, `${edit.id}.flac`);
  const opus = join(outputDirectory, `${edit.id}.ogg`);
  await writeFile(scratch, floatWav(samples, 1));
  const before = measure(scratch);
  assert.ok(before.integratedLufs !== null, edit.id);
  const gainDb = Math.min(edit.targetLufs - before.integratedLufs, -12 - before.truePeakDbtp);
  command('ffmpeg', [
    '-v',
    'error',
    '-i',
    scratch,
    '-af',
    `volume=${gainDb}dB`,
    '-c:a',
    'flac',
    '-sample_fmt',
    's32',
    master,
  ]);
  command('ffmpeg', [
    '-v',
    'error',
    '-i',
    master,
    '-c:a',
    'libopus',
    '-b:a',
    '80k',
    '-application',
    'audio',
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    opus,
  ]);
  const metrics = measure(opus);
  assert.ok(metrics.truePeakDbtp <= -11.5, edit.id);
  const decoded = decode(opus, 1);
  assert.equal(decoded.length, samples.length, edit.id);
  cues.push({
    ...edit,
    sourceSha256: metadata.sha256,
    nativeMetadata: metadata,
    gainDb,
    masterSha256: await sha256(master),
    sha256: await sha256(opus),
    file: `${edit.id}.ogg`,
    masterFile: `${edit.id}.flac`,
    channels: 1,
    frames: decoded.length,
    durationSeconds: decoded.length / SAMPLE_RATE,
    metrics,
    humanDirection: 'pending',
  });
}
const mixFrames = 38 * SAMPLE_RATE;
const mixed = new Float32Array(mixFrames * 2);
const tracks = [
  {
    id: 'amb-room',
    file: join(baseline, 'amb-room.ogg'),
    channels: 2,
    start: 0,
    duration: 38,
    gain: 0.6,
    loop: true,
    attack: 0.8,
    release: 1.2,
  },
  {
    id: cues[0].id,
    file: join(outputDirectory, cues[0].file),
    channels: 1,
    start: 5,
    gain: cues[0].proposedLayerGain,
    pan: -0.55,
  },
  {
    id: 'vo-recorder',
    file: join(baseline, 'vo-recorder.ogg'),
    channels: 1,
    start: 11,
    gain: 1,
    pan: 0,
  },
  {
    id: cues[1].id,
    file: join(outputDirectory, cues[1].file),
    channels: 1,
    start: 14.3,
    gain: cues[1].proposedLayerGain,
    pan: 0.55,
  },
  {
    id: cues[2].id,
    file: join(outputDirectory, cues[2].file),
    channels: 1,
    start: 29,
    gain: cues[2].proposedLayerGain,
    pan: -0.2,
  },
];
for (const track of tracks) {
  const source = decode(track.file, track.channels);
  const sourceFrames = source.length / track.channels;
  const frames = track.duration ? Math.round(track.duration * SAMPLE_RATE) : sourceFrames;
  const start = Math.round(track.start * SAMPLE_RATE);
  for (let frame = 0; frame < frames; frame++) {
    if (start + frame >= mixFrames) break;
    const sourceFrame = track.loop ? frame % sourceFrames : frame;
    const fade = Math.min(
      1,
      track.attack ? frame / (track.attack * SAMPLE_RATE) : 1,
      track.release ? (frames - frame - 1) / (track.release * SAMPLE_RATE) : 1,
    );
    for (let channel = 0; channel < 2; channel++) {
      const panGain =
        track.channels === 1 ? Math.sqrt((channel === 0 ? 1 - track.pan : 1 + track.pan) / 2) : 1;
      mixed[(start + frame) * 2 + channel] +=
        source[sourceFrame * track.channels + (channel % track.channels)] *
        track.gain *
        0.65 *
        fade *
        panGain;
    }
  }
}
let peak = 0;
for (const value of mixed) peak = Math.max(peak, Math.abs(value));
assert.ok(peak < 0.7, 'No after-mix normalizer or limiter may conceal gain mistakes');
const mixWav = join(outputDirectory, 'context-38s.wav');
const mixFlac = join(outputDirectory, 'context-38s.flac');
await writeFile(mixWav, floatWav(mixed, 2));
command('ffmpeg', ['-v', 'error', '-i', mixWav, '-c:a', 'flac', '-sample_fmt', 's32', mixFlac]);
const mixMetrics = measure(mixFlac);
assert.ok(mixMetrics.truePeakDbtp < -3);
const mix = {
  file: 'context-38s.flac',
  channels: 2,
  frames: mixFrames,
  durationSeconds: 38,
  sha256: await sha256(mixFlac),
  metrics: mixMetrics,
  peak,
  masterHeadroom: 0.65,
  finalGainNormalization: false,
  tracks: await Promise.all(
    tracks.map(async (track) => ({ ...track, sha256: await sha256(track.file) })),
  ),
  scope:
    'Constructed contextual audition using unchanged room and approved recorder line; fixed equal-power pan, NOT game HRTF, distance, threat response or real playback acceptance. Quiet chitter at14.3s intentionally overlaps the clue as a listening test, not an authored game event. Silence separates the other gestures.',
};
const manifest = {
  schema: 'null-meridian-horror-audition/1',
  gate: 'Parent-mediated human sound-direction approval pending',
  baselineCommit: '5e9cdcdbcafc14ada77002322886408c33945890',
  nativeDirectory: resolve(nativeDirectory),
  outputDirectory: resolve(outputDirectory),
  cues,
  mix,
  reviewSequence: ['dread-membrane', 'dread-chitter', 'responder-breath', 'context-38s'],
  unchanged:
    'All27 baseline runtime files and casting. No score, no new gameplay event or authoritative anchor.',
};
await writeFile(join(outputDirectory, 'audition.json'), `${JSON.stringify(manifest, null, 2)}\n`);
