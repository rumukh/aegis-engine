import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildAssets } from '../assets/source/generate.mjs';

const ROOT = fileURLToPath(new URL('../assets/', import.meta.url));
const FILES = [
  'access-console.gltf',
  'access-granted.wav',
  'armor-hit.wav',
  'deck-panel.png',
  'extraction-pad.gltf',
  'extraction.wav',
  'guard-alert.wav',
  'operative.gltf',
  'partition-panel.png',
  'provenance.json',
  'pulse-shot.wav',
  'route-denied.wav',
  'sentinel.gltf',
  'server-emission.png',
  'server-face.png',
  'server-rack.gltf',
  'service-partition.gltf',
  'terminal-active.png',
  'terminal-locked.png',
  'vault-air.wav',
  'vault-door.gltf',
  'vault-icons.svg',
  'vault-unseal.wav',
];

interface Gltf {
  asset: { version: string };
  buffers: { uri: string; byteLength: number }[];
  bufferViews: { byteOffset: number; byteLength: number }[];
  accessors: {
    bufferView: number;
    componentType: number;
    type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4';
    count: number;
  }[];
  nodes: { name: string; mesh?: number; translation?: number[]; children?: number[] }[];
  meshes: {
    primitives: { attributes: Record<string, number>; indices: number; material: number }[];
  }[];
  materials: unknown[];
  images?: { uri: string }[];
  animations?: {
    name: string;
    samplers: { input: number; output: number }[];
    channels: { sampler: number; target: { node: number; path: string } }[];
  }[];
}

function model(name: string): Gltf {
  return JSON.parse(readFileSync(join(ROOT, name), 'utf8')) as Gltf;
}

function values(gltf: Gltf, id: number): number[] {
  const accessor = gltf.accessors[id]!;
  const view = gltf.bufferViews[accessor.bufferView]!;
  const buffer = Buffer.from(gltf.buffers[0]!.uri.split(',')[1]!, 'base64');
  const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
  const bytes = accessor.componentType === 5123 ? 2 : 4;
  return Array.from({ length: accessor.count * width }, (_, i) =>
    bytes === 2
      ? buffer.readUInt16LE(view.byteOffset + i * bytes)
      : buffer.readFloatLE(view.byteOffset + i * bytes),
  );
}

function bounds(gltf: Gltf): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const visit = (index: number, parent: number[]): void => {
    const node = gltf.nodes[index]!;
    const position = parent.map((value, axis) => value + (node.translation?.[axis] ?? 0));
    if (node.mesh !== undefined) {
      for (const primitive of gltf.meshes[node.mesh]!.primitives) {
        const points = values(gltf, primitive.attributes['POSITION']!);
        for (let i = 0; i < points.length; i++) {
          const axis = i % 3;
          min[axis] = Math.min(min[axis]!, points[i]! + position[axis]!);
          max[axis] = Math.max(max[axis]!, points[i]! + position[axis]!);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, position);
  };
  visit(0, [0, 0, 0]);
  return { min, max };
}

describe('Server Vault original presentation assets', () => {
  it('reproduces the complete shipped kit byte for byte, with provenance and a bounded payload', () => {
    const generated = buildAssets();
    expect([...generated.keys()].sort()).toEqual(FILES);
    let total = 0;
    for (const [file, expected] of generated) {
      const actual = readFileSync(join(ROOT, file));
      expect(actual.equals(expected), `${file} has drifted from its reproducible source`).toBe(
        true,
      );
      total += actual.length;
    }
    expect(total).toBeLessThan(1_500_000);
    const provenance = JSON.parse(readFileSync(join(ROOT, 'provenance.json'), 'utf8')) as {
      license: string;
      assets: { file: string; bytes: number; sha256: string }[];
    };
    expect(provenance.license).toBe('MIT');
    expect(provenance.assets).toHaveLength(22);
    for (const asset of provenance.assets) {
      const bytes = readFileSync(join(ROOT, asset.file));
      expect(bytes.length).toBe(asset.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
    }
  });

  it('ships finite indexed glTF geometry with unit normals, complete local dependencies and few draw batches', () => {
    let triangles = 0;
    let primitives = 0;
    for (const file of FILES.filter((name) => name.endsWith('.gltf'))) {
      const gltf = model(file);
      expect(gltf.asset.version).toBe('2.0');
      expect(gltf.buffers).toHaveLength(1);
      const buffer = Buffer.from(gltf.buffers[0]!.uri.split(',')[1]!, 'base64');
      expect(buffer.length).toBe(gltf.buffers[0]!.byteLength);
      for (const view of gltf.bufferViews) {
        expect(view.byteOffset % 4).toBe(0);
        expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(buffer.length);
      }
      for (const image of gltf.images ?? []) {
        expect(image.uri).toMatch(/^[a-z-]+\.png$/);
        expect(readFileSync(join(ROOT, image.uri)).length).toBeGreaterThan(100);
      }
      for (const mesh of gltf.meshes) {
        for (const primitive of mesh.primitives) {
          const positions = values(gltf, primitive.attributes['POSITION']!);
          const normals = values(gltf, primitive.attributes['NORMAL']!);
          const indices = values(gltf, primitive.indices);
          expect(positions.length).toBeGreaterThanOrEqual(4 * 3);
          expect(positions.every(Number.isFinite)).toBe(true);
          expect(normals.length).toBe(positions.length);
          expect(indices.length % 3).toBe(0);
          expect(Math.max(...indices)).toBeLessThan(positions.length / 3);
          expect(primitive.material).toBeLessThan(gltf.materials.length);
          for (let i = 0; i < normals.length; i += 3) {
            const length = normals[i]! ** 2 + normals[i + 1]! ** 2 + normals[i + 2]! ** 2;
            expect(length).toBeCloseTo(1, 5);
          }
          triangles += indices.length / 3;
          primitives++;
        }
      }
    }
    expect(triangles).toBeGreaterThan(3_000);
    expect(triangles).toBeLessThan(8_000);
    expect(primitives).toBeLessThanOrEqual(48);
  });

  it('keeps tactical partitions and shutter geometry below the half-cell occlusion bound', () => {
    for (const file of ['service-partition.gltf', 'vault-door.gltf']) {
      const box = bounds(model(file));
      expect(box.min[1]).toBeGreaterThanOrEqual(-0.001);
      expect(box.max[1]).toBeGreaterThan(0.3);
      expect(box.max[1]).toBeLessThan(0.45);
      expect(box.max[0]! - box.min[0]!).toBeLessThanOrEqual(1.001);
      expect(box.max[2]! - box.min[2]!).toBeLessThanOrEqual(1.001);
    }
  });

  it('authors recognizable articulated silhouettes and independently meaningful motion clips', () => {
    for (const file of ['operative.gltf', 'sentinel.gltf']) {
      const gltf = model(file);
      expect(gltf.nodes.map((node) => node.name)).toEqual([
        'root',
        'torso',
        'head',
        'arm-left',
        'leg-left',
        'arm-right',
        'leg-right',
        'weapon',
      ]);
      const box = bounds(gltf);
      expect(box.min[1]).toBeCloseTo(0, 2);
      expect(box.max[1]).toBeGreaterThan(1.15);
      expect(box.max[1]).toBeLessThan(1.3);
      expect(box.max[0]! - box.min[0]!).toBeGreaterThan(0.6);
      expect(gltf.animations?.map((clip) => clip.name)).toEqual([
        'idle',
        'walk',
        'attack',
        'death',
      ]);
      const walk = gltf.animations!.find((clip) => clip.name === 'walk')!;
      expect(walk.channels.map((channel) => gltf.nodes[channel.target.node]!.name)).toEqual([
        'leg-left',
        'leg-right',
        'arm-left',
        'arm-right',
      ]);
      for (const clip of gltf.animations!) {
        for (const sampler of clip.samplers) {
          const times = values(gltf, sampler.input);
          expect(times[0]).toBe(0);
          expect(times.at(-1)).toBeGreaterThan(0.2);
          expect(times.every((time, i) => i === 0 || time > times[i - 1]!)).toBe(true);
          const output = values(gltf, sampler.output);
          const width = output.length / times.length;
          const changed = output.some((value, i) => Math.abs(value - output[i % width]!) > 0.005);
          expect(changed, `${file}/${clip.name} must actually move a part`).toBe(true);
        }
      }
    }
  });

  it('contains real decodable surface pixels and a visibly different active terminal state', () => {
    for (const file of FILES.filter((name) => name.endsWith('.png'))) {
      const bytes = readFileSync(join(ROOT, file));
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      expect(width).toBe(256);
      expect([256, 512]).toContain(height);
      const data: Buffer[] = [];
      for (let offset = 8; offset < bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        if (type === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
        offset += length + 12;
      }
      const pixels = inflateSync(Buffer.concat(data));
      expect(pixels.length).toBe(height * (width * 3 + 1));
      expect(new Set(pixels).size).toBeGreaterThan(6);
    }
    expect(
      readFileSync(join(ROOT, 'terminal-locked.png')).equals(
        readFileSync(join(ROOT, 'terminal-active.png')),
      ),
    ).toBe(false);
  });

  it('ships non-silent, unclipped PCM cues with quiet start/end boundaries', () => {
    for (const file of FILES.filter((name) => name.endsWith('.wav'))) {
      const bytes = readFileSync(join(ROOT, file));
      expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
      expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
      expect(bytes.readUInt16LE(20)).toBe(1);
      expect(bytes.readUInt16LE(22)).toBe(1);
      expect(bytes.readUInt32LE(24)).toBe(22_050);
      expect(bytes.readUInt16LE(34)).toBe(16);
      expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44);
      let peak = 0;
      let energy = 0;
      for (let offset = 44; offset < bytes.length; offset += 2) {
        const sample = bytes.readInt16LE(offset) / 32768;
        peak = Math.max(peak, Math.abs(sample));
        energy += sample * sample;
      }
      expect(peak).toBeGreaterThan(0.05);
      expect(peak).toBeLessThan(0.96);
      expect(energy / ((bytes.length - 44) / 2)).toBeGreaterThan(0.00001);
      expect(Math.abs(bytes.readInt16LE(44))).toBeLessThan(20);
      expect(Math.abs(bytes.readInt16LE(bytes.length - 2))).toBeLessThan(20);
    }
  });
});
