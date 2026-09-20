import { readFile, writeFile, mkdir, copyFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { argv } from 'node:process';
import { sha256 } from './audio-tools.mjs';

const [name, destination] = argv.slice(2);
if (!['voices', 'foley', 'score'].includes(name) || !destination) {
  throw new Error('Usage: node freeze-delivery.mjs <voices|foley|score> <new-snapshot-directory>');
}
const root = resolve(import.meta.dirname, '..');
const target = resolve(destination);
const inventory = JSON.parse(await readFile(join(root, `${name}.json`), 'utf8'));
for (const cue of inventory.cues) {
  if ((await sha256(join(root, cue.url))) !== cue.sha256)
    throw new Error(`Changed asset ${cue.id}`);
}
await mkdir(target);
await mkdir(join(target, 'runtime'));
const files = [];
for (const cue of inventory.cues) {
  await copyFile(join(root, cue.url), join(target, cue.url));
  files.push({ path: cue.url, sha256: cue.sha256 });
}
for (const path of [`${name}.json`, `${name}.presentation-fragment.json`]) {
  await copyFile(join(root, path), join(target, path));
  files.push({ path, sha256: await sha256(join(target, path)) });
}
await cp(join(root, 'source'), join(target, 'source'), { recursive: true, errorOnExist: true });
await writeFile(
  join(target, 'delivery.json'),
  `${JSON.stringify(
    {
      schema: 'null-meridian-audio-delivery/1',
      subset: name,
      status:
        'Complete physical asset subset and proposed bindings. Sound-direction and integrated-game acceptance are separate human gates.',
      files,
      runtimeBytes: inventory.totalRuntimeBytes,
      sourceToolsIncluded: true,
      noMissingAssetReferences: true,
    },
    null,
    2,
  )}\n`,
);
