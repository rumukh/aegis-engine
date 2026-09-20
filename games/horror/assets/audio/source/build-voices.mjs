import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { argv, execPath } from 'node:process';
import { sha256, command } from './audio-tools.mjs';

const [speechDirectory, archiveDirectory] = argv.slice(2);
if (!speechDirectory || !archiveDirectory) {
  throw new Error('Usage: node build-voices.mjs <speech-production-dir> <processed-master-dir>');
}
const report = JSON.parse(await readFile(join(speechDirectory, 'production-report.json'), 'utf8'));
const { lines } = JSON.parse(await readFile(join(import.meta.dirname, 'voice-lines.json'), 'utf8'));
if (report.decision !== 'PASS' || report.segments.length !== lines.length) {
  throw new Error(
    'Final speech must pass the unchanged production thresholds for every authored line',
  );
}
const cues = [];
for (const line of lines) {
  const segment = report.segments.find((candidate) => candidate.id === line.id);
  if (!segment || segment.text !== line.text || segment.decision !== 'PASS') {
    throw new Error(`Unverified speech line: ${line.id}`);
  }
  if ((await sha256(segment.final_path)) !== segment.final_sha256) {
    throw new Error(`Speech changed after assessment: ${line.id}`);
  }
  cues.push({
    id: line.id,
    source: `${line.id}.wav`,
    category: 'speech',
    channels: 1,
    filters: [
      ...(line.speaker === 'Station'
        ? ['highpass=f=160', 'lowpass=f=6200', 'equalizer=f=2400:width_type=q:w=0.7:g=1.2']
        : ['highpass=f=180', 'lowpass=f=5800']),
      'acompressor=threshold=0.03:ratio=3:attack=2:release=90:knee=4:makeup=1',
    ],
    targetLufs: -21,
    minimumLufs: -23,
    maxTruePeakDbtp: -6,
    bitrateKbps: 64,
    event: line.event,
    volume: 1,
    maxVoices: 1,
    voiceGroup: 'dialogue',
    cooldownTicks: 600,
    caption: { speaker: line.speaker, text: line.text },
    spatial: null,
    nativeMasterSha256: segment.raw_sha256,
    speechAssessment: {
      accuracy: segment.accuracy_score,
      fluency: segment.fluency_score,
      completeness: segment.completeness_score,
      fitFactor: segment.fit_factor,
    },
  });
}
await mkdir(archiveDirectory, { recursive: true });
const recipe = resolve(archiveDirectory, 'voice-recipes.json');
await writeFile(recipe, `${JSON.stringify({ inventoryName: 'voices', cues }, null, 2)}\n`);
command(execPath, [
  join(import.meta.dirname, 'build-audio.mjs'),
  recipe,
  resolve(speechDirectory, 'segments', 'final'),
  archiveDirectory,
]);
