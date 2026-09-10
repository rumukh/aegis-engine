import {
  DirectionalLight,
  HemisphereLight,
  Light,
  PointLight,
  RectAreaLight,
  Scene,
  SpotLight,
} from 'three';
import type { Camera, WebGLRenderer } from 'three';
import type { ForegroundPass, RenderAdapter } from './adapter.js';

type Renderer = Pick<WebGLRenderer, 'render' | 'clearDepth' | 'autoClear'> & {
  info: Pick<WebGLRenderer['info'], 'autoReset' | 'reset'>;
};

/** Preserve foreground self-depth, caller render state and the total work of both passes. */
export function renderAdapter(
  renderer: Renderer,
  adapter: Pick<RenderAdapter, 'scene' | 'camera' | 'foreground'>,
): void {
  if (adapter.foreground === undefined) {
    renderer.render(adapter.scene, adapter.camera);
    return;
  }
  const autoClear = renderer.autoClear;
  const autoReset = renderer.info.autoReset;
  try {
    renderer.info.autoReset = false;
    if (autoReset) renderer.info.reset();
    renderer.render(adapter.scene, adapter.camera);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(adapter.foreground.scene, adapter.foreground.camera);
  } finally {
    renderer.autoClear = autoClear;
    renderer.info.autoReset = autoReset;
  }
}

/** A transparent-background foreground with owned light copies and borrowed environment maps. */
export class ForegroundScene implements ForegroundPass {
  readonly scene = new Scene();
  readonly #lights = new Map<Light, Light>();

  constructor(readonly camera: Camera) {
    this.scene.name = 'foreground';
  }

  syncLighting(world: Scene): void {
    this.scene.environment = world.environment;
    this.scene.environmentIntensity = world.environmentIntensity;
    this.scene.environmentRotation.copy(world.environmentRotation);
    const seen = new Set<Light>();
    world.traverseVisible((source) => {
      if (!(source instanceof Light)) return;
      seen.add(source);
      let light = this.#lights.get(source);
      if (light === undefined) {
        light = source.clone(false);
        this.#lights.set(source, light);
        this.scene.add(light);
        if (light instanceof DirectionalLight || light instanceof SpotLight)
          this.scene.add(light.target);
      }
      light.color.copy(source.color);
      light.intensity = source.intensity;
      light.layers.mask = source.layers.mask;
      light.castShadow = false;
      source.updateWorldMatrix(true, false);
      source.matrixWorld.decompose(light.position, light.quaternion, light.scale);
      if (source instanceof PointLight && light instanceof PointLight) {
        light.distance = source.distance;
        light.decay = source.decay;
      }
      if (source instanceof HemisphereLight && light instanceof HemisphereLight)
        light.groundColor.copy(source.groundColor);
      if (source instanceof RectAreaLight && light instanceof RectAreaLight) {
        light.width = source.width;
        light.height = source.height;
      }
      if (source instanceof SpotLight && light instanceof SpotLight) {
        light.distance = source.distance;
        light.decay = source.decay;
        light.angle = source.angle;
        light.penumbra = source.penumbra;
        light.map = source.map;
      }
      if (
        (source instanceof DirectionalLight || source instanceof SpotLight) &&
        (light instanceof DirectionalLight || light instanceof SpotLight)
      )
        source.target.getWorldPosition(light.target.position);
    });
    for (const [source, light] of this.#lights) {
      if (seen.has(source)) continue;
      this.#remove(light);
      this.#lights.delete(source);
    }
    this.scene.updateMatrixWorld(true);
  }

  #remove(light: Light): void {
    if (light instanceof DirectionalLight || light instanceof SpotLight)
      light.target.removeFromParent();
    light.removeFromParent();
    light.dispose();
  }

  dispose(): void {
    for (const light of this.#lights.values()) this.#remove(light);
    this.#lights.clear();
    this.scene.environment = null;
    this.scene.clear();
  }
}
