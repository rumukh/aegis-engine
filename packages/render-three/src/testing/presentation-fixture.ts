import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { PresentationManifest, PresentationSource } from '../presentation/schema.js';

const provenance = {
  author: 'Aegis contributors',
  license: 'MIT',
  source: 'packages/render-three/src/testing/presentation-fixture.ts',
};

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) !== 0 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, bytes: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([size, name, bytes, crc]);
}

/** Original two-color RGBA tiles; one transparent corner also exercises alpha decoding. */
export function fixturePng(palette: 'surface' | 'rig' = 'surface'): Buffer {
  const size = 32;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const at = y * (size * 4 + 1) + 1 + x * 4;
      const stripe = ((x >> 2) + (y >> 2)) % 2 === 0;
      pixels.set(
        palette === 'rig'
          ? stripe
            ? [230, 255, 255, 255]
            : [35, 105, 185, 255]
          : stripe
            ? [255, 168, 42, 255]
            : [38, 190, 225, 255],
        at,
      );
      if (x < 2 && y < 2) pixels[at + 3] = 0;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A short original decaying tone, encoded as ordinary PCM rather than an audio dependency. */
export function fixtureWav(): Buffer {
  const rate = 22050;
  const samples = 5512;
  const out = Buffer.alloc(44 + samples * 2);
  out.write('RIFF');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    out.writeInt16LE(
      Math.round(Math.sin((i / rate) * 440 * Math.PI * 2) * (1 - i / samples) * 8000),
      44 + i * 2,
    );
  return out;
}

/** A textured diamond-bodied rig with a separate rotating fin, not a renamed box primitive. */
export function fixtureGltf(withTexture = true): string {
  const positions = new Float32Array([
    0, 1, 0, -0.6, 0, 0.3, 0.6, 0, 0.3, 0, 1, 0, 0.6, 0, 0.3, 0, 0, -0.5, 0, 1, 0, 0, 0, -0.5, -0.6,
    0, 0.3, -0.6, 0, 0.3, 0, 0, -0.5, 0.6, 0, 0.3,
  ]);
  const uv = new Float32Array(
    Array.from({ length: 12 }, (_, i) =>
      i % 3 === 0 ? [0.5, 1] : i % 3 === 1 ? [0, 0] : [1, 0],
    ).flat(),
  );
  const times = new Float32Array([0, 1, 2]);
  const rotations = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1]);
  const parts = [positions, uv, times, rotations];
  let offset = 0;
  const bufferViews = parts.map((part) => {
    const view = { buffer: 0, byteOffset: offset, byteLength: part.byteLength };
    offset += part.byteLength;
    return view;
  });
  const bytes = Buffer.concat(
    parts.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength)),
  );
  return JSON.stringify({
    asset: { version: '2.0', generator: provenance.source },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'fixture-rig', children: [1, 2] },
      { name: 'body', mesh: 0 },
      { name: 'fin', mesh: 0, translation: [0, 1.1, 0], scale: [0.7, 0.25, 0.25] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [
      {
        name: 'fixture-striped',
        doubleSided: true,
        pbrMetallicRoughness: {
          ...(withTexture
            ? { baseColorTexture: { index: 0 } }
            : { baseColorFactor: [0.2, 0.7, 0.9, 1] }),
          metallicFactor: 0.15,
          roughnessFactor: 0.6,
        },
      },
    ],
    ...(withTexture ? { textures: [{ source: 0 }], images: [{ uri: 'rig.png' }] } : {}),
    buffers: [
      {
        byteLength: bytes.length,
        uri: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
      },
    ],
    bufferViews,
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 12,
        type: 'VEC3',
        min: [-0.6, 0, -0.5],
        max: [0.6, 1, 0.3],
      },
      { bufferView: 1, componentType: 5126, count: 12, type: 'VEC2' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [2] },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' },
    ],
    animations: [
      {
        name: 'spin',
        samplers: [{ input: 2, output: 3, interpolation: 'LINEAR' }],
        channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }],
      },
    ],
  });
}

/** The same geometry in a GLB; Node can parse it without a browser's fetch progress events. */
export function fixtureGlb(instanced = false): ArrayBuffer {
  const source = JSON.parse(fixtureGltf(false)) as {
    buffers: { uri?: string; byteLength: number }[];
    nodes: { extensions?: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: number } } } }[];
    extensionsUsed?: string[];
  };
  if (instanced) {
    source.extensionsUsed = ['EXT_mesh_gpu_instancing'];
    source.nodes[1]!.extensions = {
      EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 0 } },
    };
  }
  const uri = source.buffers[0]?.uri;
  if (uri === undefined) throw new Error('Fixture buffer URI is missing.');
  const binary = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
  delete source.buffers[0]!.uri;
  const json = Buffer.from(JSON.stringify(source));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const binLength = Math.ceil(binary.length / 4) * 4;
  const glb = Buffer.alloc(12 + 8 + jsonLength + 8 + binLength);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonLength, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  glb.fill(0x20, 20, 20 + jsonLength);
  json.copy(glb, 20);
  glb.writeUInt32LE(binLength, 20 + jsonLength);
  glb.writeUInt32LE(0x004e4942, 24 + jsonLength);
  binary.copy(glb, 28 + jsonLength);
  return Uint8Array.from(glb).buffer;
}

export const FIXTURE_MANIFEST: PresentationManifest = {
  aegis: 'presentation/1',
  assets: [
    {
      id: 'surface',
      kind: 'texture',
      src: 'surface.png',
      provenance,
      frames: { left: [0, 0, 0.5, 1], right: [0.5, 0, 1, 1] },
    },
    { id: 'rig', kind: 'gltf', src: 'rig.gltf', provenance },
    { id: 'tone', kind: 'audio', src: 'tone.wav', provenance },
  ],
  materials: [
    { id: 'striped', shading: 'standard', map: 'surface', roughness: 0.65, metalness: 0.1 },
  ],
  surfaces: { wall: 'striped', floor: 'striped' },
  objects: [
    {
      id: 'specimen',
      visual: { kind: 'model', mesh: 'rig', clip: 'spin' },
      pose: { position: [0, 0, 4] },
    },
  ],
  audio: { cues: [{ event: 'player.jumped', asset: 'tone' }] },
};

export function writePresentationFixture(root: string): PresentationSource {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'surface.png'), fixturePng());
  writeFileSync(join(root, 'rig.png'), fixturePng('rig'));
  writeFileSync(join(root, 'rig.gltf'), fixtureGltf());
  writeFileSync(join(root, 'tone.wav'), fixtureWav());
  return { assetRoot: root, manifest: structuredClone(FIXTURE_MANIFEST) };
}
