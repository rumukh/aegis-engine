import { AmbientLight, DirectionalLight, Group, PointLight, SpotLight, Vector3 } from 'three';
import type { Camera, Light as ThreeLight, Scene } from 'three';
import { Name, Transform, DiagnosticError } from '@aegis/core';
import type { GameMode, World } from '@aegis/core';
import { Light } from '@aegis/content';
import { CINEMATIC_QUALITY, PRESENTATION_LIMITS } from './schema.js';
import type { QualityTier, SpotSpec } from './schema.js';
import type { PresentationState } from './state.js';
import { RenderCode, renderDiagnostic } from './diagnostics.js';

export interface RenderPosition {
  x: number;
  y: number;
  z: number;
}

/** Iso Transform.y is grid Y; Transform.z is the optional visual elevation. */
export function renderPosition(mode: GameMode, at: RenderPosition): RenderPosition {
  return mode === 'iso' ? { x: at.x, y: at.z, z: at.y } : at;
}

/** Content lights also work on the legacy path, without constructing a presentation library. */
export class ContentLights {
  readonly root = new Group();
  readonly #scene: Scene;
  readonly #mode: GameMode;
  readonly #lights = new Map<number, { kind: string; light: ThreeLight }>();
  #attached = false;

  constructor(scene: Scene, mode: GameMode) {
    this.#scene = scene;
    this.#mode = mode;
    this.root.name = 'presentation:content-lights';
  }

  get size(): number {
    return this.#lights.size;
  }

  sync(world: World): void {
    const claimed = new Set<number>();
    for (const view of world.query({ has: [Light] }).views()) {
      claimed.add(view.entity);
      const data = view.get(Light);
      let entry = this.#lights.get(view.entity);
      if (entry !== undefined && entry.kind !== data.kind) {
        this.#remove(entry.light);
        this.#lights.delete(view.entity);
        entry = undefined;
      }
      if (entry === undefined) {
        const light =
          data.kind === 'ambient'
            ? new AmbientLight()
            : data.kind === 'directional'
              ? new DirectionalLight()
              : new PointLight();
        light.name = `light:content:${world.get(view.entity, Name)?.value ?? view.entity}`;
        entry = { kind: data.kind, light };
        this.#lights.set(view.entity, entry);
        this.root.add(light);
        if (light instanceof DirectionalLight) this.root.add(light.target);
      }
      const light = entry.light;
      light.color.set(data.color);
      light.intensity = data.intensity;
      light.castShadow = false;
      const transform = view.tryGet(Transform);
      const at = renderPosition(this.#mode, transform?.position ?? { x: 0, y: 0, z: 0 });
      light.position.copy(at);
      if (light instanceof DirectionalLight) {
        const direction = new Vector3(0, -1, 0);
        if (transform !== undefined) direction.applyQuaternion(transform.rotation);
        light.target.position.copy(at).add(direction);
      }
    }
    for (const [entity, entry] of this.#lights) {
      if (claimed.has(entity)) continue;
      this.#remove(entry.light);
      this.#lights.delete(entity);
    }
    if (this.#lights.size > 0 && !this.#attached) {
      this.#scene.add(this.root);
      this.#attached = true;
    }
    if (this.#lights.size === 0 && this.#attached) {
      this.root.removeFromParent();
      this.#attached = false;
    }
  }

  #remove(light: ThreeLight): void {
    if (light instanceof DirectionalLight) light.target.removeFromParent();
    light.removeFromParent();
    light.dispose();
  }

  dispose(): void {
    for (const entry of this.#lights.values()) this.#remove(entry.light);
    this.#lights.clear();
    this.root.removeFromParent();
    this.root.clear();
    this.#attached = false;
  }
}

export function lightStats(scene: Scene): {
  lights: number;
  pointLights: number;
  spotLights: number;
  shadowLights: number;
} {
  let lights = 0;
  let pointLights = 0;
  let spotLights = 0;
  let shadowLights = 0;
  scene.traverse((node) => {
    if ('isLight' in node && node.isLight === true) {
      lights++;
      if (node.castShadow) shadowLights++;
    }
    if (node instanceof PointLight) pointLights++;
    if (node instanceof SpotLight) spotLights++;
  });
  return { lights, pointLights, spotLights, shadowLights };
}

export function checkLightBudget(scene: Scene): void {
  const count = lightStats(scene).pointLights;
  if (count > PRESENTATION_LIMITS.pointLights)
    throw new DiagnosticError([
      renderDiagnostic(
        RenderCode.Budget,
        'environment.points',
        `The rendered scene has ${count} point lights; the shared limit is 8.`,
        'Reduce manifest, content Light, or glTF point lights so their combined count is at most 8.',
      ),
    ]);
  const stats = lightStats(scene);
  for (const [field, limit] of [
    ['spotLights', PRESENTATION_LIMITS.spotLights],
    ['shadowLights', PRESENTATION_LIMITS.shadowLights],
  ] as const) {
    if (stats[field] > limit)
      throw new DiagnosticError([
        renderDiagnostic(
          RenderCode.Budget,
          'environment.spots',
          `The rendered scene has ${stats[field]} ${field}; the shared limit is ${limit}.`,
          'Reduce combined manifest, content and glTF lights before rendering.',
        ),
      ]);
  }
}

/** Bounded practical lights; camera-local coordinates use the camera's full world transform. */
export class PracticalLights {
  readonly root = new Group();
  readonly #entries: { spec: SpotSpec; light: SpotLight }[];
  constructor(specs: readonly SpotSpec[], quality: QualityTier) {
    this.root.name = 'presentation:practical-lights';
    this.#entries = specs.map((spec) => {
      const light = new SpotLight(
        spec.color,
        spec.intensity,
        spec.distance,
        (spec.angle * Math.PI) / 180,
        spec.penumbra ?? 0.5,
        spec.decay ?? 2,
      );
      light.name = `presentation:spot:${spec.id}`;
      light.castShadow = spec.shadow !== undefined;
      light.shadow.camera.near = 0.05;
      light.shadow.camera.far = spec.distance;
      light.shadow.bias = spec.shadow?.bias ?? -0.0001;
      light.shadow.normalBias = spec.shadow?.normalBias ?? 0.015;
      this.root.add(light, light.target);
      return { spec, light };
    });
    this.setQuality(quality);
  }

  setQuality(quality: QualityTier): void {
    for (const { spec, light } of this.#entries) {
      if (spec.shadow === undefined) continue;
      const size = Math.min(spec.shadow.mapSize ?? 1024, CINEMATIC_QUALITY[quality].shadowMap);
      if (light.shadow.mapSize.x !== size) {
        light.shadow.map?.dispose();
        light.shadow.map = null;
        light.shadow.mapSize.set(size, size);
        light.shadow.needsUpdate = true;
      }
    }
  }

  sync(camera: Camera, state: PresentationState): void {
    camera.updateWorldMatrix(true, false);
    for (const { spec, light } of this.#entries) {
      light.visible = spec.enabledWhen === undefined || state.matches(spec.enabledWhen);
      light.position.fromArray(spec.position);
      light.target.position.fromArray(spec.target);
      if (spec.anchor === 'camera') {
        light.position.applyMatrix4(camera.matrixWorld);
        light.target.position.applyMatrix4(camera.matrixWorld);
      } else if (typeof spec.anchor === 'object') {
        const at = new Vector3().fromArray(state.position(spec.anchor.entity));
        light.position.add(at);
        light.target.position.add(at);
      }
    }
  }

  dispose(): void {
    for (const { light } of this.#entries) light.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }
}
