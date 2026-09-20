import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv } from 'node:process';
import { sha256 } from './audio-tools.mjs';

const [reportPath] = argv.slice(2);
if (!reportPath)
  throw new Error('Usage: node make-voice-delivery.mjs <runtime-speech-report.json>');
const root = join(import.meta.dirname, '..');
const inventory = JSON.parse(await readFile(join(root, 'voices.json'), 'utf8'));
const assessment = JSON.parse(await readFile(reportPath, 'utf8'));
if (assessment.decision !== 'PASS' || assessment.segments.length !== inventory.cues.length) {
  throw new Error('Every delivered voice needs passing final-runtime speech assessment');
}
for (const cue of inventory.cues) {
  const checked = assessment.segments.find((segment) => segment.id === cue.id);
  if (!checked || checked.runtimeSha256 !== cue.sha256 || checked.decision !== 'PASS') {
    throw new Error(`Missing exact runtime evidence for ${cue.id}`);
  }
  if ((await sha256(join(root, cue.url))) !== cue.sha256) {
    throw new Error(`Asset changed after final assessment: ${cue.id}`);
  }
}
const assets = inventory.cues.map((cue) => ({
  id: cue.id,
  kind: 'audio',
  src: `audio/${cue.url}`,
  provenance: {
    author: 'Aegis contributors using Azure Speech',
    license:
      'Project-generated dialogue; Azure service terms apply. See audio/source/production-policy.json.',
    source: `Original line in audio/source/voice-lines.json; sha256:${cue.sha256}`,
  },
}));
const cues = inventory.cues.map((cue) => ({
  event: cue.event,
  asset: cue.id,
  volume: cue.volume,
  cooldownTicks: cue.cooldownTicks,
  maxVoices: 1,
  voiceGroup: 'dialogue',
  fadeSeconds: 0.015,
  caption: { ...cue.caption, durationTicks: Math.ceil(cue.durationSeconds * 60) + 18 },
}));
await writeFile(
  join(root, 'voices.presentation-fragment.json'),
  `${JSON.stringify(
    {
      status:
        'Complete voice-only delivery. Score and foley are separate pending inventories, not missing references.',
      assetRoot: 'games/horror/assets',
      note: 'Merge assets and audio.cues into presentation/1; do not treat these production notes as presentation schema fields. Dialogue is centered PA/handheld; threat/foley provide world HRTF separately.',
      assets,
      audio: { volume: 1, headroom: 0.65, cues },
    },
    null,
    2,
  )}\n`,
);
