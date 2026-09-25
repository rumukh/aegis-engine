import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticError } from '@aegis/core';
import {
  AssetImportCode,
  importModelAsset,
  parseImportProvenance,
  readImportProvenance,
} from './asset-import.js';
import type { AssetImportOptions } from './asset-import.js';
import { preparePresentation } from './presentation/files.js';
import type { PresentationManifest } from './presentation/schema.js';
import { fixtureGlb, fixtureGltf, fixturePng } from './testing/presentation-fixture.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

const provenance = {
  author: 'Aegis contributors',
  license: 'MIT',
  source: 'Original independent test fixture',
};
let root: string;
let inputs: string;
let options: AssetImportOptions;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'aegis-import-'));
  inputs = join(root, 'source');
  fs.mkdirSync(inputs);
  fs.writeFileSync(join(inputs, 'rig.glb'), Buffer.from(fixtureGlb()));
  options = {
    source: join(inputs, 'rig.glb'),
    outDir: join(root, 'package'),
    id: 'responder',
    provenance,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function externalFixture(): {
  buffers: { uri: string; byteLength: number }[];
  images: { uri: string }[];
  extensionsRequired?: string[];
} {
  const model = JSON.parse(fixtureGltf()) as ReturnType<typeof externalFixture>;
  const buffer = model.buffers[0]!;
  fs.writeFileSync(join(inputs, 'geometry.bin'), Buffer.from(buffer.uri.split(',')[1]!, 'base64'));
  buffer.uri = 'geometry.bin';
  fs.writeFileSync(join(inputs, 'rig.png'), fixturePng('rig'));
  options.source = join(inputs, 'rig.gltf');
  fs.writeFileSync(options.source, JSON.stringify(model));
  return model;
}

function refuses(code: string): void {
  let error: unknown;
  try {
    importModelAsset(options);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(DiagnosticError);
  if (!(error instanceof DiagnosticError))
    throw new Error('Expected structured import diagnostics');
  expect(error.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  expect(fs.existsSync(options.outDir)).toBe(false);
  expect(fs.readdirSync(root).filter((name) => name.startsWith('.'))).toEqual([]);
}

describe('model import using the production dependency preflight', () => {
  it('packages unchanged GLB bytes with an independent receipt and portable descriptor', () => {
    const source = fs.readFileSync(options.source);
    const result = importModelAsset(options);
    expect(result.status).toBe('imported');
    expect(result.receipt.aegis).toBe('asset-import/1');
    expect(result.receipt.source.sha256).toBe(createHash('sha256').update(source).digest('hex'));
    expect(fs.readFileSync(join(options.outDir, 'model', 'rig.glb'))).toEqual(source);
    expect(fs.readFileSync(options.source)).toEqual(source);
    const descriptor = fs.readFileSync(join(options.outDir, 'asset.presentation.json'));
    expect(result.receipt.descriptor.sha256).toBe(
      createHash('sha256').update(descriptor).digest('hex'),
    );
    expect(JSON.parse(descriptor.toString())).toEqual({
      aegis: 'presentation/1',
      assets: [{ id: 'responder', kind: 'gltf', src: 'model/rig.glb', provenance }],
    });
    expect(fs.readdirSync(options.outDir).sort()).toEqual([
      'asset.presentation.json',
      'import.json',
      'model',
    ]);
    expect(JSON.parse(fs.readFileSync(join(options.outDir, 'import.json'), 'utf8'))).toEqual(
      result.receipt,
    );
    expect(JSON.stringify(result.receipt)).not.toContain(root);
    expect(result.receipt.review).toContain('not visual approval');
  });

  it('retains exact external buffer/texture URIs, excluding unrelated source files', () => {
    externalFixture();
    fs.writeFileSync(join(inputs, 'not-a-dependency.txt'), 'must not be distributed');
    const result = importModelAsset(options);
    expect(result.receipt.files.map((file) => file.path).sort()).toEqual([
      'model/geometry.bin',
      'model/rig.gltf',
      'model/rig.png',
    ]);
    for (const file of result.receipt.files)
      expect(fs.readFileSync(join(options.outDir, file.path))).toEqual(
        fs.readFileSync(join(inputs, file.source)),
      );
    const manifest = JSON.parse(
      fs.readFileSync(join(options.outDir, 'asset.presentation.json'), 'utf8'),
    ) as PresentationManifest;
    const prepared = preparePresentation({ manifest, assetRoot: options.outDir });
    expect(prepared.files).toHaveLength(3);
    expect(prepared.totalBytes).toBe(result.receipt.totalAssetBytes);
  });

  it('dry-runs the full dependency closure without even creating a reservation', () => {
    externalFixture();
    const before = fs.readdirSync(root, { recursive: true });
    const planned = importModelAsset({ ...options, dryRun: true });
    expect(planned.status).toBe('planned');
    expect(planned.receipt.files).toHaveLength(3);
    expect(fs.readdirSync(root, { recursive: true })).toEqual(before);
    expect(importModelAsset(options).receipt).toEqual(planned.receipt);
  });

  it.each(['file', 'empty-directory', 'nonempty-directory'])(
    'refuses existing %s without replacing it',
    (kind) => {
      if (kind === 'file') fs.writeFileSync(options.outDir, 'keep');
      else {
        fs.mkdirSync(options.outDir);
        if (kind === 'nonempty-directory')
          fs.writeFileSync(join(options.outDir, 'keep.txt'), 'keep');
      }
      expect(() => importModelAsset(options)).toThrow(/already exists/);
      expect(fs.existsSync(options.outDir)).toBe(true);
      if (kind === 'file') expect(fs.readFileSync(options.outDir, 'utf8')).toBe('keep');
      if (kind === 'empty-directory') expect(fs.readdirSync(options.outDir)).toEqual([]);
      if (kind === 'nonempty-directory')
        expect(fs.readFileSync(join(options.outDir, 'keep.txt'), 'utf8')).toBe('keep');
    },
  );

  it('refuses source aliases and leaves unrelated importer reservations intact', () => {
    expect(() => importModelAsset({ ...options, outDir: inputs })).toThrow(/already exists/);
    const lock = join(root, '.package.aegis-import.lock');
    fs.writeFileSync(lock, 'another owner');
    expect(() => importModelAsset(options)).toThrow(/reservation exists/);
    expect(fs.readFileSync(lock, 'utf8')).toBe('another owner');
    expect(fs.existsSync(options.outDir)).toBe(false);
  });

  it('rejects missing texture dependencies', () => {
    externalFixture();
    fs.unlinkSync(join(inputs, 'rig.png'));
    refuses('AEG-RENDER-0004');
  });

  it.each(['../escape.png', 'https://example.invalid/image.png', 'rig%2epng'])(
    'rejects unsafe dependency %s',
    (uri) => {
      const model = externalFixture();
      model.images[0]!.uri = uri;
      fs.writeFileSync(options.source, JSON.stringify(model));
      refuses('AEG-RENDER-0003');
    },
  );

  it('rejects case-colliding dependency names', () => {
    const model = externalFixture();
    fs.writeFileSync(join(inputs, 'RIG.png'), fixturePng());
    model.images.push({ uri: 'RIG.png' });
    fs.writeFileSync(options.source, JSON.stringify(model));
    refuses('AEG-RENDER-0003');
  });

  it('rejects escaped directory junction dependencies, without removing the target', () => {
    const model = externalFixture();
    const outside = join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, 'image.png'), fixturePng());
    fs.symlinkSync(
      outside,
      join(inputs, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    model.images[0]!.uri = 'link/image.png';
    fs.writeFileSync(options.source, JSON.stringify(model));
    refuses('AEG-RENDER-0003');
    expect(fs.readFileSync(join(outside, 'image.png'))).toEqual(fixturePng());
  });

  it('rejects unsupported decoders', () => {
    const model = externalFixture();
    model.extensionsRequired = ['KHR_draco_mesh_compression'];
    fs.writeFileSync(options.source, JSON.stringify(model));
    refuses('AEG-RENDER-0005');
  });

  it('preserves the existing 32 MiB per-file budget', () => {
    fs.truncateSync(options.source, 32 * 1024 * 1024 + 1);
    refuses('AEG-RENDER-0006');
  });

  it('accepts exactly 32 MiB for one dependency and rejects total closure overflow', () => {
    const model = externalFixture();
    model.buffers[0]!.byteLength = 32 * 1024 * 1024;
    fs.truncateSync(join(inputs, 'geometry.bin'), model.buffers[0]!.byteLength);
    fs.writeFileSync(options.source, JSON.stringify(model));
    expect(
      importModelAsset({ ...options, dryRun: true }).receipt.files.find(
        (file) => file.source === 'geometry.bin',
      )?.bytes,
    ).toBe(33_554_432);
    fs.writeFileSync(join(inputs, 'second.bin'), Buffer.alloc(0));
    fs.truncateSync(join(inputs, 'second.bin'), 32 * 1024 * 1024);
    model.buffers.push({ uri: 'second.bin', byteLength: 32 * 1024 * 1024 });
    fs.writeFileSync(options.source, JSON.stringify(model));
    refuses('AEG-RENDER-0006');
  });

  it('rejects a dependency inventory exceeding 256 files', () => {
    const model = externalFixture();
    for (let i = 0; i < 255; i++) {
      const uri = `image-${i}.png`;
      fs.writeFileSync(join(inputs, uri), fixturePng());
      model.images.push({ uri });
    }
    fs.writeFileSync(options.source, JSON.stringify(model));
    refuses('AEG-RENDER-0006');
  });

  it('rejects unsupported sources and missing explicit provenance', () => {
    options.source = join(inputs, 'asset.ply');
    refuses(AssetImportCode.Input);
    for (const value of [
      undefined,
      {},
      { ...provenance, license: ' ' },
      { ...provenance, model: 'inferred' },
    ])
      expect(() => parseImportProvenance(value)).toThrow(/exactly/);
  });

  it('cleans owned staging on publication failure without changing source bytes', () => {
    const original = fs.readFileSync(options.source);
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error('Injected rename failure');
    });
    refuses(AssetImportCode.Publication);
    expect(fs.readFileSync(options.source)).toEqual(original);
  });

  it('rejects source changes during staging instead of publishing a stale receipt', () => {
    const realWrite = fs.writeFileSync;
    vi.mocked(fs.writeFileSync).mockImplementationOnce((file, data, writeOptions) => {
      realWrite(file, data, writeOptions);
      // The first write is the owned reservation, after source preflight but before copying.
      const bytes = fs.readFileSync(options.source);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      realWrite(options.source, bytes);
    });
    refuses('AEG-RENDER-0004');
  });

  it('reads only bounded explicit provenance JSON', () => {
    const path = join(root, 'provenance.json');
    fs.writeFileSync(path, JSON.stringify(provenance));
    expect(readImportProvenance(path)).toEqual(provenance);
    fs.writeFileSync(path, '{');
    expect(() => readImportProvenance(path)).toThrow(/Cannot read provenance/);
    fs.writeFileSync(path, ' '.repeat(16_385));
    expect(() => readImportProvenance(path)).toThrow(/16 KiB/);
  });
});
