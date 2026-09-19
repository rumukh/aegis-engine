import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { preparePresentation } from '@aegis/render-three/presentation/node';
import { Raster, noise, png } from './lib/raster.mjs';

const here = dirname(fileURLToPath(import.meta.url)),
  options = new Map(),
  args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--body', '--out'].includes(args[i]) && args[i + 1] && !options.has(args[i]));
  options.set(args[i], resolve(args[i + 1]));
}
assert.ok(options.has('--body') && options.has('--out'));
const input = options.get('--body'),
  output = options.get('--out'),
  sourceRoot = dirname(input);
const bytes = await readFile(input),
  jsonLength = bytes.readUInt32LE(12);
const original = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
const originalBinary = bytes.subarray(28 + jsonLength);
const hash = (data) => createHash('sha256').update(data).digest('hex');
assert.equal(
  hash(bytes),
  'ff9969eadf19aea103e1800543c332f6dc1b001c52b8b5c3b976f7c40b98565f',
  'Use the frozen approved sculpt candidate, not a procedural predecessor',
);
const doc = JSON.parse(JSON.stringify(original));
const chunks = [originalBinary];
let offset = originalBinary.length;
const dimensions = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function values(index) {
  const a = original.accessors[index],
    view = original.bufferViews[a.bufferView];
  const size = dimensions[a.type],
    width = a.componentType === 5123 ? 2 : 4;
  return Array.from({ length: a.count * size }, (_, i) => {
    const at =
      (view.byteOffset ?? 0) +
      (a.byteOffset ?? 0) +
      Math.floor(i / size) * (view.byteStride ?? size * width) +
      (i % size) * width;
    return a.componentType === 5126
      ? originalBinary.readFloatLE(at)
      : a.componentType === 5123
        ? originalBinary.readUInt16LE(at)
        : originalBinary.readUInt32LE(at);
  });
}
function put(data, size, integer = false) {
  const buffer = Buffer.alloc(data.length * 4),
    min = Array(size).fill(Infinity),
    max = Array(size).fill(-Infinity);
  data.forEach((value, i) => {
    assert.ok(Number.isFinite(value));
    if (integer) buffer.writeUInt32LE(value, i * 4);
    else buffer.writeFloatLE(value, i * 4);
    min[i % size] = Math.min(min[i % size], value);
    max[i % size] = Math.max(max[i % size], value);
  });
  const bufferView = doc.bufferViews.length;
  doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buffer.length });
  chunks.push(buffer);
  offset += buffer.length;
  const index = doc.accessors.length;
  doc.accessors.push({
    bufferView,
    componentType: integer ? 5125 : 5126,
    count: data.length / size,
    type: ['SCALAR', 'VEC2', 'VEC3', 'VEC4'][size - 1],
    min,
    max,
  });
  return index;
}
const vertex = (p, n, uv) => ({ p: new Vector3(...p), n: new Vector3(...n), uv });
const interpolate = (a, b, t) => ({
  p: a.p.clone().lerp(b.p, t),
  n: a.n.clone().lerp(b.n, t).normalize(),
  uv: a.uv.map((value, i) => value + (b.uv[i] - value) * t),
});
function triangles(part) {
  const p = values(part.attributes.POSITION),
    n = values(part.attributes.NORMAL),
    uv = values(part.attributes.TEXCOORD_0),
    index = values(part.indices);
  const result = [];
  for (let i = 0; i < index.length; i += 3)
    result.push(
      index
        .slice(i, i + 3)
        .map((v) =>
          vertex(p.slice(v * 3, v * 3 + 3), n.slice(v * 3, v * 3 + 3), uv.slice(v * 2, v * 2 + 2)),
        ),
    );
  return result;
}
function subdivide(triangle, depth) {
  if (depth === 0) return [triangle];
  const [a, b, c] = triangle,
    ab = interpolate(a, b, 0.5),
    bc = interpolate(b, c, 0.5),
    ca = interpolate(c, a, 0.5);
  return [
    [a, ab, ca],
    [ab, b, bc],
    [ca, bc, c],
    [ab, bc, ca],
  ].flatMap((part) => subdivide(part, depth - 1));
}
function primitive(parts, material, uvMapper) {
  assert.ok(parts.length);
  const positions = [],
    normals = [],
    uvs = [],
    originalUvs = [],
    indices = [],
    cache = new Map();
  for (const tri of parts)
    for (const v of tri) {
      const mapped = uvMapper ? uvMapper(v) : v.uv;
      const key = [...v.p.toArray(), ...v.n.toArray(), ...mapped, ...v.uv]
        .map((value) => Math.round(value * 1e7))
        .join(',');
      let id = cache.get(key);
      if (id === undefined) {
        id = positions.length / 3;
        cache.set(key, id);
        positions.push(...v.p.toArray());
        normals.push(...v.n.toArray());
        uvs.push(...mapped);
        originalUvs.push(...v.uv);
      }
      indices.push(id);
    }
  const attributes = {
    POSITION: put(positions, 3),
    NORMAL: put(normals, 3),
    TEXCOORD_0: put(uvs, 2),
  };
  if (uvMapper) attributes.TEXCOORD_1 = put(originalUvs, 2);
  return { attributes, indices: put(indices, 1, true), material, mode: 4 };
}
function material(name, properties) {
  const index = doc.materials.length;
  doc.materials.push({ name, ...properties });
  return index;
}
const fracture = material('responder-damaged-composite-edge', {
  pbrMetallicRoughness: {
    baseColorFactor: [0.2, 0.19, 0.14, 1],
    metallicFactor: 0.08,
    roughnessFactor: 0.92,
  },
});
const backing = material('responder-pressure-underliner', {
  pbrMetallicRoughness: {
    baseColorFactor: [0.017, 0.02, 0.016, 1],
    metallicFactor: 0,
    roughnessFactor: 0.98,
  },
  doubleSided: true,
});
const fiber = material('responder-frayed-pressure-textile', {
  pbrMetallicRoughness: {
    baseColorFactor: [0.11, 0.1, 0.068, 1],
    metallicFactor: 0,
    roughnessFactor: 0.97,
  },
  doubleSided: true,
});

const base = new Raster(512, 512, [0, 0, 0, 0]),
  orm = new Raster(512, 512, [255, 230, 0, 255]);
const spot = (u, v, x, y, rx, ry) => Math.exp(-(((u - x) / rx) ** 2 + ((v - y) / ry) ** 2) * 2);
const softNoise = (u, v, seed) => {
  const x = Math.floor(u),
    y = Math.floor(v);
  const a = u - x,
    b = v - y;
  const sx = a * a * (3 - 2 * a),
    sy = b * b * (3 - 2 * b);
  return (
    noise(x, y, seed) * (1 - sx) * (1 - sy) +
    noise(x + 1, y, seed) * sx * (1 - sy) +
    noise(x, y + 1, seed) * (1 - sx) * sy +
    noise(x + 1, y + 1, seed) * sx * sy
  );
};
const marks = [];
for (let y = 0; y < 512; y++)
  for (let x = 0; x < 512; x++) {
    const tile = Math.floor(x / 256) + Math.floor(y / 256) * 2;
    const u = (x % 256) / 255,
      v = (y % 256) / 255;
    const broad = softNoise(u * 31, v * 29, 401 + tile);
    const warp = 0.022 * Math.sin(v * 39) + (broad - 0.5) * 0.04;
    const grain = noise(x, y, 817);
    let amount = 0,
      blood = true;
    if (tile === 0) {
      amount =
        0.91 * spot(u + warp, v, 0.67, 0.33, 0.32, 0.19) +
        0.89 * spot(u, v, 0.6, 0.55, 0.31, 0.26) +
        0.69 * spot(u, v, 0.72, 0.71, 0.22, 0.15);
      for (const [cx, end, width] of [
        [0.57, 0.94, 0.013],
        [0.7, 0.98, 0.009],
        [0.78, 0.87, 0.015],
      ]) {
        const drift = cx + 0.018 * Math.sin(v * 14 + cx * 3);
        if (v > 0.43 && v < end)
          amount +=
            Math.max(0, 1 - Math.abs(u - drift) / width) * (1 - (v - 0.43) / (end - 0.43)) * 0.77;
      }
      amount +=
        spot(u + warp, v, 0.31, 0.43, 0.27, 0.16) * 0.94 +
        spot(u, v, 0.36, 0.65, 0.23, 0.18) * 0.57;
      if (v > 0.57 && v < 0.91)
        amount += Math.max(0, 1 - Math.abs(u - 0.31 - warp * 0.3) / 0.012) * (0.91 - v) * 1.7;
    } else if (tile === 1) {
      amount =
        spot(u + warp, v, 0.64, 0.37, 0.47, 0.18) * 1.02 +
        spot(u, v, 0.36, 0.59, 0.31, 0.23) * 0.87;
      if (v > 0.49 && v < 0.9) amount += Math.max(0, 1 - Math.abs(u - 0.47 - warp) / 0.019) * 0.62;
    } else if (tile === 2) {
      blood = false;
      amount = spot(u, v, 0.58, 0.41, 0.36, 0.32) * 0.85;
      for (const line of [0.31, 0.43, 0.59]) {
        const d = Math.abs(u - (line + v * 0.38 + warp * 0.3));
        amount += Math.max(0, 1 - d / 0.013) * Math.max(0, 1 - Math.abs(v - 0.44) / 0.35) * 0.85;
      }
    } else {
      amount =
        spot(u + warp, v, 0.51, 0.38, 0.29, 0.21) * 0.71 +
        spot(u, v, 0.62, 0.63, 0.18, 0.29) * 0.49;
    }
    const fringe = Math.max(0, Math.min(1, (amount - 0.035 + (grain - 0.5) * 0.06) * 1.12));
    const edgeFade = Math.min(1, u * 30, (1 - u) * 30, v * 30, (1 - v) * 30);
    const alpha = Math.round(Math.min(0.96, fringe * (0.75 + broad * 0.25)) * edgeFade * 255);
    if (alpha < 3) continue;
    const wet = blood && tile < 2 && amount > 0.85 && broad > 0.69 && grain > 0.12;
    const color = blood
      ? [64 + broad * 26, 15 + broad * 16, 11 + broad * 9]
      : [32 + broad * 24, 31 + broad * 21, 24 + broad * 14];
    base.pixel(x, y, [...color, alpha]);
    orm.pixel(x, y, [255, wet ? 82 + broad * 17 : 218 + broad * 24, 0]);
    marks.push({ tile, alpha, wet });
  }
await mkdir(output);
const atlasFiles = ['responder-contact-stains.png', 'responder-contact-stains-orm.png'];
await writeFile(join(output, atlasFiles[0]), png(base));
await writeFile(join(output, atlasFiles[1]), png(orm));
const sampler = doc.samplers.length;
doc.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 });
const atlasTextures = atlasFiles.map((uri) => {
  const source = doc.images.length;
  doc.images.push({ uri });
  const texture = doc.textures.length;
  doc.textures.push({ source, sampler });
  return texture;
});
const stainMaterials = new Map();
function stainMaterial(originalIndex) {
  if (stainMaterials.has(originalIndex)) return stainMaterials.get(originalIndex);
  const old = original.materials[originalIndex];
  const id = material(`responder-contact-stain-${old.name}`, {
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      baseColorTexture: { index: atlasTextures[0] },
      metallicRoughnessTexture: { index: atlasTextures[1] },
      metallicFactor: 0,
      roughnessFactor: 1,
    },
    ...(old.normalTexture ? { normalTexture: { ...old.normalTexture, texCoord: 1 } } : {}),
    alphaMode: 'BLEND',
  });
  stainMaterials.set(originalIndex, id);
  return id;
}
const damage = [
  {
    node: 'thorax',
    material: 'suit-shell',
    center: [-0.129, 0.091],
    radius: [0.037, 0.043],
    depth: 0.009,
    floor: 0.18,
    level: 3,
    seed: 3,
  },
  {
    node: 'shoulder-left',
    material: 'suit-shell',
    center: [0.024, -0.015],
    radius: [0.032, 0.039],
    depth: 0.007,
    floor: 0.081,
    level: 3,
    seed: 7,
  },
  {
    node: 'elbow-left',
    material: 'suit-shell',
    center: [0.019, -0.09],
    radius: [0.022, 0.026],
    depth: 0.005,
    floor: 0.064,
    level: 3,
    seed: 11,
  },
  {
    node: 'shoulder-right',
    material: 'suit-textile',
    center: [-0.011, -0.225],
    radius: [0.026, 0.048],
    depth: 0.002,
    floor: 0.053,
    level: 2,
    seed: 9,
    fabric: true,
  },
];
const stainSpecs = [
  {
    node: 'thorax',
    materials: ['suit-shell', 'shell-edge', 'suit-textile'],
    rect: [-0.235, -0.29, 0.24, 0.27],
    tile: 0,
    front: 0.085,
  },
  {
    node: 'shoulder-left',
    materials: ['suit-shell', 'shell-edge', 'suit-textile'],
    rect: [-0.108, -0.3, 0.112, 0.075],
    tile: 2,
    front: 0.045,
  },
  {
    node: 'shoulder-right',
    materials: ['suit-shell', 'shell-edge', 'suit-textile'],
    rect: [-0.095, -0.31, 0.09, 0.075],
    tile: 1,
    front: 0.045,
  },
  {
    node: 'elbow-left',
    materials: ['suit-shell', 'suit-textile'],
    rect: [-0.077, -0.3, 0.077, -0.04],
    tile: 2,
    front: 0.04,
  },
  {
    node: 'elbow-right',
    materials: ['suit-shell', 'suit-textile', 'graphite'],
    rect: [-0.077, -0.31, 0.077, -0.04],
    tile: 1,
    front: 0.04,
  },
  {
    node: 'hip-right',
    materials: ['suit-textile'],
    rect: [-0.08, -0.29, 0.12, 0.055],
    tile: 3,
    front: 0.065,
  },
];
function clipTriangle(tri, rectangle) {
  let polygon = tri;
  for (const [axis, limit, sign] of [
    [0, rectangle[0], 1],
    [0, rectangle[2], -1],
    [1, rectangle[1], 1],
    [1, rectangle[3], -1],
  ]) {
    const next = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length],
        av = a.p.getComponent(axis),
        bv = b.p.getComponent(axis);
      const ain = (av - limit) * sign >= 0,
        bin = (bv - limit) * sign >= 0;
      if (ain) next.push(a);
      if (ain !== bin) next.push(interpolate(a, b, (limit - av) / (bv - av)));
    }
    polygon = next;
    if (!polygon.length) break;
  }
  return Array.from({ length: Math.max(0, polygon.length - 2) }, (_, i) => [
    polygon[0],
    polygon[i + 1],
    polygon[i + 2],
  ]);
}
const edits = [],
  stains = [],
  originalDescriptors = [];
for (const node of doc.nodes) {
  if (node.mesh === undefined) continue;
  const mesh = doc.meshes[node.mesh],
    extra = [];
  mesh.primitives = mesh.primitives.map((part) => {
    const name = original.materials[part.material].name;
    const rule = damage.find((entry) => entry.node === node.name && entry.material === name);
    const stain = stainSpecs.find(
      (entry) => entry.node === node.name && entry.materials.includes(name),
    );
    if (!rule && !stain) {
      originalDescriptors.push({ node: node.name, primitive: part });
      return part;
    }
    let faces = triangles(part),
      finalPart = part;
    if (rule) {
      const refined = [];
      for (const tri of faces) {
        const bounds = [
          Math.min(...tri.map((v) => v.p.x)),
          Math.min(...tri.map((v) => v.p.y)),
          Math.max(...tri.map((v) => v.p.x)),
          Math.max(...tri.map((v) => v.p.y)),
        ];
        const nearby =
          bounds[0] < rule.center[0] + rule.radius[0] * 1.8 &&
          bounds[2] > rule.center[0] - rule.radius[0] * 1.8 &&
          bounds[1] < rule.center[1] + rule.radius[1] * 1.8 &&
          bounds[3] > rule.center[1] - rule.radius[1] * 1.8;
        const front = tri.every((v) => v.n.z > 0.55 && v.p.z > rule.floor + 0.008);
        refined.push(...(front && nearby ? subdivide(tri, rule.level) : [tri]));
      }
      const kept = [],
        removed = [];
      const deform = (v) => {
        const result = { p: v.p.clone(), n: v.n.clone(), uv: [...v.uv] };
        const distance =
          ((v.p.x - rule.center[0]) / rule.radius[0]) ** 2 +
          ((v.p.y - rule.center[1]) / rule.radius[1]) ** 2;
        if (v.n.z > 0.55 && v.p.z > rule.floor + 0.008)
          result.p.z -= rule.depth * Math.exp(-distance * 0.9);
        return result;
      };
      for (const tri of refined) {
        const center = tri.reduce((sum, v) => sum.add(v.p), new Vector3()).multiplyScalar(1 / 3);
        const dx = (center.x - rule.center[0]) / rule.radius[0],
          dy = (center.y - rule.center[1]) / rule.radius[1];
        const angle = Math.atan2(dy, dx),
          jag = 0.6 + 0.12 * Math.sin(angle * 5 + rule.seed) + 0.08 * Math.cos(angle * 9);
        const cut =
          Math.hypot(dx, dy) < jag && tri.every((v) => v.n.z > 0.55 && v.p.z > rule.floor + 0.008);
        const deformed = tri.map(deform);
        if (cut) removed.push(deformed);
        else kept.push(deformed);
      }
      assert.ok(removed.length > 0, `No real fracture opened in ${node.name}/${name}`);
      const edgeKey = (a, b) =>
        [
          a.p
            .toArray()
            .map((v) => v.toFixed(6))
            .join(','),
          b.p
            .toArray()
            .map((v) => v.toFixed(6))
            .join(','),
        ]
          .sort()
          .join('|');
      const boundary = new Map();
      for (const tri of removed)
        for (let i = 0; i < 3; i++) {
          const a = tri[i],
            b = tri[(i + 1) % 3],
            key = edgeKey(a, b);
          if (boundary.has(key)) boundary.delete(key);
          else boundary.set(key, [a, b]);
        }
      const walls = [],
        dark = [];
      for (const [a, b] of boundary.values()) {
        const backA = { ...a, p: a.p.clone().setZ(rule.floor) },
          backB = { ...b, p: b.p.clone().setZ(rule.floor) };
        const normal = b.p.clone().sub(a.p).cross(backA.p.clone().sub(a.p)).normalize();
        const v = [a, b, backB, backA].map((p) => ({ ...p, n: normal }));
        walls.push([v[0], v[1], v[2]], [v[0], v[2], v[3]]);
      }
      for (const tri of removed)
        dark.push(
          tri.map((v) => ({ ...v, p: v.p.clone().setZ(rule.floor), n: new Vector3(0, 0, 1) })),
        );
      for (const tri of kept) {
        const normal = tri[1].p
          .clone()
          .sub(tri[0].p)
          .cross(tri[2].p.clone().sub(tri[0].p))
          .normalize();
        if (
          tri.some(
            (v) =>
              Math.abs(v.p.z - rule.floor) > 0.008 &&
              Math.hypot(
                (v.p.x - rule.center[0]) / rule.radius[0],
                (v.p.y - rule.center[1]) / rule.radius[1],
              ) < 1.7 &&
              v.n.z > 0.55,
          )
        )
          tri.forEach((v) => {
            v.n = normal.clone();
          });
      }
      faces = kept;
      finalPart = primitive(kept, part.material);
      extra.push(primitive(walls, rule.fabric ? fiber : fracture), primitive(dark, backing));
      if (rule.fabric) {
        const frays = [];
        [...boundary.values()]
          .filter((_, index) => index % 3 === 0)
          .slice(0, 7)
          .forEach(([a, b], i) => {
            const tip = a.p
              .clone()
              .lerp(b.p, 0.35)
              .add(new Vector3((i % 2 ? 1 : -1) * 0.004, -0.013 - i * 0.001, 0.001));
            frays.push([
              vertex(a.p.toArray(), [0, 0, 1], [0, 0]),
              vertex(a.p.clone().lerp(b.p, 0.16).toArray(), [0, 0, 1], [1, 0]),
              vertex(tip.toArray(), [0, 0, 1], [0.5, 1]),
            ]);
          });
        extra.push(primitive(frays, fiber));
      }
      edits.push({
        node: node.name,
        material: name,
        removedTriangles: removed.length,
        fractureBoundaryEdges: boundary.size,
        backingDepth: rule.floor,
        authorizedRegion: rule,
      });
    }
    if (stain) {
      const overlay = faces
        .filter((tri) => tri.every((v) => v.n.z > 0.45 && v.p.z > stain.front))
        .flatMap((tri) => clipTriangle(tri, stain.rect))
        .map((tri) => tri.map((v) => ({ ...v, p: v.p.clone().addScaledVector(v.n, 0.00045) })));
      if (overlay.length) {
        const [x0, y0, x1, y1] = stain.rect;
        const map = (v) => [
          (stain.tile % 2) * 0.5 + 0.002 + ((v.p.x - x0) / (x1 - x0)) * 0.496,
          Math.floor(stain.tile / 2) * 0.5 + 0.002 + ((y1 - v.p.y) / (y1 - y0)) * 0.496,
        ];
        extra.push(primitive(overlay, stainMaterial(part.material), map));
        stains.push({
          node: node.name,
          material: name,
          tile: stain.tile,
          triangles: overlay.length,
          region: stain.rect,
        });
      }
    }
    return finalPart;
  });
  mesh.primitives.push(...extra);
}
assert.equal(edits.length, 4);
const binary = Buffer.concat(chunks);
assert.ok(binary.subarray(0, originalBinary.length).equals(originalBinary));
assert.deepEqual(doc.nodes, original.nodes);
assert.deepEqual(doc.animations, original.animations);
for (const item of originalDescriptors)
  assert.ok(
    doc.meshes[doc.nodes.find((node) => node.name === item.node).mesh].primitives.some(
      (part) => JSON.stringify(part) === JSON.stringify(item.primitive),
    ),
  );
const readNew = (index) => {
  if (index < original.accessors.length) return values(index);
  const a = doc.accessors[index],
    view = doc.bufferViews[a.bufferView];
  return Array.from({ length: a.count * dimensions[a.type] }, (_, i) =>
    a.componentType === 5126
      ? binary.readFloatLE(view.byteOffset + i * 4)
      : binary.readUInt32LE(view.byteOffset + i * 4),
  );
};
const world = new Map();
function walk(index, parent) {
  const node = doc.nodes[index],
    m = parent
      .clone()
      .multiply(
        new Matrix4().compose(
          new Vector3(...(node.translation ?? [0, 0, 0])),
          new Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
          new Vector3(...(node.scale ?? [1, 1, 1])),
        ),
      );
  world.set(index, m);
  node.children?.forEach((child) => walk(child, m));
}
doc.scenes[doc.scene].nodes.forEach((node) => walk(node, new Matrix4()));
const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
let count = 0;
doc.nodes.forEach((node, index) => {
  if (node.mesh === undefined) return;
  for (const part of doc.meshes[node.mesh].primitives) {
    const p = readNew(part.attributes.POSITION),
      n = readNew(part.attributes.NORMAL);
    for (let i = 0; i < p.length; i += 3) {
      assert.ok(Math.abs(Math.hypot(...n.slice(i, i + 3)) - 1) < 0.002);
      const point = new Vector3(...p.slice(i, i + 3)).applyMatrix4(world.get(index)).toArray();
      point.forEach((v, axis) => {
        bounds.min[axis] = Math.min(bounds.min[axis], v);
        bounds.max[axis] = Math.max(bounds.max[axis], v);
      });
    }
    count += doc.accessors[part.indices].count / 3;
  }
});
const baselineBounds = {
  min: [-0.39416886276006696, -2.0861626315316073e-9, -0.3179999923706055],
  max: [0.3849999994635582, 2.0290000003576276, 0.2677024303901752],
};
for (let axis = 0; axis < 3; axis++) {
  assert.ok(
    bounds.min[axis] >= baselineBounds.min[axis] - 0.00001,
    `Negative envelope crossed:${axis}`,
  );
  assert.ok(
    bounds.max[axis] <= baselineBounds.max[axis] + 0.00001,
    `Positive envelope crossed:${axis}`,
  );
}
doc.buffers = [{ byteLength: binary.length }];
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
const result = Buffer.concat([header, padded, binHeader, binary]);
await writeFile(join(output, 'responder.glb'), result);
for (const image of original.images) {
  assert.ok(image.uri && /^[a-z0-9-]+\.(png|jpg)$/.test(image.uri));
  await copyFile(join(sourceRoot, image.uri), join(output, image.uri));
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
          author: 'Original Aegis bounded responder damage',
          license: 'Project-authored overlays/geometry; inherited source media provenance retained',
          source: 'damage-suit.mjs and source/suit-damage.recipe.json',
        },
      },
    ],
  },
});
const addedTextureBytes = (
  await Promise.all(atlasFiles.map((file) => readFile(join(output, file))))
).reduce((sum, data) => sum + data.length, 0);
const byteDelta = result.length - bytes.length + addedTextureBytes;
assert.ok(
  49252392 + byteDelta < 48 * 1024 * 1024,
  `Base48MiB guard exceeded by newactorpayload: ${byteDelta}`,
);
assert.ok(51241160 + byteDelta < 50 * 1024 * 1024);
assert.ok(52746947 + byteDelta < 64 * 1024 * 1024);
const sourceHash = hash(await readFile(fileURLToPath(import.meta.url)));
const recipe = JSON.parse(await readFile(join(here, 'source', 'suit-damage.recipe.json'), 'utf8'));
const proof = {
  stage:
    'ONE user-selected responder suit-damage checkpoint; neutral/torch parent review required before integration',
  input: { path: input, bytes: bytes.length, sha256: hash(bytes) },
  output: prepared.files,
  model: {
    file: 'responder.glb',
    bytes: result.length,
    sha256: hash(result),
    triangles: count,
    bounds,
  },
  source: { file: 'damage-suit.mjs', sha256: sourceHash },
  recipe,
  edits,
  stainRegions: stains,
  preservation: {
    originalBinaryPrefixIdentical: true,
    nodesAndAnimationsIdentical: true,
    unaffectedPrimitiveDescriptorsIdentical: originalDescriptors.length,
    sculptAndVisorUntouched: true,
    originalTextureFilesCopiedByteIdentically: original.images.length,
  },
  atlas: {
    width: 512,
    height: 512,
    tiles: 4,
    nontransparentTexels: marks.length,
    wetTexels: marks.filter((pixel) => pixel.wet).length,
    noEmission: true,
    noOriginalTextureReplacement: true,
  },
  budget: {
    byteDelta,
    newActorTextureBytes: addedTextureBytes,
    baseVisualBytes: 49252392 + byteDelta,
    allVisualIncludingEndingBytes: 51241160 + byteDelta,
    audioBytes: 1505787,
    combinedBytes: 52746947 + byteDelta,
    note: 'Actual actor-only dependency delta over independently measured73-file baseline; final production union still to be preflighted before any integration. Allguardsunchanged.',
  },
};
await writeFile(join(output, 'damage-proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ output, model: proof.model, edits, stains: stains.length, budget: proof.budget, stage: proof.stage }, null, 2)}\n`,
);
