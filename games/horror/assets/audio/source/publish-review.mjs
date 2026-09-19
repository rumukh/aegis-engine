import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { argv } from 'node:process';

const [reviewDirectory, ...inventoryPaths] = argv.slice(2);
if (!reviewDirectory || !inventoryPaths.length) {
  throw new Error('Usage: node publish-review.mjs <review-artifact-dir> <inventory.json> ...');
}
const items = [];
for (const path of inventoryPaths) {
  const inventory = JSON.parse(await readFile(path, 'utf8'));
  if (Array.isArray(inventory.reviewItems)) {
    items.push(...inventory.reviewItems);
    continue;
  }
  if (!Array.isArray(inventory.cues)) throw new Error(`Unrecognized review input ${path}`);
  for (const cue of inventory.cues) {
    items.push({
      id: `${cue.id}-${cue.sha256.slice(0, 12)}`,
      title: cue.id,
      status:
        cue.category === 'speech'
          ? 'Approved casting / final processed line for mix review'
          : 'Original generated audio / listening review',
      voice: cue.caption?.speaker ?? cue.category,
      text: cue.caption?.text ?? cue.description ?? cue.id,
      path: resolve(join(import.meta.dirname, '..', cue.url)),
      note: `${cue.durationSeconds.toFixed(3)} seconds; ${cue.measured.integratedLufs ?? 'below measurement gate'} LUFS; ${cue.measured.truePeakDbtp} dBTP before engine gain. ${cue.loop ? 'Seamless offline overlap loop.' : 'One-shot.'} SHA256 ${cue.sha256}. Metrics are not human listening.`,
    });
  }
}
await writeFile(
  resolve(reviewDirectory, 'review-items.json'),
  `${JSON.stringify(items, null, 2)}\n`,
);
