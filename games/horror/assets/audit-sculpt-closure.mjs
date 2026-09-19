import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const args = process.argv.slice(2),
  options = new Map();
for (let i = 0; i < args.length; i += 2) {
  assert.ok(
    [
      '--art-presentation',
      '--handoff-receipt',
      '--ending-source',
      '--node-preflight',
      '--sculpt',
      '--out',
    ].includes(args[i]) &&
      args[i + 1] &&
      !options.has(args[i]),
  );
  options.set(args[i], resolve(args[i + 1]));
}
for (const key of [
  '--art-presentation',
  '--ending-source',
  '--node-preflight',
  '--sculpt',
  '--out',
])
  assert.ok(options.has(key), `Missing ${key}`);
const output = options.get('--out'),
  sculpt = options.get('--sculpt');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const forbiddenRoot = String.raw`C:\Users\predi\.copilot\repos\aegis-engine`.toLowerCase();
function authorized(path) {
  assert.ok(
    !resolve(path).toLowerCase().startsWith(forbiddenRoot),
    'Read a frozen exported source, never the protected main checkout',
  );
  return path;
}
const { horrorPresentation: art } = await import(
  pathToFileURL(authorized(options.get('--art-presentation')))
);
const endingSourceBytes = await readFile(authorized(options.get('--ending-source')));
const ending = JSON.parse(endingSourceBytes.toString('utf8'));
const frozenInventoryBytes = await readFile(
  join(dirname(options.get('--ending-source')), 'inventory.json'),
);
const frozenInventory = JSON.parse(frozenInventoryBytes.toString('utf8'));
const handoffReceipt = options.has('--handoff-receipt')
  ? {
      path: authorized(options.get('--handoff-receipt')),
      sha256: hash(await readFile(authorized(options.get('--handoff-receipt')))),
    }
  : null;
assert.ok(
  ending.assetRoot && ending.manifest?.assets?.length,
  'Ending source must identify its real assetRoot and exact declared assets',
);
authorized(art.assetRoot);
authorized(ending.assetRoot);
const { preparePresentation } = await import(
  pathToFileURL(authorized(options.get('--node-preflight')))
);
const assetPreflight = (source) =>
  preparePresentation({
    assetRoot: source.assetRoot,
    manifest: { aegis: 'presentation/1', assets: source.manifest.assets },
  });
const artPrepared = assetPreflight(art);
const combinedSourcePrepared = preparePresentation({
  assetRoot: ending.assetRoot,
  manifest: { aegis: 'presentation/1', assets: ending.manifest.assets },
});
const closureRows = (files) =>
  files
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
assert.deepEqual(
  closureRows(combinedSourcePrepared.files),
  closureRows(frozenInventory.files),
  'Frozen combined dependency closure differs from its own SHA inventory',
);
assert.equal(combinedSourcePrepared.totalBytes, frozenInventory.totalBytes);
const endingAssets = ending.manifest.assets.filter(
  (asset) => asset.kind === 'gltf' && asset.src.endsWith('/evacuation-ending.glb'),
);
assert.ok(endingAssets.length > 0, 'Combined source has no new ending declarations');
const endingPrepared = preparePresentation({
  assetRoot: ending.assetRoot,
  manifest: { aegis: 'presentation/1', assets: endingAssets },
});
const endingModels = endingPrepared.files.filter((file) => file.path.endsWith('.glb'));
assert.ok(endingModels.length >= 1, 'No final ending model was examined');
assert.ok(
  endingModels.some((file) => file.bytes === 1988768),
  'Expected reported final1988768-byte ending model; do not audit an obsolete checkpoint',
);
const manifest = JSON.parse(JSON.stringify(art.manifest));
for (const asset of endingAssets) {
  const existing = manifest.assets.find((item) => item.id === asset.id);
  if (existing) {
    assert.equal(existing.kind, asset.kind);
    assert.equal(existing.src, asset.src, `Conflicting ending asset ${asset.id}`);
  } else manifest.assets.push(asset);
}
await mkdir(output);
const candidateRoot = join(output, 'candidate-assets');
await mkdir(candidateRoot);
const initialFiles = new Map();
for (const file of [...artPrepared.files, ...endingPrepared.files]) {
  const prior = initialFiles.get(file.path);
  if (prior) {
    assert.equal(
      prior.sha256,
      file.sha256,
      `Shared dependency differs across sources: ${file.path}`,
    );
    continue;
  }
  const bytes = await readFile(authorized(file.source));
  assert.equal(hash(bytes), file.sha256);
  const destination = join(candidateRoot, ...file.path.split('/'));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(file.source, destination);
  initialFiles.set(file.path, {
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
    source: file.source,
  });
}
const assembly = JSON.parse(await readFile(join(sculpt, 'assembly-proof.json'), 'utf8'));
const replacements = [];
for (const file of assembly.output) {
  const source = join(sculpt, file.path),
    relative = `generated/${file.path}`;
  const bytes = await readFile(source);
  assert.equal(hash(bytes), file.sha256);
  const prior = initialFiles.get(relative);
  if (relative !== 'generated/responder.glb' && !relative.startsWith('generated/insert-'))
    assert.equal(
      prior?.sha256,
      file.sha256,
      `An existing accepted dependency would change: ${relative}`,
    );
  if (prior?.sha256 !== file.sha256)
    replacements.push({
      path: relative,
      before: prior ?? null,
      after: { bytes: file.bytes, sha256: file.sha256 },
    });
  const destination = join(candidateRoot, ...relative.split('/'));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
const candidate = { assetRoot: candidateRoot, manifest };
const beforePrune = assetPreflight(candidate);
const allowedOrphans = new Set([
  'generated/colony-shell-basecolor.png',
  'generated/colony-shell-orm.png',
]);
const imageConsumers = new Map(),
  usedMaterials = [];
function textureReferences(value, into, field = '') {
  if (!value || typeof value !== 'object') return;
  if (field.endsWith('Texture') && typeof value.index === 'number') {
    into.add(value.index);
    return;
  }
  for (const [key, item] of Object.entries(value)) textureReferences(item, into, key);
}
for (const file of beforePrune.files.filter((file) => file.path.endsWith('.glb'))) {
  const bytes = await readFile(file.source);
  const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
  const materials = new Set(
    gltf.meshes
      .flatMap((mesh) => mesh.primitives.map((primitive) => primitive.material))
      .filter((index) => index !== undefined),
  );
  const tex = new Set();
  for (const index of materials) {
    textureReferences(gltf.materials[index], tex);
    usedMaterials.push({
      model: file.path,
      index,
      name: gltf.materials[index].name,
      material: gltf.materials[index],
    });
  }
  for (const index of tex) {
    const image = gltf.images[gltf.textures[index].source];
    if (!image.uri) continue;
    assert.ok(
      !image.uri.includes('..') && !image.uri.includes(':'),
      'Unexpected external/traversing image reference',
    );
    const relative = file.path.slice(0, file.path.lastIndexOf('/') + 1) + image.uri;
    if (!imageConsumers.has(relative)) imageConsumers.set(relative, []);
    imageConsumers.get(relative).push({ model: file.path, textureIndex: index });
  }
}
const declaredTextureRoots = manifest.assets
  .filter((asset) => asset.kind === 'texture')
  .map((asset) => asset.src);
const candidates = [];
for (const path of allowedOrphans) {
  const old = initialFiles.get(path);
  assert.ok(old, `No rejected-prototype preimage for ${path}`);
  const consumers = imageConsumers.get(path) ?? [];
  const direct = manifest.assets.filter((asset) => asset.src === path);
  assert.equal(consumers.length, 0, `Cannot prune used material texture: ${path}`);
  assert.equal(direct.length, 0, `Direct declaration must be reviewed before pruning: ${path}`);
  assert.ok(
    !beforePrune.files.some((file) => file.path === path),
    `Production closure still references ${path}`,
  );
  candidates.push({
    ...old,
    materialConsumers: consumers,
    directDeclarations: direct.length,
    reason:
      'Only an orphaned rejected-prototype file/catalog entry remains; no GLB used-material or presentation declaration references it.',
  });
}
const appearanceInputs = (prepared) => ({
  manifest,
  files: prepared.files
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path)),
});
const beforeAppearance = appearanceInputs(beforePrune);
for (const entry of candidates) await rm(join(candidateRoot, ...entry.path.split('/')));
const afterPrune = assetPreflight(candidate);
const afterAppearance = appearanceInputs(afterPrune);
assert.deepEqual(
  afterAppearance,
  beforeAppearance,
  'Orphan pruning altered an actual rendering/input dependency',
);
const beforeAppearanceSha = hash(JSON.stringify(beforeAppearance)),
  afterAppearanceSha = hash(JSON.stringify(afterAppearance));
assert.equal(beforeAppearanceSha, afterAppearanceSha);
const audioPaths = new Set(
  manifest.assets.filter((asset) => asset.kind === 'audio').map((asset) => asset.src),
);
const audio = afterPrune.files.filter((file) => audioPaths.has(file.path));
const visual = afterPrune.files.filter((file) => !audioPaths.has(file.path));
const visualBytes = visual.reduce((sum, file) => sum + file.bytes, 0),
  audioBytes = audio.reduce((sum, file) => sum + file.bytes, 0);
assert.equal(visualBytes + audioBytes, afterPrune.totalBytes);
assert.ok(afterPrune.totalBytes <= 64 * 1024 * 1024, 'Hard combined64MiB cap exceeded');
assert.ok(afterPrune.files.every((file) => file.bytes <= 32 * 1024 * 1024));
const endingIds = new Set(endingAssets.map((asset) => asset.id));
const basePrepared = preparePresentation({
  assetRoot: candidateRoot,
  manifest: {
    aegis: 'presentation/1',
    assets: art.manifest.assets.filter((asset) => !endingIds.has(asset.id)),
  },
});
const baseVisualBytes = basePrepared.files
  .filter((file) => !audioPaths.has(file.path))
  .reduce((sum, file) => sum + file.bytes, 0);
const baseVisualLimit = 48 * 1024 * 1024;
const visualLimit = 50 * 1024 * 1024,
  audioAllocation = 14 * 1024 * 1024;
const allocationDecision = {
  authority: 'Parent coordinator b3e4d9e1-746a-4cbe-9266-39afd91ce2e7, explicit2026-09-19 message',
  reason: 'User-added final ending legitimately changes internal planning allocation.',
  decision:
    'Combined visuals INCLUDING ending:50MiB; audio reserve:14MiB. Existing BASEartinventory<48MiB and engine64MiB hard tests remain unchanged.',
  caveat:
    'The50+14 category allocation is an explicit coordinator planning decision, not a user-specified limit and not a silent test relaxation.',
};
const report = {
  stage:
    'Actual production asset-dependency preflight before integration candidate handoff; full ending controller/binding validation remains with integrator. No style/texture recook.',
  status:
    baseVisualBytes > baseVisualLimit || visualBytes > visualLimit || audioBytes > audioAllocation
      ? 'STOP: actual used closure exceeds an explicit base/category allocation; coordinator decision required'
      : 'Actual used closure fits unchanged48MiB base guard, explicit50+14 planning allocation and64MiB hard combined cap',
  currentArt: { files: artPrepared.files.length, bytes: artPrepared.totalBytes },
  immutableCombinedSource: {
    source: options.get('--ending-source'),
    materializedSourceFileSha256: hash(endingSourceBytes),
    manifestSha256: hash(JSON.stringify(ending.manifest)),
    manifestHashSerialization:
      'JSON.stringify(parsed materialized manifest), no whitespace; distinct from a coordinator-reported source-module fingerprint',
    frozenDependencyInventorySha256: hash(frozenInventoryBytes),
    topLevelHandoffReceipt: handoffReceipt,
    totalFiles: combinedSourcePrepared.files.length,
    totalBytes: combinedSourcePrepared.totalBytes,
    newEndingDeclarations: endingAssets,
    note: 'Full parent combined source preflighted. Union overlays current isolated horror art and new sculpt without reverting it to the parent snapshot old actor. This audit proves exact file/material closure, not the ending controller or final integration bindings.',
  },
  finalEnding: {
    models: endingModels.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    closure: endingPrepared.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  },
  candidate: {
    assetRoot: candidateRoot,
    baseVisualBytes,
    baseVisualLimit,
    visualFiles: visual.length,
    visualBytes,
    audioFiles: audio.length,
    audioBytes,
    totalFiles: afterPrune.files.length,
    totalBytes: afterPrune.totalBytes,
    visualLimit,
    audioAllocation,
    visualOverage: Math.max(0, visualBytes - visualLimit),
    combinedLimit: 64 * 1024 * 1024,
  },
  allocationDecision,
  prunedOrphans: candidates,
  runtimeBytesSavedByPruning: beforePrune.totalBytes - afterPrune.totalBytes,
  removedUnusedDiskBytes: candidates.reduce((sum, file) => sum + file.bytes, 0),
  preservation: {
    beforeAppearanceDefinitionSha256: beforeAppearanceSha,
    afterAppearanceDefinitionSha256: afterAppearanceSha,
    allActualManifestAndDependencyBytesIdentical: true,
    note: 'This is an appearance-input graph hash, not a new GPU pixel capture. Orphans were already absent from runtime dependency closure. No accepted file was deleted or modified in any source workspace.',
  },
  replacements,
  declaredTextureRoots,
  usedMaterials,
  imageConsumers: [...imageConsumers].map(([path, consumers]) => ({ path, consumers })),
  visualClosure: visual.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  audioClosure: audio.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  limits:
    'No geometry repack, texture reduction, style change, rendering, operator review access or source-workspace writes were performed.',
};
await writeFile(join(output, 'used-closure-proof.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(
  join(output, 'candidate-presentation.json'),
  `${JSON.stringify(candidate, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({ proof: join(output, 'used-closure-proof.json'), status: report.status, candidate: report.candidate, pruned: candidates.map((file) => file.path), runtimeBytesSavedByPruning: report.runtimeBytesSavedByPruning, appearanceSha256: afterAppearanceSha }, null, 2)}\n`,
);
