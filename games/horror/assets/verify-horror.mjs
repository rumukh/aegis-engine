import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  AnimationClip,
  AnimationMixer,
  Group,
  QuaternionKeyframeTrack,
  Ray,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import { preparePresentation } from '@aegis/render-three/presentation/node';
import { responderModel } from './lib/responder.mjs';

const here = dirname(fileURLToPath(import.meta.url)),
  options = new Map(),
  args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(
    ['--candidate', '--baseline', '--report'].includes(args[i]) &&
      args[i + 1] &&
      !options.has(args[i]),
  );
  options.set(args[i], resolve(args[i + 1]));
}
assert.ok(options.has('--candidate') && options.has('--report'));
const candidate = options.get('--candidate'),
  baseline = options.get('--baseline') ?? join(here, 'generated');
const prior = JSON.parse(await readFile(join(baseline, 'inventory.json'), 'utf8'));
const inventory = JSON.parse(await readFile(join(candidate, 'inventory.json'), 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(prior.budget.totalBytes, 38117885);
assert.equal(inventory.files.length, 41);
const sourceLineEndingBridges = [];
for (const input of inventory.prototypeSources) {
  const bytes = await readFile(join(here, ...input.file.split('/')));
  const rawSha256 = sha(bytes);
  if (rawSha256 === input.sha256) continue;
  assert.ok(
    input.lfSha256 && /\.(mjs|json)$/.test(input.file),
    `Prototype binary source changed: ${input.file}`,
  );
  assert.equal(
    sha(bytes.toString('utf8').replaceAll('\r\n', '\n')),
    input.lfSha256,
    `Prototype source content changed: ${input.file}`,
  );
  sourceLineEndingBridges.push({
    file: input.file,
    originalRawSha256: input.sha256,
    checkoutRawSha256: rawSha256,
    lfSha256: input.lfSha256,
    difference: 'CRLF/LF only; no binary tolerance',
  });
}
for (const file of inventory.files)
  assert.equal(sha(await readFile(join(candidate, file.file))), file.sha256);
for (const file of prior.files.filter((entry) => entry.file !== 'responder.glb'))
  assert.equal(
    sha(await readFile(join(candidate, file.file))),
    file.sha256,
    `Unrelated accepted runtime changed: ${file.file}`,
  );
const originalMaterial = JSON.parse(
  await readFile(join(here, 'source', 'horror-pass.recipe.json'), 'utf8'),
);
assert.equal(
  originalMaterial.status,
  'first representative prototype; parent/user creative approval pending',
);
const prepared = preparePresentation({
  assetRoot: candidate,
  manifest: {
    aegis: 'presentation/1',
    assets: inventory.files.map((file) => ({
      id: file.file,
      src: file.file,
      kind: file.file.endsWith('.glb') ? 'gltf' : 'texture',
      provenance: {
        author: 'Aegis original authored assets / documented generated source derivatives',
        license: 'Mixed project-generated terms; see prototype-provenance.json',
        source: 'source/horror-pass.recipe.json',
      },
    })),
  },
});
assert.equal(prepared.totalBytes, inventory.budget.totalBytes);
assert.equal(prepared.files.length, 41);
assert.ok(prepared.totalBytes <= 48 * 1024 * 1024);

async function glb(path) {
  const bytes = await readFile(path),
    length = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.toString('utf8', 20, 20 + length)),
    binary = bytes.subarray(28 + length);
  const accessor = (index) => {
    const a = doc.accessors[index],
      view = doc.bufferViews[a.bufferView],
      size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    assert.ok(size && [5125, 5126].includes(a.componentType));
    const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return Array.from({ length: a.count * size }, (_, i) => {
      const value =
        a.componentType === 5126
          ? binary.readFloatLE(offset + i * 4)
          : binary.readUInt32LE(offset + i * 4);
      assert.ok(Number.isFinite(value));
      return value;
    });
  };
  const material = (input, field = '') => {
    if (!input || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map((value) => material(value));
    if (field.endsWith('Texture')) {
      const { index, ...rest } = input,
        texture = doc.textures[index];
      return {
        ...rest,
        uri: doc.images[texture.source].uri,
        sampler: doc.samplers[texture.sampler],
      };
    }
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, material(value, key)]),
    );
  };
  const parts = doc.meshes.flatMap((mesh) =>
    mesh.primitives.map((part) => ({
      node: mesh.name,
      material: material(doc.materials[part.material]),
      positions: accessor(part.attributes.POSITION),
      normals: accessor(part.attributes.NORMAL),
      uv: accessor(part.attributes.TEXCOORD_0),
      indices: accessor(part.indices),
    })),
  );
  const clips = (doc.animations ?? []).map((clip) => ({
    name: clip.name,
    channels: clip.channels.map((channel) => {
      const sampler = clip.samplers[channel.sampler];
      return {
        node: doc.nodes[channel.target.node].name,
        path: channel.target.path,
        times: accessor(sampler.input),
        values: accessor(sampler.output),
        interpolation: sampler.interpolation,
      };
    }),
  }));
  return { doc, parts, clips };
}
const oldHero = await glb(join(baseline, 'responder.glb')),
  newHero = await glb(join(candidate, 'responder.glb'));
assert.deepEqual(
  newHero.doc.nodes.map((node) =>
    Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'mesh')),
  ),
  oldHero.doc.nodes.map((node) =>
    Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'mesh')),
  ),
  'Rig or bind pose changed',
);
for (const name of ['Search', 'Lunge'])
  assert.deepEqual(
    newHero.clips.find((clip) => clip.name === name),
    oldHero.clips.find((clip) => clip.name === name),
    `${name} readability/timing changed`,
  );
const allowed = { Idle: ['helmet'], Stalk: ['helmet'] };
for (const name of ['Idle', 'Stalk']) {
  const before = oldHero.clips.find((clip) => clip.name === name),
    after = newHero.clips.find((clip) => clip.name === name);
  assert.deepEqual(
    after.channels.filter((track) => !allowed[name].includes(track.node)),
    before.channels.filter((track) => !allowed[name].includes(track.node)),
    `${name} non-head animation changed`,
  );
  assert.notDeepEqual(after.channels, before.channels, `${name} interruption did not exist`);
}
assert.deepEqual(
  newHero.parts.filter((part) => part.material.name === 'rescue-visor'),
  oldHero.parts.filter((part) => part.material.name === 'rescue-visor'),
  'Accepted r2 visor optical surface/material must remain exact',
);
for (const node of oldHero.doc.nodes
  .filter((node) => /^(pelvis|hip-|knee-|ankle-)/.test(node.name))
  .map((node) => node.name))
  assert.deepEqual(
    newHero.parts.filter((part) => part.node === node),
    oldHero.parts.filter((part) => part.node === node),
    `Lower-body geometry changed: ${node}`,
  );
for (const part of newHero.parts) {
  for (let i = 0; i < part.normals.length; i += 3)
    assert.ok(Math.abs(Math.hypot(...part.normals.slice(i, i + 3)) - 1) < 0.001);
  for (const index of part.indices) assert.ok(index < part.positions.length / 3);
  if (/^colony-|wound|blood/.test(part.material.name)) {
    assert.equal(part.material.emissiveFactor, undefined);
    assert.equal(part.material.extensions?.KHR_materials_unlit, undefined);
  }
}
const groups = newHero.doc.nodes.map((node) => {
  const group = new Group();
  group.name = node.name;
  group.position.fromArray(node.translation ?? [0, 0, 0]);
  group.quaternion.fromArray(node.rotation ?? [0, 0, 0, 1]);
  return group;
});
newHero.doc.nodes.forEach((node, i) =>
  node.children?.forEach((child) => groups[i].add(groups[child])),
);
const walk = newHero.clips.find((clip) => clip.name === 'Stalk');
const animation = new AnimationClip(
  'Stalk',
  -1,
  walk.channels.map((track) => {
    const Type = track.path === 'rotation' ? QuaternionKeyframeTrack : VectorKeyframeTrack;
    return new Type(
      `${track.node}.${track.path === 'rotation' ? 'quaternion' : 'position'}`,
      track.times,
      track.values,
    );
  }),
);
const mixer = new AnimationMixer(groups[0]);
mixer.clipAction(animation).play();
let soleError = 0,
  maximumSlip = 0;
for (const [name, start] of [
  ['ankle-left', 0],
  ['ankle-right', 1.1],
]) {
  for (const localZ of [-0.081, 0.205]) {
    let initial;
    for (let sample = 0; sample <= 20; sample++) {
      const time = start + (sample * 1.1) / 20;
      mixer.setTime(time);
      groups[0].updateMatrixWorld(true);
      const point = groups[0].getObjectByName(name).localToWorld(new Vector3(0, -0.115, localZ));
      initial ??= point.z + (time * 1.6) / 2.2;
      soleError = Math.max(soleError, Math.abs(point.y));
      maximumSlip = Math.max(maximumSlip, Math.abs(point.z + (time * 1.6) / 2.2 - initial));
    }
  }
}
assert.ok(soleError < 0.02 && maximumSlip < 0.02);
const afterBounds = inventory.models.find((model) => model.file === 'responder.glb').bounds;
const beforeBounds = prior.models.find((model) => model.file === 'responder.glb').bounds;
for (let axis = 0; axis < 3; axis++) {
  assert.ok(afterBounds.min[axis] >= beforeBounds.min[axis] - 0.00001);
  assert.ok(afterBounds.max[axis] <= beforeBounds.max[axis] + 0.00001);
}
const scene = await glb(join(candidate, 'struggle.glb'));
const grilleProbe = new Ray(new Vector3(3, 0.42, 15.43), new Vector3(1, 0, 0));
let firstHit = null;
for (const part of scene.parts) {
  if (part.material.alphaMode === 'BLEND') continue;
  for (let triangle = 0; triangle < part.indices.length; triangle += 3) {
    const points = part.indices
      .slice(triangle, triangle + 3)
      .map((index) => new Vector3(...part.positions.slice(index * 3, index * 3 + 3)));
    const hit = grilleProbe.intersectTriangle(...points, true, new Vector3());
    if (hit && (!firstHit || hit.x < firstHit.x))
      firstHit = { x: hit.x, material: part.material.name };
  }
}
assert.equal(
  firstHit?.material,
  'satin',
  'The bent grille, not an opaque rubber backing, must be the first visible surface',
);
let minimumSlateDistance = Infinity,
  maximumProjection = 0;
for (const part of scene.parts)
  for (let i = 0; i < part.positions.length; i += 3) {
    const [x, y, z] = part.positions.slice(i, i + 3);
    minimumSlateDistance = Math.min(minimumSlateDistance, Math.hypot(x - 7.55, z - 17));
    if (part.node === 'flush-directional-drag-evidence') assert.ok(y >= 0 && y <= 0.004);
    else {
      assert.ok(
        x >= 4.485 - 0.00001 && x <= 4.72 && y >= 0.18 && y <= 1.55 && z >= 15.3 && z <= 16.7,
      );
      maximumProjection = Math.max(maximumProjection, 4.5 - x);
    }
  }
assert.ok(minimumSlateDistance >= 2.8);
const clean = responderModel();
const cleanPath = join(candidate, 'clean-control.glb');
await clean.save(cleanPath);
assert.equal(
  sha(await readFile(cleanPath)),
  prior.files.find((file) => file.file === 'responder.glb').sha256,
  'Clean constructor behavior changed; prototype must be explicitly opt-in',
);
await rm(cleanPath);
const report = {
  revision: inventory.revision,
  passed: true,
  creativeStatus: 'Gate pending; engineering proof is not artistic approval',
  files: inventory.files,
  runtimeBytes: prepared.totalBytes,
  unchangedRuntimeFiles: 35,
  rigAndBindUnchanged: true,
  r2VisorExact: true,
  SearchAndLungeExact: true,
  lowerBodyGeometryAndChannelsExact: true,
  intentionalHeadOnlyChanges: inventory.intentionalAnimationDelta,
  afterBounds,
  beforeBounds,
  soleSamples: 84,
  soleError,
  maximumSlip,
  firstCluster: {
    ...inventory.placement.struggle,
    minimumSlateDistance,
    maximumProjection,
    grilleFrontRay: firstHit,
  },
  sourceHashes: inventory.prototypeSources,
  sourceLineEndingBridges,
};
await writeFile(options.get('--report'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(
  `${JSON.stringify({ passed: true, runtimeBytes: prepared.totalBytes, unchangedRuntimeFiles: 35, r2VisorExact: true, SearchAndLungeExact: true, soleError, maximumSlip, minimumSlateDistance, maximumProjection, report: options.get('--report') }, null, 2)}\n`,
);
