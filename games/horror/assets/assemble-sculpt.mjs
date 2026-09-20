import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { preparePresentation } from '@aegis/render-three/presentation/node';

const options = new Map(),
  args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(
    ['--body-runtime', '--body-model', '--body-inventory', '--sculpt', '--out'].includes(args[i]) &&
      args[i + 1] &&
      !options.has(args[i]),
  );
  options.set(args[i], resolve(args[i + 1]));
}
for (const key of ['--body-runtime', '--sculpt', '--out'])
  assert.ok(options.has(key), `Missing ${key}`);
const bodyRoot = options.get('--body-runtime'),
  sculpt = options.get('--sculpt'),
  output = options.get('--out');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function readGlb(path) {
  const bytes = await readFile(path);
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const length = bytes.readUInt32LE(12);
  return {
    bytes,
    doc: JSON.parse(bytes.toString('utf8', 20, 20 + length)),
    binary: bytes.subarray(28 + length),
  };
}
const body = await readGlb(options.get('--body-model') ?? join(bodyRoot, 'responder.glb'));
const insert = await readGlb(join(sculpt, 'infestation-insert.glb'));
const inventory = JSON.parse(
  await readFile(options.get('--body-inventory') ?? join(bodyRoot, 'inventory.json'), 'utf8'),
);
const sculptProof = JSON.parse(await readFile(join(sculpt, 'sculpt-provenance.json'), 'utf8'));
for (const file of sculptProof.files)
  assert.equal(
    hash(await readFile(join(sculpt, file.file))),
    file.sha256,
    `Sculpt checkpoint drift: ${file.file}`,
  );
assert.equal(
  hash(body.bytes),
  inventory.files.find((file) => file.file === 'responder.glb').sha256,
);
assert.deepEqual(insert.doc.nodes.map((node) => node.name).sort(), [
  'helmet',
  'shoulder-right',
  'thorax',
]);
const doc = JSON.parse(JSON.stringify(body.doc));
const chunks = [body.binary];
let offset = body.binary.length;
const views = new Map(),
  accessors = new Map();
function importView(index) {
  if (views.has(index)) return views.get(index);
  const original = insert.doc.bufferViews[index];
  assert.equal(original.buffer, 0);
  const bytes = insert.binary.subarray(
    original.byteOffset ?? 0,
    (original.byteOffset ?? 0) + original.byteLength,
  );
  const padding = (4 - (bytes.length % 4)) % 4;
  const id = doc.bufferViews.length;
  doc.bufferViews.push({ ...original, buffer: 0, byteOffset: offset });
  chunks.push(bytes, Buffer.alloc(padding));
  offset += bytes.length + padding;
  views.set(index, id);
  return id;
}
function importAccessor(index) {
  if (accessors.has(index)) return accessors.get(index);
  const a = insert.doc.accessors[index];
  assert.equal(a.sparse, undefined);
  const id = doc.accessors.length;
  doc.accessors.push({ ...a, bufferView: importView(a.bufferView) });
  accessors.set(index, id);
  return id;
}
const basecolorCook = JSON.parse(await readFile(join(sculpt, 'basecolor-cook.json'), 'utf8'));
assert.equal(basecolorCook.file, 'insert-basecolor.jpg');
assert.equal(hash(await readFile(join(sculpt, basecolorCook.file))), basecolorCook.sha256);
const maps = ['insert-basecolor.jpg', 'insert-normal.png', 'insert-orm.png'];
const newTextureIds = maps.map((file) => {
  const image = doc.images.length;
  doc.images.push({ uri: file });
  const texture = doc.textures.length;
  doc.textures.push({ source: image, sampler: 0 });
  return texture;
});
const materialIndex = doc.materials.length;
doc.materials.push({
  name: 'sculpted-infestation-insert',
  doubleSided: true,
  pbrMetallicRoughness: {
    baseColorFactor: [1, 1, 1, 1],
    baseColorTexture: { index: newTextureIds[0] },
    metallicFactor: 0,
    roughnessFactor: 1,
    metallicRoughnessTexture: { index: newTextureIds[2] },
  },
  normalTexture: { index: newTextureIds[1], scale: 1 },
  occlusionTexture: { index: newTextureIds[2], strength: 0.65 },
});
const removable = /^(colony-|wound-tissue$|dried-blood$|torn-liner$|ceramic-fracture$)/;
const changes = [];
const originalSurvivors = [];
for (const sourceNode of insert.doc.nodes) {
  assert.equal(sourceNode.translation, undefined, 'Insert export must remain exactly bone-local');
  assert.equal(sourceNode.rotation, undefined);
  assert.equal(sourceNode.scale, undefined);
  const targetNode = doc.nodes.find((node) => node.name === sourceNode.name);
  assert.ok(targetNode?.mesh !== undefined);
  const mesh = doc.meshes[targetNode.mesh],
    removed = [];
  mesh.primitives = mesh.primitives.filter((part) => {
    const name = doc.materials[part.material].name;
    if (removable.test(name)) {
      removed.push(name);
      return false;
    }
    return true;
  });
  assert.ok(
    removed.length > 0,
    `No obsolete procedural infestation removed for ${sourceNode.name}`,
  );
  originalSurvivors.push({
    node: sourceNode.name,
    primitives: JSON.parse(JSON.stringify(mesh.primitives)),
  });
  const incoming = insert.doc.meshes[sourceNode.mesh].primitives;
  assert.equal(incoming.length, 1);
  for (const part of incoming) {
    assert.ok(
      part.attributes.POSITION !== undefined &&
        part.attributes.NORMAL !== undefined &&
        part.attributes.TANGENT !== undefined &&
        part.attributes.TEXCOORD_0 !== undefined,
    );
    mesh.primitives.push({
      ...part,
      attributes: Object.fromEntries(
        Object.entries(part.attributes).map(([key, value]) => [key, importAccessor(value)]),
      ),
      indices: importAccessor(part.indices),
      material: materialIndex,
    });
  }
  changes.push({
    target: sourceNode.name,
    removedMaterials: removed,
    insertedPrimitives: incoming.length,
  });
}
// Prune unused material/image declarations, not original geometry/animation bytes.
const usedMaterials = new Set(
  doc.meshes.flatMap((mesh) => mesh.primitives.map((part) => part.material)),
);
const materialMap = new Map(),
  materials = [];
doc.materials.forEach((material, index) => {
  if (usedMaterials.has(index)) {
    materialMap.set(index, materials.length);
    materials.push(material);
  }
});
doc.meshes.forEach((mesh) =>
  mesh.primitives.forEach((part) => {
    part.material = materialMap.get(part.material);
  }),
);
doc.materials = materials;
const usedTextures = new Set();
function visitTextures(value, operation, key = '') {
  if (!value || typeof value !== 'object') return;
  if (key.endsWith('Texture')) {
    operation(value);
    return;
  }
  for (const [field, item] of Object.entries(value)) visitTextures(item, operation, field);
}
doc.materials.forEach((material) =>
  visitTextures(material, (texture) => usedTextures.add(texture.index)),
);
const textureMap = new Map(),
  textures = [];
doc.textures.forEach((texture, index) => {
  if (usedTextures.has(index)) {
    textureMap.set(index, textures.length);
    textures.push(texture);
  }
});
doc.materials.forEach((material) =>
  visitTextures(material, (texture) => {
    texture.index = textureMap.get(texture.index);
  }),
);
doc.textures = textures;
const usedImages = new Set(doc.textures.map((texture) => texture.source)),
  imageMap = new Map(),
  images = [];
doc.images.forEach((image, index) => {
  if (usedImages.has(index)) {
    imageMap.set(index, images.length);
    images.push(image);
  }
});
doc.textures.forEach((texture) => {
  texture.source = imageMap.get(texture.source);
});
doc.images = images;
doc.buffers = [{ byteLength: offset }];
const binary = Buffer.concat(chunks);
assert.ok(
  binary.subarray(0, body.binary.length).equals(body.binary),
  'An existing vertex/normal/UV/animation payload was changed',
);
assert.deepEqual(doc.animations, body.doc.animations);
assert.deepEqual(doc.nodes, body.doc.nodes);
for (const survivor of originalSurvivors) {
  const mesh = doc.meshes[doc.nodes.find((node) => node.name === survivor.node).mesh];
  for (const part of survivor.primitives) {
    const expected = { ...part, material: materialMap.get(part.material) };
    assert.ok(
      mesh.primitives.some((current) => JSON.stringify(current) === JSON.stringify(expected)),
    );
  }
}
function accessorValues(index) {
  const a = doc.accessors[index],
    view = doc.bufferViews[a.bufferView];
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type],
    bytes = a.componentType === 5123 ? 2 : 4;
  const stride = view.byteStride ?? size * bytes;
  return Array.from({ length: a.count * size }, (_, i) => {
    const at =
      (view.byteOffset ?? 0) +
      (a.byteOffset ?? 0) +
      Math.floor(i / size) * stride +
      (i % size) * bytes;
    return a.componentType === 5126
      ? binary.readFloatLE(at)
      : a.componentType === 5123
        ? binary.readUInt16LE(at)
        : binary.readUInt32LE(at);
  });
}
const transforms = new Map();
function walk(index, parent) {
  const node = doc.nodes[index];
  const world = parent
    .clone()
    .multiply(
      new Matrix4().compose(
        new Vector3(...(node.translation ?? [0, 0, 0])),
        new Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
        new Vector3(...(node.scale ?? [1, 1, 1])),
      ),
    );
  transforms.set(index, world);
  node.children?.forEach((child) => walk(child, world));
}
doc.scenes[doc.scene].nodes.forEach((index) => walk(index, new Matrix4()));
const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
let triangles = 0;
doc.nodes.forEach((node, nodeIndex) => {
  if (node.mesh === undefined) return;
  for (const part of doc.meshes[node.mesh].primitives) {
    const points = accessorValues(part.attributes.POSITION),
      normals = accessorValues(part.attributes.NORMAL);
    assert.equal(points.length, normals.length);
    for (let i = 0; i < points.length; i += 3) {
      const point = new Vector3(...points.slice(i, i + 3)).applyMatrix4(transforms.get(nodeIndex));
      point.toArray().forEach((value, axis) => {
        bounds.min[axis] = Math.min(bounds.min[axis], value);
        bounds.max[axis] = Math.max(bounds.max[axis], value);
      });
      assert.ok(Math.abs(Math.hypot(...normals.slice(i, i + 3)) - 1) < 0.002);
    }
    triangles += doc.accessors[part.indices].count / 3;
  }
});
const originalBounds = inventory.models.find((model) => model.file === 'responder.glb').bounds;
for (let axis = 0; axis < 3; axis++) {
  assert.ok(bounds.min[axis] >= originalBounds.min[axis] - 0.00001);
  assert.ok(bounds.max[axis] <= originalBounds.max[axis] + 0.00001);
}
const json = Buffer.from(JSON.stringify(doc)),
  padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(20),
  binHeader = Buffer.alloc(8);
header.write('glTF');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(28 + padded.length + binary.length, 8);
header.writeUInt32LE(padded.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);
binHeader.writeUInt32LE(binary.length);
binHeader.writeUInt32LE(0x004e4942, 4);
await mkdir(output);
await writeFile(join(output, 'responder.glb'), Buffer.concat([header, padded, binHeader, binary]));
const dependencies = doc.images.map((image) => image.uri);
for (const file of dependencies) {
  assert.match(file, /^[a-z0-9-]+\.(png|jpg)$/);
  await copyFile(join(maps.includes(file) ? sculpt : bodyRoot, file), join(output, file));
}
const prepared = preparePresentation({
  assetRoot: output,
  manifest: {
    aegis: 'presentation/1',
    assets: [
      {
        id: 'responder',
        kind: 'gltf',
        src: 'responder.glb',
        provenance: {
          author: 'Original Aegis scripted Blender sculpt and bake',
          license: 'Original project-authored media; existing source rights retained',
          source: 'source/sculpt_infestation.py; sculpt-provenance.json',
        },
      },
    ],
  },
});
const hypotheticalFiles = new Map(inventory.files.map((file) => [file.file, file.bytes]));
for (const file of prepared.files) hypotheticalFiles.set(file.path, file.bytes);
hypotheticalFiles.delete('colony-shell-basecolor.png');
hypotheticalFiles.delete('colony-shell-orm.png');
const projectedBytes = [...hypotheticalFiles.values()].reduce((sum, bytes) => sum + bytes, 0);
assert.ok(
  projectedBytes <= 48 * 1024 * 1024,
  `Projected visual closure exceeds reserved budget: ${projectedBytes}`,
);
const report = {
  status: 'FIRST SCULPT/MATERIAL CHECKPOINT; not integration or artistic acceptance',
  bodySha256: hash(body.bytes),
  insertSha256: hash(insert.bytes),
  output: prepared.files,
  changes,
  triangles,
  bounds,
  dependencies,
  projectedVisualClosureBytes: projectedBytes,
  reservedAudioBytes: 16 * 1024 * 1024,
  preservation: {
    originalBinaryPayloadPrefixIdentical: true,
    allExistingNodesAndAnimationsIdentical: true,
    unrelatedPrimitiveDescriptorsIdenticalExceptMaterialIndexRemap: true,
    visorCopiedNotReexported: true,
  },
  limitations:
    'Original unused binary payload is deliberately retained for preservation proof; this checkpoint is not an optimized fullgame export. The35 unrelated original assets and accepted environment are not authored or rebuilt.',
  sculpt: sculptProof,
  basecolorCook,
};
await writeFile(join(output, 'assembly-proof.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ output, triangles, bounds, projectedBytes, preservation: report.preservation }, null, 2)}\n`,
);
