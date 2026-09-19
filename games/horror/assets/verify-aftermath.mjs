import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Box3, Matrix4, Quaternion, Ray, Vector3 } from 'three';
import { preparePresentation } from '@aegis/render-three/presentation/node';

const here = dirname(fileURLToPath(import.meta.url)),
  options = new Map(),
  args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(
    ['--candidate', '--baseline', '--asset-root', '--contract', '--out'].includes(args[i]) &&
      args[i + 1] &&
      !options.has(args[i]),
  );
  options.set(args[i], resolve(args[i + 1]));
}
for (const key of ['--candidate', '--baseline', '--contract', '--out']) assert.ok(options.has(key));
const candidate = options.get('--candidate'),
  output = options.get('--out'),
  hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const provenance = JSON.parse(await readFile(join(candidate, 'aftermath-provenance.json'), 'utf8'));
const baselineBytes = await readFile(options.get('--baseline')),
  baseline = JSON.parse(baselineBytes);
const contractBytes = await readFile(options.get('--contract')),
  contract = JSON.parse(contractBytes);
for (const [label, bytes, recorded] of [
  ['baseline', baselineBytes, provenance.baselinePresentationSha256],
  ['contract', contractBytes, provenance.ownerContractSha256],
]) {
  const expectedLf = provenance.inputSnapshots.find((input) => input.label === label).lfSha256;
  assert.ok(
    hash(bytes) === recorded ||
      hash(bytes.toString('utf8').replaceAll('\r\n', '\n')) === expectedLf,
  );
}
if (options.has('--asset-root')) baseline.assetRoot = options.get('--asset-root');
for (const source of provenance.sources) {
  const bytes = await readFile(join(here, ...source.file.split('/')));
  assert.ok(
    hash(bytes) === source.sha256 ||
      hash(bytes.toString('utf8').replaceAll('\r\n', '\n')) === source.lfSha256,
    `Source content changed: ${source.file}`,
  );
}
const preflight = (manifest, assetRoot) =>
  preparePresentation({
    assetRoot,
    manifest: { aegis: 'presentation/1', assets: manifest.assets },
  });
const before = preflight(baseline.manifest, baseline.assetRoot);
assert.equal(before.files.length, 75);
assert.equal(before.totalBytes, 53347114);
const newBytes = await readFile(join(candidate, 'aftermath-sites.glb'));
assert.equal(hash(newBytes), provenance.newRuntime.sha256);
assert.ok(newBytes.length < 479089);

async function geometry(path, source) {
  const bytes = await readFile(path),
    length = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.toString('utf8', 20, 20 + length)),
    binary = bytes.subarray(28 + length);
  const read = (index) => {
    const a = doc.accessors[index],
      v = doc.bufferViews[a.bufferView],
      size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type],
      width = a.componentType === 5123 ? 2 : 4;
    return Array.from({ length: a.count * size }, (_, i) => {
      const at =
        (v.byteOffset ?? 0) +
        (a.byteOffset ?? 0) +
        Math.floor(i / size) * (v.byteStride ?? size * width) +
        (i % size) * width;
      return a.componentType === 5126
        ? binary.readFloatLE(at)
        : a.componentType === 5123
          ? binary.readUInt16LE(at)
          : binary.readUInt32LE(at);
    });
  };
  const batches = [];
  function walk(index, parent) {
    const node = doc.nodes[index];
    const transform = parent
      .clone()
      .multiply(
        new Matrix4().compose(
          new Vector3(...(node.translation ?? [0, 0, 0])),
          new Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
          new Vector3(...(node.scale ?? [1, 1, 1])),
        ),
      );
    if (node.mesh !== undefined)
      for (const part of doc.meshes[node.mesh].primitives) {
        const material = doc.materials[part.material],
          raw = read(part.attributes.POSITION);
        const positions = [];
        const box = new Box3();
        for (let i = 0; i < raw.length; i += 3) {
          const p = new Vector3(...raw.slice(i, i + 3)).applyMatrix4(transform);
          positions.push(p);
          box.expandByPoint(p);
        }
        batches.push({
          source,
          node: node.name,
          material,
          positions,
          indices: read(part.indices),
          box,
        });
      }
    node.children?.forEach((child) => walk(child, transform));
  }
  doc.scenes[doc.scene].nodes.forEach((index) => walk(index, new Matrix4()));
  return { doc, batches };
}
const added = await geometry(join(candidate, 'aftermath-sites.glb'), 'new-aftermath');
const facilityPath = before.files.find((file) => file.path === 'generated/facility.glb').source;
const facility = await geometry(facilityPath, 'unchanged-facility');
function firstHit(ray, batches) {
  let closest = null;
  for (const batch of batches) {
    if (batch.material.alphaMode === 'BLEND' || !ray.intersectsBox(batch.box)) continue;
    for (let i = 0; i < batch.indices.length; i += 3) {
      const [a, b, c] = batch.indices.slice(i, i + 3).map((index) => batch.positions[index]);
      const hit = ray.intersectTriangle(a, b, c, !batch.material.doubleSided, new Vector3());
      if (!hit) continue;
      const distance = hit.distanceTo(ray.origin);
      if (!closest || distance < closest.distance)
        closest = {
          source: batch.source,
          node: batch.node,
          material: batch.material.name,
          point: hit.toArray(),
          distance,
        };
    }
  }
  return closest;
}
const clearance = [],
  visibility = [];
for (const site of provenance.sites) {
  const owner = contract.results.find((item) => item.id === site.id.replace('-aftermath', ''));
  const batches = added.batches.filter((batch) => batch.node.startsWith(site.id));
  assert.ok(batches.length >= 2);
  let raised = 0,
    floor = 0,
    maximumLip = 0,
    minimumApproachDistance = Infinity;
  for (const batch of batches) {
    const isFloor = batch.node.endsWith('-floor'),
      bounds = isFloor ? site.floor : site.raised;
    assert.equal(batch.material.emissiveFactor, undefined, 'No emissive/UI-like aftermath');
    assert.equal(batch.material.extensions?.KHR_materials_unlit, undefined);
    for (const p of batch.positions) {
      const tuple = p.toArray();
      tuple.forEach((value, axis) =>
        assert.ok(
          value >= bounds.min[axis] - 0.00001 && value <= bounds.max[axis] + 0.00001,
          `Cooked ${site.id} exceeds envelope axis${axis}`,
        ),
      );
      const dx = Math.max(site.protected.min[0] - p.x, p.x - site.protected.max[0], 0);
      const dz = Math.max(site.protected.min[2] - p.z, p.z - site.protected.max[2], 0);
      assert.ok(dx > 0 || dz > 0);
      minimumApproachDistance = Math.min(minimumApproachDistance, Math.hypot(dx, dz));
      if (isFloor) floor++;
      else {
        raised++;
        maximumLip = Math.max(
          maximumLip,
          (tuple[site.wallAxis] - site.wallPlane) * site.normal[site.wallAxis],
        );
      }
    }
  }
  assert.ok(raised > 0 && floor > 0 && maximumLip <= 0.014 + 0.00001);
  const origin = new Vector3(...owner.eye),
    target = new Vector3(...site.primary);
  const ray = new Ray(origin, target.clone().sub(origin).normalize());
  const baselineHit = firstHit(ray, facility.batches);
  const candidateHit = firstHit(ray, [...facility.batches, ...added.batches]);
  assert.ok(baselineHit, `No positive existing-facility control for ${site.id}`);
  assert.ok(
    candidateHit && candidateHit.source === 'new-aftermath' && candidateHit.node === site.id,
    `${site.id} is hidden behind ${candidateHit?.node}/${candidateHit?.material}`,
  );
  assert.ok(candidateHit.distance < baselineHit.distance);
  clearance.push({
    site: site.id,
    raisedVertices: raised,
    floorVertices: floor,
    maximumLip,
    minimumApproachDistance,
  });
  visibility.push({
    site: site.id,
    ownerCanonicalTick: owner.tick,
    ownerWorldHash: owner.worldHash,
    flashlight: owner.flashlight,
    camera: owner.eye,
    target: site.primary,
    before: baselineHit,
    after: candidateHit,
    depthLeadMetres: baselineHit.distance - candidateHit.distance,
    scope:
      'Actual cooked geometry first-hit positive/negative control, not lighting/artistic acceptance',
  });
}
const alphaFloor = added.batches.filter((batch) => batch.node.endsWith('-floor'));
assert.equal(alphaFloor.length, 3, 'Exactly one separate floor-trace batch per site');
const actualDeps = added.doc.images.map((image) => `generated/${image.uri}`);
assert.ok(actualDeps.length > 0);
for (const path of actualDeps) {
  const old = before.files.find((file) => file.path === path);
  assert.ok(old, `New texture not allowed: ${path}`);
  assert.equal(hash(await readFile(join(candidate, path.slice('generated/'.length)))), old.sha256);
}
await mkdir(output);
const root = join(output, 'assets');
await mkdir(root);
for (const file of before.files) {
  const bytes = await readFile(file.source);
  assert.equal(hash(bytes), file.sha256);
  const path = join(root, ...file.path.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await copyFile(file.source, path);
}
await copyFile(
  join(candidate, 'aftermath-sites.glb'),
  join(root, 'generated', 'aftermath-sites.glb'),
);
const manifest = JSON.parse(JSON.stringify(baseline.manifest));
manifest.assets.push({
  id: 'aftermath-sites',
  kind: 'gltf',
  src: 'generated/aftermath-sites.glb',
  provenance: {
    author: 'Aegis contributors / three original restrained aftermath sites',
    license: 'Original authored geometry; existing reused-map provenance unchanged',
    source: 'games/horror/assets/source/aftermath-three.recipe.json',
  },
});
manifest.objects.push(provenance.object);
const after = preflight(manifest, root);
assert.equal(after.files.length, 76);
assert.equal(after.totalBytes - before.totalBytes, newBytes.length);
for (const file of before.files) {
  const next = after.files.find((entry) => entry.path === file.path);
  assert.ok(next);
  assert.equal(next.bytes, file.bytes);
  assert.equal(next.sha256, file.sha256);
}
const newFiles = after.files.filter((file) => !before.files.some((old) => old.path === file.path));
assert.equal(newFiles.length, 1);
assert.equal(newFiles[0].path, 'generated/aftermath-sites.glb');
const audioPaths = new Set(
  manifest.assets.filter((asset) => asset.kind === 'audio').map((asset) => asset.src),
);
const audioBytes = after.files
  .filter((file) => audioPaths.has(file.path))
  .reduce((sum, file) => sum + file.bytes, 0);
const visualBytes = after.totalBytes - audioBytes;
const endingBytes = after.files.find(
  (file) => file.path === 'generated/evacuation-ending.glb',
).bytes;
const baseBytes = visualBytes - endingBytes;
assert.ok(baseBytes < 48 * 1024 * 1024);
assert.ok(visualBytes < 50 * 1024 * 1024);
assert.ok(audioBytes < 14 * 1024 * 1024);
assert.ok(after.totalBytes < 64 * 1024 * 1024);
const report = {
  revision: provenance.revision,
  status:
    'Engineering/occlusion/budget proof complete; user actual-game environment review pending',
  sourceSceneSha256: provenance.sourceSceneSha256,
  baselineManifestFileSha256: hash(baselineBytes),
  ownerContractSha256: hash(contractBytes),
  newRuntime: provenance.newRuntime,
  clearance,
  visibility,
  noNewTextures: true,
  allPriorRuntimeClassified: before.files.map(({ path, bytes, sha256 }) => ({
    path,
    bytes,
    sha256,
    classification: 'unchanged byte-identical',
    additionallyReferencedByNewSites: actualDeps.includes(path),
  })),
  dependencies: provenance.dependencies,
  actualClosure: {
    files: 76,
    bytes: after.totalBytes,
    uniqueAddedBytes: newBytes.length,
    baseVisualBytes: baseBytes,
    baseLimit: 48 * 1024 * 1024,
    allVisualIncludingEndingBytes: visualBytes,
    visualLimit: 50 * 1024 * 1024,
    audioBytes,
    audioLimit: 14 * 1024 * 1024,
    hardCombinedLimit: 64 * 1024 * 1024,
    remainingBaseHeadroomBytes: 48 * 1024 * 1024 - baseBytes,
  },
  prePost: {
    beforeFiles: before.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    afterFiles: after.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  },
  integration: {
    object: provenance.object,
    sameSceneAndGameplay: true,
    captureOnlyNewSites: provenance.sites.map((site) => ({ id: site.id, ...site.capture })),
  },
  limits:
    'No character, old-maintenance, ending, audio, map, light, scene or collision change. No operator endpoint action. Geometry first-hit checks cannot prove lighting/readability; owner captures one actualgame view per newsite after guardedimport.',
};
await writeFile(join(output, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(
  join(output, 'candidate-presentation.json'),
  `${JSON.stringify({ assetRoot: root, manifest }, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({ passed: true, report: join(output, 'verification.json'), visibility, actualClosure: report.actualClosure }, null, 2)}\n`,
);
