import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Euler, Matrix4, Vector3 } from 'three';
import { decodePng } from './lib/raster.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2),
  options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--baseline', '--report'].includes(args[i]) || !args[i + 1] || options.has(args[i]))
    throw new Error(
      'Usage: node games\\horror\\assets\\verify-v10.mjs --baseline <frozen v9 asset directory> --report <new JSON receipt>',
    );
  options.set(args[i], resolve(args[i + 1]));
}
assert.ok(
  options.has('--baseline') && options.has('--report'),
  'Explicit frozen baseline and new report paths required',
);
const baseline = options.get('--baseline');
assert.notEqual(baseline, here);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const before = JSON.parse(await readFile(join(baseline, 'generated', 'inventory.json'), 'utf8'));
const after = JSON.parse(await readFile(join(here, 'generated', 'inventory.json'), 'utf8'));
assert.equal(before.files.length, 35);
assert.equal(before.budget.totalBytes, 38508211);
assert.equal(
  before.sourceScene.sha256,
  'b813645272b39897cecb0dbee587412acc5bb052e3ba3de16100f4797814f660',
);
assert.deepEqual(
  after.sourceScene,
  before.sourceScene,
  'No scene or gameplay input changes permitted',
);
assert.deepEqual(after.placement, before.placement);
assert.deepEqual(after.suggestedLighting, before.suggestedLighting);
assert.deepEqual(after.authoredFeatures, before.authoredFeatures);
assert.deepEqual(after.toolchain, before.toolchain);
assert.equal(after.files.length, 36);
const changedRuntime = [];
for (const file of before.files) {
  const original = await readFile(join(baseline, 'generated', file.file));
  assert.equal(hash(original), file.sha256, `Frozen preimage corrupted: ${file.file}`);
  const current = after.files.find((entry) => entry.file === file.file);
  assert.ok(current, `Unexpected deletion: ${file.file}`);
  const bytes = await readFile(join(here, 'generated', file.file));
  assert.equal(hash(bytes), current.sha256);
  if (current.sha256 !== file.sha256) changedRuntime.push(file.file);
}
assert.deepEqual(changedRuntime.sort(), ['orbital-exterior.glb', 'responder.glb']);
assert.deepEqual(
  after.files
    .filter((file) => !before.files.some((old) => old.file === file.file))
    .map((file) => file.file),
  ['ring-density.png'],
);
assert.ok(
  after.budget.totalBytes < before.budget.totalBytes,
  'Bounded optical repair should reduce encoded closure bytes',
);
assert.ok(after.budget.totalBytes + 16777216 <= 67108864);

async function model(root, file) {
  const bytes = await readFile(join(root, 'generated', file));
  const length = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + length));
  const binary = bytes.subarray(28 + length);
  const materialValue = (value, field = '') => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((entry) => materialValue(entry));
    if (field.endsWith('Texture')) {
      const { index, ...settings } = value;
      const texture = gltf.textures[index];
      return {
        ...settings,
        uri: gltf.images[texture.source].uri,
        sampler: gltf.samplers[texture.sampler],
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, materialValue(entry, key)]),
    );
  };
  const accessor = (index) => {
    const spec = gltf.accessors[index],
      view = gltf.bufferViews[spec.bufferView];
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[spec.type];
    assert.ok(size && [5125, 5126].includes(spec.componentType));
    const offset = (view.byteOffset ?? 0) + (spec.byteOffset ?? 0);
    return Array.from({ length: spec.count * size }, (_, i) =>
      spec.componentType === 5126
        ? binary.readFloatLE(offset + i * 4)
        : binary.readUInt32LE(offset + i * 4),
    );
  };
  const nodes = gltf.nodes.map(({ mesh, ...node }) => ({
    ...node,
    meshName: mesh === undefined ? null : gltf.meshes[mesh].name,
  }));
  const clips = (gltf.animations ?? []).map((clip) => ({
    name: clip.name,
    channels: clip.channels.map((channel) => {
      const sampler = clip.samplers[channel.sampler];
      return {
        target: channel.target,
        interpolation: sampler.interpolation,
        times: accessor(sampler.input),
        values: accessor(sampler.output),
      };
    }),
  }));
  const primitives = gltf.meshes.flatMap((mesh) =>
    mesh.primitives.map((part) => ({
      node: mesh.name,
      material: materialValue(gltf.materials[part.material]),
      positions: accessor(part.attributes.POSITION),
      normals: accessor(part.attributes.NORMAL),
      uvs: accessor(part.attributes.TEXCOORD_0),
      indices: accessor(part.indices),
    })),
  );
  return { gltf, nodes, clips, primitives };
}
const oldHero = await model(baseline, 'responder.glb'),
  newHero = await model(here, 'responder.glb');
assert.deepEqual(newHero.nodes, oldHero.nodes, 'Rig names, parentage and bind pose are immutable');
assert.deepEqual(
  newHero.clips,
  oldHero.clips,
  'All four clips must be byte-equivalent after resolving accessors',
);
assert.deepEqual(
  after.models.find((m) => m.file === 'responder.glb').bounds,
  before.models.find((m) => m.file === 'responder.glb').bounds,
);
assert.deepEqual(
  newHero.primitives.filter((p) => p.material.name !== 'rescue-visor'),
  oldHero.primitives.filter((p) => p.material.name !== 'visor'),
  'Only visor surface may change on responder',
);
const visor = newHero.primitives.filter((p) => p.material.name === 'rescue-visor');
assert.equal(visor.length, 1);
assert.equal(visor[0].node, 'helmet');
assert.equal(visor[0].material.emissiveFactor, undefined);
assert.equal(visor[0].material.alphaMode, undefined);
assert.deepEqual(visor[0].material.pbrMetallicRoughness, {
  baseColorFactor: [0.006, 0.012, 0.014, 1],
  roughnessFactor: 0.42,
  metallicFactor: 0.08,
});
const normalZ = visor[0].normals.filter((_, i) => i % 3 === 2);
assert.ok(Math.min(...normalZ) > 0.89 && Math.min(...normalZ) < 0.93);
assert.ok(Math.max(...normalZ) > 0.999);
const depths = visor[0].positions.filter((_, i) => i % 3 === 2);
assert.ok(
  Math.max(...depths) - Math.min(...depths) > 0.0239,
  'Visor must have genuine physical curvature, not a flat material swap',
);
for (let i = 0; i < visor[0].positions.length; i += 3) {
  const [x, y, z] = visor[0].positions.slice(i, i + 3);
  const dy = y + 0.002;
  assert.ok(Math.abs(z - (0.232 - 0.8 * x * x - 2 * dy * dy)) < 0.000001);
  const expected = new Vector3(1.6 * x, 4 * dy, 1).normalize().toArray();
  expected.forEach((value, axis) =>
    assert.ok(
      Math.abs(value - visor[0].normals[i + axis]) < 0.000001,
      'Visor normal must match the smooth global surface, not radial polygon facets',
    ),
  );
}

const oldSpace = await model(baseline, 'orbital-exterior.glb'),
  newSpace = await model(here, 'orbital-exterior.glb');
assert.deepEqual(
  newSpace.nodes,
  oldSpace.nodes,
  'Celestial and station node transforms stay unchanged',
);
assert.deepEqual(
  newSpace.primitives.filter((p) => p.material.name !== 'ring-density'),
  oldSpace.primitives.filter((p) => !['ring', 'ringDark'].includes(p.material.name)),
  'Planet, antenna and star geometry/materials must be identical',
);
const rings = newSpace.primitives.filter((p) => p.material.name === 'ring-density');
assert.equal(rings.length, 1);
const ring = rings[0];
assert.equal(ring.material.alphaMode, 'BLEND');
assert.equal(ring.material.doubleSided, true);
assert.deepEqual(ring.material.extensions, { KHR_materials_unlit: {} });
assert.equal(ring.indices.length / 3, 512);
assert.equal(ring.material.pbrMetallicRoughness.baseColorTexture.uri, 'ring-density.png');
const undo = new Matrix4().makeRotationFromEuler(new Euler(0.42, -0.1, -0.32)).invert();
const vertices = new Map(),
  neighbors = new Map();
let minimumRadius = Infinity,
  maximumRadius = 0;
for (let i = 0; i < ring.positions.length; i += 3) {
  const point = new Vector3(...ring.positions.slice(i, i + 3)).applyMatrix4(undo);
  assert.ok(Math.abs(point.z) < 0.0001, 'Ring remains in exact approved plane');
  const radius = Math.hypot(point.x, point.y);
  minimumRadius = Math.min(minimumRadius, radius);
  maximumRadius = Math.max(maximumRadius, radius);
  assert.ok(
    Math.min(
      Math.abs(radius - (51 * 360) / 43),
      Math.abs(radius - ((51 + 41 * 0.6 + 0.49) * 360) / 43),
    ) < 0.0001,
  );
  vertices.set(i / 3, `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`);
}
assert.ok(Math.abs(minimumRadius - (51 * 360) / 43) < 0.0001);
assert.ok(Math.abs(maximumRadius - ((51 + 41 * 0.6 + 0.49) * 360) / 43) < 0.0001);
for (let i = 0; i < ring.indices.length; i += 3) {
  const points = ring.indices.slice(i, i + 3).map((index) => vertices.get(index));
  for (let j = 0; j < 3; j++) {
    if (!neighbors.has(points[j])) neighbors.set(points[j], new Set());
    neighbors.get(points[j]).add(points[(j + 1) % 3]);
    neighbors.get(points[j]).add(points[(j + 2) % 3]);
  }
}
const visited = new Set(),
  pending = [neighbors.keys().next().value];
while (pending.length) {
  const vertex = pending.pop();
  if (visited.has(vertex)) continue;
  visited.add(vertex);
  pending.push(...neighbors.get(vertex));
}
assert.equal(
  visited.size,
  neighbors.size,
  'Ring must be one connected annulus, not disconnected bands',
);
const image = decodePng(await readFile(join(here, 'generated', 'ring-density.png')));
assert.equal(image.width, 512);
assert.equal(image.height, 4);
const alpha = [];
for (let x = 0; x < image.width; x++) {
  const pixel = image.get(x, 0);
  assert.deepEqual(pixel.slice(0, 3), [141, 134, 119]);
  alpha.push(pixel[3]);
  for (let y = 1; y < image.height; y++) assert.deepEqual(image.get(x, y), pixel);
}
assert.equal(alpha[0], 0);
assert.equal(alpha.at(-1), 0);
assert.ok(Math.max(...alpha) <= Math.ceil(0.46 * 255));
assert.ok(Math.min(...alpha.slice(45, -45)) >= Math.floor(0.18 * 255));
assert.ok(Math.max(...alpha.slice(1).map((a, i) => Math.abs(a - alpha[i]))) <= 5);
let previousDirection = 0,
  troughCount = 0;
for (let i = 46; i < alpha.length - 45; i++) {
  const direction = Math.sign(alpha[i] - alpha[i - 1]);
  if (direction && previousDirection === -1 && direction === 1) troughCount++;
  if (direction) previousDirection = direction;
}
assert.equal(troughCount, 2);

async function fileMap(root, directory = '') {
  const files = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (directory === '' && entry.name === 'audio') continue;
    const name = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await fileMap(root, name)));
    else if (entry.isFile()) {
      const bytes = await readFile(join(root, name));
      files.push({ file: name.split('\\').join('/'), bytes: bytes.length, sha256: hash(bytes) });
    } else throw new Error(`Unexpected asset file type: ${name}`);
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}
const originalFiles = await fileMap(baseline),
  candidateFiles = await fileMap(here);
const delta = [];
for (const file of candidateFiles) {
  const previous = originalFiles.find((entry) => entry.file === file.file);
  if (previous?.sha256 !== file.sha256)
    delta.push({ path: file.file, before: previous ?? null, after: file });
}
assert.ok(
  originalFiles.every((file) => candidateFiles.some((entry) => entry.file === file.file)),
  'No deletion permitted in bounded v10',
);
const report = {
  aegis: 'null-meridian-visual-delta/1',
  revision: 'v10',
  candidateIteration: 'r2-smooth-visor',
  baselineRevision: 'v9',
  scope:
    'Two-asset optical repair only; no generation, scene, audio, rig, clip, roomkit, light or camera changes.',
  baselineInventorySha256: hash(await readFile(join(baseline, 'generated', 'inventory.json'))),
  candidateInventorySha256: hash(await readFile(join(here, 'generated', 'inventory.json'))),
  preservedRuntimeFiles: 33,
  modifiedRuntimeFiles: changedRuntime,
  addedRuntimeFiles: ['ring-density.png'],
  runtimeBytes: after.budget.totalBytes,
  reservedAudioBytes: 16777216,
  proofs: {
    responderBoundsAndRigAndClipsIdentical: true,
    nonVisorGeometryIdentical: true,
    nonRingExteriorIdentical: true,
    continuousRingComponents: 1,
    radialTroughs: troughCount,
    ringRadii: [minimumRadius, maximumRadius],
    maximumRingAlpha: Math.max(...alpha) / 255,
  },
  beforeFiles: originalFiles,
  afterFiles: candidateFiles,
  delta,
  visualAcceptance:
    'Pending unchanged1440p integrated hero/center/two-lateral captures. Structural proof is not artistic acceptance.',
};
await writeFile(options.get('--report'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(
  `${JSON.stringify({ passed: true, ...report.proofs, runtimeBytes: report.runtimeBytes, delta: delta.map((entry) => entry.path), report: options.get('--report') }, null, 2)}\n`,
);
