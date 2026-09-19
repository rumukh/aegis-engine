import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { argv } from 'node:process';
import { sha256 } from '../audio-tools.mjs';

const [baselinePath, auditionDirectory, resultPath] = argv.slice(2);
if (!baselinePath || !auditionDirectory || !resultPath) {
  throw new Error('Usage: node seal-audition.mjs <baseline.json> <audition-dir> <new-delta.json>');
}
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const audition = JSON.parse(await readFile(join(auditionDirectory, 'audition.json'), 'utf8'));
const producer = resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const files = [];
const sources = join(auditionDirectory, 'reproduction-source');
await mkdir(sources);
for (const entry of await readdir(import.meta.dirname, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const absolute = join(import.meta.dirname, entry.name);
  const path = relative(producer, absolute);
  const preimage = baseline.files.find((file) => file.path === path);
  assert.equal(preimage, undefined, `First audition must not overwrite baseline source:${path}`);
  const sourceSha256 = await sha256(absolute);
  await copyFile(absolute, join(sources, entry.name));
  files.push({
    path,
    operation: 'add',
    preimageSha256: null,
    sourceSha256,
    resultSha256: sourceSha256,
  });
}
for (const file of baseline.files.filter((entry) => entry.path.endsWith('.ogg'))) {
  assert.equal(await sha256(join(producer, file.path)), file.sha256, file.path);
}
const media = [];
for (const cue of [...audition.cues, { id: 'context-38s', ...audition.mix }]) {
  const actual = await sha256(join(auditionDirectory, cue.file));
  assert.equal(actual, cue.sha256, cue.id);
  media.push({
    id: cue.id,
    path: join(auditionDirectory, cue.file),
    sourceSha256: cue.sourceSha256 ?? null,
    preimageSha256: null,
    resultSha256: actual,
    durationSeconds: cue.durationSeconds,
    channels: cue.channels,
    integratedLufs: cue.metrics.integratedLufs,
    truePeakDbtp: cue.metrics.truePeakDbtp,
    scope: 'Audition-only artifact, not yet a runtime asset delta',
  });
}
await writeFile(
  resultPath,
  `${JSON.stringify(
    {
      schema: 'null-meridian-horror-audition-delta/1',
      baselineCommit: baseline.baselineCommit,
      gate: 'Awaiting parent-mediated human first-audition approval before full palette',
      sourceSnapshotDirectory: sources,
      baselineRuntimeCount: 27,
      baselineRuntimeBytes: 1325284,
      baselineRuntimeModified: false,
      runtimeDelta: [],
      sourceDelta: files,
      auditionMedia: media,
      auditionManifestSha256: await sha256(join(auditionDirectory, 'audition.json')),
      nativeSources: audition.cues.map((cue) => ({
        id: cue.nativeMetadata.id,
        path: join(audition.nativeDirectory, cue.source),
        sha256: cue.sourceSha256,
        seed: cue.nativeMetadata.seed,
        model: cue.nativeMetadata.model,
        distributionRevision: cue.nativeMetadata.distributionRevision,
      })),
      license:
        'Existing accepted Stability Community2024-07-05 / Gemma2026-04-01 noncommercial hobby/evaluation terms. No new weights, acceptance or commercial eligibility claimed.',
      bindingContract:
        'source/horror-pass/contract.json; proposed bindings only. Existing windup/catch/steps and approved voices unchanged.',
    },
    null,
    2,
  )}\n`,
  { flag: 'wx' },
);
