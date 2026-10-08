import { BrowserServiceError } from '../errors.js';
import { ease } from './easing.js';
import { isMouthShape, resolveMouthShape } from './mouth.js';
import { createPresentationRandom } from './random.js';
import { compose, IDENTITY, multiply, sampleClip } from './sample.js';
import type { Matrix } from './sample.js';
import { parseFrameRef } from './validate.js';
import type {
  AccessoryBinding,
  AvatarComposition,
  ClipFile,
  Easing,
  MouthShape,
  NumericProperty,
  RigFile,
  RigPart,
  Vec2,
} from './types.js';

/** One textured quad. `matrix` maps untrimmed frame pixels to logical stage pixels. */
export interface DrawItem {
  id: string;
  frame: string;
  matrix: Matrix;
  opacity: number;
  tint?: string;
  mask?: string;
  /** Lexicographic draw order within the puppet. */
  order: readonly number[];
}

export interface BreatheOptions {
  amplitude?: number;
  period?: number;
}
export interface BlinkOptions {
  minInterval?: number;
  maxInterval?: number;
  duration?: number;
  seed?: string;
}
export interface Behaviours {
  breathe?: BreatheOptions | false;
  bob?: { amplitude?: number; period?: number } | false;
  blink?: BlinkOptions | false;
  lookAt?: { target: Vec2; maxDegrees?: number } | false;
}
export interface PlayOptions {
  /** Stage time in seconds at which the clip starts. */
  at: number;
  weight?: number;
  /** Crossfade-in seconds for override clips. */
  fade?: number;
  /** Override the clip's own loop flag. */
  loop?: boolean;
  /** Keep the last pose of a non-looping clip instead of fading out. */
  hold?: boolean;
  /** Layer name; a new clip on the same layer replaces the previous one. Defaults to `gesture`. */
  layer?: string;
}
export interface PuppetModelOptions {
  rigs: ReadonlyMap<string, RigFile>;
  clips?: ReadonlyMap<string, ClipFile>;
  composition: AvatarComposition;
  /** Logical pixels per atlas pixel, by atlas ID. Defaults to 1. */
  atlasScales?: ReadonlyMap<string, number>;
  at?: Vec2;
  scale?: number;
  facing?: 'left' | 'right';
  seed?: string;
  reducedMotion?: boolean;
}

interface Node {
  key: string;
  rig: RigFile;
  part: RigPart;
  base: boolean;
  /** Parent node key, slot key (`slot:<rig>/<id>`) or anchor key. */
  parent?: string;
  order: number[];
  variant?: string;
  tint?: string;
}
interface Attachment {
  key: string;
  kind: 'slot' | 'anchor';
  parentNode?: string;
  /** Offset in the parent's space (slot: logical px; anchor: frame px relative to pivot). */
  x: number;
  y: number;
  order: number[];
  rig: RigFile;
}
interface Layer {
  name: string;
  clip: ClipFile;
  start: number;
  weight: number;
  fade: number;
  loop: boolean;
  hold: boolean;
  additive: boolean;
}
interface Motion {
  points: Vec2[];
  start: number;
  duration: number;
  ease?: Easing;
  walk: boolean;
}
const STRIDE = 140;
const FADE_OUT = 0.15;

function hex(value: string | undefined): string | undefined {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined;
}

/**
 * A presentation-only puppet: a pure function of its configuration and a stage time. It never
 * reads the wall clock, so the same calls and times always give the same draw list.
 */
export class PuppetModel {
  readonly base: RigFile;
  private readonly nodes: Node[] = [];
  private readonly nodeByKey = new Map<string, Node>();
  private readonly attachments = new Map<string, Attachment>();
  private readonly clips: ReadonlyMap<string, ClipFile>;
  private readonly scales: ReadonlyMap<string, number>;
  private readonly layers = new Map<string, Layer>();
  private readonly baseParts = new Map<string, RigPart>();
  private readonly mouthShapes = new Set<string>();
  private behaviours: Behaviours = {};
  private blinkTimes: number[] = [];
  private blinkRandom = createPresentationRandom('blink');
  private blinkSeed = '';
  private expression?: string;
  private mouth?: MouthShape;
  private hops: { start: number; height: number; duration: number }[] = [];
  private motion?: Motion;
  position: Vec2;
  scale: number;
  facing: 'left' | 'right';
  reducedMotion: boolean;

  constructor(private readonly options: PuppetModelOptions) {
    const base = options.rigs.get(options.composition.rig);
    if (!base) throw new BrowserServiceError('asset', `Unknown rig "${options.composition.rig}".`);
    this.base = base;
    this.clips = options.clips ?? new Map();
    this.scales = options.atlasScales ?? new Map();
    this.position = { ...(options.at ?? { x: 0, y: 0 }) };
    this.scale = options.scale ?? 1;
    this.facing = options.facing ?? 'right';
    this.reducedMotion = options.reducedMotion ?? false;
    this.blinkSeed = options.seed ?? base.id;
    for (const part of base.parts) this.baseParts.set(part.id, part);
    const mouth = base.roles?.mouth ? this.baseParts.get(base.roles.mouth) : undefined;
    for (const name of Object.keys(mouth?.variants ?? {})) this.mouthShapes.add(name);
    this.addRig(base, true, undefined, [], undefined);
    const accessories = options.composition.accessories ?? [];
    const pending = [...accessories];
    // Accessories may attach to anchors declared by other accessories; resolve in passes.
    for (let pass = 0; pending.length && pass < 8; pass++)
      for (const binding of [...pending])
        if (this.attach(binding)) pending.splice(pending.indexOf(binding), 1);
    if (pending.length)
      throw new BrowserServiceError(
        'asset',
        `Unknown slot or anchor for accessory "${pending[0]!.rig}".`,
      );
    this.sortNodes();
    for (const node of this.nodes) this.nodeByKey.set(node.key, node);
  }

  private tintOf(rig: RigFile, part: RigPart): string | undefined {
    if (!part.tint) return undefined;
    return (
      hex(this.options.composition.tints?.[part.tint.channel]) ??
      hex(rig.tints?.[part.tint.channel]?.default)
    );
  }

  private addRig(
    rig: RigFile,
    base: boolean,
    root: string | undefined,
    order: number[],
    binding: AccessoryBinding | undefined,
  ): void {
    const prefix = base ? '' : `${rig.id}@${root ?? ''}/`;
    for (const part of rig.parts) {
      const key = `${prefix}${part.id}`;
      const parent = part.parent
        ? rig.slots?.[part.parent]
          ? `slot:${prefix}${part.parent}`
          : `${prefix}${part.parent}`
        : root;
      const variant =
        binding?.variant && part.variants?.[binding.variant] ? binding.variant : part.variant;
      const tint = this.tintOf(rig, part);
      this.nodes.push({
        key,
        rig,
        part,
        base,
        ...(parent ? { parent } : {}),
        order: [...order, part.z],
        ...(variant ? { variant } : {}),
        ...(tint ? { tint } : {}),
      });
    }
    for (const [name, slot] of Object.entries(rig.slots ?? {}))
      this.attachments.set(`slot:${prefix}${name}`, {
        key: `slot:${prefix}${name}`,
        kind: 'slot',
        ...(slot.parent
          ? { parentNode: `${prefix}${slot.parent}` }
          : root
            ? { parentNode: root }
            : {}),
        x: slot.position.x,
        y: slot.position.y,
        order: [...order, slot.z, 1],
        rig,
      });
    for (const [name, anchor] of Object.entries(rig.anchors ?? {})) {
      const owner = rig.parts.find((part) => part.id === anchor.part);
      if (!owner) continue;
      this.attachments.set(`anchor:${name}`, {
        key: `anchor:${name}`,
        kind: 'anchor',
        parentNode: `${prefix}${anchor.part}`,
        x: anchor.x,
        y: anchor.y,
        order: [...order, owner.z, 1],
        rig,
      });
    }
  }

  private attach(binding: AccessoryBinding): boolean {
    const rig = this.options.rigs.get(binding.rig);
    if (!rig) throw new BrowserServiceError('asset', `Unknown accessory rig "${binding.rig}".`);
    if ((binding.slot === undefined) === (binding.anchor === undefined))
      throw new BrowserServiceError(
        'invalid-data',
        'An accessory names exactly one slot or anchor.',
      );
    const target = binding.slot
      ? this.attachments.get(`slot:${binding.slot}`)
      : this.attachments.get(`anchor:${binding.anchor!}`);
    if (!target) return false;
    this.addRig(rig, false, target.key, target.order, binding);
    return true;
  }

  private sortNodes(): void {
    const compare = (a: readonly number[], b: readonly number[]): number => {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] ?? -Infinity;
        const y = b[i] ?? -Infinity;
        if (x !== y) return x - y;
      }
      return 0;
    };
    this.nodes.sort((a, b) => compare(a.order, b.order));
  }

  /** Parts drawn by this composition, with their frame references (for loading and tests). */
  frames(): string[] {
    const frames = new Set<string>();
    for (const node of this.nodes) {
      if (node.part.frame) frames.add(node.part.frame);
      for (const ref of Object.values(node.part.variants ?? {})) frames.add(ref);
      if (node.part.tint?.mask) frames.add(node.part.tint.mask);
    }
    return [...frames];
  }

  hasClip(id: string): boolean {
    return this.clips.has(id);
  }
  clipDuration(id: string): number {
    const clip = this.clips.get(id);
    if (!clip) throw new BrowserServiceError('asset', `Unknown clip "${id}".`);
    return clip.duration;
  }

  play(id: string, options: PlayOptions): void {
    const clip = this.clips.get(id);
    if (!clip) throw new BrowserServiceError('asset', `Unknown clip "${id}".`);
    const name = options.layer ?? 'gesture';
    this.layers.set(name, {
      name,
      clip,
      start: options.at,
      weight: Math.min(1, Math.max(0, options.weight ?? 1)),
      fade: Math.max(0, options.fade ?? (clip.blend === 'additive' ? 0 : 0.2)),
      loop: options.loop ?? clip.loop ?? false,
      hold: options.hold ?? false,
      additive: clip.blend === 'additive',
    });
  }
  stopLayer(name: string): void {
    this.layers.delete(name);
  }
  clearLayers(): void {
    this.layers.clear();
  }
  setExpression(name: string | undefined): void {
    if (name !== undefined && !this.base.expressions?.[name])
      throw new BrowserServiceError('asset', `Rig "${this.base.id}" has no expression "${name}".`);
    this.expression = name;
  }
  getExpression(): string | undefined {
    return this.expression;
  }
  /** Drive the mouth; `undefined` returns it to rest. */
  setMouth(shape: MouthShape | undefined): void {
    if (shape !== undefined && !isMouthShape(shape))
      throw new BrowserServiceError('invalid-data', `Unknown mouth shape "${String(shape)}".`);
    this.mouth = shape;
  }
  getMouth(): MouthShape | undefined {
    return this.mouth;
  }
  /** The variant the rig actually draws for a requested shape (with G/H/X fallbacks). */
  mouthVariant(shape: MouthShape | undefined): string | undefined {
    if (!this.mouthShapes.size) return undefined;
    return resolveMouthShape(shape ?? 'X', this.mouthShapes);
  }
  behave(behaviours: Behaviours): void {
    this.behaviours = { ...this.behaviours, ...behaviours };
    if (behaviours.blink) {
      const seed = behaviours.blink.seed ?? this.blinkSeed;
      this.blinkSeed = seed;
      this.blinkRandom = createPresentationRandom(`blink:${seed}`);
      this.blinkTimes = [];
    }
  }
  hop(at: number, options: { height?: number; duration?: number } = {}): number {
    const duration = options.duration ?? 0.45;
    this.hops = this.hops.filter((hop) => at < hop.start + hop.duration);
    this.hops.push({ start: at, height: options.height ?? 40, duration });
    return duration;
  }
  /** Move along `points` (the first is the start) over `duration` seconds from `at`. */
  move(
    points: readonly Vec2[],
    at: number,
    options: { duration?: number; speed?: number; ease?: Easing; walk?: boolean } = {},
  ): number {
    const path = [this.positionAt(at), ...points.map((point) => ({ ...point }))];
    let length = 0;
    for (let i = 1; i < path.length; i++)
      length += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
    const duration = options.duration ?? (options.speed ? length / options.speed : length / 360);
    this.motion = {
      points: path,
      start: at,
      duration: Math.max(0, duration),
      ...(options.ease ? { ease: options.ease } : {}),
      walk: options.walk ?? true,
    };
    const last = path.at(-1)!;
    if (Math.abs(last.x - path[0]!.x) > 1) this.facing = last.x < path[0]!.x ? 'left' : 'right';
    return this.motion.duration;
  }
  /** Jump to the end of any movement and one-shot motion (skip). */
  settle(at: number): void {
    if (this.motion) this.position = { ...this.motion.points.at(-1)! };
    this.motion = undefined;
    this.hops = [];
    for (const [name, layer] of this.layers)
      if (!layer.loop && !layer.hold && at >= layer.start) this.layers.delete(name);
  }
  setPosition(point: Vec2): void {
    this.position = { ...point };
    this.motion = undefined;
  }

  positionAt(time: number): Vec2 {
    const motion = this.motion;
    if (!motion) return { ...this.position };
    const raw = motion.duration > 0 ? (time - motion.start) / motion.duration : 1;
    if (raw >= 1) {
      this.position = { ...motion.points.at(-1)! };
      this.motion = undefined;
      return { ...this.position };
    }
    const progress = ease(motion.ease, Math.max(0, raw));
    return this.pointAlong(motion.points, progress).point;
  }

  private pointAlong(points: readonly Vec2[], progress: number): { point: Vec2; distance: number } {
    const lengths: number[] = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const length = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
      lengths.push(length);
      total += length;
    }
    if (!total) return { point: { ...points.at(-1)! }, distance: 0 };
    let remaining = total * progress;
    for (let i = 0; i < lengths.length; i++) {
      if (remaining <= lengths[i]! || i === lengths.length - 1) {
        const u = lengths[i] ? Math.min(1, remaining / lengths[i]!) : 1;
        const a = points[i]!;
        const b = points[i + 1]!;
        return {
          point: { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u },
          distance: total * progress,
        };
      }
      remaining -= lengths[i]!;
    }
    return { point: { ...points.at(-1)! }, distance: total };
  }

  private blinkState(time: number): 'open' | 'half' | 'closed' {
    const blink = this.behaviours.blink;
    if (!blink) return 'open';
    const min = blink.minInterval ?? 2.5;
    const max = Math.max(min, blink.maxInterval ?? 6);
    const duration = blink.duration ?? 0.15;
    while ((this.blinkTimes.at(-1) ?? 0) <= time + max) {
      if (this.blinkTimes.length > 100_000) break;
      this.blinkTimes.push((this.blinkTimes.at(-1) ?? 0) + this.blinkRandom.range(min, max));
    }
    let low = 0;
    let high = this.blinkTimes.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.blinkTimes[middle]! <= time) low = middle;
      else high = middle - 1;
    }
    const start = this.blinkTimes[low]!;
    if (start > time) return 'open';
    const phase = (time - start) / duration;
    if (phase >= 1) return 'open';
    return phase < 1 / 3 || phase >= 2 / 3 ? 'half' : 'closed';
  }

  private layerWeight(layer: Layer, time: number): number {
    const elapsed = time - layer.start;
    if (elapsed < 0) return 0;
    let weight = layer.weight;
    if (layer.fade > 0 && elapsed < layer.fade) weight *= elapsed / layer.fade;
    if (!layer.loop && !layer.hold && elapsed > layer.clip.duration) {
      const out = (elapsed - layer.clip.duration) / FADE_OUT;
      if (out >= 1) return 0;
      weight *= 1 - out;
    }
    return weight;
  }

  /** The complete draw list at a stage time. */
  pose(time: number): DrawItem[] {
    const damp = this.reducedMotion ? 0.3 : 1;
    // 1. Rest values and variants for base parts, then expression.
    const values = new Map<string, Record<NumericProperty, number>>();
    const variants = new Map<string, string>();
    for (const node of this.nodes) {
      const part = node.part;
      values.set(node.key, {
        x: part.position.x,
        y: part.position.y,
        rotation: part.rotation ?? 0,
        scaleX: part.scale?.x ?? 1,
        scaleY: part.scale?.y ?? 1,
        opacity: part.opacity ?? 1,
      });
      if (node.variant) variants.set(node.key, node.variant);
    }
    const expressions = this.base.expressions ?? {};
    const applyExpression = (name: string | undefined): void => {
      if (!name || !expressions[name]) return;
      for (const [part, variant] of Object.entries(expressions[name])) variants.set(part, variant);
    };
    applyExpression(this.expression);
    // 2. Clip layers, in insertion order (override then additive as authored).
    for (const [name, layer] of this.layers) {
      const weight = this.layerWeight(layer, time);
      if (weight <= 0) {
        if (!layer.loop && !layer.hold && time - layer.start > layer.clip.duration + FADE_OUT)
          this.layers.delete(name);
        continue;
      }
      const sample = sampleClip(
        layer.loop ? { ...layer.clip, loop: true } : layer.clip,
        time - layer.start,
      );
      if (weight >= 0.5) {
        applyExpression(sample.expression);
        for (const [part, variant] of sample.variants)
          if (this.baseParts.has(part)) variants.set(part, variant);
      }
      for (const [part, numbers] of sample.numbers) {
        const current = values.get(part);
        const rest = this.baseParts.get(part);
        if (!current || !rest) continue;
        for (const [property, value] of Object.entries(numbers) as [NumericProperty, number][]) {
          if (layer.additive) {
            if (property === 'scaleX' || property === 'scaleY' || property === 'opacity')
              current[property] *= 1 + (value - 1) * weight;
            else current[property] += value * weight * (property === 'rotation' ? 1 : damp);
          } else {
            const target =
              property === 'x'
                ? rest.position.x + value
                : property === 'y'
                  ? rest.position.y + value
                  : property === 'rotation'
                    ? (rest.rotation ?? 0) + value
                    : property === 'scaleX'
                      ? (rest.scale?.x ?? 1) * value
                      : property === 'scaleY'
                        ? (rest.scale?.y ?? 1) * value
                        : (rest.opacity ?? 1) * value;
            current[property] += (target - current[property]) * weight;
          }
        }
      }
    }
    // 3. Procedural behaviours on roles.
    const roles = this.base.roles ?? {};
    const bodyKey = roles.body ?? this.base.parts.find((part) => !part.parent)?.id;
    const body = bodyKey ? values.get(bodyKey) : undefined;
    const breathe = this.behaviours.breathe;
    if (breathe && body) {
      const period = breathe.period ?? 3.6;
      const wave = (Math.sin((2 * Math.PI * time) / period) + 1) / 2;
      body.y -= (breathe.amplitude ?? 6) * wave * damp;
      body.scaleY *= 1 + 0.015 * wave * damp;
    }
    const bob = this.behaviours.bob;
    if (bob && body)
      body.y -= (bob.amplitude ?? 4) * Math.sin((2 * Math.PI * time) / (bob.period ?? 1.8)) * damp;
    const look = this.behaviours.lookAt;
    const lookKey = roles.lookAt ?? roles.head;
    if (look && lookKey && values.has(lookKey)) {
      const position = this.positionAt(time);
      const dx = (look.target.x - position.x) * (this.facing === 'left' ? -1 : 1);
      const dy = look.target.y - position.y;
      const max = look.maxDegrees ?? 12;
      values.get(lookKey)!.rotation += Math.max(
        -max,
        Math.min(max, (dy / 600) * max * Math.sign(dx || 1)),
      );
    }
    if (roles.eyes && this.behaviours.blink && (variants.get(roles.eyes) ?? 'open') === 'open') {
      const state = this.blinkState(time);
      const eyeVariants = this.baseParts.get(roles.eyes)?.variants ?? {};
      if (state !== 'open') variants.set(roles.eyes, eyeVariants[state] ? state : 'closed');
    }
    if (roles.mouth) {
      const variant = this.mouthVariant(this.mouth);
      if (variant) variants.set(roles.mouth, variant);
    }
    // 4. Root transform with movement, hops and gait.
    const position = this.positionAt(time);
    let lift = 0;
    let squash = 1;
    for (const hop of this.hops) {
      const u = (time - hop.start) / hop.duration;
      if (u < 0 || u >= 1) continue;
      lift += hop.height * damp * 4 * u * (1 - u);
      if (u > 0.85) squash = Math.min(squash, 1 - 0.08 * damp);
    }
    const motion = this.motion;
    if (motion?.walk && time >= motion.start) {
      const progress = ease(
        motion.ease,
        Math.min(1, (time - motion.start) / (motion.duration || 1)),
      );
      const { distance } = this.pointAlong(motion.points, progress);
      lift += 8 * damp * Math.abs(Math.sin((Math.PI * distance) / STRIDE));
    }
    const flip = this.facing === 'left' ? -1 : 1;
    const origin = this.base.origin ?? { x: 0, y: 0 };
    const root = multiply(
      compose(position.x, position.y - lift, 0, flip * this.scale, this.scale * squash),
      [1, 0, 0, 1, -origin.x, -origin.y],
    );
    // 5. World matrices in hierarchy order.
    const worlds = new Map<string, Matrix>();
    const frameWorlds = new Map<string, Matrix>();
    const opacities = new Map<string, number>();
    const resolving = new Set<string>();
    const scaleOf = (ref: string | undefined): number =>
      (ref && this.scales.get(parseFrameRef(ref)?.atlas ?? '')) || 1;
    const world = (key: string): Matrix => {
      const cached = worlds.get(key);
      if (cached) return cached;
      if (resolving.has(key)) return [...IDENTITY] as Matrix;
      resolving.add(key);
      let result: Matrix;
      let opacity = 1;
      const attachment = this.attachments.get(key);
      if (attachment) {
        const parent = attachment.parentNode;
        if (attachment.kind === 'slot') {
          result = multiply(parent ? world(parent) : root, [
            1,
            0,
            0,
            1,
            attachment.x,
            attachment.y,
          ]);
        } else {
          const owner = this.nodeByKey.get(parent!)!;
          const scale = scaleOf(owner.part.frame ?? Object.values(owner.part.variants ?? {})[0]);
          result = multiply(world(parent!), [
            scale,
            0,
            0,
            scale,
            (attachment.x - owner.part.pivot.x) * scale,
            (attachment.y - owner.part.pivot.y) * scale,
          ]);
        }
        opacity = parent ? (opacities.get(parent) ?? 1) : 1;
      } else {
        const node = this.nodeByKey.get(key)!;
        const value = values.get(key)!;
        const parentMatrix = node.parent ? world(node.parent) : root;
        result = multiply(
          parentMatrix,
          compose(value.x, value.y, value.rotation, value.scaleX, value.scaleY),
        );
        opacity = value.opacity * (node.parent ? (opacities.get(node.parent) ?? 1) : 1);
      }
      opacities.set(key, opacity);
      worlds.set(key, result);
      resolving.delete(key);
      return result;
    };
    const items: DrawItem[] = [];
    for (const node of this.nodes) {
      const part = node.part;
      const variant = variants.get(node.key) ?? node.variant;
      const frame = part.frame ?? (variant ? part.variants?.[variant] : undefined);
      const matrix = world(node.key);
      if (!frame) continue;
      const scale = scaleOf(frame);
      const frameMatrix = multiply(matrix, [
        scale,
        0,
        0,
        scale,
        -part.pivot.x * scale,
        -part.pivot.y * scale,
      ]);
      frameWorlds.set(node.key, frameMatrix);
      const opacity = opacities.get(node.key) ?? 1;
      if (opacity <= 0) continue;
      items.push({
        id: node.key,
        frame,
        matrix: frameMatrix,
        opacity,
        ...(node.tint ? { tint: node.tint } : {}),
        ...(node.tint && part.tint?.mask ? { mask: part.tint.mask } : {}),
        order: node.order,
      });
    }
    return items;
  }

  /** World position of a named anchor at a time (e.g. where a badge or an effect sits). */
  anchorAt(name: string, time: number): Vec2 | undefined {
    const attachment = this.attachments.get(`anchor:${name}`);
    if (!attachment) return undefined;
    const owner = this.pose(time).find((item) => item.id === attachment.parentNode);
    if (!owner) return undefined;
    const m = owner.matrix;
    return {
      x: m[0] * attachment.x + m[2] * attachment.y + m[4],
      y: m[1] * attachment.x + m[3] * attachment.y + m[5],
    };
  }
}
