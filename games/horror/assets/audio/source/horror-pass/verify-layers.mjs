import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { argv } from 'node:process';
import { decode, sha256 } from '../audio-tools.mjs';
import { inspectQuiet } from './sparse-loop.mjs';

const [reportPath] = argv.slice(2);
if (!reportPath) throw new Error('Usage: node verify-layers.mjs <report.json>');
const root = resolve(import.meta.dirname, '..', '..');
const inventory = JSON.parse(await readFile(join(root, 'horror-layers.json'), 'utf8'));
const fragment = JSON.parse(
  await readFile(join(root, 'horror-layers.presentation-fragment.json'), 'utf8'),
);
const recipe = JSON.parse(await readFile(join(import.meta.dirname, 'layer-recipes.json'), 'utf8'));
assert.equal(inventory.recipeSha256, await sha256(join(import.meta.dirname, 'layer-recipes.json')));
assert.equal(
  inventory.approvalReceiptSha256,
  await sha256(join(import.meta.dirname, 'approval.json')),
);
assert.equal(
  inventory.approvedAuditionManifestSha256,
  '3d5713ca6174657dbd9ba32671f97effb435e7a347387905230392427608f5f0',
);
assert.equal(inventory.cues.length, 3);
assert.deepEqual(
  inventory.cues.map((cue) => cue.id),
  ['dread-membrane', 'dread-chitter', 'responder-breath'],
);
assert.deepEqual(
  inventory.cues.map((cue) => cue.durationSeconds),
  [37, 41, 47],
);
assert.deepEqual(
  inventory.cues.map((cue) => cue.layer.volume),
  [0.3, 0.26, 0.22],
);
assert.deepEqual(
  fragment.audio.layers.map((layer) => layer.spatial.target),
  [{ position: [4.7, 1.4, 16] }, { position: [29.6, 2.3, 16.5] }, { entity: 'responder' }],
);
assert.deepEqual(
  Object.keys(fragment.audio),
  ['layers'],
  'Do not reset master gain or replace real event cues',
);
assert.equal(fragment.assets.length, 3);
assert.equal(fragment.audio.layers.length, 3);
assert.equal(new Set(fragment.assets.map((asset) => asset.id)).size, 3);
let bytes = 0;
let pcmBytes = 0;
const verified = [];
for (const cue of inventory.cues) {
  const file = join(root, cue.url);
  assert.equal(await sha256(file), cue.sha256, cue.id);
  const source = recipe.layers.find((item) => item.id === cue.id);
  assert.equal(cue.sourceSha256, source.approvedMasterSha256);
  assert.equal(cue.channels, 1);
  assert.equal(cue.measured.sampleRate, 48000);
  assert.equal(cue.measured.codec, 'opus');
  assert.ok(cue.measured.truePeakDbtp <= -11.5, cue.id);
  assert.ok(cue.layer.volume <= 0.3);
  assert.equal(cue.layer.fadeSeconds, 0.2);
  assert.deepEqual(cue.layer.enabledWhen, {
    entity: 'player',
    component: 'HorrorStatus',
    field: 'musicPhase',
    equals: 'explore',
  });
  assert.deepEqual(
    fragment.audio.layers.find((layer) => layer.id === cue.id),
    cue.layer,
  );
  assert.equal(fragment.assets.find((asset) => asset.id === cue.id).src, `audio/${cue.url}`);
  assert.equal(cue.loop.startSeconds, 0);
  assert.equal(cue.loop.endSeconds, cue.durationSeconds);
  assert.equal(cue.loop.offlineOverlapSeconds, 0);
  assert.ok(cue.quietFraction >= 0.85);
  const pcm = decode(file, 1);
  assert.equal(pcm.length, cue.frames);
  assert.equal(pcm.length / 48000, cue.durationSeconds);
  const intervals = cue.authoredQuietIntervals.map((interval) => ({
    startFrame: Math.round(interval.startSeconds * 48000),
    endFrame: Math.round(interval.endSeconds * 48000),
  }));
  assert.ok(
    inspectQuiet(pcm, intervals, 48000).every((interval) => interval.peak <= 0.00001),
    cue.id,
  );
  assert.ok(Math.abs(pcm[0] - pcm.at(-1)) <= 0.000001);
  bytes += (await stat(file)).size;
  pcmBytes += pcm.length * 4;
  verified.push({ id: cue.id, sha256: cue.sha256, quietFraction: cue.quietFraction });
}
const baseline = [];
for (const name of ['voices', 'foley']) {
  const original = JSON.parse(await readFile(join(root, `${name}.json`), 'utf8'));
  baseline.push(...original.cues);
}
assert.equal(baseline.length, 27);
let baselineBytes = 0;
for (const cue of baseline) {
  assert.equal(await sha256(join(root, cue.url)), cue.sha256, `Unchanged ${cue.id}`);
  baselineBytes += (await stat(join(root, cue.url))).size;
}
assert.equal(baselineBytes, 1325284);
assert.equal(bytes, inventory.totalRuntimeBytes);
assert.ok(bytes <= 1048576);
assert.equal(pcmBytes, 24000000);
assert.equal(inventory.combinedDecodedFloatPcmBytes, 64557712);
await writeFile(
  reportPath,
  `${JSON.stringify(
    {
      decision: 'PASS',
      approvedSourceGestures: 3,
      runtimeLayers: 3,
      additionalRuntimeBytes: bytes,
      additionalDecodedFloatPcmBytes: pcmBytes,
      combinedRuntimeBytes: baselineBytes + bytes,
      combinedDecodedFloatPcmBytes: 64557712,
      unchangedBaselineAssets: 27,
      fullGameOrAestheticAcceptance: false,
      verified,
    },
    null,
    2,
  )}\n`,
);
