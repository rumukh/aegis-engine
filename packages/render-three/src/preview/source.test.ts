import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiagnosticError } from '@aegis/core';
import { fixturePng, writePresentationFixture } from '../testing/presentation-fixture.js';
import { assertPreviewFresh, prepareAssetPreview } from './source.js';
import { captureDimensions, validatePreviewSettings, validateSelection } from './settings.js';
import type { PreviewSelection } from './types.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
let root: string;
let source: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aegis-preview-source-'));
  const fixture = writePresentationFixture(root);
  source = join(root, 'look.presentation.json');
  writeFileSync(source, JSON.stringify(fixture.manifest));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function rejected(work: () => unknown, code: string): readonly string[] {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(DiagnosticError);
    const diagnostics = (error as DiagnosticError).diagnostics;
    expect(diagnostics.some((entry) => entry.code === code)).toBe(true);
    expect(diagnostics.every((entry) => entry.fix !== undefined)).toBe(true);
    return diagnostics.map((entry) => entry.message);
  }
  throw new Error('Expected the preview to refuse this input.');
}

describe('asset-only source preparation', () => {
  it('prepares a direct image without a scene, plugin, descriptor, or invented provenance', () => {
    writeFileSync(join(root, 'aegis.json'), '{"plugin":"./trap.mjs#plugin"}');
    writeFileSync(
      join(root, 'trap.mjs'),
      'throw new Error("A preview must never import a game plugin");',
    );
    const preview = prepareAssetPreview({ source: join(root, 'surface.png') });
    expect(preview.document.selection).toEqual({ kind: 'texture', id: 'preview-asset' });
    expect(preview.document.source.format).toBe('direct');
    expect(preview.document.dependencies.map((entry) => entry.path)).toEqual(['surface.png']);
    expect(preview.document.dependencies[0]?.provenance).toEqual({
      status: 'user-supplied',
      author: null,
      license: null,
      source: null,
    });
    expect(preview.document.presentation.baseUrl).toBe('./assets/r1/');
    expect(JSON.stringify(preview.document)).not.toContain(root);
  });

  it('loads only the selected model closure, not a descriptor world or its audio', () => {
    const preview = prepareAssetPreview({ source, selection: { kind: 'model', id: 'rig' } }, 7);
    expect(preview.document.presentation.manifest).toEqual({
      aegis: 'presentation/1',
      assets: [
        {
          id: 'rig',
          kind: 'gltf',
          src: 'rig.gltf',
          provenance: {
            author: 'Aegis contributors',
            license: 'MIT',
            source: 'packages/render-three/src/testing/presentation-fixture.ts',
          },
        },
      ],
      materials: [],
    });
    expect(preview.document.dependencies.map((entry) => entry.path)).toEqual([
      'rig.gltf',
      'rig.png',
    ]);
    expect(
      preview.document.dependencies.every((entry) => entry.provenance.status === 'declared'),
    ).toBe(true);
    expect(preview.document.choices.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      'texture:surface',
      'model:rig',
      'material:striped',
    ]);
    expect(preview.document.presentation.baseUrl).toBe('./assets/r7/');
  });

  it('selects material dependencies and atlas frames through the production declarations', () => {
    const sample = prepareAssetPreview({ source, selection: { kind: 'material', id: 'striped' } });
    expect(sample.document.dependencies.map((entry) => entry.path)).toEqual(['surface.png']);
    expect(sample.document.presentation.manifest.materials?.[0]?.map).toBe('surface');
    const atlas = prepareAssetPreview({
      source,
      selection: { kind: 'texture', id: 'surface', frame: 'left' },
    });
    expect(atlas.document.selection.frame).toBe('left');
    expect(atlas.document.presentation.manifest.assets?.[0]).toMatchObject({
      frames: { left: [0, 0, 0.5, 1] },
    });
    const override = prepareAssetPreview({
      source,
      selection: { kind: 'model', id: 'rig', material: 'striped' },
    });
    expect(override.document.dependencies.map((entry) => entry.path)).toEqual([
      'rig.gltf',
      'rig.png',
      'surface.png',
    ]);
  });

  it('requires an explicit choice instead of guessing which declared resource to render', () => {
    expect(rejected(() => prepareAssetPreview({ source }), 'AEG-PREVIEW-0002').join(' ')).toContain(
      '3 preview choices',
    );
    for (const selection of [
      { kind: 'model', id: 'missing' },
      { kind: 'texture', id: 'surface', frame: 'missing' },
      { kind: 'model', id: 'rig', material: 'missing' },
    ] satisfies PreviewSelection[])
      rejected(() => prepareAssetPreview({ source, selection }), 'AEG-PREVIEW-0002');
  });

  it('does not weaken the checked-byte refusal when a dependency changes', () => {
    const first = prepareAssetPreview({ source: join(root, 'rig.gltf') });
    writeFileSync(join(root, 'rig.png'), fixturePng());
    rejected(() => assertPreviewFresh(first), 'AEG-RENDER-0004');
    const second = prepareAssetPreview({ source: join(root, 'rig.gltf') }, 2);
    expect(second.document.fingerprint).not.toBe(first.document.fingerprint);
    expect(second.document.source.sha256).toBe(first.document.source.sha256);
    expect(second.document.dependencies.find((entry) => entry.path === 'rig.png')?.sha256).not.toBe(
      first.document.dependencies.find((entry) => entry.path === 'rig.png')?.sha256,
    );
    expect(second.document.presentation.baseUrl).toBe('./assets/r2/');
    expect(() => assertPreviewFresh(second)).not.toThrow();
    writeFileSync(join(root, 'rig.gltf'), '{}');
    rejected(() => assertPreviewFresh(second), 'AEG-PREVIEW-0004');
  });

  it('refuses missing buffers, remote dependencies, unsupported encodings, and invalid image bytes', () => {
    const model = JSON.parse(readFileSync(join(root, 'rig.gltf'), 'utf8')) as {
      buffers: { uri: string }[];
      images: { uri: string }[];
      extensionsRequired?: string[];
    };
    model.buffers[0]!.uri = 'missing.bin';
    writeFileSync(join(root, 'bad.gltf'), JSON.stringify(model));
    expect(
      rejected(
        () => prepareAssetPreview({ source: join(root, 'bad.gltf') }),
        'AEG-RENDER-0004',
      ).join(' '),
    ).toContain('missing.bin');
    model.buffers = JSON.parse(readFileSync(join(root, 'rig.gltf'), 'utf8')).buffers;
    model.images[0]!.uri = 'https://example.invalid/private.png';
    writeFileSync(join(root, 'bad.gltf'), JSON.stringify(model));
    rejected(() => prepareAssetPreview({ source: join(root, 'bad.gltf') }), 'AEG-RENDER-0003');
    model.extensionsRequired = ['KHR_draco_mesh_compression'];
    writeFileSync(join(root, 'bad.gltf'), JSON.stringify(model));
    rejected(() => prepareAssetPreview({ source: join(root, 'bad.gltf') }), 'AEG-RENDER-0005');
    writeFileSync(join(root, 'surface.png'), 'not an image');
    rejected(() => prepareAssetPreview({ source: join(root, 'surface.png') }), 'AEG-RENDER-0004');
  });

  it('refuses unsupported input rather than treating it as a zero-tick game', () => {
    writeFileSync(
      join(root, 'scene.json'),
      '{"aegis":"scene/1","mode":"platformer","entities":[]}',
    );
    rejected(() => prepareAssetPreview({ source: join(root, 'scene.json') }), 'AEG-RENDER-0001');
    writeFileSync(join(root, 'mesh.obj'), 'v 0 0 0');
    rejected(() => prepareAssetPreview({ source: join(root, 'mesh.obj') }), 'AEG-PREVIEW-0001');
    writeFileSync(join(root, 'broken.json'), '{');
    rejected(() => prepareAssetPreview({ source: join(root, 'broken.json') }), 'AEG-PREVIEW-0001');
    rejected(() => prepareAssetPreview({ source: join(root, 'absent.glb') }), 'AEG-PREVIEW-0001');
  });

  it.each([
    ['games', 'platformer', 'assets', 'engineer.svg'],
    ['games', 'iso', 'assets', 'operative.gltf'],
    ['games', 'fps', 'assets', 'generated', 'kestrel-security.glb'],
    ['games', 'fps', 'assets', 'generated', 'vaultline-rifle.glb'],
  ])('preflights the existing PoC input %s/%s/%s/%s', (...path) => {
    const prepared = prepareAssetPreview({ source: join(ROOT, ...path) });
    expect(prepared.prepared.totalBytes).toBeGreaterThan(1000);
    expect(prepared.document.dependencies.length).toBeGreaterThanOrEqual(1);
    expect(prepared.document.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.document.prepareMs).toBeGreaterThan(0);
  });
});

describe('studio request validation', () => {
  it.each([
    { width: 0, height: 256 },
    { width: 256.5, height: 256 },
    { width: 4096, height: 4096 },
  ])('rejects unsafe or inexact capture dimensions %j', ({ width, height }) => {
    expect(() => captureDimensions(width, height)).toThrow(DiagnosticError);
  });
  it('accepts explicit measured settings without silently dropping invalid fields', () => {
    expect(captureDimensions(640, 360)).toEqual({ width: 640, height: 360 });
    expect(validatePreviewSettings({ background: '#AABBCC', clip: 'walk', time: 0.25 })).toEqual({
      background: '#aabbcc',
      clip: 'walk',
      time: 0.25,
    });
    for (const invalid of [
      { camera: { position: [0, 0, 0], target: [0, 0, 0] } },
      { lighting: 'moon' },
      { time: NaN },
      { time: -1 },
      { background: 'url(remote)' },
      { clip: '' },
      { camera: { position: [0, 0, 1], target: [0, 0, 0], zoom: 0 } },
      { unexpected: true },
      { playing: 'true' },
    ])
      expect(() => validatePreviewSettings(invalid)).toThrow(DiagnosticError);
    expect(() => validateSelection({ kind: 'material', id: 'striped', frame: 'left' })).toThrow(
      DiagnosticError,
    );
  });
});
