import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import {
  BoxGeometry,
  CylinderGeometry,
  Euler,
  Matrix3,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  BufferGeometry,
  Float32BufferAttribute,
  CatmullRomCurve3,
  TubeGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
export function rotation(axis, radians) {
  return new Quaternion().setFromAxisAngle(new Vector3(...AXES[axis]), radians).toArray();
}

export class Model {
  constructor(name, materials) {
    this.name = name;
    this.materials = materials;
    this.nodes = [{ name, children: [] }];
    this.parts = new Map();
    this.animations = [];
    this.features = [];
    this.transform = new Matrix4();
  }
  node(name, parent = 0, position = [0, 0, 0], quaternion = [0, 0, 0, 1]) {
    if (this.nodes.some((node) => node.name === name)) throw new Error(`Duplicate node ${name}`);
    const id = this.nodes.length;
    this.nodes.push({ name, translation: position, rotation: quaternion, children: [] });
    this.nodes[parent].children.push(id);
    return id;
  }
  add(node, material, geometry, position = [0, 0, 0], angles = [0, 0, 0], uvScale = null) {
    if (!this.materials[material]) throw new Error(`Undeclared material ${material}`);
    const expanded = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    const matrix = this.transform
      .clone()
      .multiply(
        new Matrix4().compose(
          new Vector3(...position),
          new Quaternion().setFromEuler(new Euler(...angles)),
          new Vector3(1, 1, 1),
        ),
      );
    expanded.applyMatrix4(matrix);
    const p = expanded.getAttribute('position'),
      n = expanded.getAttribute('normal'),
      uv = expanded.getAttribute('uv');
    if (!p || !n || !uv || p.count % 3 !== 0)
      throw new Error('Geometry lacks triangle position, normal or UV');
    const key = `${node}:${material}`;
    let part = this.parts.get(key);
    if (!part)
      this.parts.set(key, (part = { node, material, positions: [], normals: [], uvs: [] }));
    for (let i = 0; i < p.count; i++) {
      part.positions.push(p.getX(i), p.getY(i), p.getZ(i));
      part.normals.push(n.getX(i), n.getY(i), n.getZ(i));
      if (uvScale) {
        const normal = [Math.abs(n.getX(i)), Math.abs(n.getY(i)), Math.abs(n.getZ(i))];
        const axis = normal.indexOf(Math.max(...normal));
        const a = axis === 0 ? p.getZ(i) : p.getX(i);
        const b = axis === 1 ? p.getZ(i) : p.getY(i);
        part.uvs.push(a / uvScale, -b / uvScale);
      } else part.uvs.push(uv.getX(i), uv.getY(i));
    }
    expanded.dispose();
    geometry.dispose();
  }
  withTransform(position, angle, draw) {
    const previous = this.transform;
    this.transform = previous
      .clone()
      .multiply(new Matrix4().makeRotationY(angle).setPosition(...position));
    try {
      draw();
    } finally {
      this.transform = previous;
    }
  }
  box(node, material, position, size, bevel = 0, angles = [0, 0, 0]) {
    const geometry =
      bevel > 0
        ? new RoundedBoxGeometry(...size, 1, Math.min(bevel, ...size.map((v) => v * 0.24)))
        : new BoxGeometry(...size);
    this.add(node, material, geometry, position, angles, this.materials[material].tile ?? null);
  }
  cylinder(
    node,
    material,
    position,
    radius,
    height,
    axis = 'y',
    radiusTop = radius,
    segments = 16,
  ) {
    const angles =
      axis === 'x' ? [0, 0, Math.PI / 2] : axis === 'z' ? [Math.PI / 2, 0, 0] : [0, 0, 0];
    this.add(
      node,
      material,
      new CylinderGeometry(radiusTop, radius, height, segments),
      position,
      angles,
    );
  }
  sphere(node, material, position, size, width = 24, height = 12) {
    const geometry = new SphereGeometry(1, width, height);
    geometry.scale(...size);
    this.add(node, material, geometry, position);
  }
  torus(node, material, position, radius, tube, angles = [0, 0, 0], segments = 28) {
    this.add(node, material, new TorusGeometry(radius, tube, 6, segments), position, angles);
  }
  cable(node, material, points, radius = 0.018, segments = 16) {
    const curve = new CatmullRomCurve3(points.map((point) => new Vector3(...point)));
    this.add(node, material, new TubeGeometry(curve, segments, radius, 5, false));
  }
  quad(
    node,
    material,
    points,
    uvs = [
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  ) {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute(
        [0, 1, 2, 0, 2, 3].flatMap((i) => points[i]),
        3,
      ),
    );
    geometry.setAttribute(
      'uv',
      new Float32BufferAttribute(
        [0, 1, 2, 0, 2, 3].flatMap((i) => uvs[i]),
        2,
      ),
    );
    geometry.computeVertexNormals();
    this.add(node, material, geometry);
  }
  sign(node, position, width, height, row, angle = 0, material = 'labels') {
    this.decal(node, position, width, height, [0, row / 16, 1, 1 / 16], angle, material);
  }
  panel(node, position, width, height, tile, angle = 0) {
    this.decal(
      node,
      position,
      width,
      height,
      [(tile % 2) / 2, Math.floor(tile / 2) / 4, 0.5, 0.25],
      angle,
      'panel',
    );
  }
  badge(node, position, width, height, row = 0) {
    this.decal(node, position, width, height, [0, row / 4, 1, 0.25], 0, 'badge');
  }
  decal(node, position, width, height, rect, angle, material) {
    const transform = new Matrix4().makeRotationY(angle).setPosition(...position);
    const points = [
      [-width / 2, -height / 2, 0],
      [width / 2, -height / 2, 0],
      [width / 2, height / 2, 0],
      [-width / 2, height / 2, 0],
    ].map((point) => new Vector3(...point).applyMatrix4(transform).toArray());
    const [u, v, w, h] = rect;
    this.quad(node, material, points, [
      [u, v + h],
      [u + w, v + h],
      [u + w, v],
      [u, v],
    ]);
  }
  animation(name, tracks) {
    const keys = tracks.map((track) => `${track.node}:${track.path}`);
    if (new Set(keys).size !== keys.length)
      throw new Error(`Clip ${name} has competing tracks for the same node property`);
    this.animations.push({ name, tracks });
  }
  async save(path) {
    const chunks = [],
      bufferViews = [],
      accessors = [];
    let offset = 0;
    const put = (values, size, bounds = false) => {
      if (values.length % size) throw new Error('Incomplete accessor');
      const bytes = Buffer.alloc(values.length * 4);
      const min = Array(size).fill(Infinity),
        max = Array(size).fill(-Infinity);
      values.forEach((value, index) => {
        if (!Number.isFinite(value)) throw new Error(`${this.name}: non-finite vertex`);
        bytes.writeFloatLE(value, index * 4);
        min[index % size] = Math.min(min[index % size], value);
        max[index % size] = Math.max(max[index % size], value);
      });
      const bufferView = bufferViews.length;
      bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
      chunks.push(bytes);
      offset += bytes.length;
      accessors.push({
        bufferView,
        componentType: 5126,
        count: values.length / size,
        type: ['SCALAR', 'VEC2', 'VEC3', 'VEC4'][size - 1],
        ...(bounds ? { min, max } : {}),
      });
      return accessors.length - 1;
    };
    const indices = (values) => {
      const bytes = Buffer.alloc(values.length * 4);
      values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
      const bufferView = bufferViews.length;
      bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: 34963 });
      chunks.push(bytes);
      offset += bytes.length;
      accessors.push({ bufferView, componentType: 5125, count: values.length, type: 'SCALAR' });
      return accessors.length - 1;
    };
    const compact = (part) => {
      const positions = [],
        normals = [],
        uvs = [],
        index = [],
        seen = new Map();
      for (let vertex = 0; vertex < part.positions.length / 3; vertex++) {
        const p = part.positions.slice(vertex * 3, vertex * 3 + 3);
        const n = part.normals.slice(vertex * 3, vertex * 3 + 3);
        const uv = part.uvs.slice(vertex * 2, vertex * 2 + 2);
        const key = [...p, ...n, ...uv].map((value) => Math.round(value * 1e6)).join(',');
        let id = seen.get(key);
        if (id === undefined) {
          id = positions.length / 3;
          seen.set(key, id);
          positions.push(...p);
          normals.push(...n);
          uvs.push(...uv);
        }
        index.push(id);
      }
      return { positions, normals, uvs, index };
    };
    const used = [...new Set([...this.parts.values()].map((part) => part.material))];
    const images = [],
      textures = [],
      textureIds = new Map();
    const texture = (name) => {
      if (textureIds.has(name)) return textureIds.get(name);
      const index = images.length;
      images.push({ uri: name });
      textures.push({ source: index, sampler: 0 });
      textureIds.set(name, index);
      return index;
    };
    const materials = used.map((name) => {
      const m = this.materials[name];
      return {
        name,
        pbrMetallicRoughness: {
          baseColorFactor: m.color ?? [1, 1, 1, 1],
          roughnessFactor: m.rough ?? 1,
          metallicFactor: m.metal ?? 0,
          ...(m.map ? { baseColorTexture: { index: texture(m.map) } } : {}),
          ...(m.orm ? { metallicRoughnessTexture: { index: texture(m.orm) } } : {}),
        },
        ...(m.orm ? { occlusionTexture: { index: texture(m.orm), strength: m.ao ?? 0.6 } } : {}),
        ...(m.normal
          ? { normalTexture: { index: texture(m.normal), scale: m.normalScale ?? 0.3 } }
          : {}),
        ...(m.emission ? { emissiveFactor: m.emission } : {}),
        ...(m.emissiveMap ? { emissiveTexture: { index: texture(m.emissiveMap) } } : {}),
        ...(m.unlit ? { extensions: { KHR_materials_unlit: {} } } : {}),
        ...(m.double ? { doubleSided: true } : {}),
        ...(m.alpha
          ? { alphaMode: m.alpha, ...(m.alpha === 'MASK' ? { alphaCutoff: 0.5 } : {}) }
          : {}),
      };
    });
    const nodes = JSON.parse(JSON.stringify(this.nodes));
    const meshes = [];
    let triangles = 0;
    for (let node = 0; node < nodes.length; node++) {
      const parts = [...this.parts.values()].filter((part) => part.node === node);
      if (!parts.length) continue;
      nodes[node].mesh = meshes.length;
      meshes.push({
        name: nodes[node].name,
        primitives: parts.map((part) => {
          triangles += part.positions.length / 9;
          const vertex = compact(part);
          return {
            attributes: {
              POSITION: put(vertex.positions, 3, true),
              NORMAL: put(vertex.normals, 3),
              TEXCOORD_0: put(vertex.uvs, 2),
            },
            indices: indices(vertex.index),
            material: used.indexOf(part.material),
            mode: 4,
          };
        }),
      });
    }
    const animations = this.animations.map(({ name, tracks }) => ({
      name,
      samplers: tracks.map((track) => ({
        input: put(track.times, 1, true),
        output: put(track.values.flat(), track.path === 'rotation' ? 4 : 3),
        interpolation: 'LINEAR',
      })),
      channels: tracks.map((track, sampler) => ({
        sampler,
        target: { node: track.node, path: track.path },
      })),
    }));
    const document = {
      asset: {
        version: '2.0',
        generator: 'NULL MERIDIAN original authored kit 1',
        copyright: 'Original Aegis geometry; generated material provenance in provenance.json',
      },
      scene: 0,
      scenes: [{ name: this.name, nodes: [0] }],
      nodes: nodes.map(({ children, ...node }) => ({
        ...node,
        ...(children.length ? { children } : {}),
      })),
      meshes,
      materials,
      accessors,
      bufferViews,
      buffers: [{ byteLength: offset }],
      ...(images.length
        ? {
            images,
            textures,
            samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
          }
        : {}),
      ...(animations.length ? { animations } : {}),
      ...(used.some((name) => this.materials[name].unlit)
        ? { extensionsUsed: ['KHR_materials_unlit'] }
        : {}),
    };
    const json = Buffer.from(JSON.stringify(document));
    const paddedJson = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const binary = Buffer.concat(chunks);
    const header = Buffer.alloc(20);
    header.write('glTF');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(28 + paddedJson.length + binary.length, 8);
    header.writeUInt32LE(paddedJson.length, 12);
    header.writeUInt32LE(0x4e4f534a, 16);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binary.length);
    binHeader.writeUInt32LE(0x004e4942, 4);
    const bytes = Buffer.concat([header, paddedJson, binHeader, binary]);
    if (bytes.length > 32 * 1024 * 1024) throw new Error(`${this.name} exceeds 32MiB`);
    await writeFile(path, bytes);
    const world = new Map([[0, new Matrix4()]]);
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const walk = (node) => {
      for (const child of this.nodes[node].children) {
        world.set(
          child,
          world
            .get(node)
            .clone()
            .multiply(
              new Matrix4().compose(
                new Vector3(...this.nodes[child].translation),
                new Quaternion(...this.nodes[child].rotation),
                new Vector3(1, 1, 1),
              ),
            ),
        );
        walk(child);
      }
    };
    walk(0);
    for (const part of this.parts.values()) {
      const transform = world.get(part.node),
        ntransform = new Matrix3().getNormalMatrix(transform);
      for (let i = 0; i < part.positions.length; i += 3) {
        const p = new Vector3(...part.positions.slice(i, i + 3)).applyMatrix4(transform).toArray();
        const n = new Vector3(...part.normals.slice(i, i + 3)).applyMatrix3(ntransform);
        if (Math.abs(n.length() - 1) > 0.01) throw new Error('Non-unit surface normal');
        p.forEach((value, axis) => {
          bounds.min[axis] = Math.min(bounds.min[axis], value);
          bounds.max[axis] = Math.max(bounds.max[axis], value);
        });
      }
    }
    return {
      file: path.split(/[\\/]/).at(-1),
      bytes: bytes.length,
      triangles,
      primitives: this.parts.size,
      nodes: nodes.map((node) => node.name),
      materials: used,
      dependencies: [...textureIds.keys()],
      bounds,
      clips: this.animations.map(({ name, tracks }) => ({
        name,
        duration: Math.max(...tracks.flatMap((track) => track.times)),
        tracks: tracks.length,
      })),
    };
  }
}
