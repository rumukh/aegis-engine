import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { join, resolve, relative, dirname } from 'node:path';
import { argv } from 'node:process';
import { sha256 } from '../audio-tools.mjs';

const [baselinePath, auditionDirectory, outputDirectory, reportDirectory] = argv.slice(2);
if (!baselinePath || !auditionDirectory || !outputDirectory || !reportDirectory) {
  throw new Error(
    'Usage: node seal-layers.mjs <baseline.json> <approved-audition-dir> <new-package-dir> <qa-artifact-dir>',
  );
}
const root = resolve(import.meta.dirname, '..', '..');
const repository = resolve(root, '..', '..', '..', '..');
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const inventory = JSON.parse(await readFile(join(root, 'horror-layers.json'), 'utf8'));
const audition = JSON.parse(await readFile(join(auditionDirectory, 'audition.json'), 'utf8'));
assert.equal(
  await sha256(join(auditionDirectory, 'audition.json')),
  inventory.approvedAuditionManifestSha256,
);
for (const file of baseline.files.filter((entry) => entry.path.endsWith('.ogg'))) {
  assert.equal(await sha256(join(repository, file.path)), file.sha256, file.path);
}
const sourcePaths = [];
for (const entry of await readdir(import.meta.dirname, { withFileTypes: true })) {
  if (entry.isFile()) sourcePaths.push(join(import.meta.dirname, entry.name));
}
const paths = [
  ...sourcePaths,
  join(root, 'horror-layers.json'),
  join(root, 'horror-layers.presentation-fragment.json'),
  ...inventory.cues.map((cue) => join(root, cue.url)),
];
await mkdir(outputDirectory);
const delta = [];
for (const source of paths) {
  const path = relative(repository, source);
  assert.equal(
    baseline.files.find((file) => file.path === path),
    undefined,
    `Refusing baseline overwrite ${path}`,
  );
  const target = join(outputDirectory, 'payload', path);
  const sourceSha256 = await sha256(source);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  assert.equal(await sha256(target), sourceSha256);
  assert.equal(await sha256(source), sourceSha256, `Concurrent source write ${path}`);
  delta.push({
    path,
    operation: 'add',
    bytes: (await stat(target)).size,
    preimageSha256: null,
    sourceSha256,
    resultSha256: sourceSha256,
  });
}
const production = [];
async function archive(source, path) {
  const target = join(outputDirectory, 'production', path);
  await mkdir(dirname(target), { recursive: true });
  const digest = await sha256(source);
  await copyFile(source, target);
  assert.equal(await sha256(target), digest);
  production.push({
    path: join('production', path),
    sha256: digest,
    bytes: (await stat(target)).size,
  });
}
await archive(join(auditionDirectory, 'audition.json'), join('approved-audition', 'audition.json'));
await archive(
  join(auditionDirectory, 'context-38s.flac'),
  join('approved-audition', 'context-38s.flac'),
);
for (const approved of audition.cues) {
  await archive(
    join(auditionDirectory, approved.masterFile),
    join('approved-audition', approved.masterFile),
  );
  await archive(join(auditionDirectory, approved.file), join('approved-audition', approved.file));
  await archive(
    join(audition.nativeDirectory, approved.source),
    join('native-sources', approved.source),
  );
  await archive(
    join(audition.nativeDirectory, approved.source.replace(/\.wav$/, '.json')),
    join('native-sources', approved.source.replace(/\.wav$/, '.json')),
  );
}
for (const cue of inventory.cues) {
  await archive(
    join(inventory.masterDirectory, `${cue.id}.flac`),
    join('assembled-masters', `${cue.id}.flac`),
  );
}
for (const name of ['horror-layer-integrity-r1.json', 'horror-layer-browser-r1.json']) {
  await archive(join(reportDirectory, name), join('qa', name));
}
await archive(
  join(reportDirectory, 'horror-layer-headroom-r1', 'headroom.json'),
  join('qa', 'headroom.json'),
);
await archive(
  join(reportDirectory, 'horror-layer-headroom-r1', 'peak-aligned-stress.flac'),
  join('qa', 'peak-aligned-stress.flac'),
);
await writeFile(
  join(outputDirectory, 'delta.json'),
  `${JSON.stringify(
    {
      schema: 'null-meridian-horror-layer-delta/1',
      baselineCommit: baseline.baselineCommit,
      revision: inventory.revision,
      approvedAuditionManifestSha256: inventory.approvedAuditionManifestSha256,
      approvalReceiptNormalizedSha256: inventory.approvalReceiptSha256,
      approvalReceiptOriginalSha256:
        '857cd22cd8cae41d64690c53e0014c1a2b4a02d1d384b34b3c4489fa6f184177',
      receiptNote:
        'Stored approval JSON is whitespace-normalized; original durable parent receipt and approved manifest remain unchanged.',
      files: delta,
      productionArchive: production,
      unchangedBaselineRuntime: baseline.files.filter((file) => file.path.endsWith('.ogg')),
      additionalRuntimeBytes: inventory.totalRuntimeBytes,
      additionalDecodedFloatPcmBytes: inventory.decodedFloatPcmBytes,
      combinedRuntimeBytes: inventory.combinedRuntimeBytes,
      combinedDecodedFloatPcmBytes: inventory.combinedDecodedFloatPcmBytes,
      integration:
        'Apply only payload files after verifying absent preimages. Merge assets and audio.layers from horror-layers.presentation-fragment.json; do not replace existing audio cues or master0.65 gain. No new events/entities or musical score.',
      reproduction:
        'Apply payload to baseline repository, then run source/horror-pass/build-layers.mjs with production/approved-audition, source/horror-pass/approval.json, a new lossless output directory and optional new output root. It refuses existing output files. Native generation is not required or authorized.',
      evidence:
        'Exact source preservation,3 repeatable lossless+Opus assemblies,30 actual Chromium decodes, authored/decoded silence, bounded peaks and explicit conservative overlap-set headroom. This does not prove actual game masking, spatial behavior, pause/restart/unlock/mute or warning acceptance.',
      pendingAcceptance:
        'Integrator actual playback and recorded master evidence, then final human mix review.',
    },
    null,
    2,
  )}\n`,
  { flag: 'wx' },
);
