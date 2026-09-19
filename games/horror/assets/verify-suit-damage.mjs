import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { Ray, Vector3 } from 'three';
import { preparePresentation } from '@aegis/render-three/presentation/node';

const options = new Map(),
  args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(
    ['--candidate', '--baseline', '--closure', '--out'].includes(args[i]) &&
      args[i + 1] &&
      !options.has(args[i]),
  );
  options.set(args[i], resolve(args[i + 1]));
}
for (const key of ['--candidate', '--baseline', '--closure', '--out']) assert.ok(options.has(key));
const candidate = options.get('--candidate'),
  baseline = options.get('--baseline'),
  output = options.get('--out');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const proof = JSON.parse(await readFile(join(candidate, 'damage-proof.json'), 'utf8'));
async function glb(path) {
  const bytes = await readFile(path),
    length = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.toString('utf8', 20, 20 + length)),
    binary = bytes.subarray(28 + length);
  function read(index) {
    const a = doc.accessors[index],
      view = doc.bufferViews[a.bufferView],
      size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type],
      width = a.componentType === 5123 ? 2 : 4;
    return Array.from({ length: a.count * size }, (_, i) => {
      const at =
        (view.byteOffset ?? 0) +
        (a.byteOffset ?? 0) +
        Math.floor(i / size) * (view.byteStride ?? size * width) +
        (i % size) * width;
      return a.componentType === 5126
        ? binary.readFloatLE(at)
        : a.componentType === 5123
          ? binary.readUInt16LE(at)
          : binary.readUInt32LE(at);
    });
  }
  return { bytes, doc, binary, read };
}
const old = await glb(join(baseline, 'responder.glb')),
  current = await glb(join(candidate, 'responder.glb'));
assert.equal(hash(old.bytes), proof.input.sha256);
assert.equal(hash(current.bytes), proof.model.sha256);
assert.ok(current.binary.subarray(0, old.binary.length).equals(old.binary));
assert.deepEqual(current.doc.nodes, old.doc.nodes);
assert.deepEqual(current.doc.animations, old.doc.animations);
assert.deepEqual(current.doc.materials.slice(0, old.doc.materials.length), old.doc.materials);
assert.deepEqual(current.doc.images.slice(0, old.doc.images.length), old.doc.images);
const permitted = new Set(proof.edits.map((edit) => `${edit.node}/${edit.material}`));
assert.deepEqual([...permitted].sort(), [
  'elbow-left/suit-shell',
  'shoulder-left/suit-shell',
  'shoulder-right/suit-textile',
  'thorax/suit-shell',
]);
let preserved = 0;
for (const node of old.doc.nodes) {
  if (node.mesh === undefined) continue;
  const now = current.doc.meshes[current.doc.nodes.find((n) => n.name === node.name).mesh];
  for (const part of old.doc.meshes[node.mesh].primitives) {
    const name = old.doc.materials[part.material].name;
    if (permitted.has(`${node.name}/${name}`)) continue;
    assert.ok(
      now.primitives.some((p) => JSON.stringify(p) === JSON.stringify(part)),
      `Unrelated primitive changed: ${node.name}/${name}`,
    );
    preserved++;
  }
}
for (const image of old.doc.images)
  assert.equal(
    hash(await readFile(join(candidate, image.uri))),
    hash(await readFile(join(baseline, image.uri))),
    `Existing texture altered: ${image.uri}`,
  );
assert.equal(current.doc.images.length - old.doc.images.length, 2);
const holeProbes = [];
for (const edit of proof.edits) {
  const node = current.doc.nodes.find((node) => node.name === edit.node);
  const ray = new Ray(
    new Vector3(edit.authorizedRegion.center[0], edit.authorizedRegion.center[1], 1),
    new Vector3(0, 0, -1),
  );
  let nearest = null;
  for (const part of current.doc.meshes[node.mesh].primitives) {
    const material = current.doc.materials[part.material];
    if (material.alphaMode === 'BLEND') continue;
    const positions = current.read(part.attributes.POSITION),
      indices = current.read(part.indices);
    for (let i = 0; i < indices.length; i += 3) {
      const points = indices
        .slice(i, i + 3)
        .map((index) => new Vector3(...positions.slice(index * 3, index * 3 + 3)));
      const hit = ray.intersectTriangle(...points, true, new Vector3());
      if (hit && (!nearest || hit.z > nearest.z)) nearest = { material: material.name, z: hit.z };
    }
  }
  assert.ok(nearest);
  assert.notEqual(
    nearest.material,
    edit.material,
    `Cut is covered by the same supposedly fractured surface: ${edit.node}`,
  );
  holeProbes.push({
    node: edit.node,
    expectedOpening: edit.material,
    firstHit: nearest,
    removedTriangles: edit.removedTriangles,
    boundaryEdges: edit.fractureBoundaryEdges,
  });
}
const baseSource = JSON.parse(await readFile(options.get('--closure'), 'utf8'));
const assetsOnly = { aegis: 'presentation/1', assets: baseSource.manifest.assets };
const previousClosure = preparePresentation({
  assetRoot: baseSource.assetRoot,
  manifest: assetsOnly,
});
assert.equal(previousClosure.files.length, 73);
assert.equal(previousClosure.totalBytes, 52746947);
await mkdir(output);
const root = join(output, 'assets');
await mkdir(root);
for (const file of previousClosure.files) {
  assert.equal(hash(await readFile(file.source)), file.sha256);
  const destination = join(root, ...file.path.split('/'));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(file.source, destination);
}
for (const file of proof.output) {
  const bytes = await readFile(join(candidate, file.path));
  assert.equal(hash(bytes), file.sha256);
  if (
    !['responder.glb', 'responder-contact-stains.png', 'responder-contact-stains-orm.png'].includes(
      file.path,
    )
  )
    assert.equal(
      previousClosure.files.find((entry) => entry.path === `generated/${file.path}`).sha256,
      file.sha256,
    );
  await copyFile(join(candidate, file.path), join(root, 'generated', file.path));
}
const nextClosure = preparePresentation({ assetRoot: root, manifest: assetsOnly });
const audioPaths = new Set(
  assetsOnly.assets.filter((asset) => asset.kind === 'audio').map((asset) => asset.src),
);
const audio = nextClosure.files.filter((file) => audioPaths.has(file.path));
const visual = nextClosure.files.filter((file) => !audioPaths.has(file.path));
const ending = nextClosure.files.find((file) => file.path === 'generated/evacuation-ending.glb');
assert.equal(ending.sha256, '55d8a739532ba47b16efe3bb9ce40c2a8a894dd53adb6e6f8dd05763c4c4ee0b');
const visualBytes = visual.reduce((sum, file) => sum + file.bytes, 0),
  audioBytes = audio.reduce((sum, file) => sum + file.bytes, 0);
const baseVisualBytes = visualBytes - ending.bytes;
assert.equal(nextClosure.files.length, 75);
assert.equal(nextClosure.totalBytes - previousClosure.totalBytes, proof.budget.byteDelta);
assert.ok(baseVisualBytes < 48 * 1024 * 1024);
assert.ok(visualBytes < 50 * 1024 * 1024);
assert.ok(audioBytes < 14 * 1024 * 1024);
assert.ok(nextClosure.totalBytes < 64 * 1024 * 1024);
const changed = [];
for (const file of previousClosure.files) {
  const now = nextClosure.files.find((entry) => entry.path === file.path);
  assert.ok(now);
  if (now.sha256 !== file.sha256) changed.push(file.path);
}
assert.deepEqual(changed, ['generated/responder.glb']);
const actual = {
  stage:
    'Neutral/torch assembledbody checkpoint only; no integrator import orgame capture approval',
  passed: true,
  changedRuntime: changed,
  newRuntime: nextClosure.files
    .filter((file) => !previousClosure.files.some((entry) => entry.path === file.path))
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  protected: {
    originalSculptAndVisorPrimitivesExact: true,
    unchangedOtherPrimitives: preserved,
    allOriginalMaterialsAndImagePayloadsExact: true,
    rigNodesAndAnimationAccessorsExact: true,
    endingAndClusterAudioAndAllOtherRuntimeFilesExact: 72,
  },
  holeProbes,
  budget: {
    files: 75,
    byteDelta: nextClosure.totalBytes - previousClosure.totalBytes,
    baseVisualBytes,
    baseVisualLimit: 48 * 1024 * 1024,
    allVisualIncludingEndingBytes: visualBytes,
    allVisualLimit: 50 * 1024 * 1024,
    audioBytes,
    audioLimit: 14 * 1024 * 1024,
    combinedBytes: nextClosure.totalBytes,
    hardCombinedLimit: 64 * 1024 * 1024,
  },
  beforeFiles: previousClosure.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  afterFiles: nextClosure.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  appearanceScope:
    'Only explicitly authorizedfour armor/fabric primitives may be replaced; conforming stain overlays are appended only to listedactorregions. Allprotected sculpt/visor/rig/clip and sharedtextures remainexact. Actual aestheticreview stillrequired.',
};
await writeFile(join(output, 'verification.json'), `${JSON.stringify(actual, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ passed: true, protected: actual.protected, holeProbes, budget: actual.budget, report: join(output, 'verification.json') }, null, 2)}\n`,
);
