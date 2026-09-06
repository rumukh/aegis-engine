import { Buffer } from 'node:buffer';

const STRUCTURE = {
  name: 'Ceramic and anodized alloy',
  pbrMetallicRoughness: {
    baseColorFactor: [1, 1, 1, 1],
    metallicFactor: 0.42,
    roughnessFactor: 0.56,
  },
};

function normal(a, b, c) {
  const u = b.map((v, i) => v - a[i]);
  const v = c.map((n, i) => n - a[i]);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.sqrt(n.reduce((sum, value) => sum + value * value, 0));
  if (length < 1e-10) throw new Error('Asset source contains a degenerate face');
  return n.map((value) => value / length);
}

/** Material-batched, flat-shaded geometry; the authoring inputs remain ordinary text. */
class Part {
  batches = new Map();

  face(points, color, material = 0, outward, uv) {
    let vertices = points;
    let coords =
      uv ??
      points.map(
        (_, i) =>
          [
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ][i % 4],
      );
    let n = normal(...vertices.slice(0, 3));
    if (outward && n.reduce((dot, value, i) => dot + value * outward[i], 0) < 0) {
      vertices = [...vertices].reverse();
      coords = [...coords].reverse();
      n = normal(...vertices.slice(0, 3));
    }
    if (!this.batches.has(material)) {
      this.batches.set(material, { positions: [], normals: [], colors: [], uvs: [], indices: [] });
    }
    const batch = this.batches.get(material);
    const start = batch.positions.length / 3;
    for (let i = 0; i < vertices.length; i++) {
      batch.positions.push(...vertices[i]);
      batch.normals.push(...n);
      batch.colors.push(...color);
      batch.uvs.push(...coords[i]);
    }
    for (let i = 1; i < vertices.length - 1; i++) {
      batch.indices.push(start, start + i, start + i + 1);
    }
    return this;
  }

  box(center, size, color, material = 0) {
    const [x, y, z] = center;
    const [w, h, d] = size.map((n) => n / 2);
    const point = (a, b, c) => [x + a * w, y + b * h, z + c * d];
    for (const [corners, outward] of [
      [
        [
          [-1, -1, 1],
          [1, -1, 1],
          [1, 1, 1],
          [-1, 1, 1],
        ],
        [0, 0, 1],
      ],
      [
        [
          [1, -1, -1],
          [-1, -1, -1],
          [-1, 1, -1],
          [1, 1, -1],
        ],
        [0, 0, -1],
      ],
      [
        [
          [1, -1, 1],
          [1, -1, -1],
          [1, 1, -1],
          [1, 1, 1],
        ],
        [1, 0, 0],
      ],
      [
        [
          [-1, -1, -1],
          [-1, -1, 1],
          [-1, 1, 1],
          [-1, 1, -1],
        ],
        [-1, 0, 0],
      ],
      [
        [
          [-1, 1, 1],
          [1, 1, 1],
          [1, 1, -1],
          [-1, 1, -1],
        ],
        [0, 1, 0],
      ],
      [
        [
          [-1, -1, -1],
          [1, -1, -1],
          [1, -1, 1],
          [-1, -1, 1],
        ],
        [0, -1, 0],
      ],
    ]) {
      this.face(
        corners.map((corner) => point(...corner)),
        color,
        material,
        outward,
      );
    }
    return this;
  }

  bevel(center, size, bevel, color, material = 0) {
    const [x, y, z] = center;
    const [w, h, d] = size.map((n) => n / 2);
    const b = Math.min(bevel, w * 0.4, h * 0.4, d * 0.4);
    const ring = (width, depth, height, cut) =>
      [
        [-width + cut, -depth],
        [width - cut, -depth],
        [width, -depth + cut],
        [width, depth - cut],
        [width - cut, depth],
        [-width + cut, depth],
        [-width, depth - cut],
        [-width, -depth + cut],
      ].map(([px, pz]) => [x + px, y + height, z + pz]);
    const rings = [
      ring(w - b, d - b, -h, b / 2),
      ring(w, d, -h + b, b),
      ring(w, d, h - b, b),
      ring(w - b, d - b, h, b / 2),
    ];
    this.face(rings[0], color, material, [0, -1, 0]);
    this.face(rings[3], color, material, [0, 1, 0]);
    for (let layer = 0; layer < 3; layer++) {
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) % 8;
        const points = [rings[layer][i], rings[layer][j], rings[layer + 1][j], rings[layer + 1][i]];
        this.face(points, color, material, [points[0][0] - x, 0, points[0][2] - z]);
      }
    }
    return this;
  }

  prism(center, radius, height, color, material = 0, sides = 12, innerRadius = 0) {
    const [x, y, z] = center;
    const circle = (r, h) =>
      Array.from({ length: sides }, (_, i) => {
        const angle = (i / sides) * Math.PI * 2;
        return [x + Math.cos(angle) * r, y + h, z + Math.sin(angle) * r];
      });
    const bottom = circle(radius, -height / 2);
    const top = circle(radius, height / 2);
    const innerBottom = innerRadius > 0 ? circle(innerRadius, -height / 2) : [];
    const innerTop = innerRadius > 0 ? circle(innerRadius, height / 2) : [];
    if (innerRadius === 0) {
      this.face(top, color, material, [0, 1, 0]);
      this.face(bottom, color, material, [0, -1, 0]);
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const outward = [top[i][0] - x, 0, top[i][2] - z];
      this.face([bottom[i], bottom[j], top[j], top[i]], color, material, outward);
      if (innerRadius > 0) {
        this.face(
          [innerBottom[i], innerTop[i], innerTop[j], innerBottom[j]],
          color,
          material,
          outward.map((v) => -v),
        );
        this.face([top[i], top[j], innerTop[j], innerTop[i]], color, material, [0, 1, 0]);
        this.face(
          [bottom[i], innerBottom[i], innerBottom[j], bottom[j]],
          color,
          material,
          [0, -1, 0],
        );
      }
    }
    return this;
  }
}

export function rgb(hex) {
  return [1, 3, 5].map((offset) => {
    const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
}

export class Model {
  nodes = [{ name: 'root', children: [] }];
  parts = new Map();
  materials = [STRUCTURE];
  images = [];
  textures = [];
  animations = [];

  constructor(name) {
    this.name = name;
  }

  part(name, translation = [0, 0, 0], parent = 0) {
    const index = this.nodes.length;
    this.nodes.push({ name, translation, children: [] });
    this.nodes[parent].children.push(index);
    const part = new Part();
    this.parts.set(index, part);
    return { index, shape: part };
  }

  glow(name, color, strength = 1) {
    const index = this.materials.length;
    const linear = rgb(color);
    this.materials.push({
      name,
      pbrMetallicRoughness: {
        baseColorFactor: [...linear, 1],
        metallicFactor: 0.05,
        roughnessFactor: 0.35,
      },
      emissiveFactor: linear.map((value) => value * strength),
    });
    return index;
  }

  texture(name, uri, emission) {
    const index = this.materials.length;
    const add = (file) => {
      const texture = this.textures.length;
      this.textures.push({ source: this.images.length, sampler: 0 });
      this.images.push({ uri: file });
      return { index: texture };
    };
    const material = {
      name,
      pbrMetallicRoughness: {
        baseColorTexture: add(uri),
        metallicFactor: 0.25,
        roughnessFactor: 0.62,
      },
    };
    if (emission) {
      material.emissiveTexture = add(emission);
      material.emissiveFactor = [0.8, 0.8, 0.8];
    }
    this.materials.push(material);
    return index;
  }

  animation(name, tracks) {
    this.animations.push({ name, tracks });
    return this;
  }

  encode() {
    const chunks = [];
    const bufferViews = [];
    const accessors = [];
    const meshes = [];
    let byteLength = 0;
    const append = (values, width, componentType, target) => {
      const bytes = componentType === 5123 ? 2 : 4;
      const padding = (4 - (byteLength % 4)) % 4;
      if (padding) {
        chunks.push(Buffer.alloc(padding));
        byteLength += padding;
      }
      const data = Buffer.alloc(values.length * bytes);
      for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) throw new Error(`${this.name}: non-finite geometry`);
        if (bytes === 2) data.writeUInt16LE(values[i], i * bytes);
        else data.writeFloatLE(values[i], i * bytes);
      }
      const view = bufferViews.length;
      bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length, target });
      chunks.push(data);
      byteLength += data.length;
      const accessor = {
        bufferView: view,
        componentType,
        count: values.length / width,
        type: width === 1 ? 'SCALAR' : `VEC${width}`,
      };
      if (width === 3 || (width === 1 && componentType === 5126)) {
        accessor.min = Array.from({ length: width }, (_, axis) =>
          Math.min(...values.filter((_, i) => i % width === axis).map(Math.fround)),
        );
        accessor.max = Array.from({ length: width }, (_, axis) =>
          Math.max(...values.filter((_, i) => i % width === axis).map(Math.fround)),
        );
      }
      accessors.push(accessor);
      return accessors.length - 1;
    };
    let triangles = 0;
    for (const [nodeIndex, part] of this.parts) {
      const primitives = [];
      for (const [material, batch] of part.batches) {
        if (batch.positions.length / 3 > 65535)
          throw new Error('Asset exceeds 16-bit geometry budget');
        primitives.push({
          attributes: {
            POSITION: append(batch.positions, 3, 5126, 34962),
            NORMAL: append(batch.normals, 3, 5126, 34962),
            COLOR_0: append(batch.colors, 3, 5126, 34962),
            TEXCOORD_0: append(batch.uvs, 2, 5126, 34962),
          },
          indices: append(batch.indices, 1, 5123, 34963),
          material,
        });
        triangles += batch.indices.length / 3;
      }
      if (primitives.length > 0) {
        this.nodes[nodeIndex].mesh = meshes.length;
        meshes.push({ name: this.nodes[nodeIndex].name, primitives });
      }
    }
    const animations = this.animations.map(({ name, tracks }) => ({
      name,
      samplers: tracks.map((track) => ({
        input: append(track.times, 1, 5126),
        output: append(track.values.flat(), track.path === 'rotation' ? 4 : 3, 5126),
        interpolation: track.interpolation ?? 'LINEAR',
      })),
      channels: tracks.map((track, sampler) => ({
        sampler,
        target: { node: track.node, path: track.path },
      })),
    }));
    const gltf = {
      asset: {
        version: '2.0',
        generator: 'Aegis Server Vault original procedural kit v1',
        copyright: '2026 Aegis contributors. MIT. See LICENSE.txt.',
      },
      scene: 0,
      scenes: [{ name: this.name, nodes: [0] }],
      nodes: this.nodes.map(({ children, ...node }) =>
        children.length > 0 ? { ...node, children } : node,
      ),
      meshes,
      materials: this.materials,
      accessors,
      bufferViews,
      buffers: [
        {
          byteLength,
          uri: `data:application/octet-stream;base64,${Buffer.concat(chunks).toString('base64')}`,
        },
      ],
      extras: {
        units: 'One unit is one navigation cell. +Y up; actors face +Z; origin at feet.',
        triangles,
        primitives: meshes.reduce((sum, mesh) => sum + mesh.primitives.length, 0),
        source: 'source/generate.mjs',
      },
    };
    if (animations.length > 0) gltf.animations = animations;
    if (this.textures.length > 0) {
      gltf.images = this.images;
      gltf.textures = this.textures;
      gltf.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    }
    return gltf;
  }
}
