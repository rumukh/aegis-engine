import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ASSETS = 'games/fps/assets/generated';
const GENERATOR = 'games/fps/assets/generate.mjs';
type V2 = readonly [number, number];
type V3 = readonly [number, number, number];
interface Node {
  children?: number[];
  mesh?: number;
  translation?: V3;
  scale?: V3;
  rotation?: readonly [number, number, number, number];
}
interface Document {
  scene: number;
  scenes: { nodes: number[] }[];
  nodes: Node[];
  materials: { name: string }[];
  accessors: { bufferView: number; count: number; componentType: number; type: string }[];
  bufferViews: { byteOffset: number; byteLength: number }[];
  meshes: {
    primitives: {
      material: number;
      attributes: { POSITION: number; TEXCOORD_0: number };
    }[];
  }[];
}
interface Triangle {
  vertices: readonly [V3, V3, V3];
  uv: readonly [V2, V2, V2];
  material: string;
}
interface Inventory {
  assets: { file: string; sha256: string }[];
  textures: { file: string; sha256: string }[];
  audio: { file: string; sha256: string }[];
  sceneSha256: string;
}

function transformed(point: V3, node: Node): V3 {
  const scale = node.scale ?? [1, 1, 1];
  const [x, y, z] = point.map((v, i) => v * (scale[i] ?? 1));
  assert.ok(x !== undefined && y !== undefined && z !== undefined);
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [px, py, pz] = node.translation ?? [0, 0, 0];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty + px,
    y + qw * ty + qz * tx - qx * tz + py,
    z + qw * tz + qx * ty - qy * tx + pz,
  ];
}

// Read committed glTF triangles independently of both the generator and the renderer.
function triangles(file: string): Triangle[] {
  const bytes = readFileSync(join(ASSETS, file));
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, `${file}: glTF magic`);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString()) as Document;
  const binary = bytes.subarray(28 + jsonLength);
  const read = (accessorIndex: number, vertex: number, component: number, size: number) => {
    const accessor = doc.accessors[accessorIndex];
    assert.ok(accessor);
    assert.equal(accessor.componentType, 5126);
    assert.ok(vertex < accessor.count);
    const view = doc.bufferViews[accessor.bufferView];
    assert.ok(view);
    const offset = view.byteOffset + (vertex * size + component) * 4;
    assert.ok(offset + 4 <= view.byteOffset + view.byteLength && offset + 4 <= binary.length);
    const value = binary.readFloatLE(offset);
    assert.ok(Number.isFinite(value));
    return value;
  };
  const result: Triangle[] = [];
  const walk = (id: number, ancestors: readonly Node[]) => {
    const node = doc.nodes[id];
    assert.ok(node);
    const chain = [...ancestors, node];
    if (node.mesh !== undefined) {
      const mesh = doc.meshes[node.mesh];
      assert.ok(mesh);
      for (const primitive of mesh.primitives) {
        const position = primitive.attributes.POSITION;
        const texcoord = primitive.attributes.TEXCOORD_0;
        const accessor = doc.accessors[position];
        const material = doc.materials[primitive.material];
        assert.ok(accessor && material);
        assert.equal(accessor.count % 3, 0);
        const vertex = (at: number): V3 => {
          const p: V3 = [
            read(position, at, 0, 3),
            read(position, at, 1, 3),
            read(position, at, 2, 3),
          ];
          return chain.reduceRight<V3>((value, transform) => transformed(value, transform), p);
        };
        const uv = (at: number): V2 => [read(texcoord, at, 0, 2), read(texcoord, at, 1, 2)];
        for (let at = 0; at < accessor.count; at += 3) {
          result.push({
            vertices: [vertex(at), vertex(at + 1), vertex(at + 2)],
            uv: [uv(at), uv(at + 1), uv(at + 2)],
            material: material.name,
          });
        }
      }
    }
    for (const child of node.children ?? []) walk(child, chain);
  };
  const scene = doc.scenes[doc.scene];
  assert.ok(scene);
  for (const id of scene.nodes) walk(id, []);
  return result;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function cast(mesh: readonly Triangle[], origin: V3, direction: V3): number {
  let nearest = Infinity;
  for (const {
    vertices: [a, b, c],
  } of mesh) {
    const edge = sub(b, a);
    const other = sub(c, a);
    const p = cross(direction, other);
    const determinant = dot(edge, p);
    if (Math.abs(determinant) < 1e-9) continue;
    const t = sub(origin, a);
    const u = dot(t, p) / determinant;
    if (u < -1e-7 || u > 1 + 1e-7) continue;
    const q = cross(t, edge);
    const v = dot(direction, q) / determinant;
    if (v < -1e-7 || u + v > 1 + 1e-7) continue;
    const distance = dot(other, q) / determinant;
    if (distance > 1e-7) nearest = Math.min(nearest, distance);
  }
  return nearest;
}

describe('Sector Breach original assets', () => {
  it('rebuilds every shipped byte from source without touching the checkout', () => {
    const output = mkdtempSync(join(tmpdir(), 'aegis-fps-assets-'));
    try {
      execFileSync(process.execPath, [GENERATOR, '--out', output], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(readdirSync(output).sort()).toEqual(readdirSync(ASSETS).sort());
      for (const file of readdirSync(ASSETS)) {
        if (file === 'manifest.json') {
          expect(JSON.parse(readFileSync(join(output, file), 'utf8'))).toEqual(
            JSON.parse(readFileSync(join(ASSETS, file), 'utf8')),
          );
        } else {
          expect(
            readFileSync(join(output, file)).equals(readFileSync(join(ASSETS, file))),
            file,
          ).toBe(true);
        }
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it('ships real models, bounded textures and audible unclipped PCM with exact provenance', () => {
    const inventory = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8')) as Inventory;
    expect(inventory.assets.map((asset) => asset.file).sort()).toEqual([
      'blast-door.glb',
      'breach-panel.glb',
      'extraction-pad.glb',
      'kestrel-security.glb',
      'orbital-facility.glb',
      'vaultline-rifle.glb',
    ]);
    expect(inventory.textures).toHaveLength(6);
    expect(inventory.audio).toHaveLength(7);
    let total = 0;
    for (const entry of [...inventory.assets, ...inventory.textures, ...inventory.audio]) {
      const bytes = readFileSync(join(ASSETS, entry.file));
      total += bytes.length;
      expect(createHash('sha256').update(bytes).digest('hex'), entry.file).toBe(entry.sha256);
      expect(bytes.length).toBeLessThan(3_000_000);
    }
    expect(total).toBeLessThan(5_000_000);
    for (const texture of inventory.textures) {
      const bytes = readFileSync(join(ASSETS, texture.file));
      expect(bytes.readUInt32BE(0)).toBe(0x89504e47);
      expect(bytes.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
      expect(bytes.readUInt32BE(16)).toBeLessThanOrEqual(512);
      expect(bytes.readUInt32BE(20)).toBeLessThanOrEqual(512);
    }
    for (const audio of inventory.audio) {
      const bytes = readFileSync(join(ASSETS, audio.file));
      expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
      expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
      expect(bytes.readUInt16LE(20)).toBe(1);
      expect(bytes.readUInt16LE(22)).toBe(1);
      expect(bytes.readUInt32LE(24)).toBe(22_050);
      expect(bytes.readUInt16LE(34)).toBe(16);
      let peak = 0;
      for (let at = 44; at < bytes.length; at += 2)
        peak = Math.max(peak, Math.abs(bytes.readInt16LE(at)));
      expect(peak, audio.file).toBeGreaterThan(300);
      expect(peak, audio.file).toBeLessThan(31_130);
    }
  });

  it('keeps the robot, panel and blast door inside their existing collision bounds', () => {
    const fixtures: readonly [string, V3, V3, number, number][] = [
      ['kestrel-security.glb', [-0.4, 0, -0.5], [0.4, 2, 0.5], 1000, 2000],
      ['breach-panel.glb', [-0.3, 0.8, -0.6], [0.3, 2.4, 0.6], 100, 250],
      ['blast-door.glb', [-0.5, 0, -0.5], [0.5, 4, 0.5], 150, 300],
    ];
    for (const [file, minimum, maximum, minTriangles, maxTriangles] of fixtures) {
      const mesh = triangles(file);
      expect(mesh.length).toBeGreaterThanOrEqual(minTriangles);
      expect(mesh.length).toBeLessThanOrEqual(maxTriangles);
      for (const { vertices } of mesh)
        for (const point of vertices) {
          for (const axis of [0, 1, 2] as const) {
            assert.ok(
              point[axis] >= minimum[axis] - 1e-5 && point[axis] <= maximum[axis] + 1e-5,
              `${file}: geometry exceeds collision on axis ${axis}`,
            );
          }
        }
    }
    const weapon = triangles('vaultline-rifle.glb');
    expect(weapon.length).toBeGreaterThan(500);
    expect(weapon.length).toBeLessThan(1000);
    for (const { vertices } of weapon)
      for (const point of vertices) {
        // Reviewed camera attachment: no model vertex reaches the aim line or the near plane.
        expect(point[1] * 0.85 - 0.31).toBeLessThan(0);
        expect(point[2] * 0.85 - 0.9).toBeLessThan(-0.1);
      }
  });

  it('covers all 105 floor cells and 72 wall boundaries, including the opened door and coolant', () => {
    const mesh = triangles('orbital-facility.glb');
    expect(mesh.length).toBeGreaterThan(10_000);
    expect(mesh.length).toBeLessThan(18_000);
    const scene = JSON.parse(readFileSync('games/fps/levels/sector-breach.scene.json', 'utf8')) as {
      resources: {
        'fps.floorplan': {
          rows: string[];
          legend: Record<string, { solid: boolean; door?: boolean; floor: number }>;
        };
      };
    };
    const grid = scene.resources['fps.floorplan'];
    const cell = (col: number, row: number) => grid.legend[grid.rows[row]?.[col] ?? ''];
    let floors = 0;
    let walls = 0;
    for (let row = 0; row < 21; row++)
      for (let col = 0; col < 11; col++) {
        const here = cell(col, row);
        assert.ok(here);
        if (here.solid && !here.door) continue;
        const x = col - 5;
        const z = 20 - row;
        expect(cast(mesh, [x, here.floor + 0.1, z], [0, -1, 0]), `floor ${col},${row}`).toBeCloseTo(
          0.1,
          4,
        );
        floors++;
        for (const [dc, dr] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const neighbor = cell(col + dc, row + dr);
          if (!neighbor?.solid || neighbor.door) continue;
          const distance = cast(mesh, [x, 1.6, z], [dc, 0, -dr]);
          // At most 6.5 cm of surface trim; no corridor is narrowed by fake freestanding props.
          expect(Math.abs(distance - 0.5), `wall ${col},${row} toward ${dc},${dr}`).toBeLessThan(
            0.065,
          );
          walls++;
        }
      }
    expect(floors).toBe(105);
    expect(walls).toBe(72);
    expect(cast(mesh, [0, 0, 12], [0, -1, 0])).toBeCloseTo(0.5, 5);
  });

  it('maps wall-panel lettering upright rather than rotating the texture through 90 degrees', () => {
    let checked = 0;
    for (const triangle of triangles('orbital-facility.glb')) {
      if (triangle.material !== 'wall') continue;
      const ys = triangle.vertices.map((point) => point[1]);
      const minimum = Math.min(...ys);
      const maximum = Math.max(...ys);
      if (maximum - minimum < 2.5) continue;
      triangle.vertices.forEach((point, index) => {
        const uv = triangle.uv[index];
        assert.ok(uv);
        expect(uv[1]).toBe(point[1] === minimum ? 1 : 0);
      });
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});
