import { Mesh, Texture } from 'three';
import type { Material, Source } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function materialTextures(material: Material): Texture[] {
  return Object.values(material).filter((value): value is Texture => value instanceof Texture);
}

/**
 * Native glTF decoders use identical image decoding options. Share their pixel Source by
 * resolved external URI, not Texture: UV transforms, color space and samplers remain independent.
 * The cache is one asset-library lifetime, never three.js's process-global Cache.
 */
export class TextureSources {
  readonly #sources = new Map<string, Source>();
  readonly #retired = new Set<unknown>();

  reuse(gltf: GLTF, modelUrl: string): void {
    const json: unknown = gltf.parser.json;
    if (!record(json) || !Array.isArray(json['textures']) || !Array.isArray(json['images'])) return;
    const textures = new Set<Texture>();
    for (const scene of gltf.scenes)
      scene.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        for (const material of Array.isArray(node.material) ? node.material : [node.material])
          for (const texture of materialTextures(material)) textures.add(texture);
      });
    const replacements = new Map<Source, Source>();
    for (const [object, reference] of gltf.parser.associations) {
      if (!(object instanceof Texture)) continue;
      textures.add(object);
      const index = reference.textures;
      if (index === undefined) continue;
      const definition: unknown = json['textures'][index];
      if (
        !record(definition) ||
        typeof definition['source'] !== 'number' ||
        definition['extensions'] !== undefined
      )
        continue;
      const image: unknown = json['images'][definition['source']];
      if (!record(image) || typeof image['uri'] !== 'string') continue;
      const uri = image['uri'];
      // Embedded image indices and blob URLs are decoder-local identities, not shared files.
      if (uri.startsWith('data:') || uri.startsWith('blob:')) continue;
      const key = new URL(uri, modelUrl).href;
      const original = object.source;
      const shared = this.#sources.get(key);
      if (shared === undefined) this.#sources.set(key, original);
      else if (shared !== original) {
        replacements.set(original, shared);
        this.#retired.add(original.data);
      }
    }
    for (const texture of textures) {
      const replacement = replacements.get(texture.source);
      if (replacement !== undefined) texture.source = replacement;
    }
  }

  /** Release duplicate decoded bitmaps only after every load has settled and all owners are known. */
  prune(textures: Iterable<Texture>): void {
    const live = new Set<unknown>([...this.#sources.values()].map((source) => source.data));
    for (const texture of textures) live.add(texture.source.data);
    for (const image of this.#retired) {
      if (live.has(image)) continue;
      if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
      this.#retired.delete(image);
    }
  }

  /** The library closes these together with its current images, once per image identity. */
  images(): readonly unknown[] {
    return [...this.#retired, ...[...this.#sources.values()].map((source) => source.data)];
  }

  clear(): void {
    this.#sources.clear();
    this.#retired.clear();
  }
}
