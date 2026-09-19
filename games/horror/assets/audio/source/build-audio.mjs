import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { argv } from 'node:process';
import {
  SAMPLE_RATE,
  command,
  decode,
  crossfadeLoop,
  fadeEdges,
  floatWav,
  measure,
  sha256,
} from './audio-tools.mjs';

const [recipePath, sourceDirectory, archiveDirectory] = argv.slice(2);
if (!recipePath || !sourceDirectory || !archiveDirectory) {
  throw new Error(
    'Usage: node build-audio.mjs <recipes.json> <native-source-dir> <processed-master-dir>',
  );
}
const audioDirectory = resolve(import.meta.dirname, '..');
const runtimeDirectory = join(audioDirectory, 'runtime');
const scratchDirectory = resolve(archiveDirectory, 'scratch');
await mkdir(runtimeDirectory, { recursive: true });
await mkdir(archiveDirectory, { recursive: true });
await mkdir(scratchDirectory, { recursive: true });
const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
const inventory = [];

for (const cue of recipe.cues) {
  if (!/^[a-z0-9-]+$/.test(cue.id)) throw new Error(`Unsafe cue ID ${cue.id}`);
  const sourcePath = resolve(sourceDirectory, cue.source);
  const filters = [...(cue.filters ?? []), ...(recipe.dynamics?.[cue.category] ?? [])];
  if (cue.startSeconds !== undefined || cue.endSeconds !== undefined) {
    filters.push(
      `atrim=start=${cue.startSeconds ?? 0}${cue.endSeconds === undefined ? '' : `:end=${cue.endSeconds}`}`,
      'asetpts=PTS-STARTPTS',
    );
  }
  let samples = decode(sourcePath, cue.channels, filters);
  if (cue.endSeconds !== undefined) {
    const expected = Math.round((cue.endSeconds - (cue.startSeconds ?? 0)) * SAMPLE_RATE);
    if (Math.abs(samples.length / cue.channels - expected) > 2) {
      throw new Error(`Source does not cover the full authored edit for ${cue.id}`);
    }
  }
  if (cue.loopOverlapSeconds) {
    samples = crossfadeLoop(
      samples,
      cue.channels,
      Math.round(cue.loopOverlapSeconds * SAMPLE_RATE),
    );
  } else {
    samples = fadeEdges(
      samples,
      cue.channels,
      Math.round((cue.attackSeconds ?? 0.005) * SAMPLE_RATE),
      Math.round((cue.releaseSeconds ?? 0.04) * SAMPLE_RATE),
    );
  }
  const scratch = join(scratchDirectory, `${cue.id}.wav`);
  const master = resolve(archiveDirectory, `${cue.id}.flac`);
  const runtime = join(runtimeDirectory, `${cue.id}.ogg`);
  await writeFile(scratch, floatWav(samples, cue.channels));
  const before = measure(scratch);
  const gainDb = Math.min(
    before.integratedLufs === null ? Infinity : cue.targetLufs - before.integratedLufs,
    cue.maxTruePeakDbtp - before.truePeakDbtp,
  );
  if (!Number.isFinite(gainDb)) throw new Error(`Cannot normalize ${cue.id}`);
  command('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-i',
    scratch,
    '-af',
    `volume=${gainDb}dB`,
    '-ar',
    String(SAMPLE_RATE),
    '-c:a',
    'flac',
    '-sample_fmt',
    's32',
    master,
  ]);
  command('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-i',
    master,
    '-c:a',
    'libopus',
    '-b:a',
    `${cue.bitrateKbps ?? (cue.channels === 2 ? 112 : 64)}k`,
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
  const delivered = measure(runtime);
  if (delivered.truePeakDbtp > cue.maxTruePeakDbtp + 0.7) {
    throw new Error(`Codec true-peak overshoot on ${cue.id}: ${delivered.truePeakDbtp}`);
  }
  if (
    cue.minimumLufs !== undefined &&
    (delivered.integratedLufs === null || delivered.integratedLufs < cue.minimumLufs)
  ) {
    throw new Error(`Insufficient foreground loudness on ${cue.id}: ${delivered.integratedLufs}`);
  }
  const decoded = decode(runtime, cue.channels);
  if (Math.abs(decoded.length - samples.length) > cue.channels * 2) {
    throw new Error(`Browser codec sample count changed for ${cue.id}`);
  }
  let boundaryStep = 0;
  if (cue.loopOverlapSeconds) {
    for (let channel = 0; channel < cue.channels; channel++) {
      boundaryStep = Math.max(
        boundaryStep,
        Math.abs(decoded[channel] - decoded[decoded.length - cue.channels + channel]),
      );
    }
  }
  inventory.push({
    ...cue,
    processingFilters: filters,
    url: `runtime/${cue.id}.ogg`,
    durationSeconds: decoded.length / cue.channels / SAMPLE_RATE,
    frames: decoded.length / cue.channels,
    loop: cue.loopOverlapSeconds
      ? {
          startSeconds: 0,
          endSeconds: decoded.length / cue.channels / SAMPLE_RATE,
          offlineOverlapSeconds: cue.loopOverlapSeconds,
          decodedBoundaryStep: boundaryStep,
        }
      : null,
    sha256: await sha256(runtime),
    masterSha256: await sha256(master),
    sourceSha256: await sha256(sourcePath),
    gainDb,
    measured: delivered,
    humanListening: 'pending',
  });
  await rm(scratch);
}
const totalBytes = inventory.reduce((total, cue) => total + cue.measured.bytes, 0);
if (totalBytes > 12 * 1024 * 1024) throw new Error(`Audio runtime budget exceeded: ${totalBytes}`);
await writeFile(
  join(audioDirectory, `${recipe.inventoryName ?? 'inventory'}.json`),
  `${JSON.stringify(
    {
      schema: 'null-meridian-audio-inventory/1',
      runtimeCodec: 'Ogg Opus',
      sampleRate: SAMPLE_RATE,
      totalRuntimeBytes: totalBytes,
      masterDirectory: resolve(archiveDirectory),
      sourceDirectory: resolve(sourceDirectory),
      mix: { masterHeadroom: 0.65, noRuntimeCrossfadeForLoops: true },
      cues: inventory,
    },
    null,
    2,
  )}\n`,
);
