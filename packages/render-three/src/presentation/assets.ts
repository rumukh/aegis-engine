import {
  DoubleSide,
  FrontSide,
  LinearFilter,
  LinearSRGBColorSpace,
  LoadingManager,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  RepeatWrapping,
  SRGBColorSpace,
  SkinnedMesh,
  TextureLoader,
} from 'three';
import type { AnimationClip, BufferGeometry, Material, Object3D, Skeleton, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { DiagnosticError } from '@aegis/core';
import { assetError, isAssetPath } from './diagnostics.js';
import { PRESENTATION_LIMITS } from './schema.js';
import type { AssetSpec, PresentationManifest, ResolvedPresentation } from './schema.js';
import { validatePresentation } from './validate.js';
import { sharedResource } from '../resources.js';

export interface PresentationAssetStats {
  textures: number;
  materials: number;
  geometries: number;
  modelInstances: number;
  audioBytes: number;
  loadedFiles: number;
}
export interface ModelInstance {
  root: Object3D;
  clips: readonly AnimationClip[];
  dispose(): void;
}
export interface PresentationAssets {
  texture(id: string, frame?: string): Texture;
  material(id: string): Material;
  instantiateModel(id: string): ModelInstance;
  audio(id: string): ArrayBuffer;
  stats(): PresentationAssetStats;
  dispose(): void;
}

/** Injectable decoding boundary; adapters and the asset ownership tests need no browser. */
export interface AssetLoaders {
  texture(url: string, signal: AbortSignal): Promise<Texture>;
  model(url: string, manager: LoadingManager, signal: AbortSignal): Promise<GLTF>;
  audio(url: string, signal: AbortSignal): Promise<ArrayBuffer>;
}
export interface AssetLoadOptions {
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
  loaders?: AssetLoaders;
}

async function fetchBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url} responded ${response.status}.`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > PRESENTATION_LIMITS.fileBytes)
    throw new Error(`${url} exceeds the asset byte limit.`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > PRESENTATION_LIMITS.fileBytes)
    throw new Error(`${url} exceeds the asset byte limit.`);
  return bytes;
}

async function verifyPixels(source: Blob | HTMLImageElement): Promise<void> {
  if (typeof createImageBitmap !== 'function')
    throw new Error('Pixel decoding requires a browser with createImageBitmap support.');
  const bitmap = await createImageBitmap(source);
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) throw new Error('Decoded image has no pixels.');
  } finally {
    bitmap.close();
  }
}

function browserLoaders(
  read: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>,
): AssetLoaders {
  return {
    async texture(url, signal) {
      const bytes = await read(url, signal);
      const mime = /\.svg$/i.test(url)
        ? 'image/svg+xml'
        : /\.jpe?g$/i.test(url)
          ? 'image/jpeg'
          : /\.webp$/i.test(url)
            ? 'image/webp'
            : 'image/png';
      const blob = new Blob([bytes], { type: mime });
      await verifyPixels(blob);
      const local = URL.createObjectURL(blob);
      try {
        const texture = await new TextureLoader().loadAsync(local);
        if (signal.aborted) {
          texture.dispose();
          signal.throwIfAborted();
        }
        return texture;
      } finally {
        URL.revokeObjectURL(local);
      }
    },
    async model(url, manager, signal) {
      const bytes = await read(url, signal);
      const result = await new GLTFLoader(manager).parseAsync(bytes, new URL('.', url).href);
      return result;
    },
    audio: read,
  };
}

function mimeFor(url: string): string {
  if (/\.png$/i.test(url)) return 'image/png';
  if (/\.jpe?g$/i.test(url)) return 'image/jpeg';
  if (/\.webp$/i.test(url)) return 'image/webp';
  if (/\.svg$/i.test(url)) return 'image/svg+xml';
  return 'application/octet-stream';
}

function texturesOf(material: Material): Texture[] {
  const textures: Texture[] = [];
  for (const value of Object.values(material)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      'isTexture' in value &&
      value.isTexture === true
    )
      textures.push(value as Texture);
  }
  return textures;
}

/** Owns shared GPU resources. Model instances borrow them until this library is disposed. */
class AssetLibrary implements PresentationAssets {
  readonly #manifest: PresentationManifest;
  readonly #textures = new Map<string, Texture>();
  readonly #models = new Map<string, GLTF>();
  readonly #audio = new Map<string, ArrayBuffer>();
  readonly #materials = new Map<string, Material>();
  readonly #samplers = new Map<string, Texture>();
  readonly #ownedTextures = new Set<Texture>();
  readonly #textureOwners = new Map<Texture, string>();
  readonly #ownedMaterials = new Set<Material>();
  readonly #ownedGeometry = new Set<BufferGeometry>();
  readonly #instances = new Set<ModelInstance>();
  #loaded = 0;
  #disposed = false;

  constructor(manifest: PresentationManifest) {
    this.#manifest = manifest;
  }

  #check(): void {
    if (this.#disposed)
      throw assetError(
        'library',
        'The presentation asset library is disposed.',
        'Load a new library before creating presentation objects.',
      );
  }

  add(asset: AssetSpec, value: Texture | GLTF | ArrayBuffer): void {
    if (asset.kind === 'texture' && 'isTexture' in value) {
      const texture = value;
      texture.colorSpace = asset.colorSpace === 'linear' ? LinearSRGBColorSpace : SRGBColorSpace;
      texture.magFilter = asset.filter === 'nearest' ? NearestFilter : LinearFilter;
      texture.minFilter = texture.magFilter;
      texture.needsUpdate = true;
      this.#textures.set(asset.id, texture);
      this.#ownedTextures.add(texture);
      this.#textureOwners.set(texture, asset.id);
    } else if (asset.kind === 'gltf' && 'scene' in value) {
      this.#models.set(asset.id, value);
      for (const scene of value.scenes)
        scene.traverse((node) => {
          if (!(node instanceof Mesh)) return;
          this.#ownedGeometry.add(sharedResource(node.geometry));
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
            this.#ownedMaterials.add(sharedResource(material));
            texturesOf(material).forEach((texture) => {
              this.#ownedTextures.add(texture);
              this.#textureOwners.set(texture, asset.id);
            });
          }
        });
    } else if (asset.kind === 'audio' && value instanceof ArrayBuffer) {
      this.#audio.set(asset.id, value);
    } else {
      throw assetError(
        asset.id,
        `Decoder returned the wrong type for "${asset.id}".`,
        'Use a decoder matching the declared asset kind.',
      );
    }
    this.#loaded++;
  }

  buildMaterials(): void {
    for (const spec of this.#manifest.materials ?? []) {
      const base = {
        color: spec.color ?? '#ffffff',
        opacity: spec.opacity ?? 1,
        transparent: (spec.opacity ?? 1) < 1,
        alphaTest: spec.alphaTest ?? 0,
        side: spec.doubleSided === true ? DoubleSide : FrontSide,
        map: spec.map === undefined ? null : this.#sampler(spec.map, undefined, spec.repeat),
      };
      const material =
        spec.shading === 'standard'
          ? new MeshStandardMaterial({
              ...base,
              roughness: spec.roughness ?? 0.85,
              metalness: spec.metalness ?? 0,
              emissive: spec.emissive ?? '#000000',
              emissiveIntensity: spec.emissiveIntensity ?? 1,
              normalMap:
                spec.normalMap === undefined
                  ? null
                  : this.#sampler(spec.normalMap, undefined, spec.repeat),
            })
          : new MeshBasicMaterial(base);
      material.name = spec.id;
      this.#materials.set(spec.id, material);
      this.#ownedMaterials.add(sharedResource(material));
    }
  }

  async verifyImages(): Promise<void> {
    for (const texture of this.#ownedTextures) {
      const id = this.#textureOwners.get(texture) ?? 'texture';
      const image: unknown = texture.image;
      try {
        // Chromium can resolve image.decode() for a PNG with a corrupt compressed payload.
        // A real bitmap decode must succeed before that image is allowed to reach WebGL.
        if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) {
          await image.decode();
          await verifyPixels(image);
        }
        if (
          typeof image === 'object' &&
          image !== null &&
          'width' in image &&
          'height' in image &&
          (typeof image.width !== 'number' ||
            typeof image.height !== 'number' ||
            image.width <= 0 ||
            image.height <= 0)
        )
          throw new Error('Decoded image has no pixels.');
      } catch (error) {
        throw assetError(
          id,
          `Cannot load "${id}": image pixels could not be decoded (${error instanceof Error ? error.message : String(error)}).`,
          'Repair or regenerate this image and retry; a load event alone does not prove valid pixels.',
        );
      }
    }
  }

  setLoadedFiles(count: number): void {
    this.#loaded = count;
  }

  #sampler(id: string, frame?: string, repeat?: readonly [number, number]): Texture {
    this.#check();
    const original = this.#textures.get(id);
    if (original === undefined)
      throw assetError(
        id,
        `Unknown texture "${id}".`,
        'Declare and preload this texture in presentation.assets.',
      );
    if (frame === undefined && repeat === undefined) return original;
    const key = `${id}|${frame ?? ''}|${repeat?.join(',') ?? ''}`;
    const cached = this.#samplers.get(key);
    if (cached !== undefined) return cached;
    const texture = original.clone();
    if (frame !== undefined) {
      const spec = this.#manifest.assets?.find((entry) => entry.id === id);
      const rect =
        spec?.kind === 'texture' && spec.frames !== undefined && Object.hasOwn(spec.frames, frame)
          ? spec.frames[frame]
          : undefined;
      if (rect === undefined) {
        texture.dispose();
        throw assetError(
          id,
          `Unknown atlas frame "${frame}" on "${id}".`,
          'Declare the normalized top-left rectangle in the texture frames.',
        );
      }
      texture.offset.set(rect[0], 1 - rect[3]);
      texture.repeat.set(rect[2] - rect[0], rect[3] - rect[1]);
    }
    if (repeat !== undefined) {
      texture.wrapS = texture.wrapT = RepeatWrapping;
      texture.repeat.set(repeat[0], repeat[1]);
    }
    texture.needsUpdate = true;
    this.#samplers.set(key, texture);
    this.#ownedTextures.add(texture);
    return texture;
  }

  texture(id: string, frame?: string): Texture {
    return this.#sampler(id, frame);
  }

  material(id: string): Material {
    this.#check();
    const material = this.#materials.get(id);
    if (material === undefined)
      throw assetError(
        id,
        `Unknown material "${id}".`,
        'Declare the material before binding it to a surface.',
      );
    return material;
  }

  instantiateModel(id: string): ModelInstance {
    this.#check();
    const template = this.#models.get(id);
    if (template === undefined)
      throw assetError(id, `Unknown model "${id}".`, 'Declare and preload this glTF asset.');
    const root = clone(template.scene);
    let released = false;
    const instance: ModelInstance = {
      root,
      clips: template.animations,
      dispose: () => {
        if (released) return;
        released = true;
        root.removeFromParent();
        const skeletons = new Set<Skeleton>();
        root.traverse((node) => {
          if (node instanceof SkinnedMesh) skeletons.add(node.skeleton);
        });
        for (const skeleton of skeletons) skeleton.dispose();
        this.#instances.delete(instance);
      },
    };
    this.#instances.add(instance);
    return instance;
  }

  audio(id: string): ArrayBuffer {
    this.#check();
    const bytes = this.#audio.get(id);
    if (bytes === undefined)
      throw assetError(id, `Unknown audio "${id}".`, 'Declare and preload this audio asset.');
    return bytes;
  }

  stats(): PresentationAssetStats {
    return {
      textures: this.#ownedTextures.size,
      materials: this.#ownedMaterials.size,
      geometries: this.#ownedGeometry.size,
      modelInstances: this.#instances.size,
      audioBytes: [...this.#audio.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0),
      loadedFiles: this.#loaded,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const instance of this.#instances) instance.dispose();
    for (const geometry of this.#ownedGeometry) geometry.dispose();
    for (const material of this.#ownedMaterials) material.dispose();
    const images = new Set<unknown>();
    for (const texture of this.#ownedTextures) {
      images.add(texture.source.data);
      texture.dispose();
    }
    for (const image of images)
      if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
    this.#ownedGeometry.clear();
    this.#ownedMaterials.clear();
    this.#ownedTextures.clear();
    this.#textureOwners.clear();
    this.#textures.clear();
    this.#models.clear();
    this.#audio.clear();
    this.#materials.clear();
    this.#samplers.clear();
    this.#loaded = 0;
  }
}

/** Preload before adapter construction; no IO is performed by an adapter's mount or sync. */
export async function loadPresentationAssets(
  config: ResolvedPresentation,
  options: AssetLoadOptions = {},
): Promise<PresentationAssets> {
  const checked = validatePresentation(config.manifest);
  if (!checked.ok) throw new DiagnosticError(checked.diagnostics);
  const library = new AssetLibrary(config.manifest);
  const base = new URL(
    config.baseUrl,
    typeof document === 'undefined' ? 'http://localhost/' : document.baseURI,
  );
  if (!base.pathname.endsWith('/'))
    throw assetError(
      'baseUrl',
      'Asset baseUrl must end with a slash.',
      'Supply a directory URL, e.g. ../../assets/demo/.',
    );
  if (typeof document !== 'undefined' && base.origin !== new URL(document.baseURI).origin)
    throw assetError(
      'baseUrl',
      'Presentation assets must be served from the page origin.',
      'Vendor the assets locally instead of using a runtime CDN.',
    );
  const assets = config.manifest.assets ?? [];
  const files = config.files ?? assets.map((a) => a.src);
  for (const path of files)
    if (!isAssetPath(path))
      throw assetError(
        path,
        'Invalid prepared dependency path.',
        'Use a relative path within this presentation asset root.',
      );
  const allowed = new Set(files.map((path) => new URL(path, base).href));
  const bytesByUrl = new Map<string, ArrayBuffer>();
  const localUrls = new Map<string, string>();
  const dependencyErrors: string[] = [];
  const manager = new LoadingManager();
  manager.onError = (url) => {
    dependencyErrors.push([...localUrls].find(([, local]) => local === url)?.[0] ?? url);
  };
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    const resolved = new URL(url, base).href;
    if (!allowed.has(resolved)) {
      dependencyErrors.push(url);
      throw assetError(
        url,
        `glTF requests an undeclared dependency "${url}".`,
        'Include this local file in the prepared asset closure; external resources are not supported.',
      );
    }
    if (options.loaders !== undefined) return resolved;
    const cached = localUrls.get(resolved);
    if (cached !== undefined) return cached;
    const bytes = bytesByUrl.get(resolved);
    if (bytes === undefined)
      throw assetError(
        url,
        'Dependency was not preloaded.',
        'Prepare the complete local glTF dependency closure.',
      );
    const local = URL.createObjectURL(new Blob([bytes], { type: mimeFor(resolved) }));
    localUrls.set(resolved, local);
    return local;
  });
  const controller = new AbortController();
  const signals = [controller.signal, AbortSignal.timeout(30_000)];
  if (options.signal !== undefined) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  // Preload the closed file graph once. glTF sub-loads then use bounded local blobs, not
  // unabortable network requests hidden inside three.js's subordinate loaders.
  if (options.loaders === undefined) {
    const queue = [...allowed];
    let index = 0;
    let totalBytes = 0;
    let failed: unknown;
    const preload = async (): Promise<void> => {
      while (index < queue.length) {
        const url = queue[index++];
        if (url === undefined) return;
        try {
          const bytes = await fetchBytes(url, signal);
          totalBytes += bytes.byteLength;
          if (totalBytes > PRESENTATION_LIMITS.totalBytes)
            throw assetError(
              url,
              'The asset graph exceeds 64 MiB.',
              'Reduce or split the presentation assets.',
            );
          bytesByUrl.set(url, bytes);
        } catch (error) {
          failed ??= assetError(
            url,
            `Cannot preload "${url}": ${error instanceof Error ? error.message : String(error)}`,
            'Check the local asset response, then retry.',
          );
          controller.abort();
          throw error;
        }
      }
    };
    await Promise.allSettled(
      Array.from({ length: Math.min(PRESENTATION_LIMITS.loadConcurrency, queue.length) }, preload),
    );
    if (failed !== undefined) throw failed;
    signal.throwIfAborted();
  }
  const loaders =
    options.loaders ??
    browserLoaders(async (url) => {
      const bytes = bytesByUrl.get(url);
      if (bytes === undefined)
        throw assetError(
          url,
          'This asset is absent from the prepared file inventory.',
          'Prepare the complete manifest file graph.',
        );
      return bytes;
    });
  let next = 0;
  let loaded = 0;
  let firstError: unknown;
  options.onProgress?.(0, assets.length);
  const worker = async (): Promise<void> => {
    while (next < assets.length) {
      signal.throwIfAborted();
      const asset = assets[next++];
      if (asset === undefined) break;
      const url = new URL(asset.src, base).href;
      try {
        const value =
          asset.kind === 'texture'
            ? await loaders.texture(url, signal)
            : asset.kind === 'gltf'
              ? await loaders.model(url, manager, signal)
              : await loaders.audio(url, signal);
        library.add(asset, value);
        if (asset.kind === 'gltf' && dependencyErrors.length > 0)
          throw assetError(
            asset.id,
            `Model "${asset.id}" has a required dependency that failed to decode: ${dependencyErrors.join(', ')}.`,
            'Repair the required texture/buffer; glTF material fallbacks are not accepted.',
          );
        signal.throwIfAborted();
        options.onProgress?.(++loaded, assets.length);
      } catch (error) {
        const failure =
          error instanceof DiagnosticError
            ? error
            : assetError(
                asset.id,
                `Cannot load "${asset.id}" (${asset.src}): ${error instanceof Error ? error.message : String(error)}`,
                'Check the file, its format and its local dependencies, then retry.',
              );
        firstError ??= failure;
        controller.abort();
        throw failure;
      }
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(PRESENTATION_LIMITS.loadConcurrency, assets.length) }, worker),
  );
  const failed = results.find((result) => result.status === 'rejected');
  try {
    if (failed?.status === 'rejected') throw firstError ?? failed.reason;
    signal.throwIfAborted();
    await library.verifyImages();
    signal.throwIfAborted();
    library.buildMaterials();
    library.setLoadedFiles(allowed.size);
    return library;
  } catch (error) {
    library.dispose();
    throw error;
  } finally {
    for (const url of localUrls.values()) URL.revokeObjectURL(url);
  }
}
