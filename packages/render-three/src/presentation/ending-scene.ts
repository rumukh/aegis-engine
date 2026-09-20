import {
  AnimationMixer,
  Color,
  DirectionalLight,
  HemisphereLight,
  LoopOnce,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import type { AnimationAction, Object3D } from 'three';
import type { ModelInstance, PresentationAssets } from './assets.js';
import type { WinEndingSpec } from './schema.js';

/** An isolated animation set, with no World, mode controller or simulation clock. */
export class EndingScene {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly duration: number;
  readonly #instance: ModelInstance;
  readonly #mixer: AnimationMixer;
  readonly #action: AnimationAction;
  readonly #eye: Object3D;
  readonly #target: Object3D;
  readonly #look = new Vector3();

  constructor(assets: PresentationAssets, spec: WinEndingSpec) {
    this.#instance = assets.instantiateModel(spec.model);
    const instance = this.#instance;
    try {
      const clips = instance.clips.filter((clip) => clip.name === spec.clip);
      const clip = clips[0];
      if (
        clips.length !== 1 ||
        clip === undefined ||
        !Number.isFinite(clip.duration) ||
        clip.duration < 1 ||
        clip.duration > 120
      )
        throw new Error(
          `[aegis:ending] "${spec.model}" needs one "${spec.clip}" clip lasting 1-120 seconds.`,
        );
      this.duration = clip.duration;
      if (
        (spec.fadeSeconds ?? 1.5) > this.duration ||
        spec.captions?.some((caption) => caption.endSeconds > this.duration) ||
        spec.cues?.some((cue) => cue.atSeconds >= this.duration)
      )
        throw new Error('[aegis:ending] Fade, captions and cues must fit inside the ending clip.');
      const node = (name: string): Object3D => {
        const matches: Object3D[] = [];
        instance.root.traverse((child) => {
          if (child.name === name) matches.push(child);
        });
        if (matches.length !== 1)
          throw new Error(
            `[aegis:ending] Camera node "${name}" must occur exactly once in "${spec.model}".`,
          );
        return matches[0]!;
      };
      this.#eye = node(spec.camera.eye);
      this.#target = node(spec.camera.target);
      this.camera = new PerspectiveCamera(spec.camera.fov ?? 50, 16 / 9, 0.05, 2000);
      this.scene.name = 'presentation:win-ending';
      this.scene.background = new Color('#020407');
      const key = new DirectionalLight('#f3dbc0', 3);
      key.position.set(-30, 60, -40);
      this.scene.add(instance.root, new HemisphereLight('#adc4db', '#181e27', 1.2), key);
      this.#mixer = new AnimationMixer(instance.root);
      this.#action = this.#mixer.clipAction(clip);
      this.#action.setLoop(LoopOnce, 1);
      this.#action.clampWhenFinished = true;
      this.#action.play();
      this.sample(0);
    } catch (error) {
      instance.dispose();
      throw error;
    }
  }

  sample(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0)
      throw new Error('[aegis:ending] Animation time must be finite and nonnegative.');
    this.#action.enabled = true;
    this.#action.paused = false;
    this.#mixer.setTime(Math.min(seconds, this.duration));
    this.scene.updateMatrixWorld(true);
    this.#eye.getWorldPosition(this.camera.position);
    this.#target.getWorldPosition(this.#look);
    if (this.camera.position.distanceToSquared(this.#look) < 0.000001)
      throw new Error('[aegis:ending] Animated camera eye and target coincide.');
    this.camera.lookAt(this.#look);
    this.camera.updateMatrixWorld(true);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = height > 0 ? width / height : 16 / 9;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.#mixer.stopAllAction();
    this.#mixer.uncacheRoot(this.#instance.root);
    this.#instance.dispose();
    this.scene.environment = null;
    this.scene.clear();
  }
}
