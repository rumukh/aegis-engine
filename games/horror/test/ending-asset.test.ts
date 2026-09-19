import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Gltf {
  nodes: { name: string }[];
  accessors: { bufferView: number; count: number; type: string }[];
  bufferViews: { byteOffset: number; byteLength: number }[];
  animations: {
    name: string;
    channels: { sampler: number; target: { node: number; path: string } }[];
    samplers: { input: number; output: number }[];
  }[];
  images: { uri: string }[];
}
const bytes = readFileSync('games/horror/assets/generated/evacuation-ending.glb');
const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as Gltf;
const binary = bytes.subarray(28 + jsonLength);
const clip = gltf.animations[0]!;
function values(accessor: number): number[] {
  const view = gltf.bufferViews[gltf.accessors[accessor]!.bufferView]!;
  return Array.from({ length: view.byteLength / 4 }, (_, index) =>
    binary.readFloatLE(view.byteOffset + index * 4),
  );
}
function track(node: string, path = 'translation') {
  const channel = clip.channels.find(
    (entry) => gltf.nodes[entry.target.node]?.name === node && entry.target.path === path,
  );
  if (channel === undefined) throw new Error(`Missing departure track: ${node}.${path}`);
  const sampler = clip.samplers[channel.sampler]!;
  return { times: values(sampler.input), values: values(sampler.output) };
}

describe('NULL MERIDIAN authored evacuation asset', () => {
  it('ships the fingerprinted separate 18-second model without adding new texture dependencies', () => {
    const provenance = JSON.parse(
      readFileSync('games/horror/assets/ending-provenance.json', 'utf8'),
    ) as { sha256: string; sourceSha256: string; bytes: number; durationSeconds: number };
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(provenance.sha256);
    expect(bytes.length).toBe(provenance.bytes);
    expect(
      createHash('sha256')
        .update(readFileSync('games/horror/assets/build-ending.mjs'))
        .digest('hex'),
    ).toBe(provenance.sourceSha256);
    expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
    expect(provenance.durationSeconds).toBe(18);
    expect(gltf.animations).toHaveLength(1);
    expect(clip.name).toBe('Departure');
    expect(Math.max(...clip.samplers.flatMap((sampler) => values(sampler.input)))).toBe(18);
    const inventory = JSON.parse(
      readFileSync('games/horror/assets/generated/inventory.json', 'utf8'),
    ) as { files: { file: string }[] };
    for (const image of gltf.images)
      expect(
        inventory.files.some((entry) => entry.file === image.uri),
        image.uri,
      ).toBe(true);
  });

  it('actually closes both hatch leaves and moves the capsule, not only the camera', () => {
    expect(track('hatch-left').values.slice(0, 3)).toEqual([0, 0, expect.closeTo(-1.6)]);
    expect(track('hatch-right').values.slice(0, 3)).toEqual([0, 0, expect.closeTo(1.6)]);
    for (const name of ['hatch-left', 'hatch-right']) {
      expect(track(name).times[2]).toBeCloseTo(2.2);
      expect(track(name).values.slice(6, 9)).toEqual([0, 0, 0]);
    }
    expect(track('independent-capsule').values.slice(0, 3)).toEqual([28, 0, 37]);
    expect(track('independent-capsule').values.slice(-3)).toEqual([92, 8, 74]);
    expect(track('departure-thrusters', 'scale').values.slice(0, 3)).toEqual([0, 0, 0]);
    expect(track('departure-thrusters', 'scale').values.slice(6, 9)).toEqual([1, 1, 1]);
    expect(track('ending-eye').values.slice(0, 3)).toEqual([
      expect.closeTo(29.2),
      expect.closeTo(1.8),
      37,
    ]);
    expect(track('ending-eye').values.slice(-3)).toEqual([140, 28, 8]);
    expect(track('ending-target').values.slice(-3)).toEqual([73, 7, 62]);
    expect(gltf.nodes.map((node) => node.name)).toContain('secured-crew-recorder');
  });
});
