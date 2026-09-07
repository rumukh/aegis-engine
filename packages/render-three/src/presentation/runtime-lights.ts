import { AmbientLight, DirectionalLight, Group, PointLight, Vector3 } from 'three';
import type { Light as ThreeLight, Scene } from 'three';
import { Name, Transform, DiagnosticError } from '@aegis/core';
import type { GameMode, World } from '@aegis/core';
import { Light } from '@aegis/content';
import { PRESENTATION_LIMITS } from './schema.js';
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

export function lightStats(scene: Scene): { lights: number; pointLights: number } {
  let lights = 0;
  let pointLights = 0;
  scene.traverse((node) => {
    if ('isLight' in node && node.isLight === true) {
      lights++;
    }
    if (node instanceof PointLight) pointLights++;
  });
  return { lights, pointLights };
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
}
