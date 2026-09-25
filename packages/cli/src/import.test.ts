import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from './cli.js';
import { COMMANDS } from './commands.js';
import type { ModeResolver } from './modes.js';

const noModes: ModeResolver = {
  available: () => {
    throw new Error('Import must not enumerate modes');
  },
  has: () => {
    throw new Error('Import must not inspect modes');
  },
  resolve: () => {
    throw new Error('Import must not initialize a plugin');
  },
};
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aegis-import-cli-'));
  // Independent triangle, not output manufactured by the importer being tested.
  const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  writeFileSync(
    join(root, 'triangle.gltf'),
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ uri: 'triangle.bin', byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
      ],
    }),
  );
  writeFileSync(join(root, 'triangle.bin'), positions);
  writeFileSync(
    join(root, 'provenance.json'),
    JSON.stringify({
      author: 'Aegis contributors',
      license: 'MIT',
      source: 'Original CLI test triangle',
    }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function cli(argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(
    {
      argv,
      cwd: root,
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    { modes: noModes },
  );
  return { code, out, err };
}
const args = [
  'import',
  'triangle.gltf',
  '--id',
  'hero',
  '--out-dir',
  'package',
  '--provenance',
  'provenance.json',
  '--json',
];

describe('aegis import', () => {
  it('resolves all paths against CLI cwd and emits the real receipt', async () => {
    const result = await cli(args);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      aegis: 'asset-import-result/1',
      status: 'imported',
      receipt: {
        aegis: 'asset-import/1',
        id: 'hero',
        descriptor: { path: 'asset.presentation.json' },
      },
    });
    expect(readFileSync(join(root, 'package', 'model', 'triangle.bin'))).toEqual(
      readFileSync(join(root, 'triangle.bin')),
    );
    expect((await cli(args)).code).toBe(2);
  });
  it('dry-runs without writing', async () => {
    const before = readdirSync(root);
    const result = await cli([...args, '--dry-run']);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).status).toBe('planned');
    expect(readdirSync(root)).toEqual(before);
  });
  it.each([
    ['import'],
    ['import', 'triangle.gltf'],
    [...args, '--force'],
    [...args, '--plugin', 'must-not-import'],
    [...args, 'extra.gltf'],
    [...args, '--dry-run=perhaps'],
  ])('refuses invalid requests: %j', async (...argv) => {
    const result = await cli(argv);
    expect(result.code).not.toBe(0);
    expect(result.err).not.toBe('');
    expect(existsSync(join(root, 'package'))).toBe(false);
  });
  it('reports missing dependencies as structured production diagnostics', async () => {
    rmSync(join(root, 'triangle.bin'));
    const result = await cli(args);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.err)).toMatchObject({ diagnostics: [{ code: 'AEG-RENDER-0004' }] });
  });
  it('wires live help and capability formats without a browser or plugin', async () => {
    const result = await cli(['import', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('--dry-run');
    expect(result.out).toContain('not visual approval');
    expect(COMMANDS.find((command) => command.name === 'import')?.formats).toEqual({
      reads: ['glTF/2.0', 'provenance-json'],
      writes: ['glTF/2.0', 'presentation/1', 'asset-import/1'],
      stdout: ['text', 'asset-import-result/1'],
    });
  });
});
