import { DataTexture, Mesh, MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import { loadPresentationAssets } from '../presentation/assets.js';
import { fixtureGlb } from '../testing/presentation-fixture.js';
import { assetBounds, meshStats, PreviewSubject } from './subject.js';
import type { PresentationManifest } from '../presentation/schema.js';
import { VisualFactory } from '../presentation/runtime-visuals.js';

const PROVENANCE = {
  author: 'Aegis contributors',
  license: 'MIT',
  source: 'subject.test.ts fixture',
};

describe('asset-only specimen geometry and ownership (CPU)', () => {
  it.each([false, true])(
    'shares correct declared-material shading with game visuals (authored normals: %s)',
    async (withNormals) => {
      const manifest: PresentationManifest = {
        aegis: 'presentation/1',
        assets: [{ id: 'rig', kind: 'gltf', src: 'rig.glb', provenance: PROVENANCE }],
        materials: [
          { id: 'clay', shading: 'standard', color: '#aabbcc', roughness: 0.8, metalness: 0 },
          { id: 'unlit', shading: 'unlit', color: '#ffffff' },
        ],
      };
      const assets = await loadPresentationAssets(
        { manifest, baseUrl: './assets/' },
        {
          loaders: {
            model: (_url, manager) =>
              new GLTFLoader(manager).parseAsync(fixtureGlb(false, withNormals), ''),
            texture: async () => {
              throw new Error('No fixture texture');
            },
            audio: async () => {
              throw new Error('No fixture audio');
            },
          },
        },
      );
      const factory = new VisualFactory(assets);
      const specimen = new PreviewSubject(assets, manifest, {
        kind: 'model',
        id: 'rig',
        material: 'clay',
      });
      const visual = factory.create(
        { kind: 'model', mesh: 'rig', material: 'clay' },
        'neutral',
        'test',
      );
      const previewMesh = specimen.root.getObjectByName('body');
      const gameMesh = visual.object.getObjectByName('body');
      if (!(previewMesh instanceof Mesh) || !(gameMesh instanceof Mesh))
        throw new Error('Real GLB mesh missing');
      const material = previewMesh.material;
      const base = assets.material('clay');
      if (!(material instanceof MeshStandardMaterial) || !(base instanceof MeshStandardMaterial))
        throw new Error('Expected standard materials');
      expect(material.flatShading).toBe(!withNormals);
      expect(gameMesh.material).toBe(material);
      expect(assets.material('clay', previewMesh.geometry)).toBe(material);
      expect(base.flatShading).toBe(false);
      expect(material === base).toBe(withNormals);
      expect(previewMesh.geometry).toBe(gameMesh.geometry);
      expect(previewMesh.geometry.hasAttribute('normal')).toBe(withNormals);
      if (withNormals)
        expect(Array.from(previewMesh.geometry.getAttribute('normal').array)).toEqual(
          Array.from({ length: 12 }, () => [0, 1, 0]).flat(),
        );
      expect(assets.material('unlit', previewMesh.geometry)).toBe(assets.material('unlit'));
      const disposed = vi.fn();
      material.addEventListener('dispose', disposed);
      specimen.dispose();
      visual.dispose();
      factory.dispose();
      expect(disposed).not.toHaveBeenCalled();
      expect(previewMesh.geometry.hasAttribute('normal')).toBe(withNormals);
      assets.dispose();
      assets.dispose();
      expect(disposed).toHaveBeenCalledTimes(1);
    },
  );

  it('uses a production-loaded model instance and samples real animated geometry', async () => {
    const manifest: PresentationManifest = {
      aegis: 'presentation/1',
      assets: [{ id: 'rig', kind: 'gltf', src: 'rig.glb', provenance: PROVENANCE }],
    };
    const assets = await loadPresentationAssets(
      { manifest, baseUrl: './assets/' },
      {
        loaders: {
          model: (_url, manager) => new GLTFLoader(manager).parseAsync(fixtureGlb(), ''),
          texture: async () => {
            throw new Error('No texture expected in this fixture.');
          },
          audio: async () => {
            throw new Error('Asset preview must not load audio.');
          },
        },
      },
    );
    const specimen = new PreviewSubject(assets, manifest, { kind: 'model', id: 'rig' });
    try {
      expect(assets.stats().modelInstances).toBe(1);
      expect(assets.stats().audioBytes).toBe(0);
      expect(meshStats(specimen.root)).toMatchObject({
        meshes: 2,
        triangles: 8,
        vertices: 24,
        materials: 1,
      });
      specimen.sample('spin', 0);
      const first = assetBounds(specimen.root);
      expect(specimen.root.getObjectByName('fin')!.quaternion.z).toBe(0);
      specimen.sample('spin', 0.5);
      expect(specimen.root.getObjectByName('fin')!.quaternion.z).toBeCloseTo(
        0.7071067811865476,
        12,
      );
      expect(assetBounds(specimen.root).max[1]).not.toBe(first.max[1]);
      specimen.sample('spin', 2);
      specimen.sample('spin', 0.5);
      expect(specimen.root.getObjectByName('fin')!.quaternion.z).toBeCloseTo(
        0.7071067811865476,
        12,
      );
      expect(() => specimen.sample('missing', 0)).toThrow('Unsupported clip');
      expect(() => specimen.sample('spin', 3)).toThrow('duration 2');
      specimen.sample(null, 0);
      expect(specimen.root.getObjectByName('fin')!.quaternion.z).toBe(0);
    } finally {
      specimen.dispose();
      specimen.dispose();
      expect(assets.stats().modelInstances).toBe(0);
      assets.dispose();
    }
    expect(assets.stats()).toEqual({
      textures: 0,
      materials: 0,
      geometries: 0,
      modelInstances: 0,
      audioBytes: 0,
      loadedFiles: 0,
    });
  });

  it('uses production materials and atlas sampling while disposing only sample-owned resources', async () => {
    const manifest: PresentationManifest = {
      aegis: 'presentation/1',
      assets: [
        {
          id: 'atlas',
          kind: 'texture',
          src: 'atlas.png',
          provenance: PROVENANCE,
          frames: { left: [0, 0, 0.5, 1] },
        },
      ],
      materials: [
        { id: 'surface', shading: 'standard', map: 'atlas', color: '#aabbcc', roughness: 0.6 },
      ],
    };
    const assets = await loadPresentationAssets(
      { manifest, baseUrl: './assets/' },
      {
        loaders: {
          texture: async () => new DataTexture(new Uint8Array(32 * 32 * 4), 32, 32),
          model: async () => {
            throw new Error('No model expected.');
          },
          audio: async () => {
            throw new Error('No audio allowed.');
          },
        },
      },
    );
    const texture = new PreviewSubject(assets, manifest, {
      kind: 'texture',
      id: 'atlas',
      frame: 'left',
    });
    expect(assetBounds(texture.root).size).toEqual([0.5, 1, 0]);
    expect(assets.texture('atlas', 'left').repeat.x).toBe(0.5);
    texture.dispose();
    expect(assets.stats().textures).toBe(2);
    const sample = new PreviewSubject(
      assets,
      manifest,
      { kind: 'material', id: 'surface' },
      'cube',
    );
    expect(meshStats(sample.root)).toMatchObject({
      meshes: 1,
      triangles: 12,
      materials: 1,
      textures: 1,
    });
    sample.dispose();
    expect(assets.material('surface').name).toBe('surface');
    assets.dispose();
    expect(assets.stats().materials).toBe(0);
  });
});
