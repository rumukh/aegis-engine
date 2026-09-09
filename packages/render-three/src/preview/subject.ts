import {
  AnimationMixer,
  Box3,
  BoxGeometry,
  DoubleSide,
  InstancedMesh,
  LoopOnce,
  Mesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import type { AnimationClip, BufferGeometry, Material, Object3D, Texture } from 'three';
import { hashString } from '@aegis/core';
import type { ModelInstance, PresentationAssets } from '../presentation/assets.js';
import type { PresentationManifest, Vec3 } from '../presentation/schema.js';
import type { PreviewBounds, PreviewSelection, PreviewSettings } from './types.js';
import { PreviewCode, previewError } from './diagnostics.js';

export function tuple(value: Vector3): Vec3 {
  return [value.x, value.y, value.z];
}

export function assetBounds(root: Object3D): PreviewBounds {
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root, true);
  const size = box.getSize(new Vector3());
  if (box.isEmpty() || ![...box.min, ...box.max].every(Number.isFinite) || size.length() <= 0)
    throw previewError(
      PreviewCode.Load,
      'bounds',
      'This asset has no finite, nonempty renderable bounds.',
      'Export visible mesh geometry with valid positions, transforms, and animation tracks.',
    );
  return {
    min: tuple(box.min),
    max: tuple(box.max),
    size: tuple(size),
    center: tuple(box.getCenter(new Vector3())),
  };
}

export function meshStats(root: Object3D): {
  meshes: number;
  triangles: number;
  vertices: number;
  materials: number;
  textures: number;
  materialNames: string[];
  poseSampleHash: string;
} {
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const pose: string[] = [];
  const vertex = new Vector3();
  const transform = new Matrix4();
  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    const instances = node instanceof InstancedMesh ? node.count : 1;
    meshes += instances;
    const count = node.geometry.getAttribute('position')?.count ?? 0;
    vertices += count * instances;
    triangles += ((node.geometry.index?.count ?? count) / 3) * instances;
    const samples = Math.min(count, 32);
    const placements = Math.min(instances, 32);
    for (let instance = 0; instance < placements; instance++) {
      if (node instanceof InstancedMesh)
        node.getMatrixAt(Math.floor((instance * instances) / placements), transform);
      else transform.identity();
      for (let sample = 0; sample < samples; sample++) {
        node
          .getVertexPosition(Math.floor((sample * count) / samples), vertex)
          .applyMatrix4(transform)
          .applyMatrix4(node.matrixWorld);
        pose.push(vertex.toArray().join(','));
      }
    }
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (
          typeof value === 'object' &&
          value !== null &&
          'isTexture' in value &&
          value.isTexture === true
        )
          textures.add(value as Texture);
      }
    }
  });
  return {
    meshes,
    triangles,
    vertices,
    materials: materials.size,
    textures: textures.size,
    materialNames: [...materials].map((material) => material.name || '(unnamed)'),
    poseSampleHash: hashString(pose.join('|')),
  };
}

function imageSize(texture: Texture): { width: number; height: number } {
  const image: unknown = texture.image;
  if (
    typeof image !== 'object' ||
    image === null ||
    !('width' in image) ||
    !('height' in image) ||
    typeof image.width !== 'number' ||
    typeof image.height !== 'number' ||
    image.width <= 0 ||
    image.height <= 0
  )
    throw previewError(
      PreviewCode.Load,
      'texture',
      'The loaded texture has no image dimensions.',
      'Use a decodable image with a nonzero width and height.',
    );
  return { width: image.width, height: image.height };
}

/** One specimen owns its instance/sample, never the production library's shared GPU resources. */
export class PreviewSubject {
  readonly root: Object3D;
  readonly clips: readonly AnimationClip[];
  readonly #instance?: ModelInstance;
  readonly #geometry?: BufferGeometry;
  readonly #material?: Material;
  readonly #mixer?: AnimationMixer;
  #clip: string | null = null;
  #disposed = false;

  constructor(
    assets: PresentationAssets,
    manifest: PresentationManifest,
    selection: PreviewSelection,
    shape: PreviewSettings['shape'] = 'sphere',
  ) {
    if (selection.kind === 'model') {
      this.#instance = assets.instantiateModel(selection.id);
      this.root = this.#instance.root;
      this.clips = this.#instance.clips;
      this.#mixer = new AnimationMixer(this.root);
      this.root.traverse((node) => {
        // The studio light choice must not depend on optional lights embedded in a model.
        if ('isLight' in node && node.isLight === true) node.visible = false;
        if (node instanceof Mesh && selection.material !== undefined)
          node.material = assets.material(selection.material);
      });
    } else {
      this.clips = [];
      let material: Material;
      if (selection.kind === 'texture') {
        const texture = assets.texture(selection.id, selection.frame);
        const size = imageSize(texture);
        const spec = manifest.assets?.find((entry) => entry.id === selection.id);
        const rect =
          spec?.kind === 'texture' && selection.frame !== undefined
            ? spec.frames?.[selection.frame]
            : undefined;
        const aspect =
          (size.width * (rect === undefined ? 1 : rect[2] - rect[0])) /
          (size.height * (rect === undefined ? 1 : rect[3] - rect[1]));
        this.#geometry = new PlaneGeometry(aspect, 1);
        material = this.#material = new MeshBasicMaterial({
          map: texture,
          side: DoubleSide,
          transparent: true,
          depthWrite: false,
        });
      } else {
        this.#geometry =
          shape === 'cube'
            ? new BoxGeometry(1.6, 1.6, 1.6)
            : shape === 'plane'
              ? new PlaneGeometry(2, 2)
              : new SphereGeometry(1, 48, 32);
        material = assets.material(selection.id);
      }
      this.root = new Mesh(this.#geometry, material);
      this.root.name = `${selection.kind}:${selection.id}`;
    }
  }

  validateSample(clip: string | null, time: number): void {
    if (clip === null) {
      if (time !== 0)
        throw previewError(
          PreviewCode.Settings,
          'time',
          'A nonzero sample time requires a selected model clip.',
          'Choose a clip or use time 0 for the rest pose.',
        );
      return;
    }
    const match = this.clips.find((entry) => entry.name === clip);
    if (match === undefined)
      throw previewError(
        PreviewCode.Selection,
        'clip',
        `Unsupported clip "${clip}".`,
        `Choose an exact clip name: ${this.clips.map((entry) => entry.name).join(', ') || '(none)'}, or select the rest pose.`,
      );
    if (time > match.duration)
      throw previewError(
        PreviewCode.Settings,
        'time',
        `Time ${time} exceeds clip "${clip}" duration ${match.duration} seconds.`,
        'Sample within [0, duration]. Playback wraps; fixed capture times never silently clamp.',
      );
  }

  sample(clip: string | null, time: number): void {
    this.validateSample(clip, time);
    if (this.#mixer !== undefined) {
      if (this.#clip !== clip || clip === null) this.#mixer.stopAllAction();
      if (clip !== null) {
        const selected = this.clips.find((entry) => entry.name === clip)!;
        const action = this.#mixer.clipAction(selected);
        action.reset().setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        this.#mixer.setTime(time);
      }
      this.#clip = clip;
    }
    this.root.updateMatrixWorld(true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#mixer?.stopAllAction();
    this.#mixer?.uncacheRoot(this.root);
    this.root.removeFromParent();
    this.#instance?.dispose();
    this.#geometry?.dispose();
    this.#material?.dispose();
  }
}
