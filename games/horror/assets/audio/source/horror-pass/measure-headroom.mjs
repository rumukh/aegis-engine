import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { argv } from 'node:process';
import { decode, floatWav, command, measure, sha256 } from '../audio-tools.mjs';

const [newOutputDirectory] = argv.slice(2);
if (!newOutputDirectory) throw new Error('Usage: node measure-headroom.mjs <new-output-directory>');
await mkdir(newOutputDirectory);
const root = resolve(import.meta.dirname, '..', '..');
const inventories = await Promise.all(
  ['voices', 'foley', 'horror-layers'].map(async (name) =>
    JSON.parse(await readFile(join(root, `${name}.json`), 'utf8')),
  ),
);
const cues = inventories.flatMap((inventory) => inventory.cues);
const voices = inventories[0].cues;
const worstVoice = voices.reduce((worst, cue) =>
  cue.measured.truePeakDbtp > worst.measured.truePeakDbtp ? cue : worst,
);
const selection = [
  {
    id: worstVoice.id,
    volume: 1,
    reason: 'Loudest approved dialogue peak; dialogue group is monophonic',
  },
  {
    id: 'threat-alert',
    volume: 0.65,
    reason: 'Actual baseline warning cue at its declared warning gain',
  },
  { id: 'amb-room', volume: 0.6, reason: 'Existing room bed, unattenuated' },
  { id: 'amb-vent', volume: 0.45, reason: 'Existing power vent, unattenuated' },
  { id: 'amb-hull', volume: 0.6, reason: 'Existing hull layer, unattenuated' },
  ...inventories[2].cues.map((cue) => ({
    id: cue.id,
    volume: cue.layer.volume,
    reason:
      'Approved new layer, unattenuated even though spatially separated and disabled outside exploration',
  })),
];
let linearTruePeakSum = 0;
const tracks = [];
const mix = new Float32Array(12 * 48000);
for (const entry of selection) {
  const cue = cues.find((item) => item.id === entry.id);
  assert.ok(cue);
  const path = join(root, cue.url);
  assert.equal(await sha256(path), cue.sha256);
  const pcm = decode(path, 1);
  let peakIndex = 0;
  for (let index = 1; index < pcm.length; index++) {
    if (Math.abs(pcm[index]) > Math.abs(pcm[peakIndex])) peakIndex = index;
  }
  const peakBound = 10 ** (cue.measured.truePeakDbtp / 20) * entry.volume;
  linearTruePeakSum += peakBound;
  const offset = 4 * 48000 - peakIndex;
  for (let frame = 0; frame < pcm.length; frame++) {
    if (frame + offset < 0 || frame + offset >= mix.length) continue;
    mix[frame + offset] += pcm[frame] * entry.volume * 0.65;
  }
  tracks.push({
    ...entry,
    sha256: cue.sha256,
    peakBoundBeforeMaster: peakBound,
    alignedOriginalPeakSeconds: peakIndex / 48000,
  });
}
const afterMasterPeakBound = linearTruePeakSum * 0.65;
assert.ok(
  afterMasterPeakBound < 0.9,
  'Simultaneous dialogue/warning/new-layer/ambient peak bound lacks headroom',
);
const wav = join(newOutputDirectory, 'peak-aligned-stress.wav');
const flac = join(newOutputDirectory, 'peak-aligned-stress.flac');
await writeFile(wav, floatWav(mix, 1), { flag: 'wx' });
command('ffmpeg', ['-v', 'error', '-n', '-i', wav, '-c:a', 'flac', '-sample_fmt', 's32', flac]);
const metrics = measure(flac);
assert.ok(metrics.truePeakDbtp < -1);
await writeFile(
  join(newOutputDirectory, 'headroom.json'),
  `${JSON.stringify(
    {
      decision: 'PASS for the explicitly bounded overlap set, not whole-game mix acceptance',
      scope:
        'Conservative sum of measured true-peak amplitudes of all3 new layers, all3 existing ambient beds, loudest monophonic dialogue and actual warning. All emitters are treated as unattenuated; all peaks may coincide.',
      excluded:
        'Other simultaneous gameplay one-shots, repeated voices, HRTF filter overshoot and the actual engine scheduler. Integrator must capture real clue/warning/steps and transitions. This is not proof of intelligibility.',
      tracks,
      headroomAppliedOnce: 0.65,
      afterMasterPeakBound,
      afterMasterPeakBoundDbfs: 20 * Math.log10(afterMasterPeakBound),
      peakAlignedExample: {
        sha256: await sha256(flac),
        file: flac,
        metrics,
        normalizationAfterMix: false,
        phaseOrPitchChanges: false,
      },
      realSpatialEngineAcceptance: 'pending',
    },
    null,
    2,
  )}\n`,
);
