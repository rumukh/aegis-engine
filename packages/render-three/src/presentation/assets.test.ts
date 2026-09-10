import { describe, expect, it, vi } from 'vitest';
import { AnimationMixer, Color, DataTexture, InstancedMesh, Mesh, SRGBColorSpace } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FIXTURE_MANIFEST, fixtureGlb, fixtureWav } from '../testing/presentation-fixture.js';
import { loadPresentationAssets } from './assets.js';
import type { AssetLoaders } from './assets.js';

function loaders(): AssetLoaders {
  return {
    texture: vi.fn(async () => new DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1)),
    model: vi.fn(async () => new GLTFLoader().parseAsync(fixtureGlb(), '')),
    audio: vi.fn(async () => Uint8Array.from(fixtureWav()).buffer),
  };
}

describe('real presentation assets and ownership', () => {
  it('uses texture maps, named frames and actual decoded glTF geometry with independent animated instances', async () => {
    const decode = loaders();
    const library = await loadPresentationAssets(
      { manifest: FIXTURE_MANIFEST, baseUrl: './assets/' },
      { loaders: decode },
    );
    expect(library.texture('surface').colorSpace).toBe(SRGBColorSpace);
    expect(library.texture('surface', 'left')).toBe(library.texture('surface', 'left'));
    expect(library.texture('surface', 'right').offset.x).toBe(0.5);
    expect(library.texture('surface', 'left').repeat.x).toBe(0.5);
    const material = library.material('striped');
    expect('map' in material && material.map).toBe(library.texture('surface'));
    const a = library.instantiateModel('rig');
    const b = library.instantiateModel('rig');
    const aBody = a.root.getObjectByName('body');
    const bBody = b.root.getObjectByName('body');
    expect(aBody).toBeInstanceOf(Mesh);
    expect(bBody).toBeInstanceOf(Mesh);
    if (!(aBody instanceof Mesh) || !(bBody instanceof Mesh))
      throw new Error('Fixture did not decode meshes.');
    expect(aBody.geometry).toBe(bBody.geometry);
    expect(aBody.geometry.getAttribute('position').count).toBe(12);
    expect(a.root).not.toBe(b.root);
    const mixer = new AnimationMixer(a.root);
    const clip = a.clips.find((entry) => entry.name === 'spin');
    if (clip === undefined) throw new Error('Fixture animation did not decode.');
    mixer.clipAction(clip).play();
    mixer.setTime(0.5);
    expect(a.root.getObjectByName('fin')?.quaternion.z).not.toBe(
      b.root.getObjectByName('fin')?.quaternion.z,
    );
    expect(library.audio('tone').byteLength).toBeGreaterThan(44);
    expect(library.stats().modelInstances).toBe(2);
    expect(decode.model).toHaveBeenCalledTimes(1);
    mixer.stopAllAction();
    mixer.uncacheRoot(a.root);
    a.dispose();
    b.dispose();
    library.dispose();
  });

  it('does not dispose borrowed geometry on instance release and disposes each cached resource exactly once', async () => {
    const library = await loadPresentationAssets(
      { manifest: FIXTURE_MANIFEST, baseUrl: './assets/' },
      { loaders: loaders() },
    );
    const a = library.instantiateModel('rig');
    const b = library.instantiateModel('rig');
    const body = a.root.getObjectByName('body');
    if (!(body instanceof Mesh)) throw new Error('Fixture body missing.');
    const disposeGeometry = vi.fn();
    body.geometry.addEventListener('dispose', disposeGeometry);
    const disposeMap = vi.fn();
    library.texture('surface').addEventListener('dispose', disposeMap);
    a.dispose();
    a.dispose();
    expect(disposeGeometry).not.toHaveBeenCalled();
    expect(library.stats().modelInstances).toBe(1);
    expect(b.root.getObjectByName('body')).toBeDefined();
    library.dispose();
    library.dispose();
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(disposeMap).toHaveBeenCalledTimes(1);
    expect(library.stats()).toEqual({
      textures: 0,
      materials: 0,
      geometries: 0,
      modelInstances: 0,
      audioBytes: 0,
      loadedFiles: 0,
    });
    expect(() => library.instantiateModel('rig')).toThrow(/disposed/);
  });

  it('rejects a failed asset and disposes successful late arrivals instead of falling back to a box', async () => {
    const texture = new DataTexture();
    const disposal = vi.fn();
    texture.addEventListener('dispose', disposal);
    const decode = loaders();
    decode.texture = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return texture;
    };
    decode.model = async () => {
      throw new Error('broken glTF');
    };
    await expect(
      loadPresentationAssets(
        { manifest: FIXTURE_MANIFEST, baseUrl: './assets/' },
        { loaders: decode },
      ),
    ).rejects.toThrow(/rig.*broken glTF/);
    expect(disposal).toHaveBeenCalledTimes(1);
  });

  it('disposes clone-owned glTF instance buffers exactly once without releasing borrowed resources', async () => {
    const decode = loaders();
    decode.model = async () => new GLTFLoader().parseAsync(fixtureGlb(true), '');
    const library = await loadPresentationAssets(
      { manifest: FIXTURE_MANIFEST, baseUrl: './assets/' },
      { loaders: decode },
    );
    try {
      const a = library.instantiateModel('rig');
      const b = library.instantiateModel('rig');
      const first = a.root.getObjectByName('body');
      const second = b.root.getObjectByName('body');
      if (!(first instanceof InstancedMesh) || !(second instanceof InstancedMesh))
        throw new Error('The GLB did not decode its instancing extension.');
      expect(first.count).toBe(12);
      expect(first.instanceMatrix).not.toBe(second.instanceMatrix);
      expect(first.instanceMatrix.array).not.toBe(second.instanceMatrix.array);
      expect(first.geometry).toBe(second.geometry);
      expect(first.material).toBe(second.material);
      first.setColorAt(0, new Color('#ff0000'));
      second.setColorAt(0, new Color('#00ff00'));
      expect(first.instanceColor).not.toBe(second.instanceColor);
      const firstRelease = vi.fn();
      const secondRelease = vi.fn();
      const geometryRelease = vi.fn();
      const materialRelease = vi.fn();
      const textureRelease = vi.fn();
      first.addEventListener('dispose', firstRelease);
      second.addEventListener('dispose', secondRelease);
      first.geometry.addEventListener('dispose', geometryRelease);
      if (Array.isArray(first.material)) throw new Error('Expected the fixture single material.');
      first.material.addEventListener('dispose', materialRelease);
      library.texture('surface').addEventListener('dispose', textureRelease);
      const remainingMatrix = second.instanceMatrix.array.slice();

      a.dispose();
      a.dispose();
      expect(firstRelease).toHaveBeenCalledTimes(1);
      expect(secondRelease).not.toHaveBeenCalled();
      expect(geometryRelease).not.toHaveBeenCalled();
      expect(materialRelease).not.toHaveBeenCalled();
      expect(textureRelease).not.toHaveBeenCalled();
      expect(second.instanceMatrix.array).toEqual(remainingMatrix);
      expect(library.stats().modelInstances).toBe(1);

      library.dispose();
      b.dispose();
      library.dispose();
      expect(firstRelease).toHaveBeenCalledTimes(1);
      expect(secondRelease).toHaveBeenCalledTimes(1);
      expect(geometryRelease).toHaveBeenCalledTimes(1);
      expect(materialRelease).toHaveBeenCalledTimes(1);
      expect(textureRelease).toHaveBeenCalledTimes(1);
      expect(library.stats().modelInstances).toBe(0);
    } finally {
      library.dispose();
    }
  });

  it('does not resolve a missing ID, unknown atlas frame, or material as a default', async () => {
    const library = await loadPresentationAssets(
      { manifest: FIXTURE_MANIFEST, baseUrl: './assets/' },
      { loaders: loaders() },
    );
    expect(() => library.texture('missing')).toThrow(/Unknown texture/);
    expect(() => library.texture('surface', 'missing')).toThrow(/Unknown atlas frame/);
    expect(() => library.material('missing')).toThrow(/Unknown material/);
    expect(() => library.instantiateModel('missing')).toThrow(/Unknown model/);
    library.dispose();
  });

  it('rejects a model whose loader silently substitutes a failed subordinate texture', async () => {
    const decode = loaders();
    decode.model = async (_url, manager) => {
      manager.itemError('corrupt-image.png');
      return new GLTFLoader().parseAsync(fixtureGlb(), '');
    };
    await expect(
      loadPresentationAssets(
        { manifest: FIXTURE_MANIFEST, baseUrl: './assets/' },
        { loaders: decode },
      ),
    ).rejects.toThrow(/rig.*corrupt-image.png/);
  });
});
