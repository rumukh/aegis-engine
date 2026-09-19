import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { responderModel } from './lib/responder.mjs';
import { cookInfestationTextures } from './lib/infestation.mjs';
import { cookAftermathDecals, FIRST_STRUGGLE, struggleModel } from './lib/struggle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const options = new Map(),
  args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!['--scene', '--out', '--baseline'].includes(args[i]) || !args[i + 1] || options.has(args[i]))
    throw new Error(
      'Usage: node games\\horror\\assets\\generate-horror.mjs --scene <canonical scene> --out <new prototype directory> [--baseline <accepted runtime directory>]',
    );
  options.set(args[i], resolve(args[i + 1]));
}
assert.ok(
  options.has('--scene') && options.has('--out'),
  'Scene and new isolated output directory are required',
);
const output = options.get('--out'),
  baseline = options.get('--baseline') ?? join(here, 'generated');
assert.notEqual(
  output,
  baseline,
  'Never overwrite the accepted runtime baseline with an unapproved creative prototype',
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const prior = JSON.parse(await readFile(join(baseline, 'inventory.json'), 'utf8'));
const sceneBytes = await readFile(options.get('--scene'));
assert.equal(hash(sceneBytes), 'b813645272b39897cecb0dbee587412acc5bb052e3ba3de16100f4797814f660');
assert.equal(prior.budget.totalBytes, 38117885);
assert.equal(prior.files.length, 36);
for (const file of prior.files)
  assert.equal(
    hash(await readFile(join(baseline, file.file))),
    file.sha256,
    `Accepted baseline drift: ${file.file}`,
  );
const scene = JSON.parse(sceneBytes.toString('utf8'));
await mkdir(output);
for (const file of prior.files)
  if (file.file !== 'responder.glb')
    await copyFile(join(baseline, file.file), join(output, file.file));
const newTextures = await cookInfestationTextures(output);
newTextures.push(await cookAftermathDecals(output));
const infected = responderModel({ infected: true });
const responder = await infected.save(join(output, 'responder.glb'));
const struggle = await struggleModel(scene).save(join(output, 'struggle.glb'));
const oldResponder = prior.models.find((model) => model.file === 'responder.glb');
for (let axis = 0; axis < 3; axis++) {
  assert.ok(
    responder.bounds.min[axis] >= oldResponder.bounds.min[axis] - 0.00001,
    `Infection exceeds existing negative actor bound axis${axis}`,
  );
  assert.ok(
    responder.bounds.max[axis] <= oldResponder.bounds.max[axis] + 0.00001,
    `Infection exceeds existing positive actor bound axis${axis}`,
  );
}
assert.deepEqual(
  responder.clips.map(({ name, duration }) => ({ name, duration })),
  oldResponder.clips.map(({ name, duration }) => ({ name, duration })),
);
assert.equal(responder.nodes.length, oldResponder.nodes.length);
const inventoryFiles = [
  ...new Set([
    ...prior.files.map((file) => file.file),
    'struggle.glb',
    ...newTextures.map((file) => file.file),
  ]),
].sort();
const files = [];
for (const file of inventoryFiles) {
  const bytes = await readFile(join(output, file));
  files.push({ file, bytes: bytes.length, sha256: hash(bytes) });
}
const preserved = prior.files.filter((file) => file.file !== 'responder.glb');
for (const file of preserved)
  assert.equal(files.find((entry) => entry.file === file.file).sha256, file.sha256);
const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
assert.ok(totalBytes <= 48 * 1024 * 1024, 'Preserve16MiB audio headroom within64MiB cap');
const sources = [];
for (const file of [
  'generate-horror.mjs',
  'lib/responder.mjs',
  'lib/infestation.mjs',
  'lib/struggle.mjs',
  'lib/model.mjs',
  'lib/optical-surfaces.mjs',
  'lib/textures.mjs',
  'lib/raster.mjs',
  'source/horror-pass.recipe.json',
  'source/infestation-concept.png',
]) {
  const bytes = await readFile(join(here, ...file.split('/')));
  sources.push({
    file,
    bytes: bytes.length,
    sha256: hash(bytes),
    ...(/\.(mjs|json)$/.test(file)
      ? {
          lfSha256: hash(bytes.toString('utf8').replaceAll('\r\n', '\n')),
          normalization:
            'CRLF-to-LF only; raw SHA retained, no other content or whitespace normalization',
        }
      : {}),
  });
}
const recipe = JSON.parse(await readFile(join(here, 'source', 'horror-pass.recipe.json'), 'utf8'));
const inventory = {
  ...prior,
  revision: recipe.revision,
  status: 'FIRST CREATIVE GATE PENDING; not approved for full pass or release',
  baselineInventorySha256: hash(await readFile(join(baseline, 'inventory.json'))),
  files,
  models: [
    ...prior.models.map((model) => (model.file === 'responder.glb' ? responder : model)),
    struggle,
  ],
  textures: [...prior.textures, ...newTextures],
  budget: {
    ...prior.budget,
    totalBytes,
    decodedUniqueTextureBytesWithMipmaps:
      prior.budget.decodedUniqueTextureBytesWithMipmaps +
      newTextures.reduce((sum, image) => sum + (image.width * image.height * 4 * 4) / 3, 0),
  },
  prototypeSources: sources,
  placement: { ...prior.placement, struggle: FIRST_STRUGGLE },
  intentionalAnimationDelta: {
    Idle: 'Small involuntary right-neck roll interruption at1.18..1.40s, same3.4s clip duration.',
    Stalk:
      'One small head roll interruption per cycle; exact lower-body/ankle/hip translation channels preserved.',
    Search: 'Unchanged',
    Lunge: 'Unchanged,0.8seconds/48ticks',
  },
  unrelatedRuntimeFilesPreserved: preserved,
  prototypeFeatures: infected.features,
  recipe,
  validation:
    'Source/runtime budget and bind envelope checked by cooker; verify-horror.mjs adds resolved rig/clip/optics/clearance proof. Actual-game first prototype review still required.',
};
await writeFile(join(output, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
await writeFile(
  join(output, 'prototype-provenance.json'),
  `${JSON.stringify({ recipe, sources, baseline: prior.files, outputs: files }, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({ output, files: files.length, totalBytes, preservedRuntimeFiles: preserved.length, responder: { triangles: responder.triangles, bounds: responder.bounds, clips: responder.clips }, struggle: { triangles: struggle.triangles, bounds: struggle.bounds }, status: inventory.status }, null, 2)}\n`,
);
