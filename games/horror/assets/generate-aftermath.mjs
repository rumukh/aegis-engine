import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { preparePresentation } from '@aegis/render-three/presentation/node';
import { AFTERMATH_SITES, aftermathSitesModel } from './lib/aftermath-sites.mjs';

const here = dirname(fileURLToPath(import.meta.url)),
  args = process.argv.slice(2),
  options = new Map();
for (let i = 0; i < args.length; i += 2) {
  assert.ok(
    ['--scene', '--baseline', '--asset-root', '--inventory', '--contract', '--out'].includes(
      args[i],
    ) &&
      args[i + 1] &&
      !options.has(args[i]),
  );
  options.set(args[i], resolve(args[i + 1]));
}
for (const key of ['--scene', '--baseline', '--inventory', '--contract', '--out'])
  assert.ok(options.has(key));
const output = options.get('--out'),
  hash = (data) => createHash('sha256').update(data).digest('hex');
const inputSnapshots = [];
function pinnedText(label, bytes, rawSha256, lfSha256 = rawSha256) {
  const readSha256 = hash(bytes),
    normalized = hash(bytes.toString('utf8').replaceAll('\r\n', '\n'));
  assert.ok(
    readSha256 === rawSha256 || normalized === lfSha256,
    `Recorded ${label} content changed`,
  );
  inputSnapshots.push({
    label,
    recordedRawSha256: rawSha256,
    lfSha256,
    readRawSha256: readSha256,
    lineEndingBridge: readSha256 !== rawSha256,
  });
}
const sceneBytes = await readFile(options.get('--scene')),
  scene = JSON.parse(sceneBytes);
pinnedText(
  'scene',
  sceneBytes,
  'b813645272b39897cecb0dbee587412acc5bb052e3ba3de16100f4797814f660',
  'd25e8c7f285a35618c9948625874e7eb24186f62759a89717a1b803cce969e10',
);
const baselineBytes = await readFile(options.get('--baseline')),
  baseline = JSON.parse(baselineBytes);
pinnedText(
  'baseline',
  baselineBytes,
  'f7c2bd9fbb6b8f5b538124043ebf45908de941d7a9e72b9bb8baa4275004c41a',
);
if (options.has('--asset-root')) baseline.assetRoot = options.get('--asset-root');
const inventoryBytes = await readFile(options.get('--inventory')),
  inventory = JSON.parse(inventoryBytes);
pinnedText(
  'inventory',
  inventoryBytes,
  'cf108f958647514f19e3933a176abdf32612fbf672f50678d7005d9aa06d3eff',
);
assert.equal(inventory.budget.totalBytes, 49852559);
const contractBytes = await readFile(options.get('--contract')),
  contract = JSON.parse(contractBytes);
pinnedText(
  'contract',
  contractBytes,
  'b7d53f1ad3d7a5b82982521c8ad0c5b4224624691d3a79efa62737a16834251e',
);
assert.equal(
  contract.sceneSha256,
  inputSnapshots.find((input) => input.label === 'scene').recordedRawSha256,
);
assert.equal(
  contract.inventorySha256,
  inputSnapshots.find((input) => input.label === 'inventory').recordedRawSha256,
);
const prepared = preparePresentation({
  assetRoot: baseline.assetRoot,
  manifest: { aegis: 'presentation/1', assets: baseline.manifest.assets },
});
assert.equal(prepared.files.length, 75);
assert.equal(prepared.totalBytes, 53347114);
for (const file of prepared.files) assert.equal(hash(await readFile(file.source)), file.sha256);
const model = aftermathSitesModel(scene),
  geometryChecks = [];
for (const site of AFTERMATH_SITES) {
  const owner = contract.results.find((result) => result.id === site.id.replace('-aftermath', ''));
  assert.ok(owner);
  assert.deepEqual(owner.min, site.raised.min);
  assert.deepEqual(owner.max, site.raised.max);
  assert.deepEqual(owner.solid, site.solid);
  assert.deepEqual(owner.open, site.open);
  assert.equal(owner.worldHash, site.capture.worldHash);
  assert.equal(owner.tick, site.capture.tick);
  const record = {
    site: site.id,
    raisedVertices: 0,
    floorVertices: 0,
    maximumLip: 0,
    minimumProtectedDistance: Infinity,
  };
  for (const part of model.parts.values()) {
    const node = model.nodes[part.node].name;
    if (!node.startsWith(site.id)) continue;
    const floor = node.endsWith('-floor'),
      region = floor ? site.floor : site.raised;
    for (let i = 0; i < part.positions.length; i += 3) {
      const p = part.positions.slice(i, i + 3);
      for (let axis = 0; axis < 3; axis++)
        assert.ok(
          p[axis] >= region.min[axis] - 0.00001 && p[axis] <= region.max[axis] + 0.00001,
          `${site.id}/${node} exceeds approved axis${axis}: ${p}`,
        );
      const protectedBox = site.protected;
      const dx = Math.max(protectedBox.min[0] - p[0], p[0] - protectedBox.max[0], 0);
      const dz = Math.max(protectedBox.min[2] - p[2], p[2] - protectedBox.max[2], 0);
      assert.ok(dx > 0 || dz > 0, `${site.id} intersects protected control approach`);
      record.minimumProtectedDistance = Math.min(
        record.minimumProtectedDistance,
        Math.hypot(dx, dz),
      );
      if (floor) record.floorVertices++;
      else {
        record.raisedVertices++;
        const lip = (p[site.wallAxis] - site.wallPlane) * site.normal[site.wallAxis];
        record.maximumLip = Math.max(record.maximumLip, lip);
        assert.ok(lip <= 0.014 + 0.00001);
      }
    }
  }
  assert.ok(record.raisedVertices > 0 && record.floorVertices > 0);
  geometryChecks.push(record);
}
await mkdir(output);
const stats = await model.save(join(output, 'aftermath-sites.glb'));
assert.ok(
  stats.bytes < 479089,
  `New unique runtime bytes exceed strict available base headroom: ${stats.bytes}`,
);
assert.ok(stats.bytes <= 400 * 1024, 'New aftermath geometry exceeded the agreed compact target');
const newBytes = await readFile(join(output, 'aftermath-sites.glb')),
  generatedFile = { file: 'aftermath-sites.glb', bytes: newBytes.length, sha256: hash(newBytes) };
const dependencies = [];
for (const name of stats.dependencies) {
  const dependency = prepared.files.find((file) => file.path === `generated/${name}`);
  assert.ok(dependency, `Unapproved new texture/dependency: ${name}`);
  assert.ok(
    !name.startsWith('responder-contact-') && !name.startsWith('insert-'),
    `Do not reuse actor-specific maps: ${name}`,
  );
  await copyFile(dependency.source, join(output, name));
  dependencies.push({ file: name, bytes: dependency.bytes, sha256: dependency.sha256 });
}
const sources = [];
for (const file of [
  'generate-aftermath.mjs',
  'lib/aftermath-sites.mjs',
  'lib/model.mjs',
  'lib/textures.mjs',
  'source/aftermath-three.recipe.json',
]) {
  const bytes = await readFile(join(here, ...file.split('/')));
  sources.push({
    file,
    bytes: bytes.length,
    sha256: hash(bytes),
    lfSha256: hash(bytes.toString('utf8').replaceAll('\r\n', '\n')),
  });
}
const recipe = JSON.parse(
  await readFile(join(here, 'source', 'aftermath-three.recipe.json'), 'utf8'),
);
const result = {
  revision: recipe.revision,
  status: 'Environment-only handoff candidate; actual-game parent/user site review pending',
  sourceSceneSha256: inputSnapshots.find((input) => input.label === 'scene').recordedRawSha256,
  baselinePresentationSha256: inputSnapshots.find((input) => input.label === 'baseline')
    .recordedRawSha256,
  baselineInventorySha256: inputSnapshots.find((input) => input.label === 'inventory')
    .recordedRawSha256,
  ownerContractSha256: inputSnapshots.find((input) => input.label === 'contract').recordedRawSha256,
  inputSnapshots,
  baselineFiles: prepared.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  newRuntime: generatedFile,
  model: stats,
  dependencies,
  allBaselineRuntimeUnchanged: true,
  budget: {
    uniqueNewBytes: stats.bytes,
    strictHeadroomBytes: 479089,
    baseVisualBytes: 49852559 + stats.bytes,
    baseLimit: 48 * 1024 * 1024,
    allVisualIncludingEndingBytes: 51841327 + stats.bytes,
    visualLimit: 50 * 1024 * 1024,
    audioBytes: 1505787,
    audioLimit: 14 * 1024 * 1024,
    combinedFiles: 76,
    combinedBytes: 53347114 + stats.bytes,
    hardCombinedLimit: 64 * 1024 * 1024,
  },
  object: {
    id: 'aftermath-sites',
    visual: { kind: 'model', mesh: 'aftermath-sites' },
    pose: { position: [0, 0, 0] },
  },
  sites: AFTERMATH_SITES,
  details: model.features,
  geometryChecks,
  sources,
  recipe,
  requiredRemainingEvidence:
    'Verify cooked geometry against current actual facility occlusion and exact production dependency union; integrator captures one actual input-driven representative view per new site. Projection/geometry checks are not artistic acceptance.',
};
assert.ok(result.budget.baseVisualBytes < result.budget.baseLimit);
assert.ok(result.budget.allVisualIncludingEndingBytes < result.budget.visualLimit);
await writeFile(join(output, 'aftermath-provenance.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ output, newRuntime: generatedFile, model: { triangles: stats.triangles, primitives: stats.primitives, nodes: stats.nodes }, geometryChecks, budget: result.budget }, null, 2)}\n`,
);
