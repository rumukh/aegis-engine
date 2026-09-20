import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv } from 'node:process';
import { sha256 } from './audio-tools.mjs';

const [name] = argv.slice(2);
if (!['foley', 'score'].includes(name))
  throw new Error('Usage: node refresh-bindings.mjs <foley|score>');
const root = join(import.meta.dirname, '..');
const recipe = JSON.parse(
  await readFile(join(import.meta.dirname, `${name}-recipes.json`), 'utf8'),
);
const inventory = JSON.parse(await readFile(join(root, `${name}.json`), 'utf8'));
const processingKeys = [
  'source',
  'category',
  'channels',
  'filters',
  'startSeconds',
  'endSeconds',
  'loopOverlapSeconds',
  'attackSeconds',
  'releaseSeconds',
  'targetLufs',
  'maxTruePeakDbtp',
  'bitrateKbps',
];
if (inventory.cues.length !== recipe.cues.length)
  throw new Error('Recipe changed asset count; rebuild audio');
for (const cue of inventory.cues) {
  const authored = recipe.cues.find((candidate) => candidate.id === cue.id);
  if (!authored) throw new Error(`Missing recipe ${cue.id}`);
  for (const key of processingKeys) {
    if (JSON.stringify(cue[key]) !== JSON.stringify(authored[key])) {
      throw new Error(`Processing changed (${cue.id}.${key}); rebuild audio`);
    }
  }
  for (const filter of recipe.dynamics?.[cue.category] ?? []) {
    if (!cue.processingFilters.includes(filter)) throw new Error(`Dynamics changed for ${cue.id}`);
  }
  if ((await sha256(join(root, cue.url))) !== cue.sha256)
    throw new Error(`Changed audio ${cue.id}`);
  delete cue.layer;
  delete cue.bindings;
  if (authored.layer) cue.layer = authored.layer;
  if (authored.bindings) cue.bindings = authored.bindings;
}
await writeFile(join(root, `${name}.json`), `${JSON.stringify(inventory, null, 2)}\n`);
