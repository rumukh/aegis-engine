import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { argv } from 'node:process';
import { decode, SAMPLE_RATE, floatWav, measure, sha256, command } from './audio-tools.mjs';

const [outputDirectory, scoreFlag] = argv.slice(2);
if (!outputDirectory || (scoreFlag !== undefined && scoreFlag !== '--score')) {
  throw new Error('Usage: node render-review-mix.mjs <existing-review-dir> [--score]');
}
const root = resolve(import.meta.dirname, '..');
const inventories = ['voices', 'foley', ...(scoreFlag ? ['score'] : [])];
const cues = new Map();
for (const name of inventories) {
  const inventory = JSON.parse(await readFile(join(root, `${name}.json`), 'utf8'));
  for (const cue of inventory.cues) {
    if ((await sha256(join(root, cue.url))) !== cue.sha256)
      throw new Error(`Changed cue ${cue.id}`);
    cues.set(cue.id, cue);
  }
}
const seconds = 51;
const samples = new Float32Array(seconds * SAMPLE_RATE * 2);
const tracks = [
  { id: 'amb-room', at: 0, duration: 51, volume: 0.6, loop: true, attack: 0.5, release: 1 },
  { id: 'amb-hull', at: 0, duration: 51, volume: 0.6, loop: true, attack: 0.5, release: 1 },
  { id: 'vo-arrival', at: 1, volume: 1 },
  { id: 'threat-search', at: 13.3, volume: 0.85 },
  { id: 'threat-alert', at: 17.5, volume: 0.85 },
  { id: 'power-rise', at: 20, volume: 0.65 },
  { id: 'vo-power', at: 20, volume: 1 },
  { id: 'amb-vent', at: 20, duration: 31, volume: 0.45, loop: true, attack: 3, release: 1 },
  { id: 'vo-recorder', at: 27, volume: 1 },
  { id: 'recorder-handle', at: 27, volume: 0.5 },
  { id: 'airlock-seal', at: 36.5, volume: 0.7 },
  { id: 'vo-exit', at: 37, volume: 1 },
];
for (let step = 0; step < 6; step++) {
  tracks.push({ id: `boots-metal-0${(step % 4) + 1}`, at: 7 + step * 1.2, volume: 0.55 });
}
for (let step = 0; step < 4; step++) {
  tracks.push({ id: `threat-step-0${(step % 3) + 1}`, at: 13 + step * 1.3, volume: 0.85 });
}
if (scoreFlag)
  tracks.push(
    { id: 'score-explore', at: 0, duration: 51, volume: 0.6, loop: true, attack: 2, release: 2 },
    { id: 'score-threat', at: 12, duration: 9, volume: 0.45, loop: true, attack: 2, release: 2 },
    { id: 'score-escape', at: 36, duration: 15, volume: 0.5, loop: true, attack: 2, release: 2 },
  );
for (const track of tracks) {
  const cue = cues.get(track.id);
  if (!cue) throw new Error(`Missing actual source ${track.id}`);
  const audio = decode(join(root, cue.url), cue.channels);
  const sourceFrames = audio.length / cue.channels;
  const frames = track.duration ? Math.round(track.duration * SAMPLE_RATE) : sourceFrames;
  const offset = Math.round(track.at * SAMPLE_RATE);
  for (let frame = 0; frame < frames && offset + frame < samples.length / 2; frame++) {
    if (!track.loop && frame >= sourceFrames) break;
    const index = track.loop ? frame % sourceFrames : frame;
    const attack = track.attack ? Math.min(1, frame / (track.attack * SAMPLE_RATE)) : 1;
    const release = track.release
      ? Math.min(1, (frames - frame - 1) / (track.release * SAMPLE_RATE))
      : 1;
    const gain = track.volume * Math.min(attack, release) * 0.65;
    for (let channel = 0; channel < 2; channel++) {
      samples[(offset + frame) * 2 + channel] +=
        audio[index * cue.channels + (channel % cue.channels)] * gain;
    }
  }
}
let peak = 0;
for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
if (peak >= 0.85) throw new Error(`Authored gain-only mix exceeds review headroom: ${peak}`);
const base = scoreFlag ? 'gain-review-with-score' : 'gain-review-voice-foley';
const wav = join(outputDirectory, `${base}.wav`);
const flac = join(outputDirectory, `${base}.flac`);
await writeFile(wav, floatWav(samples, 2));
command('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-c:a', 'flac', '-sample_fmt', 's32', flac]);
const metrics = measure(flac);
if (metrics.truePeakDbtp >= -1)
  throw new Error(`Inter-sample peak too high: ${metrics.truePeakDbtp}`);
const digest = await sha256(flac);
await writeFile(
  join(outputDirectory, `${base}.json`),
  `${JSON.stringify(
    {
      scope:
        'Gain-only unattenuated assembly, NOT recorded gameplay, HRTF, listener orientation or final mix acceptance.',
      sourceInventoryNames: inventories,
      tracks,
      headroomAppliedOnce: 0.65,
      normalizationAfterMix: false,
      peak,
      metrics,
      sha256: digest,
      reviewItems: [
        {
          id: `${base}-${digest.slice(0, 12)}`,
          title: 'Gain-only assembly: air, steps, threat, power, speech, extraction',
          status: 'Listening reference only / not gameplay or spatial acceptance',
          voice: 'Approved voices and generated foley at proposed engine gains',
          text: '51-second condensed assembly. All mono emitters are centered and unattenuated here; the game adds listener-relative HRTF and distance. No normalization after the shared 0.65 headroom gain.',
          path: flac,
          note: `Measured ${metrics.integratedLufs} LUFS, ${metrics.truePeakDbtp} dBTP. No score is present unless the title/file explicitly says with-score. Human review must judge intelligibility and mechanical character.`,
        },
      ],
    },
    null,
    2,
  )}\n`,
);
