import {
  AnimationMixer,
  Box3,
  Color,
  DoubleSide,
  Euler,
  Group,
  InstancedMesh,
  LoopOnce,
  LoopRepeat,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PropertyBinding,
  Quaternion,
  SkinnedMesh,
  Vector3,
} from 'three';
import type { AnimationClip, BufferGeometry, Material, Object3D, Texture } from 'three';
import { DEG2RAD, DiagnosticError } from '@aegis/core';
import type { ModelData, SpriteData } from '@aegis/content';
import { ROLE_COLORS, resolveAppearance } from '../appearance.js';
import type { VisualRole } from '../appearance.js';
import { Primitives } from '../primitives.js';
import { sharedResource } from '../resources.js';
import type { ModelInstance, PresentationAssets } from './assets.js';
import { RenderCode, renderDiagnostic } from './diagnostics.js';
import type { Decoration, Pose, SpriteState, VisualSpec } from './schema.js';

export function visualError(path: string, message: string, fix: string): DiagnosticError {
  return new DiagnosticError([renderDiagnostic(RenderCode.Reference, path, message, fix)]);
}

export function applyPose(object: Object3D, pose?: Pose): void {
  object.position.fromArray(pose?.position ?? [0, 0, 0]);
  const rotation = pose?.rotation ?? [0, 0, 0];
  object.rotation.set(rotation[0] * DEG2RAD, rotation[1] * DEG2RAD, rotation[2] * DEG2RAD);
  object.scale.fromArray(pose?.scale ?? [1, 1, 1]);
}

type MappedMaterial = Material & { color?: Color; map?: Texture | null };

/** Runtime-owned variants borrow maps; neither entity removal nor a frame change frees a map. */
export class VisualFactory {
  readonly primitives = new Primitives();
  readonly #assets: PresentationAssets;
  readonly #spriteBase = sharedResource(
    new MeshBasicMaterial({
      color: '#ffffff',
      side: DoubleSide,
      transparent: true,
      alphaTest: 0.01,
    }),
  );
  readonly #variants = new Map<string, Material>();
  readonly #palette = new Set<Material>();
  #disposed = false;

  constructor(assets: PresentationAssets) {
    this.#assets = assets;
  }

  material(base: Material, tint?: string, map?: Texture): Material {
    if (tint === undefined && map === undefined) return base;
    const key = `${base.uuid}|${tint ?? ''}|${map?.uuid ?? ''}`;
    const cached = this.#variants.get(key);
    if (cached !== undefined) return cached;
    const material = base.clone() as MappedMaterial;
    if (map !== undefined) {
      if (!('map' in material)) {
        material.dispose();
        throw visualError(
          'material',
          `Material "${base.name}" cannot display a sprite texture.`,
          'Use a standard or unlit presentation material.',
        );
      }
      material.map = map;
      material.side = DoubleSide;
      material.transparent = true;
    }
    if (tint !== undefined) {
      const appearance = resolveAppearance({ role: 'unknown', sprite: { texture: '', tint } });
      material.color?.multiply(new Color(appearance.color));
      material.opacity *= appearance.opacity;
      if (material.opacity < 1) material.transparent = true;
    }
    this.#variants.set(key, sharedResource(material));
    return material;
  }

  base(spec: VisualSpec, role: VisualRole): Material {
    if (spec.material !== undefined) return this.#assets.material(spec.material);
    if (spec.kind === 'sprite') return this.#spriteBase;
    const material = this.primitives.roleMaterial(role);
    this.#palette.add(material);
    return material;
  }

  effectMesh(color: string, opacity: number): Mesh {
    const material = this.primitives.material({ color, opacity, visible: true }, 'flat');
    this.#palette.add(material);
    return new Mesh(this.primitives.box, material);
  }

  create(spec: VisualSpec, role: VisualRole, path: string): ManagedVisual {
    return new ManagedVisual(this, this.#assets, spec, role, path);
  }

  batch(spec: Decoration, path: string): StaticBatch {
    const source = this.create(spec.visual, 'neutral', `${path}.visual`);
    const root = new Group();
    root.name = `object:${spec.id}`;
    applyPose(root, spec.pose);
    const placements = spec.instances ?? [];
    const batches: InstancedMesh[] = [];
    try {
      if (
        source.clips.length > 0 ||
        (spec.visual.kind !== 'primitive' && spec.visual.animations !== undefined)
      )
        throw visualError(
          `${path}.instances`,
          `Object "${spec.id}" requests static instances of an animated visual.`,
          'Export an unanimated model for static instancing, or use a single animated object.',
        );
      source.root.updateMatrixWorld(true);
      const groups = new Map<
        string,
        { geometry: BufferGeometry; material: Material | Material[]; matrices: Matrix4[] }
      >();
      source.object.traverse((node) => {
        if ('isLight' in node && node.isLight === true)
          throw visualError(
            `${path}.instances`,
            `Object "${spec.id}" contains a light that cannot be instanced.`,
            'Export mesh-only scenery and declare bounded lights separately.',
          );
        if (!(node instanceof Mesh)) return;
        if (
          node instanceof SkinnedMesh ||
          node instanceof InstancedMesh ||
          (node.morphTargetInfluences?.length ?? 0) > 0
        )
          throw visualError(
            `${path}.instances`,
            `Object "${spec.id}" contains a skinned, morphed, or already instanced mesh.`,
            'Export a static, ordinary mesh instead of cloning incompatible nodes.',
          );
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        const key = `${node.geometry.uuid}|${materials.map((m) => m.uuid).join('|')}`;
        let group = groups.get(key);
        if (group === undefined) {
          group = { geometry: node.geometry, material: node.material, matrices: [] };
          groups.set(key, group);
        }
        group.matrices.push(node.matrixWorld.clone());
      });
      if (groups.size === 0)
        throw visualError(
          path,
          `Object "${spec.id}" has no meshes to instance.`,
          'Use mesh geometry.',
        );
      const transform = new Matrix4();
      const position = new Vector3();
      const rotation = new Quaternion();
      const euler = new Euler();
      const scale = new Vector3();
      for (const group of groups.values()) {
        const mesh = new InstancedMesh(
          group.geometry,
          group.material,
          placements.length * group.matrices.length,
        );
        mesh.name = `batch:${batches.length}`;
        let index = 0;
        for (const pose of placements) {
          position.fromArray(pose.position ?? [0, 0, 0]);
          const angles = pose.rotation ?? [0, 0, 0];
          rotation.setFromEuler(
            euler.set(angles[0] * DEG2RAD, angles[1] * DEG2RAD, angles[2] * DEG2RAD),
          );
          scale.fromArray(pose.scale ?? [1, 1, 1]);
          transform.compose(position, rotation, scale);
          for (const local of group.matrices)
            mesh.setMatrixAt(index++, new Matrix4().multiplyMatrices(transform, local));
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        root.add(mesh);
        batches.push(mesh);
      }
    } catch (error) {
      for (const batch of batches) batch.dispose();
      throw error;
    } finally {
      source.dispose();
    }
    let disposed = false;
    return {
      root,
      instances: placements.length,
      batches: batches.length,
      dispose() {
        if (disposed) return;
        disposed = true;
        root.removeFromParent();
        for (const batch of batches) batch.dispose();
        root.clear();
      },
    };
  }

  stats(): { materials: number; geometries: number } {
    return {
      materials: this.#disposed ? 0 : this.#variants.size + this.#palette.size + 1,
      geometries: this.#disposed ? 0 : 2,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const material of this.#variants.values()) material.dispose();
    this.#variants.clear();
    this.#palette.clear();
    this.#spriteBase.dispose();
    this.primitives.dispose();
  }
}

export interface StaticBatch {
  root: Group;
  instances: number;
  batches: number;
  dispose(): void;
}

export type AnimationOverride =
  | { kind: 'clip'; clip: string; progress: number; node?: string }
  | { kind: 'frames'; frame: string };

/** An instance owns transforms, a mixer, and mutable flash materials, but never asset resources. */
export class ManagedVisual {
  readonly root = new Group();
  readonly pose = new Group();
  readonly effect = new Group();
  readonly fit = new Group();
  readonly object: Object3D;
  readonly clips: readonly AnimationClip[];
  readonly bounds: Box3;
  readonly #factory: VisualFactory;
  readonly #assets: PresentationAssets;
  readonly #path: string;
  readonly #model?: ModelInstance;
  readonly #mixer?: AnimationMixer;
  readonly #mixerRoots = new Set<Object3D>();
  readonly #validatedClips = new Map<string, AnimationClip>();
  readonly #originals = new Map<Mesh, Material | Material[]>();
  readonly #spriteFrames = new Set<string | undefined>();
  readonly #flashes = new Map<
    Mesh,
    { base: Material | Material[]; copies: Material[]; active: boolean }
  >();
  #flashOperations: { node: Object3D; color: Color; strength: number }[] = [];
  #spec: VisualSpec;
  #role: VisualRole;
  #sprite?: SpriteData;
  #modelData?: ModelData;
  #frame?: string;
  #authoredFrame?: string;
  #appearanceReady = false;
  #appearanceState: SpriteState = 'idle';
  #spriteFrameRevision = 0;
  #spriteCacheKey?: string;
  #eventFrame = false;
  #lastState?: SpriteState;
  #stateStart = 0;
  #loopKey?: string;
  #loopStart = 0;
  #disposed = false;

  constructor(
    factory: VisualFactory,
    assets: PresentationAssets,
    spec: VisualSpec,
    role: VisualRole,
    path: string,
  ) {
    this.#factory = factory;
    this.#assets = assets;
    this.#spec = spec;
    this.#role = role;
    this.#path = path;
    this.root.name = 'presentation:anchor';
    this.pose.name = 'presentation:pose';
    this.effect.name = 'presentation:effect';
    this.fit.name = 'presentation:fit';
    this.root.add(this.pose);
    this.pose.add(this.effect);
    this.effect.add(this.fit);
    if (spec.kind === 'model') {
      this.#model = assets.instantiateModel(spec.mesh);
      this.object = this.#model.root;
      this.clips = this.#model.clips;
      this.#mixer = new AnimationMixer(this.object);
    } else {
      this.object = new Mesh(
        spec.kind === 'primitive' && spec.shape === 'box'
          ? factory.primitives.box
          : factory.primitives.plane,
        factory.base(spec, role),
      );
      this.object.name = spec.kind === 'sprite' ? 'sprite' : spec.shape;
      this.clips = [];
    }
    this.fit.add(this.object);
    this.object.traverse((node) => {
      if ('isLight' in node && node.isLight === true) node.castShadow = false;
      if (node instanceof Mesh) this.#originals.set(node, node.material);
    });
    this.bounds = new Box3();
    try {
      this.bounds.setFromObject(this.object, true);
      if (this.bounds.isEmpty())
        throw visualError(
          path,
          'The selected visual contains no mesh geometry.',
          'Export visible mesh geometry.',
        );
      this.configure(spec, role);
      this.syncAppearance(undefined, undefined, 'idle');
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  configure(spec: VisualSpec, role: VisualRole): void {
    this.#spec = spec;
    this.#role = role;
    if (spec.kind === 'model') {
      if (spec.clip !== undefined) this.clip(spec.clip);
      for (const name of Object.values(spec.animations ?? {})) this.clip(name);
      for (const entry of spec.stateClips ?? []) this.clip(entry.clip);
    } else if (spec.kind === 'sprite') {
      this.#rememberFrame(spec.frame);
      for (const sequence of Object.values(spec.animations ?? {}))
        for (const frame of sequence.frames) this.#rememberFrame(frame);
    }
  }

  clip(name: string, node?: string): AnimationClip {
    const key = `${name}|${node ?? ''}`;
    const cached = this.#validatedClips.get(key);
    if (cached !== undefined) return cached;
    const matches = this.clips.filter((entry) => entry.name === name);
    const clip = matches[0];
    if (clip === undefined)
      throw visualError(
        `${this.#path}.clip`,
        `Unknown animation clip "${name}". Available clips: ${this.clips.map((c) => c.name).join(', ') || '(none)'}.`,
        'Use the exact exported glTF clip name, or export the missing animation.',
      );
    if (matches.length > 1)
      throw visualError(
        `${this.#path}.clip`,
        `More than one animation clip is named "${name}".`,
        'Export unique animation clip names.',
      );
    const root = node === undefined ? this.object : this.node(node);
    for (const track of clip.tracks) {
      const parsed = PropertyBinding.parseTrackName(track.name);
      const target: Object3D | undefined | null = PropertyBinding.findNode(root, parsed.nodeName);
      if (target === undefined || target === null)
        throw visualError(
          `${this.#path}.clip`,
          `Clip "${name}" track "${track.name}" does not resolve below "${node ?? this.object.name}".`,
          'Target the model root or a node containing every track of this clip.',
        );
    }
    this.#validatedClips.set(key, clip);
    return clip;
  }

  node(name?: string, path?: string): Object3D {
    if (name === undefined) return this.effect;
    const node = this.object.getObjectByName(name);
    if (node === undefined) {
      const names = new Set<string>();
      this.object.traverse((entry) => {
        if (entry.name !== '') names.add(entry.name);
      });
      const available = [...names].sort().slice(0, 32).join(', ') || '(none)';
      throw visualError(
        path ?? `${this.#path}.node`,
        `Unknown visual node "${name}". Available nodes: ${available}${names.size > 32 ? ` (${names.size} total)` : ''}.`,
        'Target an exact node name exported by this model.',
      );
    }
    return node;
  }

  validateFrame(frame: string): void {
    if (this.#spec.kind !== 'sprite')
      throw visualError(this.#path, 'A frames effect requires a sprite.', 'Bind a sprite visual.');
    this.#rememberFrame(frame);
    this.#cacheSpriteMaterials(this.#appearanceState);
  }

  #rememberFrame(frame: string | undefined): void {
    if (this.#spec.kind !== 'sprite' || this.#spriteFrames.has(frame)) return;
    this.#assets.texture(this.#spec.texture, frame);
    this.#spriteFrames.add(frame);
    this.#spriteFrameRevision++;
  }

  syncAppearance(
    sprite: SpriteData | undefined,
    model: ModelData | undefined,
    state: SpriteState,
  ): void {
    const flashes = this.#flashOperations;
    this.restoreFlash();
    this.#sprite = sprite === undefined ? undefined : { ...sprite };
    this.#modelData = model === undefined ? undefined : { ...model };
    this.root.visible = (sprite?.visible ?? true) && (model?.visible ?? true);
    if (this.#spec.kind === 'sprite') {
      const frame =
        this.#spec.frame ??
        (sprite?.texture && sprite.texture !== this.#spec.texture ? undefined : sprite?.frame);
      this.#rememberFrame(frame);
      const animated =
        this.#lastState !== undefined && this.#spec.animations?.[this.#lastState] !== undefined;
      if (
        (!this.#appearanceReady || frame !== this.#authoredFrame) &&
        !this.#eventFrame &&
        !animated
      )
        this.#frame = frame;
      this.#authoredFrame = frame;
      this.#appearanceReady = true;
    }
    this.#applyMaterials(state);
    for (const flash of flashes) this.flash(flash.node, flash.color, flash.strength);
  }

  #tint(state: SpriteState): string | undefined {
    const spec = this.#spec;
    const deadTint =
      state === 'dead' &&
      this.#role !== 'dead' &&
      (spec.kind === 'primitive' || spec.animations?.dead === undefined)
        ? ROLE_COLORS.dead
        : undefined;
    return this.#sprite?.tint ?? deadTint;
  }

  #baseMaterial(original: Material | Material[], geometry?: BufferGeometry): Material | Material[] {
    const spec = this.#spec;
    const override = this.#modelData?.material || spec.material;
    return override !== undefined
      ? this.#assets.material(override, geometry)
      : spec.kind === 'primitive'
        ? this.#factory.base(spec, this.#role)
        : original;
  }

  #cacheSpriteMaterials(state: SpriteState): void {
    if (this.#spec.kind !== 'sprite') return;
    const materials = [...this.#originals.values()].flatMap((original) => {
      const base = this.#baseMaterial(original);
      return Array.isArray(base) ? base : [base];
    });
    const tint = this.#tint(state);
    const key = `${this.#spriteFrameRevision}|${tint ?? ''}|${materials.map((m) => m.uuid).join('|')}`;
    if (key === this.#spriteCacheKey) return;
    for (const frame of this.#spriteFrames) {
      const map = this.#assets.texture(this.#spec.texture, frame);
      for (const material of materials) this.#factory.material(material, tint, map);
    }
    this.#spriteCacheKey = key;
  }

  #applyMaterials(state: SpriteState): void {
    this.#appearanceState = state;
    this.#cacheSpriteMaterials(state);
    const spec = this.#spec;
    const tint = this.#tint(state);
    for (const [mesh, original] of this.#originals) {
      const base = this.#baseMaterial(original, mesh.geometry);
      const map =
        spec.kind === 'sprite' ? this.#assets.texture(spec.texture, this.#frame) : undefined;
      const material = Array.isArray(base)
        ? base.map((m) => this.#factory.material(m, tint, map))
        : this.#factory.material(base, tint, map);
      mesh.material = material;
      mesh.castShadow = this.#modelData?.castShadow === true;
      mesh.renderOrder = this.#sprite?.z ?? 0;
    }
  }

  sample(
    tick: number,
    tickRate: number,
    state: SpriteState,
    override?: AnimationOverride,
    matches?: (condition: import('./schema.js').StateCondition) => boolean,
  ): void {
    this.restoreFlash();
    if (state !== this.#lastState) {
      this.#stateStart = this.#lastState === undefined ? 0 : tick;
      this.#lastState = state;
      this.#applyMaterials(state);
    }
    const spec = this.#spec;
    if (spec.kind === 'sprite') {
      this.#eventFrame = override?.kind === 'frames';
      const sequence = spec.animations?.[state];
      const frame =
        override?.kind === 'frames'
          ? override.frame
          : sequence === undefined
            ? this.#authoredFrame
            : sequence.frames[
                Math.floor(Math.max(0, tick - this.#stateStart) / sequence.frameTicks) %
                  sequence.frames.length
              ];
      if (frame !== this.#frame) {
        this.#frame = frame;
        this.#applyMaterials(state);
      }
    } else if (spec.kind === 'model') {
      if (spec.stateClips !== undefined && matches === undefined)
        throw visualError(
          this.#path,
          'State clips need a presentation state reader.',
          'Sample state-bound models through the presentation runtime.',
        );
      const loop = spec.stateClips?.find((entry) => matches?.(entry.when));
      const loopKey = loop === undefined ? '' : `${loop.clip}:${loop.timeScale ?? 1}`;
      if (loopKey !== this.#loopKey) {
        this.#loopStart = this.#loopKey === undefined ? 0 : tick;
        this.#loopKey = loopKey;
      }
      const name =
        override?.kind === 'clip'
          ? override.clip
          : (loop?.clip ?? spec.animations?.[state] ?? spec.clip);
      this.#mixer?.stopAllAction();
      if (name !== undefined && this.#mixer !== undefined) {
        const oneShot = override?.kind === 'clip';
        const clip = this.clip(name, oneShot ? override.node : undefined);
        const root =
          oneShot && override.node !== undefined ? this.node(override.node) : this.object;
        this.#mixerRoots.add(root);
        const action = this.#mixer.clipAction(clip, root);
        action.reset().setLoop(oneShot ? LoopOnce : LoopRepeat, oneShot ? 1 : Infinity);
        action.clampWhenFinished = true;
        action.play();
        this.#mixer.setTime(
          oneShot
            ? Math.min(1, Math.max(0, override.progress)) * clip.duration
            : (Math.max(0, tick - (loop === undefined ? this.#stateStart : this.#loopStart)) /
                tickRate) *
                (loop?.timeScale ?? 1),
        );
      }
    }
  }

  flash(node: Object3D, color: Color, strength: number): void {
    this.#flashOperations.push({ node, color: color.clone(), strength });
    node.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      let entry = this.#flashes.get(object);
      const material = entry?.active ? entry.base : object.material;
      const bases = Array.isArray(material) ? material : [material];
      if (
        entry === undefined ||
        entry.copies.length !== bases.length ||
        bases.some((base, i) => entry?.copies[i]?.type !== base.type)
      ) {
        for (const copy of entry?.copies ?? []) copy.dispose();
        entry = {
          base: object.material,
          copies: bases.map((m) => sharedResource(m.clone())),
          active: false,
        };
        this.#flashes.set(object, entry);
      }
      if (!entry.active) entry.base = object.material;
      for (const [i, base] of bases.entries()) {
        const copy = entry.copies[i] as MappedMaterial;
        if (!entry.active) copy.copy(base);
        copy.color?.lerp(color, strength);
      }
      entry.active = true;
      object.material = Array.isArray(object.material) ? entry.copies : entry.copies[0]!;
    });
  }

  restoreFlash(): void {
    for (const [mesh, entry] of this.#flashes) {
      if (!entry.active) continue;
      mesh.material = entry.base;
      entry.active = false;
    }
    this.#flashOperations = [];
  }

  reset(): void {
    this.restoreFlash();
    this.#mixer?.stopAllAction();
    this.#lastState = undefined;
    this.#stateStart = 0;
    this.#loopKey = undefined;
    this.#loopStart = 0;
    this.#eventFrame = false;
    this.#frame = this.#authoredFrame;
    if (this.#spec.kind === 'sprite') this.#applyMaterials('idle');
  }

  stats(): { mixers: number; materials: number } {
    return {
      mixers: this.#disposed || this.#mixer === undefined ? 0 : 1,
      materials: [...this.#flashes.values()].reduce((n, entry) => n + entry.copies.length, 0),
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.restoreFlash();
    this.#mixer?.stopAllAction();
    for (const root of this.#mixerRoots) this.#mixer?.uncacheRoot(root);
    this.#mixerRoots.clear();
    this.#validatedClips.clear();
    for (const entry of this.#flashes.values()) for (const copy of entry.copies) copy.dispose();
    this.#flashes.clear();
    this.#model?.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }
}
