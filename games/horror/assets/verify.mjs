import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  AnimationClip,
  AnimationMixer,
  Group,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import { preparePresentation } from '@aegis/render-three/presentation/node';
import { decodePng, png, Raster } from './lib/raster.mjs';
import { DOORS } from './lib/facility.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const generated = join(here, 'generated');
const inventory = JSON.parse(await readFile(join(generated, 'inventory.json'), 'utf8'));
const collision = JSON.parse(await readFile(join(generated, 'collision-audit.json'), 'utf8'));
const provenance = JSON.parse(await readFile(join(here, 'provenance.json'), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const near = (actual, expected, epsilon = 0.0001) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const models = new Map();
let countedBytes = 0;
let floorTriangleArea = 0;
let ceilingHullArea = 0;
let floorHullArea = 0;
for (const file of inventory.files) {
  const bytes = await readFile(join(generated, file.file));
  assert.equal(bytes.length, file.bytes, file.file);
  assert.equal(
    hash(bytes),
    file.sha256,
    `Current bytes do not match cooked inventory: ${file.file}`,
  );
  assert.ok(bytes.length <= 32 * 1024 * 1024);
  countedBytes += bytes.length;
  if (!file.file.endsWith('.glb')) continue;
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const length = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.toString('utf8', 20, 20 + length));
  const binary = bytes.subarray(28 + length);
  assert.equal(document.buffers[0].byteLength, binary.length);
  const accessor = (index) => {
    const a = document.accessors[index];
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    assert.ok(size);
    assert.ok([5125, 5126].includes(a.componentType));
    const view = document.bufferViews[a.bufferView];
    const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    assert.ok(offset + a.count * size * 4 <= binary.length);
    return Array.from({ length: a.count * size }, (_, i) => {
      const value =
        a.componentType === 5126
          ? binary.readFloatLE(offset + i * 4)
          : binary.readUInt32LE(offset + i * 4);
      assert.ok(Number.isFinite(value));
      return value;
    });
  };
  let triangles = 0;
  for (const mesh of document.meshes) {
    for (const primitive of mesh.primitives) {
      const positions = accessor(primitive.attributes.POSITION);
      const normals = accessor(primitive.attributes.NORMAL);
      const uvs = accessor(primitive.attributes.TEXCOORD_0);
      const indices = accessor(primitive.indices);
      assert.equal(indices.length % 3, 0);
      assert.equal(normals.length, positions.length);
      assert.equal(uvs.length / 2, positions.length / 3);
      for (const index of indices) assert.ok(index < positions.length / 3);
      if (file.file === 'facility.glb' && document.materials[primitive.material].name === 'hull') {
        assert.equal(document.materials[primitive.material].alphaMode, undefined);
        for (let i = 0; i < indices.length; i += 3) {
          const points = indices
            .slice(i, i + 3)
            .map((index) => new Vector3(...positions.slice(index * 3, index * 3 + 3)));
          const area =
            points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).length() / 2;
          if (points[0].y > 0) {
            for (const point of points) near(point.y, 3.61);
            ceilingHullArea += area;
          } else {
            for (const point of points) near(point.y, -0.01);
            floorHullArea += area;
          }
        }
      }
      if (file.file === 'facility.glb' && document.materials[primitive.material].name === 'deck') {
        for (let i = 0; i < indices.length; i += 3) {
          const points = indices
            .slice(i, i + 3)
            .map((index) => new Vector3(...positions.slice(index * 3, index * 3 + 3)));
          for (const point of points) {
            near(point.y, 0);
            near(Math.abs(point.x % 1), 0.5, 0.00001);
            near(Math.abs(point.z % 1), 0.5, 0.00001);
          }
          const area =
            points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).length() / 2;
          near(area, 0.5, 0.00001);
          floorTriangleArea += area;
        }
      }
      for (let vertex = 0; vertex < normals.length; vertex += 3) {
        near(new Vector3(...normals.slice(vertex, vertex + 3)).length(), 1, 0.001);
      }
      triangles += indices.length / 3;
    }
  }
  assert.equal(triangles, inventory.models.find((model) => model.file === file.file).triangles);
  const nodes = document.nodes.map((node) => {
    const group = new Group();
    group.name = node.name;
    group.position.fromArray(node.translation ?? [0, 0, 0]);
    group.quaternion.fromArray(node.rotation ?? [0, 0, 0, 1]);
    return group;
  });
  document.nodes.forEach((node, i) =>
    node.children?.forEach((child) => nodes[i].add(nodes[child])),
  );
  const clips = (document.animations ?? []).map(
    (clip) =>
      new AnimationClip(
        clip.name,
        -1,
        clip.channels.map((channel) => {
          const sampler = clip.samplers[channel.sampler];
          assert.equal(sampler.interpolation, 'LINEAR');
          const times = accessor(sampler.input);
          assert.equal(times[0], 0);
          for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1]);
          const Track =
            channel.target.path === 'rotation' ? QuaternionKeyframeTrack : VectorKeyframeTrack;
          const property = channel.target.path === 'rotation' ? 'quaternion' : 'position';
          return new Track(
            `${nodes[channel.target.node].name}.${property}`,
            times,
            accessor(sampler.output),
          );
        }),
      ),
  );
  models.set(file.file, { document, root: nodes[0], nodes, clips });
}
assert.equal(countedBytes, inventory.budget.totalBytes);
assert.ok(countedBytes <= 48 * 1024 * 1024, 'Preserve16MiB audio reservation');
assert.equal(
  collision.floorTiles.length,
  789,
  'Pinned authored map coverage, not a zero-scene pass',
);
assert.equal(new Set(collision.floorTiles.map((cell) => cell.join(','))).size, 789);
near(floorTriangleArea, 789, 0.00001);
near(ceilingHullArea, 1271);
near(floorHullArea, 1271);
assert.equal(collision.boundaryFaces.length, 330);
assert.equal(collision.doorCells.length, 18);
assert.ok(collision.maxWallIntrusion <= 0.00001);
for (const door of DOORS) {
  for (const cell of door.cells)
    assert.ok(collision.doorCells.some((value) => value[0] === cell[0] && value[1] === cell[1]));
}
for (const cell of [
  [15, 3],
  [3, 11],
  [3, 30],
  [27, 13],
  [21, 29],
  [15, 38],
  [28, 38],
])
  assert.ok(
    collision.floorTiles.some((value) => value[0] === cell[0] && value[1] === cell[1]),
    `Missing required gameplay anchor floor ${cell}`,
  );
for (const cell of [
  [6, 16],
  [6, 27],
  [24, 25],
])
  assert.ok(!collision.floorTiles.some((value) => value[0] === cell[0] && value[1] === cell[1]));
assert.equal(collision.boundaryFaces.filter((face) => face.window).length, 14);
assert.equal(
  inventory.authoredFeatures.filter((feature) => feature.type === 'interactive-recess').length,
  11,
);
for (const prop of inventory.placement.props) {
  const model = inventory.models.find((model) => model.file === prop.model);
  assert.ok(model.bounds.min[1] >= 0.5, `Phantom floor pedestal: ${prop.entity}`);
  assert.ok(
    model.bounds.max[2] <= 0.0001,
    `Prop crosses its local wall-front plane: ${prop.entity}`,
  );
  assert.ok(
    model.bounds.min[2] >= -0.311,
    `Prop exceeds supported wall recess depth: ${prop.entity}`,
  );
}

const prepared = preparePresentation({
  assetRoot: generated,
  manifest: {
    aegis: 'presentation/1',
    assets: inventory.files.map((file) => ({
      id: file.file,
      src: file.file,
      kind: file.file.endsWith('.glb') ? 'gltf' : 'texture',
      provenance: {
        author: 'Aegis original authored / Azure-generated material derivatives',
        license: 'Mixed original/generated terms; see provenance.json',
        source: 'source/recipes.json and generate.mjs',
      },
    })),
  },
});
assert.equal(prepared.totalBytes, countedBytes);
assert.equal(
  prepared.files.length,
  36,
  'Actual production preflight must inspect whole dependency closure',
);

const motion = [];
function pose(model, name, time, landmark, localPoint = [0, 0, 0]) {
  const clip = model.clips.find((clip) => clip.name === name);
  assert.ok(clip, `Missing clip ${name}`);
  const mixer = new AnimationMixer(model.root);
  const action = mixer.clipAction(clip);
  action.play();
  mixer.setTime(time);
  model.root.updateMatrixWorld(true);
  const point = model.root
    .getObjectByName(landmark)
    .localToWorld(new Vector3(...localPoint))
    .toArray();
  const quaternion = model.root.getObjectByName(landmark).quaternion.toArray();
  mixer.stopAllAction();
  mixer.uncacheRoot(model.root);
  return { point, quaternion };
}
const door = models.get('pressure-door.glb');
assert.equal(door.clips.length, 1);
near(door.clips[0].duration, 0.7);
near(pose(door, 'Open', 0, 'leaf-left').point[0], -0.75);
near(pose(door, 'Open', 0.69999, 'leaf-left').point[0], -2.28, 0.001);
near(pose(door, 'Open', 0.69999, 'leaf-right').point[0], 2.28, 0.001);
assert.ok(
  Math.abs(pose(door, 'Open', 0.69999, 'leaf-left').point[0]) - 0.747 > 1.5,
  'Open leaves clear3m passage',
);
const threat = models.get('responder.glb');
assert.deepEqual(
  threat.clips.map((clip) => clip.name),
  ['Idle', 'Stalk', 'Search', 'Lunge'],
);
let maximumSoleError = 0;
let maximumWorldFootDrift = 0;
for (const [ankle, times] of [
  ['ankle-left', Array.from({ length: 21 }, (_, i) => (i * 1.1) / 20)],
  ['ankle-right', Array.from({ length: 21 }, (_, i) => 1.1 + (i * 1.1) / 20)],
]) {
  for (const time of times)
    for (const z of [-0.081, 0.205]) {
      const point = pose(threat, 'Stalk', time, ankle, [0, -0.115, z]).point;
      const height = point[1];
      maximumSoleError = Math.max(maximumSoleError, Math.abs(height));
      assert.ok(Math.abs(height) <= 0.02, `Unplanted ${ankle} heel/toe at${time}s: ${height}m`);
      const initial = pose(threat, 'Stalk', times[0], ankle, [0, -0.115, z]).point;
      const worldDrift = Math.abs(
        point[2] + time * (1.6 / 2.2) - initial[2] - times[0] * (1.6 / 2.2),
      );
      maximumWorldFootDrift = Math.max(maximumWorldFootDrift, worldDrift);
      assert.ok(
        worldDrift <= 0.02,
        `Stance foot slides at required0.8m footfall cadence: ${worldDrift}m`,
      );
    }
}
near(
  pose(threat, 'Stalk', 0, 'ankle-left').point[2] -
    pose(threat, 'Stalk', 1.1, 'ankle-left').point[2],
  0.8,
  0.0001,
);
for (const [clip, landmark, a, b, minimum] of [
  ['Idle', 'helmet', 0, 1.7, 0.003],
  ['Stalk', 'knee-left', 0, 1.1, 0.25],
  ['Search', 'helmet', 1.1, 3.6, 0.6],
  ['Lunge', 'shoulder-left', 0, 0.65, 0.5],
]) {
  const start = pose(threat, clip, a, landmark),
    end = pose(threat, clip, b, landmark);
  const displacement = Math.sqrt(
    start.point.reduce((sum, value, i) => sum + (value - end.point[i]) ** 2, 0),
  );
  const rotationDelta = Math.sqrt(
    start.quaternion.reduce((sum, value, i) => sum + (value - end.quaternion[i]) ** 2, 0),
  );
  const measured = Math.max(displacement, rotationDelta);
  assert.ok(
    measured > minimum,
    `${clip} is not meaningfully articulated: ${measured} <= ${minimum}`,
  );
  motion.push({
    clip,
    landmark,
    displacementMeters: displacement,
    quaternionChord: rotationDelta,
    minimum,
    passed: true,
  });
}

for (const name of ['ceramic-basecolor.png', 'graphite-basecolor.png', 'station-reflection.png']) {
  const image = decodePng(await readFile(join(generated, name)));
  let seam = 0;
  for (let y = 0; y < image.height; y++)
    for (let c = 0; c < 3; c++)
      seam = Math.max(seam, Math.abs(image.get(0, y)[c] - image.get(image.width - 1, y)[c]));
  assert.ok(seam <= 1, `${name}: horizontal texture seam${seam}`);
}
const probe = new Raster(7, 5, [17, 30, 80, 255]);
probe.pixel(3, 2, [220, 1, 8, 128]);
assert.ok(decodePng(png(probe)).data.equals(probe.data));
assert.throws(() => decodePng(Buffer.from('not png')), /PNG/);
const corrupt = png(probe);
corrupt[corrupt.length - 1] ^= 1;
assert.throws(() => decodePng(corrupt), /CRC/);
assert.equal(provenance.conceptApproval.status, 'human-approved');
assert.equal(
  hash(await readFile(join(here, 'source', 'observation-concept.png'))),
  provenance.approvalConceptSha256,
);
for (const input of inventory.recipeInputs)
  assert.equal(
    hash(await readFile(join(here, ...input.file.split('/')))),
    input.sha256,
    `Cook source changed after output publication: ${input.file}`,
  );
process.stdout.write(
  `${JSON.stringify({ passed: true, productionClosure: prepared.files.length, totalBytes: countedBytes, floorCells: 789, doorCells: 18, wallFaces: 330, motion, locomotion: { halfCycleTravelMetres: 0.8, referenceSpeedMetresPerSecond: 1.6 / 2.2, soleSamples: 84, maximumSoleError, maximumWorldFootDrift } }, null, 2)}\n`,
);
