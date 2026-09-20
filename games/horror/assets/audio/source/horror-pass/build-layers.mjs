import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { argv, stdout } from 'node:process';
import { SAMPLE_RATE, command, decode, floatWav, measure, sha256 } from '../audio-tools.mjs';
import { assembleSparseLoop, inspectQuiet } from './sparse-loop.mjs';

const [auditionDirectory, approvalPath, archiveDirectory, destinationArgument] = argv.slice(2);
if (!auditionDirectory || !approvalPath || !archiveDirectory) {
  throw new Error(
    'Usage: node build-layers.mjs <approved-audition-dir> <approval.json> <new-master-dir> [new-delivery-root]',
  );
}
const root = destinationArgument
  ? resolve(destinationArgument)
  : resolve(import.meta.dirname, '..', '..');
const recipesPath = join(import.meta.dirname, 'layer-recipes.json');
const recipes = JSON.parse(await readFile(recipesPath, 'utf8'));
const auditionPath = join(auditionDirectory, 'audition.json');
assert.equal(await sha256(auditionPath), recipes.approvedAuditionManifestSha256);
const approval = JSON.parse(await readFile(approvalPath, 'utf8'));
assert.equal(approval.userStatement, 'SFX approved.');
assert.equal(approval.auditionManifestSha256, recipes.approvedAuditionManifestSha256);
const audition = JSON.parse(await readFile(auditionPath, 'utf8'));
const baselineVoices = JSON.parse(
  await readFile(join(import.meta.dirname, '..', '..', 'voices.json'), 'utf8'),
);
const baselineFoley = JSON.parse(
  await readFile(join(import.meta.dirname, '..', '..', 'foley.json'), 'utf8'),
);
for (const cue of [...baselineVoices.cues, ...baselineFoley.cues]) {
  assert.equal(await sha256(join(import.meta.dirname, '..', '..', cue.url)), cue.sha256, cue.id);
}
await mkdir(archiveDirectory);
await mkdir(join(root, 'runtime'), { recursive: true });
const cues = [];
for (const recipe of recipes.layers) {
  const accepted = audition.cues.find((cue) => cue.id === recipe.approvedCueId);
  assert.ok(accepted, recipe.id);
  const sourcePath = join(auditionDirectory, accepted.masterFile);
  assert.equal(await sha256(sourcePath), recipe.approvedMasterSha256);
  const source = decode(sourcePath, 1);
  assert.equal(source.length, accepted.frames);
  const assembly = assembleSparseLoop(source, SAMPLE_RATE, recipe.durationSeconds, recipe.gestures);
  const scratch = join(archiveDirectory, `${recipe.id}.wav`);
  const master = join(archiveDirectory, `${recipe.id}.flac`);
  const runtime = join(root, 'runtime', `${recipe.id}.ogg`);
  await writeFile(scratch, floatWav(assembly.samples, 1), { flag: 'wx' });
  command('ffmpeg', [
    '-v',
    'error',
    '-n',
    '-i',
    scratch,
    '-c:a',
    'flac',
    '-sample_fmt',
    's32',
    master,
  ]);
  command('ffmpeg', [
    '-v',
    'error',
    '-n',
    '-i',
    master,
    '-c:a',
    'libopus',
    '-b:a',
    '80k',
    '-application',
    'audio',
    '-frame_duration',
    '20',
    '-vbr',
    'on',
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    runtime,
  ]);
  const lossless = decode(master, 1);
  assert.equal(lossless.length, assembly.samples.length);
  let maxMasterError = 0;
  for (let index = 0; index < lossless.length; index++) {
    maxMasterError = Math.max(maxMasterError, Math.abs(lossless[index] - assembly.samples[index]));
  }
  assert.ok(maxMasterError <= 0.00000015, `${recipe.id}: master changed approved gesture`);
  const decoded = decode(runtime, 1);
  assert.equal(decoded.length, assembly.samples.length);
  const quiet = inspectQuiet(decoded, assembly.quiet, SAMPLE_RATE);
  assert.ok(
    quiet.every((interval) => interval.peak <= 0.00001),
    `${recipe.id}: codec silence leakage`,
  );
  const metrics = measure(runtime);
  assert.ok(metrics.truePeakDbtp <= -11.5, recipe.id);
  const seam = Math.abs(decoded[0] - decoded.at(-1));
  assert.ok(seam <= 0.000001, `${recipe.id}: wrap discontinuity`);
  cues.push({
    id: recipe.id,
    category: 'sparse-horror-ambience',
    description: recipe.description,
    channels: 1,
    frames: decoded.length,
    durationSeconds: recipe.durationSeconds,
    url: `runtime/${recipe.id}.ogg`,
    sha256: await sha256(runtime),
    sourceSha256: recipe.approvedMasterSha256,
    originalNativeSha256: accepted.sourceSha256,
    masterSha256: await sha256(master),
    maxMasterQuantizationError: maxMasterError,
    gestures: assembly.active.map((interval) => ({
      startSeconds: interval.startFrame / SAMPLE_RATE,
      endSeconds: interval.endFrame / SAMPLE_RATE,
      gain: interval.gain,
    })),
    authoredQuietIntervals: assembly.quiet.map((interval) => ({
      startSeconds: interval.startFrame / SAMPLE_RATE,
      endSeconds: interval.endFrame / SAMPLE_RATE,
    })),
    quietFraction: assembly.quietFraction,
    decodedQuiet: quiet,
    loop: {
      startSeconds: 0,
      endSeconds: recipe.durationSeconds,
      seamPolicy: 'digital-silence boundary',
      offlineOverlapSeconds: 0,
      decodedBoundaryStep: seam,
    },
    measured: metrics,
    layer: {
      id: recipe.id,
      asset: recipe.id,
      volume: recipe.volume,
      fadeSeconds: recipe.fadeSeconds,
      spatial: recipe.spatial,
      enabledWhen: recipe.enabledWhen,
    },
    acceptance: {
      sourceDirection: 'Human-approved audition r1',
      assembledGameMix: 'Pending integrator actual playback and listening',
    },
  });
  await rm(scratch);
}
const bytes = cues.reduce((sum, cue) => sum + cue.measured.bytes, 0);
const decodedBytes = cues.reduce((sum, cue) => sum + cue.frames * 4, 0);
assert.ok(bytes <= recipes.encodedAdditionalBytesLimit);
assert.ok(decodedBytes <= recipes.decodedAdditionalBytesLimit);
const inventory = {
  schema: 'null-meridian-audio-inventory/1',
  revision: 'approved-horror-layers-r1',
  baselineCommit: recipes.baselineCommit,
  approvedAuditionManifestSha256: recipes.approvedAuditionManifestSha256,
  approvalReceiptSha256: await sha256(approvalPath),
  recipeSha256: await sha256(recipesPath),
  sampleRate: SAMPLE_RATE,
  runtimeCodec: 'Ogg Opus',
  totalRuntimeBytes: bytes,
  decodedFloatPcmBytes: decodedBytes,
  baselineRuntimeBytes: 1325284,
  baselineDecodedFloatPcmBytes: 40557712,
  combinedRuntimeBytes: 1325284 + bytes,
  combinedDecodedFloatPcmBytes: 40557712 + decodedBytes,
  masterDirectory: resolve(archiveDirectory),
  sourceDirectory: resolve(auditionDirectory),
  mix: { headroomAlreadyInGame: 0.65, fragmentDoesNotAddMasterGain: true },
  cues,
};
await writeFile(join(root, 'horror-layers.json'), `${JSON.stringify(inventory, null, 2)}\n`, {
  flag: 'wx',
});
await writeFile(
  join(root, 'horror-layers.presentation-fragment.json'),
  `${JSON.stringify(
    {
      assets: cues.map((cue) => ({
        id: cue.id,
        kind: 'audio',
        src: `audio/${cue.url}`,
        provenance: {
          author:
            'Aegis contributors using Stable Audio 3 Small SFX; approved original project gestures',
          license:
            'Generated output under existing noncommercial model authorization. See audio/source/production-policy.json and audio/source/horror-pass/approval.json. No model weights shipped.',
          source: `Approved audition ${recipeReference(cue)}; offline sparse placement only. Runtime SHA256:${cue.sha256}`,
        },
      })),
      audio: { layers: cues.map((cue) => cue.layer) },
    },
    null,
    2,
  )}\n`,
  { flag: 'wx' },
);
stdout.write(
  `${JSON.stringify({ assets: cues.length, runtimeBytes: bytes, decodedAdditionalBytes: decodedBytes, combinedDecodedBytes: inventory.combinedDecodedFloatPcmBytes }, null, 2)}\n`,
);

function recipeReference(cue) {
  return `${cue.id}; source-master SHA256:${cue.sourceSha256}; audio/source/horror-pass/layer-recipes.json`;
}
