/**
 * Tick-sampled, presentation-only scene ownership. `sync` binds authoritative positions;
 * `present` alone consumes events and samples animation. Neither operation writes to a World.
 */
import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  Group,
  Mesh,
  PointLight,
  Quaternion,
  Vector3,
} from 'three';
import type { AnimationClip, Camera, Material, Object3D, Scene } from 'three';
import { DiagnosticError, Name, Transform, cos, sin } from '@aegis/core';
import type { Entity, GameMode, World } from '@aegis/core';
import { Health, Model, Sprite } from '@aegis/content';
import type { ModelData, SpriteData } from '@aegis/content';
import type { VisualRole } from '../appearance.js';
import type { EventLine } from '../protocol.js';
import type { PresentationAssets, PresentationAssetStats } from './assets.js';
import { ContentLights, checkLightBudget, lightStats, renderPosition } from './runtime-lights.js';
import type { RenderPosition } from './runtime-lights.js';
import { ManagedVisual, VisualFactory, applyPose, visualError } from './runtime-visuals.js';
import type { AnimationOverride, StaticBatch } from './runtime-visuals.js';
import { QUALITY } from './schema.js';
import type {
  Decoration,
  EventEffect,
  PresentationManifest,
  QualityTier,
  SpriteState,
  VisualSpec,
} from './schema.js';
import { validatePresentation } from './validate.js';

export interface PresentationFrame {
  tick: number;
  tickRate: number;
  generation: number;
  paused: boolean;
  events: readonly EventLine[];
}

/** A render-local extension. Events in update are de-duplicated, including while paused. */
export interface PresentationEffect {
  update(frame: PresentationFrame): void;
  reset(): void;
  dispose(): void;
}

export interface PresentationRuntimeOptions {
  scene: Scene;
  camera: Camera;
  mode: GameMode;
  manifest: PresentationManifest;
  assets: PresentationAssets;
  quality?: QualityTier;
}

/** Adapter input, in renderer coordinates; the runtime never edits these mechanical objects. */
export interface EntityPresentationBinding {
  key: string;
  role: VisualRole;
  origin: RenderPosition;
  bounds: { center: RenderPosition; size: RenderPosition };
  legacy?: readonly Object3D[];
  state?: SpriteState;
  facing?: number;
  orientation?: { x: number; y: number; z: number; w: number };
  scale?: RenderPosition;
  trigger?: boolean;
}

export interface PresentedEntity {
  readonly root: Object3D;
  /** The unrenamed glTF root or sprite/primitive mesh. Named nodes remain addressable here. */
  readonly object: Object3D;
  readonly state: SpriteState;
}

export interface PresentationVisual {
  /** Caller-parented root, in authored units/orientation; no automatic fitting or placement. */
  readonly root: Object3D;
  /** Original named glTF clips, or an empty array for primitives and sprites. */
  readonly clips: readonly AnimationClip[];
  /** Release this instance, not the shared library. Safe to call more than once. */
  dispose(): void;
}

export interface PresentationStats {
  quality: QualityTier;
  reducedMotion: boolean;
  resources: PresentationAssetStats & {
    runtimeMaterials: number;
    runtimeGeometries: number;
    objects: number;
    instances: number;
    batches: number;
    mixers: number;
    lights: number;
    pointLights: number;
  };
  effects: { active: number; registered: number; limit: number };
  /** Configured legacy visibility plus actual retained scene-graph geometry, not pixel coverage. */
  legacy: {
    level: boolean;
    triggers: boolean;
    debugGeometry: boolean;
    levelVisible: boolean;
    retainedMeshes: number;
    visibleMeshes: number;
  };
  /** Lifetime count of transient instances or registrations deliberately evicted/suppressed. */
  dropped: number;
}

type EntitySpec = NonNullable<PresentationManifest['entities']>[number];
type Target = EventEffect['target'];
interface Binding extends EntityPresentationBinding {
  entity: Entity;
  name: string;
  state: SpriteState;
  sprite?: SpriteData;
  model?: ModelData;
  visual?: ManagedVisual;
  identity?: string;
  selection?: EntitySpec;
  restored: Map<Object3D, { visible: boolean; trigger: boolean }>;
}
interface SceneObject {
  spec: Decoration;
  visual?: ManagedVisual;
  batch?: StaticBatch;
  root: Object3D;
}
interface ResolvedTarget {
  visual?: ManagedVisual;
  node?: Object3D;
  origin: RenderPosition;
  bounds: { center: RenderPosition; size: RenderPosition };
}
interface Cue {
  kind: 'cue';
  spec: EventEffect;
  start: number;
  overlay?: Mesh;
}
interface Particle {
  kind: 'particle';
  start: number;
  duration: number;
  mesh: Mesh;
  origin: Vector3;
  source?: Object3D;
  velocity: Vector3;
  size: number;
}
type Transient = Cue | Particle;
interface HeldAnimation {
  target: Target;
  animation: AnimationOverride;
}

function visualIdentity(spec: VisualSpec): string {
  return spec.kind === 'model'
    ? `model:${spec.mesh}`
    : spec.kind === 'sprite'
      ? `sprite:${spec.texture}`
      : `primitive:${spec.shape}`;
}

function targetKey(target: Target): string {
  return 'entity' in target ? `entity:${target.entity}` : `object:${target.object}`;
}

function bindingRank(binding: EntityPresentationBinding): number {
  if (binding.key.startsWith('actor:') || binding.key.startsWith('hitbox:')) return 3;
  if (binding.key.startsWith('platform:') || binding.key.startsWith('door:')) return 2;
  return binding.trigger ? 1 : 0;
}

/** Browser-safe; assets must already be loaded. Constructing/mounting never performs IO. */
export class PresentationRuntime {
  readonly manifest: PresentationManifest;
  readonly #scene: Scene;
  readonly #camera: Camera;
  readonly #mode: GameMode;
  readonly #assets: PresentationAssets;
  readonly #factory: VisualFactory;
  readonly #lights: ContentLights;
  readonly #root = new Group();
  readonly #entityRoot = new Group();
  readonly #objectRoot = new Group();
  readonly #effectRoot = new Group();
  readonly #environment = new Group();
  readonly #names = new Map<string, EntitySpec>();
  readonly #roles = new Map<VisualRole, EntitySpec>();
  readonly #bindings = new Map<string, Binding>();
  readonly #byName = new Map<string, Binding>();
  readonly #objects = new Map<string, SceneObject>();
  readonly #createdVisuals = new Set<ManagedVisual>();
  readonly #stateOverrides = new Map<string, SpriteState>();
  readonly #held = new Map<string, HeldAnimation>();
  readonly #extensions = new Set<PresentationEffect>();
  readonly #debugAncestors = new Map<Object3D, boolean>();
  readonly #restore = new Map<
    Object3D,
    { position: Vector3; quaternion: Quaternion; scale: Vector3 }
  >();
  readonly #background: Scene['background'];
  readonly #fog: Scene['fog'];
  #claimed = new Set<string>();
  #boundEntities = new Set<Entity>();
  #effects: Transient[] = [];
  #quality: QualityTier;
  #reducedMotion = false;
  #generation?: number;
  #sampleTick?: number;
  #syncedTick?: number;
  #cameraOrigin?: Vector3;
  #sequences: [number, number][] = [];
  #legacyEventTick = -1;
  #legacyEventCounts = new Map<string, number>();
  #occurrences = 0;
  #dropped = 0;
  #disposed = false;
  #debugGeometry = false;
  #legacyLevel?: Object3D;

  constructor(options: PresentationRuntimeOptions) {
    const checked = validatePresentation(options.manifest);
    if (!checked.ok) throw new DiagnosticError(checked.diagnostics);
    this.manifest = options.manifest;
    this.#scene = options.scene;
    this.#camera = options.camera;
    this.#mode = options.mode;
    this.#assets = options.assets;
    this.#quality = options.quality ?? options.manifest.quality ?? 'standard';
    this.#factory = new VisualFactory(options.assets);
    this.#lights = new ContentLights(options.scene, options.mode);
    this.#background = options.scene.background;
    this.#fog = options.scene.fog;
    this.#root.name = 'presentation';
    this.#entityRoot.name = 'presentation:entities';
    this.#objectRoot.name = 'presentation:objects';
    this.#effectRoot.name = 'presentation:effects';
    this.#environment.name = 'presentation:environment';
    this.#root.add(this.#entityRoot, this.#objectRoot, this.#effectRoot, this.#environment);
    this.#scene.add(this.#root);
    try {
      for (const spec of this.manifest.entities ?? []) {
        if ('name' in spec.target) this.#names.set(spec.target.name, spec);
        else this.#roles.set(spec.target.role, spec);
      }
      this.#buildEnvironment();
      for (const [index, spec] of (this.manifest.objects ?? []).entries()) {
        if (spec.instances !== undefined) {
          const batch = this.#factory.batch(spec, `objects[${index}]`);
          this.#objects.set(spec.id, { spec, root: batch.root, batch });
          this.#objectRoot.add(batch.root);
        } else {
          const visual = this.#factory.create(spec.visual, 'neutral', `objects[${index}].visual`);
          visual.root.name = `object:${spec.id}`;
          applyPose(visual.pose, spec.pose);
          this.#objects.set(spec.id, { spec, root: visual.root, visual });
          this.#objectRoot.add(visual.root);
        }
      }
      this.#validateTargets(false);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** Borrowed asset library; its ownership stays with the page/loader, not a visual instance. */
  get assets(): PresentationAssets {
    return this.#assets;
  }

  /**
   * Create a visual for an adapter-owned parent (for example an iso cell's picking owner).
   * `present` samples its idle/default clip; placement belongs to the caller. Dispose on removal;
   * remount/dispose also release any remaining handles. No level replacement is inferred.
   */
  createVisual(spec: VisualSpec): PresentationVisual {
    if (this.#disposed)
      throw new Error('[aegis] Cannot create a visual from a disposed presentation.');
    const checked = validatePresentation({
      aegis: 'presentation/1',
      assets: this.manifest.assets,
      materials: this.manifest.materials,
      objects: [{ id: 'adapter-visual', visual: spec }],
    });
    if (!checked.ok) throw new DiagnosticError(checked.diagnostics);
    const visual = this.#factory.create(spec, 'neutral', 'createVisual');
    this.#createdVisuals.add(visual);
    return {
      root: visual.root,
      clips: visual.clips,
      dispose: () => {
        if (!this.#createdVisuals.delete(visual)) return;
        visual.dispose();
      },
    };
  }

  /** Swap surface materials without modifying a level mesh's position, scale, or geometry. */
  surface(role: VisualRole, fallback: Material | Material[]): Material | Material[] {
    const id = this.manifest.surfaces?.[role];
    return id === undefined ? fallback : this.#assets.material(id);
  }

  bindLevel(level: Object3D): void {
    this.#legacyLevel = level;
    level.visible = this.#debugGeometry || this.manifest.legacy?.level !== false;
  }

  /** Reveal the original diagnostic geometry without changing collision positions or extents. */
  setDebugGeometry(enabled: boolean): void {
    if (this.#disposed) return;
    if (!enabled) this.#restoreDebugAncestors();
    this.#debugGeometry = enabled;
    if (this.#legacyLevel !== undefined)
      this.#legacyLevel.visible = enabled || this.manifest.legacy?.level !== false;
    for (const binding of this.#bindings.values()) this.#showLegacy(binding);
  }

  #showLegacy(binding: Binding): void {
    for (const [object, normal] of binding.restored) {
      object.visible =
        this.#debugGeometry ||
        (normal.visible &&
          binding.selection === undefined &&
          !(normal.trigger && this.manifest.legacy?.triggers === false));
      if (!this.#debugGeometry) continue;
      for (
        let parent = object.parent;
        parent !== null && parent !== this.#scene;
        parent = parent.parent
      ) {
        if (!this.#debugAncestors.has(parent)) this.#debugAncestors.set(parent, parent.visible);
        parent.visible = true;
      }
    }
  }

  #restoreDebugAncestors(): void {
    for (const [object, visible] of this.#debugAncestors) object.visible = visible;
    this.#debugAncestors.clear();
  }

  beginSync(): void {
    if (this.#disposed) return;
    this.#restoreDebugAncestors();
    this.#claimed.clear();
    this.#boundEntities.clear();
    this.#byName.clear();
  }

  bindEntity(world: World, entity: Entity, input: EntityPresentationBinding): void {
    if (this.#disposed) return;
    const stableKey = String(entity);
    this.#claimed.add(stableKey);
    const alreadyBound = this.#boundEntities.has(entity);
    this.#boundEntities.add(entity);
    const name = world.get(entity, Name)?.value ?? String(entity);
    const sprite = world.get(entity, Sprite);
    const model = world.get(entity, Model);
    let binding = this.#bindings.get(stableKey);
    const secondary =
      binding !== undefined && alreadyBound && bindingRank(binding) > bindingRank(input);
    const selection = secondary
      ? binding?.selection
      : this.#select(name, input.role, sprite, model, input.state);
    if (binding === undefined) {
      binding = { ...input, entity, name, state: 'idle', restored: new Map() };
      this.#bindings.set(stableKey, binding);
    }
    // Adapters refresh legacy visibility on every sync. Only declared replacements hide bodies.
    if (!alreadyBound) binding.restored.clear();
    for (const object of input.legacy ?? [])
      binding.restored.set(object, { visible: object.visible, trigger: input.trigger === true });
    if (!secondary)
      Object.assign(binding, input, {
        entity,
        name,
        sprite: sprite === undefined ? undefined : { ...sprite },
        model: model === undefined ? undefined : { ...model },
        selection,
        state: input.state ?? 'idle',
        origin: { ...input.origin },
        bounds: { center: { ...input.bounds.center }, size: { ...input.bounds.size } },
        orientation: input.orientation === undefined ? undefined : { ...input.orientation },
        scale: input.scale === undefined ? undefined : { ...input.scale },
        trigger: input.trigger,
        legacy: input.legacy,
      });
    this.#byName.set(name, binding);
    const identity = selection === undefined ? undefined : visualIdentity(selection.visual);
    if (identity !== binding.identity) {
      binding.visual?.root.traverse((node) => this.#restore.delete(node));
      binding.visual?.dispose();
      binding.visual = undefined;
      binding.identity = identity;
      this.#held.delete(`entity:${name}`);
    }
    if (selection !== undefined) {
      const visualRole = 'role' in selection.target ? selection.target.role : binding.role;
      if (binding.visual === undefined) {
        binding.visual = this.#factory.create(
          selection.visual,
          visualRole,
          `entities[${JSON.stringify(name)}].visual`,
        );
        binding.visual.root.name = `presentation:${input.key}`;
        this.#entityRoot.add(binding.visual.root);
      } else binding.visual.configure(selection.visual, visualRole);
      binding.visual.syncAppearance(sprite, model, this.#state(binding));
      this.#positionVisual(binding);
    }
    this.#showLegacy(binding);
    for (const object of input.legacy ?? []) {
      if (object instanceof Mesh) {
        const material = model?.material;
        object.material =
          material !== undefined && material !== ''
            ? this.#assets.material(material)
            : this.surface(input.state === 'dead' ? 'dead' : input.role, object.material);
      }
    }
  }

  /** Complete one read-only reconciliation, including purely visual Transform entities. */
  endSync(world: World): void {
    if (this.#disposed) return;
    for (const view of world.query({ has: [Transform] }).views()) {
      if (this.#boundEntities.has(view.entity)) continue;
      const transform = view.get(Transform);
      const origin = renderPosition(this.#mode, transform.position);
      this.bindEntity(world, view.entity, {
        key: `entity:${view.entity}`,
        role: 'neutral',
        origin,
        bounds: { center: origin, size: { x: 1, y: 1, z: 1 } },
        orientation: transform.rotation,
        scale: transform.scale,
        state: (view.tryGet(Health)?.current ?? 1) <= 0 ? 'dead' : 'idle',
      });
    }
    for (const [key, binding] of this.#bindings) {
      if (this.#claimed.has(key)) continue;
      this.#release(binding);
      this.#bindings.delete(key);
    }
    this.#lights.sync(world);
    this.#positionObjects();
    this.#validateTargets(true);
    checkLightBudget(this.#scene);
    this.#syncedTick = world.tick;
  }

  #select(
    name: string,
    role: VisualRole,
    sprite?: SpriteData,
    model?: ModelData,
    state?: SpriteState,
  ): EntitySpec | undefined {
    const named = this.#names.get(name);
    if (named !== undefined) return named;
    const spriteSpec: VisualSpec | undefined = sprite?.texture
      ? { kind: 'sprite', texture: sprite.texture, frame: sprite.frame }
      : undefined;
    const modelSpec: VisualSpec | undefined = model?.mesh
      ? { kind: 'model', mesh: model.mesh, material: model.material || undefined }
      : undefined;
    const component = this.#mode === 'fps' ? (modelSpec ?? spriteSpec) : (spriteSpec ?? modelSpec);
    return component === undefined
      ? state === 'dead'
        ? (this.#roles.get('dead') ?? this.#roles.get(role))
        : this.#roles.get(role)
      : { target: { name }, visual: component };
  }

  #state(binding: Binding): SpriteState {
    return this.#stateOverrides.get(binding.name) ?? binding.state;
  }

  /**
   * State-linked extension point for adapter-local effects. This changes only the presentation
   * state used by declarative sprite/model animation maps; undefined restores adapter inference.
   */
  setEntityState(name: string, state: SpriteState | undefined): void {
    if (state === undefined) this.#stateOverrides.delete(name);
    else this.#stateOverrides.set(name, state);
  }

  entity(name: string): PresentedEntity | undefined {
    const binding = this.#byName.get(name);
    if (binding?.visual === undefined) return undefined;
    return {
      root: binding.visual.root,
      object: binding.visual.object,
      state: this.#state(binding),
    };
  }

  object(id: string): { readonly root: Object3D; readonly object: Object3D } | undefined {
    const object = this.#objects.get(id);
    return object === undefined
      ? undefined
      : { root: object.root, object: object.visual?.object ?? object.root };
  }

  /** Entity visuals participate in logical picking; decorative objects and effects never do. */
  pickingRoots(): readonly Object3D[] {
    return this.#entityRoot.children;
  }

  pickOwner(object: Object3D): RenderPosition | undefined {
    let root: Object3D | null = object;
    while (root !== null && root.parent !== this.#entityRoot) root = root.parent;
    if (root === null) return undefined;
    for (const binding of this.#bindings.values())
      if (binding.visual?.root === root) return { ...binding.origin };
    return undefined;
  }

  #positionVisual(binding: Binding): void {
    const visual = binding.visual;
    if (visual === undefined) return;
    const authored = binding.selection?.fit === 'authored';
    visual.root.position.copy(authored ? binding.origin : binding.bounds.center);
    visual.root.quaternion.identity();
    visual.root.scale.set(1, 1, 1);
    applyPose(visual.pose, binding.selection?.pose);
    visual.fit.position.set(0, 0, 0);
    visual.fit.scale.set(1, 1, 1);
    if (authored) {
      if (binding.orientation !== undefined)
        visual.root.quaternion.set(
          binding.orientation.x,
          binding.orientation.y,
          binding.orientation.z,
          binding.orientation.w,
        );
      if (binding.scale !== undefined) visual.root.scale.copy(binding.scale);
    } else {
      const size = visual.bounds.getSize(new Vector3());
      const center = visual.bounds.getCenter(new Vector3());
      const target = binding.bounds.size;
      visual.fit.scale.set(
        size.x > 1e-8 ? target.x / size.x : 1,
        size.y > 1e-8 ? target.y / size.y : 1,
        size.z > 1e-8 ? target.z / size.z : 1,
      );
      visual.fit.position.copy(center).multiply(visual.fit.scale).negate();
    }
    if (binding.selection?.visual.kind === 'sprite') {
      if (!authored && this.#mode === 'iso') visual.root.quaternion.copy(this.#camera.quaternion);
      if (binding.facing !== undefined) visual.root.scale.x *= binding.facing < 0 ? -1 : 1;
    } else if (!authored && this.#mode === 'platformer' && binding.facing !== undefined) {
      visual.root.scale.x *= binding.facing < 0 ? -1 : 1;
    }
  }

  #positionObjects(): void {
    this.#cameraOrigin ??= this.#camera.position.clone();
    for (const object of this.#objects.values()) {
      if (object.batch !== undefined) continue;
      const root = object.root;
      const anchor = object.spec.anchor;
      root.visible = true;
      root.quaternion.identity();
      root.position.set(0, 0, 0);
      if (anchor === 'camera') {
        root.position.copy(this.#camera.position);
        root.quaternion.copy(this.#camera.quaternion);
      } else if (typeof anchor === 'object') {
        const binding = this.#byName.get(anchor.entity);
        root.visible = binding !== undefined;
        if (binding !== undefined) {
          root.position.copy(binding.origin);
          if (binding.orientation !== undefined)
            root.quaternion.set(
              binding.orientation.x,
              binding.orientation.y,
              binding.orientation.z,
              binding.orientation.w,
            );
        }
      } else if (!this.#reducedMotion && object.spec.parallax !== undefined) {
        root.position
          .copy(this.#camera.position)
          .sub(this.#cameraOrigin)
          .multiplyScalar(object.spec.parallax);
      }
    }
  }

  #buildEnvironment(): void {
    const environment = this.manifest.environment;
    if (environment === undefined) return;
    if (environment.background !== undefined)
      this.#scene.background = new Color(environment.background);
    if (environment.fog !== undefined) {
      const fog = environment.fog;
      this.#scene.fog = new Fog(fog.color, fog.near, fog.far);
    }
    if (environment.ambient !== undefined) {
      const light = new AmbientLight(environment.ambient.color, environment.ambient.intensity);
      light.name = 'presentation:ambient';
      this.#environment.add(light);
    }
    if (environment.directional !== undefined) {
      const spec = environment.directional;
      const light = new DirectionalLight(spec.color, spec.intensity);
      light.name = 'presentation:directional';
      light.position.fromArray(spec.position);
      this.#environment.add(light, light.target);
    }
    for (const [i, spec] of (environment.points ?? []).entries()) {
      const light = new PointLight(spec.color, spec.intensity, spec.distance);
      light.name = `presentation:point:${i}`;
      light.position.fromArray(spec.position);
      this.#environment.add(light);
    }
  }

  #target(target: Target, path?: string): ResolvedTarget | undefined {
    const nodePath = path === undefined ? undefined : `${path}.node`;
    if ('entity' in target) {
      const binding = this.#byName.get(target.entity);
      if (binding === undefined) return undefined;
      return {
        visual: binding.visual,
        node: binding.visual?.node(target.node, nodePath),
        origin: binding.origin,
        bounds: binding.bounds,
      };
    }
    const object = this.#objects.get(target.object);
    if (object === undefined) return undefined;
    object.root.updateWorldMatrix(true, true);
    const node = object.visual?.node(target.node, nodePath) ?? object.root;
    const origin = node.getWorldPosition(new Vector3());
    return {
      visual: object.visual,
      node,
      origin,
      bounds: { center: origin, size: { x: 1, y: 1, z: 1 } },
    };
  }

  #validateTargets(entities: boolean): void {
    for (const [i, spec] of (this.manifest.effects ?? []).entries()) {
      if (!entities && 'entity' in spec.target) continue;
      const path = `effects[${i}]`;
      const target = this.#target(spec.target, `${path}.target`);
      // A live entity may despawn. Validate its replacement while it exists, not after removal.
      if (target === undefined) continue;
      if (spec.target.node !== undefined && target.visual === undefined)
        throw visualError(
          `${path}.target.node`,
          'A named node needs a non-instanced visual.',
          'Bind a named model.',
        );
      if (spec.kind === 'clip') {
        if (target.visual === undefined)
          throw visualError(path, 'A clip effect needs a model replacement.', 'Bind a glTF model.');
        target.visual.clip(spec.clip ?? '', spec.target.node);
      }
      if (spec.kind === 'frames') {
        if (target.visual === undefined)
          throw visualError(path, 'A frames effect needs a sprite replacement.', 'Bind a sprite.');
        for (const frame of spec.frames ?? []) target.visual.validateFrame(frame);
      }
      if (spec.kind === 'recoil') {
        const object = 'object' in spec.target ? this.#objects.get(spec.target.object) : undefined;
        if (object?.spec.anchor !== 'camera')
          throw visualError(
            path,
            'Recoil can only move a camera-anchored presentation object, never the camera.',
            'Declare a camera-anchored view object and target its id.',
          );
      }
    }
  }

  /** Called once per displayed frame, never from a pick/project sync. */
  present(frame: PresentationFrame): void {
    if (this.#disposed || (this.#generation !== undefined && frame.generation < this.#generation))
      return;
    if (!Number.isFinite(frame.tickRate) || frame.tickRate <= 0 || !Number.isFinite(frame.tick))
      throw new Error('[aegis] Presentation requires a finite tick and positive tickRate.');
    if (frame.generation !== this.#generation) {
      if (this.#generation !== undefined) this.reset();
      this.#generation = frame.generation;
    }
    // Paused display frames freeze, but an explicitly stepped and synchronized world does not.
    const tick =
      frame.paused && this.#sampleTick !== undefined
        ? Math.max(this.#sampleTick, Math.min(frame.tick, this.#syncedTick ?? this.#sampleTick))
        : Math.max(frame.tick, this.#sampleTick ?? frame.tick);
    this.#sampleTick = tick;
    this.#restoreTransforms();
    const events = this.#freshEvents(frame.events);
    this.#expire(tick);
    const bursts: { spec: EventEffect; event: EventLine }[] = [];
    for (const event of events) {
      for (const spec of this.manifest.effects ?? []) {
        if (spec.event !== event.type) continue;
        if (spec.kind === 'burst') bursts.push({ spec, event });
        else this.#cue(spec, event.tick, tick);
      }
    }
    this.#sampleVisuals(tick, frame.tickRate);
    this.#positionObjects();
    for (const { spec, event } of bursts) this.#burst(spec, event.tick, tick);
    // Resolve muzzle positions after every surviving transform cue, not before recoil/pulse.
    for (const effect of this.#effects)
      if (effect.kind === 'cue') this.#sampleEffect(effect, tick, frame.tickRate);
    for (const effect of this.#effects)
      if (effect.kind === 'particle') this.#sampleEffect(effect, tick, frame.tickRate);
    const sampled: PresentationFrame = { ...frame, tick, events };
    for (const extension of [...this.#extensions]) extension.update(sampled);
  }

  #freshEvents(events: readonly EventLine[]): EventLine[] {
    const fresh: EventLine[] = [];
    const counts = new Map<string, number>();
    let newestTick = this.#legacyEventTick;
    for (const event of events) {
      if (event.sequence !== undefined) {
        if (!this.#claimSequence(event.sequence)) continue;
      } else {
        if (event.tick < this.#legacyEventTick) continue;
        const key = `${event.tick}:${event.type}`;
        const occurrence = (counts.get(key) ?? 0) + 1;
        counts.set(key, occurrence);
        if (
          event.tick === this.#legacyEventTick &&
          occurrence <= (this.#legacyEventCounts.get(key) ?? 0)
        )
          continue;
        newestTick = Math.max(newestTick, event.tick);
      }
      fresh.push(event);
    }
    if (newestTick > this.#legacyEventTick) this.#legacyEventCounts.clear();
    for (const [key, count] of counts)
      if (key.startsWith(`${newestTick}:`))
        this.#legacyEventCounts.set(key, Math.max(count, this.#legacyEventCounts.get(key) ?? 0));
    this.#legacyEventTick = newestTick;
    return fresh;
  }

  /** Compress the usual contiguous stream, without discarding unseen out-of-order occurrences. */
  #claimSequence(sequence: number): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < 0)
      throw new Error('[aegis] Presentation event sequence must be a nonnegative safe integer.');
    let low = 0;
    let high = this.#sequences.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.#sequences[middle]![1] < sequence) low = middle + 1;
      else high = middle;
    }
    const next = this.#sequences[low];
    const previous = this.#sequences[low - 1];
    if (next !== undefined && next[0] <= sequence) return false;
    if (previous !== undefined && previous[1] + 1 === sequence) {
      previous[1] = sequence;
      if (next !== undefined && next[0] === sequence + 1) {
        previous[1] = next[1];
        this.#sequences.splice(low, 1);
      }
    } else if (next !== undefined && next[0] === sequence + 1) next[0] = sequence;
    else this.#sequences.splice(low, 0, [sequence, sequence]);
    return true;
  }

  #sampleVisuals(tick: number, tickRate: number): void {
    const overrides = new Map<ManagedVisual, AnimationOverride>();
    for (const held of this.#held.values()) {
      const visual = this.#target(held.target)?.visual;
      if (visual !== undefined) overrides.set(visual, held.animation);
    }
    for (const effect of this.#effects) {
      if (effect.kind !== 'cue') continue;
      const visual = this.#target(effect.spec.target)?.visual;
      if (visual === undefined) continue;
      const override = this.#animation(effect.spec, Math.max(0, tick - effect.start));
      if (override !== undefined) overrides.set(visual, override);
    }
    for (const binding of this.#bindings.values())
      binding.visual?.sample(tick, tickRate, this.#state(binding), overrides.get(binding.visual));
    for (const visual of this.#createdVisuals) visual.sample(tick, tickRate, 'idle');
    for (const object of this.#objects.values()) {
      const visual = object.visual;
      if (visual === undefined) continue;
      visual.sample(tick, tickRate, 'idle', overrides.get(visual));
      applyPose(visual.pose, object.spec.pose);
      const motion = object.spec.motion;
      if (motion === undefined || this.#reducedMotion) continue;
      const phase = ((tick % motion.periodTicks) / motion.periodTicks) * 2 * Math.PI;
      if (motion.kind === 'bob') visual.pose.position[motion.axis] += sin(phase) * motion.amplitude;
      else if (motion.kind === 'spin')
        visual.pose.rotation[motion.axis] +=
          (tick / motion.periodTicks) * motion.amplitude * (Math.PI / 180);
      else visual.pose.scale[motion.axis] *= 1 + sin(phase) * motion.amplitude;
    }
  }

  #animation(spec: EventEffect, age: number): AnimationOverride | undefined {
    // One-shot durationTicks spans the whole clip. Ambient/state clips use native seconds.
    if (spec.kind === 'clip')
      return {
        kind: 'clip',
        clip: spec.clip ?? '',
        progress: Math.min(age / spec.durationTicks, 1),
        node: spec.target.node,
      };
    if (spec.kind === 'frames') {
      const frames = spec.frames ?? [];
      const index = Math.min(Math.floor(age / (spec.frameTicks ?? 1)), frames.length - 1);
      const frame = frames[index];
      if (frame !== undefined) return { kind: 'frames', frame };
    }
    return undefined;
  }

  #cue(spec: EventEffect, start: number, tick: number): void {
    if (this.#reducedMotion && (spec.kind === 'pulse' || spec.kind === 'recoil')) {
      this.#dropped++;
      return;
    }
    if (this.#target(spec.target) === undefined) {
      this.#dropped++;
      return;
    }
    if (spec.kind === 'clip' || spec.kind === 'frames') {
      const key = targetKey(spec.target);
      this.#held.delete(key);
      this.#effects = this.#effects.filter((effect) => {
        if (
          effect.kind !== 'cue' ||
          (effect.spec.kind !== 'clip' && effect.spec.kind !== 'frames') ||
          targetKey(effect.spec.target) !== key
        )
          return true;
        this.#removeEffect(effect);
        this.#dropped++;
        return false;
      });
    }
    if (tick - start >= spec.durationTicks) {
      const animation = this.#animation(spec, spec.durationTicks);
      if (spec.holdLast && animation !== undefined)
        this.#held.set(targetKey(spec.target), { target: spec.target, animation });
      else this.#dropped++;
      return;
    }
    this.#reserve();
    this.#effects.push({ kind: 'cue', spec, start });
  }

  #burst(spec: EventEffect, start: number, tick: number): void {
    const count = spec.count ?? 8;
    if (this.#reducedMotion) {
      this.#dropped += count;
      return;
    }
    const target = this.#target(spec.target);
    if (target === undefined || tick - start >= spec.durationTicks) {
      this.#dropped += count;
      return;
    }
    const origin = new Vector3().copy(target.bounds.center);
    const source =
      spec.target.node !== undefined || 'object' in spec.target ? target.node : undefined;
    const occurrence = this.#occurrences++;
    const allowed = Math.min(count, QUALITY[this.#quality].effects);
    this.#dropped += count - allowed;
    for (let i = 0; i < allowed; i++) {
      this.#reserve();
      const angle = ((i + occurrence * 0.37) / Math.max(count, 1)) * 2 * Math.PI;
      const mesh = this.#factory.effectMesh(spec.color ?? '#ffffff', 0.9);
      mesh.name = `effect:burst:${occurrence}:${i}`;
      const size = Math.max(0.02, (spec.amount ?? 0.12) * 0.4);
      this.#effectRoot.add(mesh);
      this.#effects.push({
        kind: 'particle',
        start,
        duration: spec.durationTicks,
        mesh,
        origin: origin.clone(),
        source,
        velocity: new Vector3(cos(angle) * 1.8, sin(angle) * 1.8 + 0.8, (i % 3) * 0.35 - 0.35),
        size,
      });
    }
  }

  #sampleEffect(effect: Transient, tick: number, tickRate: number): void {
    if (effect.kind === 'particle') {
      if (effect.source !== undefined) {
        effect.source.getWorldPosition(effect.origin);
        effect.source = undefined;
      }
      const age = Math.max(0, tick - effect.start);
      const seconds = age / tickRate;
      effect.mesh.position.copy(effect.origin).addScaledVector(effect.velocity, seconds);
      effect.mesh.position.y -= seconds * seconds * 1.2;
      effect.mesh.scale.setScalar(effect.size * (1 - age / effect.duration));
      return;
    }
    const spec = effect.spec;
    if (spec.kind !== 'pulse' && spec.kind !== 'recoil') return;
    const target = this.#target(spec.target);
    if (target === undefined) return;
    const remaining = 1 - Math.max(0, tick - effect.start) / spec.durationTicks;
    const amount = (spec.amount ?? (spec.kind === 'pulse' ? 0.2 : 0.12)) * remaining;
    if (target.visual !== undefined && target.node !== undefined) {
      const node = target.node;
      this.#remember(node);
      if (spec.kind === 'recoil') node.position.z += amount;
      else {
        node.scale.multiplyScalar(1 + amount);
        if (spec.color !== undefined) target.visual.flash(node, new Color(spec.color), remaining);
      }
    } else if (spec.kind === 'pulse') {
      effect.overlay ??= this.#factory.effectMesh(spec.color ?? '#ffffff', 0.25);
      effect.overlay.name = 'effect:pulse';
      if (effect.overlay.parent === null) this.#effectRoot.add(effect.overlay);
      effect.overlay.position.copy(target.bounds.center);
      effect.overlay.scale.copy(target.bounds.size).multiplyScalar(1 + amount);
    }
  }

  #remember(object: Object3D): void {
    if (this.#restore.has(object)) return;
    this.#restore.set(object, {
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      scale: object.scale.clone(),
    });
  }

  #restoreTransforms(): void {
    for (const [object, transform] of this.#restore) {
      object.position.copy(transform.position);
      object.quaternion.copy(transform.quaternion);
      object.scale.copy(transform.scale);
    }
    this.#restore.clear();
  }

  #expire(tick: number): void {
    this.#effects = this.#effects.filter((effect) => {
      const duration = effect.kind === 'particle' ? effect.duration : effect.spec.durationTicks;
      if (tick - effect.start < duration) return true;
      if (effect.kind === 'cue' && effect.spec.holdLast) {
        const animation = this.#animation(effect.spec, duration);
        if (animation !== undefined)
          this.#held.set(targetKey(effect.spec.target), { target: effect.spec.target, animation });
      }
      this.#removeEffect(effect);
      return false;
    });
  }

  #removeEffect(effect: Transient): void {
    if (effect.kind === 'particle') effect.mesh.removeFromParent();
    else effect.overlay?.removeFromParent();
  }

  #reserve(): void {
    while (this.#effects.length + this.#extensions.size >= QUALITY[this.#quality].effects)
      this.#evict();
  }

  #evict(): void {
    const oldest = this.#effects.shift();
    if (oldest !== undefined) this.#removeEffect(oldest);
    else {
      const extension = this.#extensions.values().next().value as PresentationEffect | undefined;
      if (extension === undefined) return;
      this.#extensions.delete(extension);
      extension.dispose();
    }
    this.#dropped++;
  }

  setQuality(quality: QualityTier): void {
    this.#quality = quality;
    while (this.#effects.length + this.#extensions.size > QUALITY[quality].effects) this.#evict();
  }

  /**
   * Disable procedural/parallax motion and spatial feedback, not state or clip/frame transitions.
   * Existing decorative motion returns to its authored pose; suppressed effects count as dropped.
   */
  setReducedMotion(enabled: boolean): void {
    if (this.#disposed || enabled === this.#reducedMotion) return;
    this.#reducedMotion = enabled;
    if (enabled) {
      this.#restoreTransforms();
      this.#effects = this.#effects.filter((effect) => {
        if (effect.kind === 'cue' && (effect.spec.kind === 'clip' || effect.spec.kind === 'frames'))
          return true;
        this.#removeEffect(effect);
        this.#dropped++;
        return false;
      });
      for (const binding of this.#bindings.values()) binding.visual?.restoreFlash();
      for (const visual of this.#createdVisuals) visual.restoreFlash();
      for (const object of this.#objects.values()) {
        object.visual?.restoreFlash();
        if (object.visual !== undefined) applyPose(object.visual.pose, object.spec.pose);
      }
    }
    this.#positionObjects();
  }

  addEffect(effect: PresentationEffect): () => void {
    if (this.#disposed) throw new Error('[aegis] Cannot add an effect to a disposed presentation.');
    if (this.#extensions.has(effect))
      throw new Error('[aegis] This presentation effect is already registered.');
    this.#reserve();
    this.#extensions.add(effect);
    return () => {
      if (!this.#extensions.delete(effect)) return;
      effect.dispose();
    };
  }

  #clearTransients(): void {
    this.#restoreTransforms();
    for (const effect of this.#effects) this.#removeEffect(effect);
    this.#effects = [];
    this.#held.clear();
    this.#sequences = [];
    this.#legacyEventTick = -1;
    this.#legacyEventCounts.clear();
    this.#sampleTick = undefined;
    this.#syncedTick = undefined;
    this.#occurrences = 0;
    this.#stateOverrides.clear();
  }

  /** Clear generation-local state without disposing cached assets or static instances. */
  reset(): void {
    this.#clearTransients();
    for (const binding of this.#bindings.values()) binding.visual?.reset();
    for (const visual of this.#createdVisuals) visual.reset();
    for (const object of this.#objects.values()) {
      object.visual?.reset();
      if (object.visual !== undefined) applyPose(object.visual.pose, object.spec.pose);
    }
    for (const extension of this.#extensions) extension.reset();
  }

  /** A new mount may have a different World; no old entity clone or light survives its binding. */
  remount(): void {
    this.reset();
    this.#restoreDebugAncestors();
    for (const binding of this.#bindings.values()) this.#release(binding);
    this.#bindings.clear();
    this.#byName.clear();
    this.#disposeCreatedVisuals();
    this.#lights.dispose();
    this.#cameraOrigin = undefined;
    this.#generation = undefined;
  }

  #disposeCreatedVisuals(): void {
    for (const visual of this.#createdVisuals) visual.dispose();
    this.#createdVisuals.clear();
  }

  #release(binding: Binding): void {
    for (const [object, normal] of binding.restored) object.visible = normal.visible;
    binding.visual?.root.traverse((node) => this.#restore.delete(node));
    binding.visual?.dispose();
    this.#effects = this.#effects.filter((effect) => {
      if (
        effect.kind !== 'cue' ||
        !('entity' in effect.spec.target) ||
        effect.spec.target.entity !== binding.name
      )
        return true;
      this.#removeEffect(effect);
      this.#dropped++;
      return false;
    });
    this.#held.delete(`entity:${binding.name}`);
  }

  #legacyStats(): PresentationStats['legacy'] {
    const meshes = new Set<Mesh>();
    const collect = (node: Object3D): void => {
      if (node instanceof Mesh) meshes.add(node);
    };
    if (!this.#disposed) {
      this.#legacyLevel?.traverse(collect);
      for (const binding of this.#bindings.values())
        for (const object of binding.restored.keys()) object.traverse(collect);
    }
    let visibleMeshes = 0;
    for (const mesh of meshes) {
      let visible = true;
      for (let node: Object3D | null = mesh; node !== null; node = node.parent) {
        if (!node.visible) {
          visible = false;
          break;
        }
      }
      if (visible) visibleMeshes++;
    }
    return {
      level: this.manifest.legacy?.level !== false,
      triggers: this.manifest.legacy?.triggers !== false,
      debugGeometry: !this.#disposed && this.#debugGeometry,
      levelVisible: !this.#disposed && (this.#legacyLevel?.visible ?? false),
      retainedMeshes: meshes.size,
      visibleMeshes,
    };
  }

  stats(): PresentationStats {
    let mixers = 0;
    let flashMaterials = 0;
    let instances = 0;
    let batches = 0;
    for (const binding of this.#bindings.values()) {
      const stats = binding.visual?.stats();
      mixers += stats?.mixers ?? 0;
      flashMaterials += stats?.materials ?? 0;
    }
    for (const visual of this.#createdVisuals) {
      const stats = visual.stats();
      mixers += stats.mixers;
      flashMaterials += stats.materials;
    }
    for (const object of this.#objects.values()) {
      const stats = object.visual?.stats();
      mixers += stats?.mixers ?? 0;
      flashMaterials += stats?.materials ?? 0;
      instances += object.batch?.instances ?? 0;
      batches += object.batch?.batches ?? 0;
    }
    const factory = this.#factory.stats();
    return {
      quality: this.#quality,
      reducedMotion: this.#reducedMotion,
      resources: {
        ...this.#assets.stats(),
        runtimeMaterials: factory.materials + flashMaterials,
        runtimeGeometries: factory.geometries,
        objects:
          this.#objects.size +
          this.#createdVisuals.size +
          [...this.#bindings.values()].filter((binding) => binding.visual !== undefined).length,
        instances,
        batches,
        mixers,
        ...lightStats(this.#scene),
      },
      effects: {
        active: this.#effects.length,
        registered: this.#extensions.size,
        limit: QUALITY[this.#quality].effects,
      },
      legacy: this.#legacyStats(),
      dropped: this.#dropped,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#restoreDebugAncestors();
    this.#clearTransients();
    for (const extension of this.#extensions) extension.dispose();
    this.#extensions.clear();
    for (const binding of this.#bindings.values()) this.#release(binding);
    this.#bindings.clear();
    this.#byName.clear();
    this.#disposeCreatedVisuals();
    for (const object of this.#objects.values()) {
      object.visual?.dispose();
      object.batch?.dispose();
    }
    this.#objects.clear();
    this.#lights.dispose();
    this.#environment.traverse((node) => {
      if (
        node instanceof AmbientLight ||
        node instanceof DirectionalLight ||
        node instanceof PointLight
      )
        node.dispose();
    });
    this.#root.removeFromParent();
    this.#root.clear();
    this.#factory.dispose();
    this.#scene.background = this.#background;
    this.#scene.fog = this.#fog;
  }
}
