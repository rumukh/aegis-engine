import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTexture, Mesh, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fixtureGlb } from '../testing/presentation-fixture.js';
import { TextureSources } from './texture-sources.js';
import { loadPresentationAssets } from './assets.js';

afterEach(() => vi.unstubAllGlobals());

async function model(uri?: string) {
  const gltf = await new GLTFLoader().parseAsync(fixtureGlb(), '');
  const map = new DataTexture(new Uint8Array([128, 64, 32, 255]), 1, 1);
  const json: unknown = gltf.parser.json;
  if (typeof json !== 'object' || json === null) throw new Error('Invalid fixture glTF.');
  Object.assign(json, {
    textures: [{ source: 0 }],
    images: [uri === undefined ? { bufferView: 0 } : { uri }],
  });
  gltf.parser.associations.set(map, { textures: 0 });
  const body = gltf.scene.getObjectByName('body');
  if (!(body instanceof Mesh) || !(body.material instanceof MeshStandardMaterial))
    throw new Error('Fixture material missing.');
  body.material.map = map;
  const transformed = map.clone();
  transformed.offset.set(0.25, 0.5);
  body.material.normalMap = transformed;
  return { gltf, map, transformed };
}

describe('library-local external glTF pixel sources', () => {
  it('does not alias extension-selected images through their common fallback URI', async () => {
    const a = await model('fallback.png');
    const b = await model('fallback.png');
    for (const value of [a, b]) {
      const json: unknown = value.gltf.parser.json;
      if (typeof json !== 'object' || json === null) throw new Error('Missing fixture document.');
      Object.assign(json, {
        textures: [{ source: 0, extensions: { EXT_texture_webp: { source: 1 } } }],
      });
    }
    const cache = new TextureSources();
    cache.reuse(a.gltf, 'http://local/a.glb');
    cache.reuse(b.gltf, 'http://local/b.glb');
    expect(a.map.source).not.toBe(b.map.source);
  });

  it('preserves injected decoder ownership even if its glTF metadata names a shared URI', async () => {
    const a = await model('shared.png');
    const b = await model('shared.png');
    const provenance = { author: 'fixture', license: 'MIT', source: 'fixture' };
    const library = await loadPresentationAssets(
      {
        manifest: {
          aegis: 'presentation/1',
          assets: [
            { id: 'a', kind: 'gltf', src: 'a.glb', provenance },
            { id: 'b', kind: 'gltf', src: 'b.glb', provenance },
          ],
        },
        baseUrl: './assets/',
      },
      {
        loaders: {
          model: async (url) => (url.endsWith('/a.glb') ? a.gltf : b.gltf),
          texture: async () => {
            throw new Error('Unexpected texture decoder');
          },
          audio: async () => {
            throw new Error('Unexpected audio decoder');
          },
        },
      },
    );
    try {
      expect(a.map.source).not.toBe(b.map.source);
    } finally {
      library.dispose();
    }
  });
  it('closes only the retired decoded bitmap, never the live shared source, and only once', async () => {
    class Bitmap {
      width = 1;
      height = 1;
      close = vi.fn();
    }
    vi.stubGlobal('ImageBitmap', Bitmap);
    const cache = new TextureSources();
    const a = await model('shared.png');
    const b = await model('shared.png');
    const first = new Bitmap();
    const discarded = new Bitmap();
    a.map.source.data = first;
    b.map.source.data = discarded;
    cache.reuse(a.gltf, 'http://local/a.glb');
    cache.reuse(b.gltf, 'http://local/b.glb');
    cache.prune([a.map, b.map, a.transformed, b.transformed]);
    cache.prune([a.map, b.map]);
    expect(discarded.close).toHaveBeenCalledOnce();
    expect(first.close).not.toHaveBeenCalled();
    expect(cache.images()).toEqual([first]);
  });
  it('shares resolved URI pixels while retaining distinct texture/sampler/color/UV state', async () => {
    const cache = new TextureSources();
    const a = await model('shared.png');
    const b = await model('shared.png');
    b.map.colorSpace = SRGBColorSpace;
    b.map.wrapS = RepeatWrapping;
    b.map.repeat.set(2, 3);
    cache.reuse(a.gltf, 'http://local/assets/a.glb');
    cache.reuse(b.gltf, 'http://local/assets/b.glb');
    expect(a.map).not.toBe(b.map);
    expect(a.map.source).toBe(b.map.source);
    expect(b.transformed.source).toBe(a.map.source);
    expect(b.transformed.offset.toArray()).toEqual([0.25, 0.5]);
    expect(a.map.colorSpace).not.toBe(SRGBColorSpace);
    expect(a.map.wrapS).not.toBe(RepeatWrapping);
    expect(a.map.repeat.toArray()).toEqual([1, 1]);
    expect(b.map.repeat.toArray()).toEqual([2, 3]);
    expect(b.map.colorSpace).toBe(SRGBColorSpace);
    cache.clear();
    expect(cache.images()).toEqual([]);
  });

  it('does not conflate equal dimensions/names under different resolved directories or embedded indices', async () => {
    const cache = new TextureSources();
    const a = await model('same.png');
    const b = await model('same.png');
    const embedded = await model();
    const secondEmbedded = await model();
    cache.reuse(a.gltf, 'http://local/left/a.glb');
    cache.reuse(b.gltf, 'http://local/right/b.glb');
    cache.reuse(embedded.gltf, 'http://local/a.glb');
    cache.reuse(secondEmbedded.gltf, 'http://local/b.glb');
    expect(a.map.source).not.toBe(b.map.source);
    expect(embedded.map.source).not.toBe(secondEmbedded.map.source);
    const independent = new TextureSources();
    const c = await model('same.png');
    independent.reuse(c.gltf, 'http://local/left/c.glb');
    expect(c.map.source).not.toBe(a.map.source);
  });

  it('retains rejected/retired image ownership until pruning or disposal, not across reloads', async () => {
    const cache = new TextureSources();
    const a = await model('same.png');
    const b = await model('same.png');
    const retired = b.map.source.data;
    cache.reuse(a.gltf, 'http://local/a.glb');
    cache.reuse(b.gltf, 'http://local/b.glb');
    expect(cache.images()).toContain(retired);
    cache.prune([a.map, b.map, a.transformed, b.transformed]);
    expect(cache.images()).not.toContain(retired);
    const live = a.map.source;
    cache.clear();
    const next = await model('same.png');
    cache.reuse(next.gltf, 'http://local/a.glb');
    expect(next.map.source).not.toBe(live);
  });
});
