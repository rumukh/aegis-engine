import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv } from 'node:process';
import { sha256 } from './audio-tools.mjs';

const [inventoryName] = argv.slice(2);
if (!['foley', 'score'].includes(inventoryName)) {
  throw new Error('Usage: node make-sound-delivery.mjs <foley|score>');
}
const root = join(import.meta.dirname, '..');
const inventory = JSON.parse(await readFile(join(root, `${inventoryName}.json`), 'utf8'));
const assets = [];
const layers = [];
const cues = [];
for (const cue of inventory.cues) {
  if ((await sha256(join(root, cue.url))) !== cue.sha256)
    throw new Error(`Changed asset ${cue.id}`);
  if (!cue.layer && !cue.bindings?.length) throw new Error(`No actual game binding for ${cue.id}`);
  if (cue.layer && !cue.loop) throw new Error(`Layer ${cue.id} has no prepared loop`);
  assets.push({
    id: cue.id,
    kind: 'audio',
    src: `audio/${cue.url}`,
    provenance: {
      author:
        inventoryName === 'score'
          ? 'Aegis contributors using ACE-Step XL-SFT'
          : 'Aegis contributors using Stable Audio 3 Small SFX',
      license:
        'Original project-generated output. Noncommercial model-use authorization and output terms in audio/source/production-policy.json; no model weights shipped.',
      source: `${cue.source}; original prompt/seed and offline edit recipe in audio/source; sha256:${cue.sha256}`,
    },
  });
  if (cue.layer) layers.push({ id: cue.id, asset: cue.id, ...cue.layer });
  for (const binding of cue.bindings ?? []) {
    cues.push({ asset: cue.id, fadeSeconds: 0.008, ...binding });
  }
}
await writeFile(
  join(root, `${inventoryName}.presentation-fragment.json`),
  `${JSON.stringify(
    {
      status: `Complete ${inventoryName}-only asset bindings. Human listening and integrated spatial balance remain acceptance gates.`,
      assetRoot: 'games/horror/assets',
      note: 'Merge assets and audio.cues/layers into presentation/1. These wrapper notes are not presentation schema. Headroom0.65 applies ONCE to the combined audio mix, not once per fragment.',
      assets,
      audio: { volume: 1, headroom: 0.65, layers, cues },
    },
    null,
    2,
  )}\n`,
);
