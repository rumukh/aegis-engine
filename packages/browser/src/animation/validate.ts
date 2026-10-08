import { isEasing } from './easing.js';
import { isMouthShape, REQUIRED_MOUTH_SHAPES } from './mouth.js';
import type {
  AnimationDiagnostic,
  AtlasFile,
  ClipFile,
  CueTrackFile,
  CutsceneFile,
  RigFile,
} from './types.js';

/**
 * Headless validation of authored animation documents (ANIM-02, ANIM-07). Every problem is
 * reported in one pass with a stable `AEG-ANIM-nnnn` code and a JSON path, like content
 * diagnostics. Validators never throw on bad input.
 */
export const ANIM_CODES = Object.freeze({
  notObject: 'AEG-ANIM-0001',
  format: 'AEG-ANIM-0002',
  required: 'AEG-ANIM-0003',
  type: 'AEG-ANIM-0004',
  unknownField: 'AEG-ANIM-0005',
  duplicate: 'AEG-ANIM-0006',
  parent: 'AEG-ANIM-0010',
  missingFrame: 'AEG-ANIM-0011',
  pivot: 'AEG-ANIM-0012',
  zOrder: 'AEG-ANIM-0013',
  variant: 'AEG-ANIM-0014',
  mouthSet: 'AEG-ANIM-0015',
  slot: 'AEG-ANIM-0016',
  tint: 'AEG-ANIM-0017',
  role: 'AEG-ANIM-0018',
  textureSize: 'AEG-ANIM-0020',
  frameBounds: 'AEG-ANIM-0021',
  imageSize: 'AEG-ANIM-0022',
  memory: 'AEG-ANIM-0023',
  mouthShape: 'AEG-ANIM-0030',
  cueDuration: 'AEG-ANIM-0031',
  cueOrder: 'AEG-ANIM-0032',
  clipTarget: 'AEG-ANIM-0040',
  clipKeys: 'AEG-ANIM-0041',
  easing: 'AEG-ANIM-0042',
  step: 'AEG-ANIM-0050',
  reference: 'AEG-ANIM-0051',
});

export const MAX_TEXTURE_SIZE = 4096;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  diagnostics: AnimationDiagnostic[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

class Checker {
  readonly diagnostics: AnimationDiagnostic[] = [];
  constructor(readonly source?: string) {}
  error(code: string, path: string, message: string): void {
    this.diagnostics.push({
      code,
      severity: 'error',
      message,
      path,
      ...(this.source ? { source: this.source } : {}),
    });
  }
  warn(code: string, path: string, message: string): void {
    this.diagnostics.push({
      code,
      severity: 'warning',
      message,
      path,
      ...(this.source ? { source: this.source } : {}),
    });
  }
  get ok(): boolean {
    return !this.diagnostics.some((item) => item.severity === 'error');
  }
  fields(
    value: Json,
    path: string,
    required: readonly string[],
    optional: readonly string[],
  ): void {
    for (const key of required)
      if (!(key in value))
        this.error(ANIM_CODES.required, path, `Missing required field "${key}".`);
    const known = new Set([...required, ...optional]);
    for (const key of Object.keys(value))
      if (!known.has(key))
        this.error(ANIM_CODES.unknownField, `${path}.${key}`, `Unknown field "${key}".`);
  }
  id(value: unknown, path: string): value is string {
    if (typeof value === 'string' && ID.test(value)) return true;
    this.error(ANIM_CODES.type, path, 'Expected a stable identifier.');
    return false;
  }
  number(value: unknown, path: string, min = -Infinity, max = Infinity): value is number {
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)
      return true;
    this.error(
      ANIM_CODES.type,
      path,
      `Expected a finite number${min > -Infinity ? ` >= ${String(min)}` : ''}${max < Infinity ? ` <= ${String(max)}` : ''}.`,
    );
    return false;
  }
  integer(value: unknown, path: string, min = -Infinity, max = Infinity): value is number {
    if (Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max)
      return true;
    this.error(ANIM_CODES.type, path, 'Expected an integer in range.');
    return false;
  }
  vec(value: unknown, path: string): boolean {
    if (!isObject(value)) {
      this.error(ANIM_CODES.type, path, 'Expected { x, y }.');
      return false;
    }
    this.fields(value, path, ['x', 'y'], []);
    return this.number(value.x, `${path}.x`) && this.number(value.y, `${path}.y`);
  }
  record(value: unknown, path: string): value is Json {
    if (isObject(value)) return true;
    this.error(ANIM_CODES.type, path, 'Expected an object.');
    return false;
  }
  array(value: unknown, path: string): value is unknown[] {
    if (Array.isArray(value)) return true;
    this.error(ANIM_CODES.type, path, 'Expected an array.');
    return false;
  }
  header(value: unknown, format: string): value is Json {
    if (!isObject(value)) {
      this.error(ANIM_CODES.notObject, '$', 'Expected a JSON object.');
      return false;
    }
    if (value.format !== format) {
      this.error(ANIM_CODES.format, '$.format', `Expected format "${format}".`);
      return false;
    }
    return true;
  }
  result<T>(value: unknown): ValidationResult<T> {
    return this.ok
      ? { ok: true, value: value as T, diagnostics: this.diagnostics }
      : { ok: false, diagnostics: this.diagnostics };
  }
}

/** Split `"atlas#frame"` references. */
export function parseFrameRef(ref: string): { atlas: string; frame: string } | undefined {
  const index = ref.indexOf('#');
  if (index <= 0 || index === ref.length - 1) return undefined;
  return { atlas: ref.slice(0, index), frame: ref.slice(index + 1) };
}

export function validateAtlas(
  input: unknown,
  options: { source?: string; maxTextureSize?: number } = {},
): ValidationResult<AtlasFile> {
  const c = new Checker(options.source);
  const max = options.maxTextureSize ?? MAX_TEXTURE_SIZE;
  if (!c.header(input, 'aegis-atlas/1')) return c.result(input);
  c.fields(input, '$', ['format', 'id', 'image', 'width', 'height', 'frames'], ['scale']);
  c.id(input.id, '$.id');
  c.id(input.image, '$.image');
  const sized = c.integer(input.width, '$.width', 1) && c.integer(input.height, '$.height', 1);
  if (sized && ((input.width as number) > max || (input.height as number) > max))
    c.error(
      ANIM_CODES.textureSize,
      '$',
      `Atlas is ${String(input.width)}x${String(input.height)}; the maximum side is ${String(max)} px.`,
    );
  if (input.scale !== undefined) c.number(input.scale, '$.scale', 0.0625, 16);
  if (c.record(input.frames, '$.frames')) {
    const frames = Object.entries(input.frames);
    if (!frames.length) c.error(ANIM_CODES.required, '$.frames', 'An atlas needs frames.');
    for (const [name, frame] of frames) {
      const path = `$.frames.${name}`;
      if (!ID.test(name)) c.error(ANIM_CODES.type, path, 'Frame names must be identifiers.');
      if (!c.record(frame, path)) continue;
      c.fields(frame, path, ['x', 'y', 'w', 'h'], ['offset', 'source']);
      const valid =
        c.integer(frame.x, `${path}.x`, 0) &&
        c.integer(frame.y, `${path}.y`, 0) &&
        c.integer(frame.w, `${path}.w`, 1) &&
        c.integer(frame.h, `${path}.h`, 1);
      if (
        valid &&
        sized &&
        ((frame.x as number) + (frame.w as number) > (input.width as number) ||
          (frame.y as number) + (frame.h as number) > (input.height as number))
      )
        c.error(ANIM_CODES.frameBounds, path, 'Frame lies outside the atlas image.');
      if (frame.offset !== undefined) c.vec(frame.offset, `${path}.offset`);
      if (frame.source !== undefined && c.record(frame.source, `${path}.source`)) {
        c.fields(frame.source, `${path}.source`, ['w', 'h'], []);
        if (
          c.integer(frame.source.w, `${path}.source.w`, 1) &&
          c.integer(frame.source.h, `${path}.source.h`, 1) &&
          valid
        ) {
          const offset = isObject(frame.offset) ? frame.offset : { x: 0, y: 0 };
          if (
            (offset.x as number) + (frame.w as number) > frame.source.w ||
            (offset.y as number) + (frame.h as number) > frame.source.h
          )
            c.error(ANIM_CODES.frameBounds, path, 'Trimmed frame does not fit its source size.');
        }
      }
    }
  }
  return c.result(input);
}

/** Untrimmed frame size, used for pivots. */
function frameSize(atlas: AtlasFile, name: string): { w: number; h: number } | undefined {
  const frame = atlas.frames[name];
  if (!frame) return undefined;
  return frame.source ?? { w: frame.w, h: frame.h };
}

export function validateRig(
  input: unknown,
  context: { source?: string; atlases?: ReadonlyMap<string, AtlasFile> } = {},
): ValidationResult<RigFile> {
  const c = new Checker(context.source);
  if (!c.header(input, 'aegis-rig/1')) return c.result(input);
  c.fields(
    input,
    '$',
    ['format', 'id', 'revision', 'atlases', 'parts'],
    ['origin', 'bounds', 'roles', 'expressions', 'slots', 'anchors', 'tints', 'emotes'],
  );
  c.id(input.id, '$.id');
  c.id(input.revision, '$.revision');
  const atlasIds = new Set<string>();
  if (c.array(input.atlases, '$.atlases'))
    input.atlases.forEach((id, i) => {
      if (c.id(id, `$.atlases[${String(i)}]`)) atlasIds.add(id);
    });
  if (input.origin !== undefined) c.vec(input.origin, '$.origin');
  if (input.bounds !== undefined && c.record(input.bounds, '$.bounds')) {
    c.fields(input.bounds, '$.bounds', ['x', 'y', 'width', 'height'], []);
    c.number(input.bounds.x, '$.bounds.x');
    c.number(input.bounds.y, '$.bounds.y');
    c.number(input.bounds.width, '$.bounds.width', 1);
    c.number(input.bounds.height, '$.bounds.height', 1);
  }
  const tints = new Set<string>();
  if (input.tints !== undefined && c.record(input.tints, '$.tints'))
    for (const [name, tint] of Object.entries(input.tints)) {
      const path = `$.tints.${name}`;
      if (!ID.test(name)) c.error(ANIM_CODES.type, path, 'Tint channels must be identifiers.');
      tints.add(name);
      if (c.record(tint, path)) {
        c.fields(tint, path, ['default'], []);
        if (typeof tint.default !== 'string' || !COLOR.test(tint.default))
          c.error(ANIM_CODES.type, `${path}.default`, 'Expected a #rrggbb colour.');
      }
    }
  const slots = new Map<string, Json>();
  if (input.slots !== undefined && c.record(input.slots, '$.slots'))
    for (const [name, slot] of Object.entries(input.slots)) {
      const path = `$.slots.${name}`;
      if (!ID.test(name)) c.error(ANIM_CODES.type, path, 'Slot names must be identifiers.');
      if (!c.record(slot, path)) continue;
      c.fields(slot, path, ['position', 'z'], ['parent']);
      c.vec(slot.position, `${path}.position`);
      c.integer(slot.z, `${path}.z`, -100_000, 100_000);
      slots.set(name, slot);
    }
  const parts = new Map<string, Json>();
  const variantsOf = new Map<string, Set<string>>();
  const zs = new Map<number, string>();
  const checkFrame = (ref: unknown, path: string): { w: number; h: number } | undefined => {
    if (typeof ref !== 'string') {
      c.error(ANIM_CODES.type, path, 'Expected an "atlas#frame" reference.');
      return undefined;
    }
    const parsed = parseFrameRef(ref);
    if (!parsed) {
      c.error(ANIM_CODES.type, path, 'Expected an "atlas#frame" reference.');
      return undefined;
    }
    if (!atlasIds.has(parsed.atlas)) {
      c.error(ANIM_CODES.missingFrame, path, `Atlas "${parsed.atlas}" is not listed in $.atlases.`);
      return undefined;
    }
    const atlas = context.atlases?.get(parsed.atlas);
    if (!context.atlases) return undefined;
    if (!atlas) {
      c.error(ANIM_CODES.missingFrame, path, `Atlas "${parsed.atlas}" was not supplied.`);
      return undefined;
    }
    const size = frameSize(atlas, parsed.frame);
    if (!size)
      c.error(
        ANIM_CODES.missingFrame,
        path,
        `Frame "${parsed.frame}" is missing from "${parsed.atlas}".`,
      );
    return size;
  };
  if (c.array(input.parts, '$.parts')) {
    if (!input.parts.length) c.error(ANIM_CODES.required, '$.parts', 'A rig needs parts.');
    input.parts.forEach((part, index) => {
      const path = `$.parts[${String(index)}]`;
      if (!c.record(part, path)) return;
      c.fields(
        part,
        path,
        ['id', 'pivot', 'position', 'z'],
        ['parent', 'frame', 'variants', 'variant', 'rotation', 'scale', 'opacity', 'tint'],
      );
      if (!c.id(part.id, `${path}.id`)) return;
      if (parts.has(part.id) || slots.has(part.id))
        c.error(ANIM_CODES.duplicate, `${path}.id`, `Duplicate part or slot ID "${part.id}".`);
      parts.set(part.id, part);
      if (c.integer(part.z, `${path}.z`, -100_000, 100_000)) {
        const owner = zs.get(part.z);
        if (owner !== undefined)
          c.error(
            ANIM_CODES.zOrder,
            `${path}.z`,
            `z ${String(part.z)} is also used by "${owner}".`,
          );
        zs.set(part.z, part.id);
      }
      c.vec(part.position, `${path}.position`);
      const pivotOk = c.vec(part.pivot, `${path}.pivot`);
      if (part.rotation !== undefined) c.number(part.rotation, `${path}.rotation`);
      if (part.scale !== undefined) c.vec(part.scale, `${path}.scale`);
      if (part.opacity !== undefined) c.number(part.opacity, `${path}.opacity`, 0, 1);
      const sizes: { w: number; h: number }[] = [];
      if ((part.frame === undefined) === (part.variants === undefined))
        c.error(ANIM_CODES.required, path, 'A part needs exactly one of "frame" or "variants".');
      if (part.frame !== undefined) {
        const size = checkFrame(part.frame, `${path}.frame`);
        if (size) sizes.push(size);
        if (part.variant !== undefined)
          c.error(ANIM_CODES.variant, `${path}.variant`, '"variant" requires "variants".');
      }
      if (part.variants !== undefined && c.record(part.variants, `${path}.variants`)) {
        const names = new Set(Object.keys(part.variants));
        variantsOf.set(part.id, names);
        if (!names.size) c.error(ANIM_CODES.variant, `${path}.variants`, 'No variants declared.');
        for (const [name, ref] of Object.entries(part.variants)) {
          if (!ID.test(name))
            c.error(
              ANIM_CODES.type,
              `${path}.variants.${name}`,
              'Variant names must be identifiers.',
            );
          const size = checkFrame(ref, `${path}.variants.${name}`);
          if (size) sizes.push(size);
        }
        if (part.variant === undefined)
          c.error(ANIM_CODES.variant, `${path}.variant`, 'Declare the default "variant".');
        else if (typeof part.variant !== 'string' || !names.has(part.variant))
          c.error(ANIM_CODES.variant, `${path}.variant`, 'The default variant is not declared.');
      }
      if (pivotOk) {
        const pivot = part.pivot as { x: number; y: number };
        for (const size of sizes)
          if (pivot.x < 0 || pivot.y < 0 || pivot.x > size.w || pivot.y > size.h) {
            c.error(
              ANIM_CODES.pivot,
              `${path}.pivot`,
              `Pivot (${String(pivot.x)}, ${String(pivot.y)}) lies outside the ${String(size.w)}x${String(size.h)} frame.`,
            );
            break;
          }
      }
      if (part.tint !== undefined && c.record(part.tint, `${path}.tint`)) {
        c.fields(part.tint, `${path}.tint`, ['channel'], ['mask']);
        if (typeof part.tint.channel !== 'string' || !tints.has(part.tint.channel))
          c.error(
            ANIM_CODES.tint,
            `${path}.tint.channel`,
            'Unknown tint channel; declare it in $.tints.',
          );
        if (part.tint.mask !== undefined) checkFrame(part.tint.mask, `${path}.tint.mask`);
      }
    });
    // Parents and cycles.
    for (const [index, part] of input.parts.entries()) {
      if (!isObject(part) || typeof part.id !== 'string' || part.parent === undefined) continue;
      const path = `$.parts[${String(index)}].parent`;
      if (typeof part.parent !== 'string' || (!parts.has(part.parent) && !slots.has(part.parent))) {
        c.error(ANIM_CODES.parent, path, `Unknown parent "${String(part.parent)}".`);
        continue;
      }
      const seen = new Set<string>([part.id]);
      let next: unknown = part.parent;
      while (typeof next === 'string') {
        if (seen.has(next)) {
          c.error(ANIM_CODES.parent, path, `Parent chain of "${part.id}" forms a cycle.`);
          break;
        }
        seen.add(next);
        next = (parts.get(next) ?? slots.get(next))?.parent;
      }
    }
  }
  for (const [name, slot] of slots)
    if (slot.parent !== undefined && (typeof slot.parent !== 'string' || !parts.has(slot.parent)))
      c.error(ANIM_CODES.slot, `$.slots.${name}.parent`, 'Slots attach to a part of this rig.');
  if (input.anchors !== undefined && c.record(input.anchors, '$.anchors'))
    for (const [name, anchor] of Object.entries(input.anchors)) {
      const path = `$.anchors.${name}`;
      if (!ID.test(name)) c.error(ANIM_CODES.type, path, 'Anchor names must be identifiers.');
      if (!c.record(anchor, path)) continue;
      c.fields(anchor, path, ['part', 'x', 'y'], []);
      if (typeof anchor.part !== 'string' || !parts.has(anchor.part))
        c.error(ANIM_CODES.slot, `${path}.part`, 'Anchors follow a part of this rig.');
      c.number(anchor.x, `${path}.x`);
      c.number(anchor.y, `${path}.y`);
    }
  if (input.roles !== undefined && c.record(input.roles, '$.roles')) {
    c.fields(input.roles, '$.roles', [], ['mouth', 'eyes', 'brows', 'head', 'lookAt', 'body']);
    for (const [role, id] of Object.entries(input.roles))
      if (typeof id !== 'string' || !parts.has(id))
        c.error(ANIM_CODES.role, `$.roles.${role}`, `Role "${role}" names an unknown part.`);
    const mouth =
      typeof input.roles.mouth === 'string' ? variantsOf.get(input.roles.mouth) : undefined;
    if (typeof input.roles.mouth === 'string' && parts.has(input.roles.mouth)) {
      if (!mouth)
        c.error(ANIM_CODES.mouthSet, '$.roles.mouth', 'The mouth part needs mouth-shape variants.');
      else {
        const missing = REQUIRED_MOUTH_SHAPES.filter((shape) => !mouth.has(shape));
        if (missing.length)
          c.error(
            ANIM_CODES.mouthSet,
            '$.roles.mouth',
            `Mouth shapes missing: ${missing.join(', ')}.`,
          );
        for (const name of mouth)
          if (!isMouthShape(name))
            c.error(
              ANIM_CODES.mouthShape,
              '$.roles.mouth',
              `"${name}" is not an engine mouth shape (X, A-H).`,
            );
      }
    }
    const eyes =
      typeof input.roles.eyes === 'string' ? variantsOf.get(input.roles.eyes) : undefined;
    if (typeof input.roles.eyes === 'string' && parts.has(input.roles.eyes))
      for (const needed of ['open', 'closed'])
        if (!eyes?.has(needed))
          c.error(ANIM_CODES.role, '$.roles.eyes', `The eyes part needs an "${needed}" variant.`);
  }
  const expressions = new Set<string>();
  if (input.expressions !== undefined && c.record(input.expressions, '$.expressions'))
    for (const [name, expression] of Object.entries(input.expressions)) {
      const path = `$.expressions.${name}`;
      expressions.add(name);
      if (!ID.test(name)) c.error(ANIM_CODES.type, path, 'Expression names must be identifiers.');
      if (!c.record(expression, path)) continue;
      for (const [part, variant] of Object.entries(expression))
        if (!variantsOf.get(part)?.has(variant as string))
          c.error(
            ANIM_CODES.variant,
            `${path}.${part}`,
            `Unknown part or variant "${part}: ${String(variant)}".`,
          );
    }
  if (input.emotes !== undefined && c.record(input.emotes, '$.emotes'))
    for (const [name, emote] of Object.entries(input.emotes)) {
      const path = `$.emotes.${name}`;
      if (!c.record(emote, path)) continue;
      c.fields(emote, path, [], ['expression', 'clip', 'effect']);
      if (emote.expression !== undefined && !expressions.has(emote.expression as string))
        c.error(ANIM_CODES.reference, `${path}.expression`, 'Unknown expression.');
      if (emote.clip !== undefined) c.id(emote.clip, `${path}.clip`);
      if (emote.effect !== undefined) c.id(emote.effect, `${path}.effect`);
    }
  return c.result(input);
}

const NUMERIC = new Set(['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity']);

export function validateClip(
  input: unknown,
  context: { source?: string; rig?: RigFile } = {},
): ValidationResult<ClipFile> {
  const c = new Checker(context.source);
  if (!c.header(input, 'aegis-clip/1')) return c.result(input);
  c.fields(input, '$', ['format', 'id', 'duration', 'tracks'], ['loop', 'blend', 'events']);
  c.id(input.id, '$.id');
  const durationOk = c.number(input.duration, '$.duration', 0.001, 3600);
  const duration = durationOk ? (input.duration as number) : Infinity;
  if (input.loop !== undefined && typeof input.loop !== 'boolean')
    c.error(ANIM_CODES.type, '$.loop', 'Expected a boolean.');
  if (input.blend !== undefined && input.blend !== 'override' && input.blend !== 'additive')
    c.error(ANIM_CODES.type, '$.blend', 'Expected "override" or "additive".');
  const rigParts = context.rig
    ? new Map(context.rig.parts.map((part) => [part.id, part]))
    : undefined;
  const seen = new Set<string>();
  if (c.array(input.tracks, '$.tracks'))
    input.tracks.forEach((track, index) => {
      const path = `$.tracks[${String(index)}]`;
      if (!c.record(track, path)) return;
      c.fields(track, path, ['property', 'keys'], ['part']);
      const property = track.property;
      if (
        typeof property !== 'string' ||
        (!NUMERIC.has(property) && property !== 'variant' && property !== 'expression')
      ) {
        c.error(
          ANIM_CODES.clipTarget,
          `${path}.property`,
          `Unknown property "${String(property)}".`,
        );
        return;
      }
      if (property === 'expression') {
        if (track.part !== undefined)
          c.error(
            ANIM_CODES.clipTarget,
            `${path}.part`,
            'Expression tracks address the whole puppet.',
          );
      } else if (!c.id(track.part, `${path}.part`)) return;
      const key = `${String(track.part)}/${property}`;
      if (seen.has(key)) c.error(ANIM_CODES.duplicate, path, `Duplicate track for ${key}.`);
      seen.add(key);
      const part = typeof track.part === 'string' ? rigParts?.get(track.part) : undefined;
      if (rigParts && property !== 'expression' && !part)
        c.error(
          ANIM_CODES.clipTarget,
          `${path}.part`,
          `Rig "${context.rig!.id}" has no part "${String(track.part)}".`,
        );
      if (!c.array(track.keys, `${path}.keys`)) return;
      if (!track.keys.length) c.error(ANIM_CODES.clipKeys, `${path}.keys`, 'A track needs keys.');
      let previous = -Infinity;
      track.keys.forEach((frame, k) => {
        const kp = `${path}.keys[${String(k)}]`;
        if (!c.record(frame, kp)) return;
        c.fields(frame, kp, ['t', 'v'], ['ease']);
        if (c.number(frame.t, `${kp}.t`, 0)) {
          if (frame.t <= previous)
            c.error(ANIM_CODES.clipKeys, `${kp}.t`, 'Key times must strictly increase.');
          if (frame.t > duration)
            c.error(ANIM_CODES.clipKeys, `${kp}.t`, 'Key lies after the clip duration.');
          previous = frame.t;
        }
        if (NUMERIC.has(property)) {
          if (property === 'opacity') c.number(frame.v, `${kp}.v`, 0, 1);
          else c.number(frame.v, `${kp}.v`);
        } else if (typeof frame.v !== 'string')
          c.error(ANIM_CODES.type, `${kp}.v`, 'Expected a name.');
        else if (property === 'variant' && part && !part.variants?.[frame.v])
          c.error(ANIM_CODES.variant, `${kp}.v`, `Part "${part.id}" has no variant "${frame.v}".`);
        else if (property === 'expression' && context.rig && !context.rig.expressions?.[frame.v])
          c.error(ANIM_CODES.variant, `${kp}.v`, `Rig has no expression "${frame.v}".`);
        if (frame.ease !== undefined && !isEasing(frame.ease))
          c.error(ANIM_CODES.easing, `${kp}.ease`, 'Unknown easing.');
      });
    });
  if (input.events !== undefined && c.array(input.events, '$.events'))
    input.events.forEach((event, index) => {
      const path = `$.events[${String(index)}]`;
      if (!c.record(event, path)) return;
      c.fields(event, path, ['t', 'name'], ['data']);
      c.number(event.t, `${path}.t`, 0, duration);
      c.id(event.name, `${path}.name`);
    });
  return c.result(input);
}

export function validateCueTrack(
  input: unknown,
  context: { source?: string; audioDuration?: number; toleranceSeconds?: number } = {},
): ValidationResult<CueTrackFile> {
  const c = new Checker(context.source);
  if (!c.header(input, 'aegis-cues/1')) return c.result(input);
  c.fields(input, '$', ['format', 'line', 'duration', 'cues'], ['revision']);
  c.id(input.line, '$.line');
  if (input.revision !== undefined) c.id(input.revision, '$.revision');
  const durationOk = c.number(input.duration, '$.duration', 0.001, 3600);
  if (
    durationOk &&
    context.audioDuration !== undefined &&
    Math.abs((input.duration as number) - context.audioDuration) >
      (context.toleranceSeconds ?? 0.05)
  )
    c.warn(
      ANIM_CODES.cueDuration,
      '$.duration',
      `Cue duration ${String(input.duration)} s differs from the audio (${context.audioDuration.toFixed(3)} s) by more than 50 ms; the cue file may be stale.`,
    );
  if (c.array(input.cues, '$.cues')) {
    let previous = -Infinity;
    input.cues.forEach((cue, index) => {
      const path = `$.cues[${String(index)}]`;
      if (!c.record(cue, path)) return;
      c.fields(cue, path, ['t', 's'], ['a']);
      if (c.number(cue.t, `${path}.t`, 0)) {
        if (cue.t <= previous)
          c.error(ANIM_CODES.cueOrder, `${path}.t`, 'Cue times must strictly increase.');
        if (durationOk && cue.t >= (input.duration as number))
          c.error(ANIM_CODES.cueOrder, `${path}.t`, 'Cue lies at or after the track duration.');
        previous = cue.t;
      }
      if (!isMouthShape(cue.s))
        c.error(
          ANIM_CODES.mouthShape,
          `${path}.s`,
          `Unknown mouth shape "${String(cue.s)}" (use X or A-H).`,
        );
      if (cue.a !== undefined) c.number(cue.a, `${path}.a`, 0, 1);
    });
  }
  return c.result(input);
}

const STEP_FIELDS: Readonly<Record<string, { required: string[]; optional: string[] }>> = {
  background: { required: ['asset'], optional: ['transition'] },
  camera: { required: [], optional: ['preset', 'to', 'duration', 'ease', 'cut'] },
  enter: { required: ['actor', 'from', 'to'], optional: ['duration', 'walk', 'ease'] },
  exit: { required: ['actor', 'to'], optional: ['duration', 'walk', 'ease'] },
  move: { required: ['actor'], optional: ['to', 'path', 'duration', 'speed', 'walk', 'ease'] },
  pose: { required: ['actor'], optional: ['expression', 'clip', 'face'] },
  emote: { required: ['actor', 'emote'], optional: [] },
  line: { required: ['line'], optional: ['actor', 'advance'] },
  music: { required: ['asset'], optional: ['fade'] },
  atmosphere: { required: ['asset'], optional: ['fade'] },
  sfx: { required: ['asset'], optional: ['gain'] },
  effect: { required: ['effect'], optional: ['at', 'duration'] },
  transition: { required: ['type'], optional: ['duration', 'color'] },
  wait: { required: [], optional: ['seconds', 'for'] },
  marker: { required: ['id'], optional: [] },
  join: { required: [], optional: [] },
};
export const CUTSCENE_OPS: readonly string[] = Object.freeze(Object.keys(STEP_FIELDS));

export interface CutsceneContext {
  source?: string;
  /** Known rigs by ID, to check poses, expressions and emotes. */
  rigs?: ReadonlyMap<string, RigFile>;
  /** Known clip IDs. */
  clips?: ReadonlySet<string>;
  /** Narration line IDs that have captions in the consumer's audio packs. */
  lines?: ReadonlySet<string>;
  cameraPresets?: ReadonlySet<string>;
  effects?: ReadonlySet<string>;
}

export function validateCutscene(
  input: unknown,
  context: CutsceneContext = {},
): ValidationResult<CutsceneFile> {
  const c = new Checker(context.source);
  if (!c.header(input, 'aegis-cutscene/1')) return c.result(input);
  c.fields(input, '$', ['format', 'id', 'revision', 'cast', 'steps'], ['advance']);
  c.id(input.id, '$.id');
  c.id(input.revision, '$.revision');
  if (input.advance !== undefined && input.advance !== 'input' && input.advance !== 'auto')
    c.error(ANIM_CODES.type, '$.advance', 'Expected "input" or "auto".');
  const cast = new Map<string, Json>();
  if (c.record(input.cast, '$.cast'))
    for (const [name, entry] of Object.entries(input.cast)) {
      const path = `$.cast.${name}`;
      if (!ID.test(name)) c.error(ANIM_CODES.type, path, 'Cast names must be identifiers.');
      if (!c.record(entry, path)) continue;
      c.fields(entry, path, [], ['rig', 'role', 'accessories', 'tints']);
      if ((entry.rig === undefined) === (entry.role === undefined))
        c.error(ANIM_CODES.required, path, 'A cast entry needs exactly one of "rig" or "role".');
      if (entry.role !== undefined && entry.role !== 'avatar')
        c.error(ANIM_CODES.type, `${path}.role`, 'The only runtime role is "avatar".');
      if (
        entry.rig !== undefined &&
        c.id(entry.rig, `${path}.rig`) &&
        context.rigs &&
        !context.rigs.has(entry.rig)
      )
        c.error(ANIM_CODES.reference, `${path}.rig`, `Unknown rig "${entry.rig}".`);
      cast.set(name, entry);
    }
  const rigOf = (actor: string): RigFile | undefined => {
    const rig = cast.get(actor)?.rig;
    return typeof rig === 'string' ? context.rigs?.get(rig) : undefined;
  };
  const markers = new Set<string>();
  if (c.array(input.steps, '$.steps')) {
    if (!input.steps.length) c.error(ANIM_CODES.required, '$.steps', 'A cutscene needs steps.');
    input.steps.forEach((step, index) => {
      const path = `$.steps[${String(index)}]`;
      if (!c.record(step, path)) return;
      const op = step.op;
      const shape = typeof op === 'string' ? STEP_FIELDS[op] : undefined;
      if (!shape) {
        c.error(ANIM_CODES.step, `${path}.op`, `Unknown step op "${String(op)}".`);
        return;
      }
      c.fields(step, path, ['op', ...shape.required], [...shape.optional, 'wait', 'comfort']);
      if (step.wait !== undefined && typeof step.wait !== 'boolean')
        c.error(ANIM_CODES.type, `${path}.wait`, 'Expected a boolean.');
      if (step.comfort !== undefined && c.record(step.comfort, `${path}.comfort`))
        for (const key of Object.keys(step.comfort))
          if (key === 'op' || !(shape.required.includes(key) || shape.optional.includes(key)))
            c.error(
              ANIM_CODES.unknownField,
              `${path}.comfort.${key}`,
              `Comfort cannot replace "${key}".`,
            );
      if ('actor' in step && step.actor !== undefined) {
        if (typeof step.actor !== 'string' || !cast.has(step.actor))
          c.error(
            ANIM_CODES.reference,
            `${path}.actor`,
            `Unknown cast member "${String(step.actor)}".`,
          );
      }
      if ('duration' in step && step.duration !== undefined)
        c.number(step.duration, `${path}.duration`, 0, 600);
      if ('ease' in step && step.ease !== undefined && !isEasing(step.ease))
        c.error(ANIM_CODES.easing, `${path}.ease`, 'Unknown easing.');
      const placement = (value: unknown, at: string, sides: boolean): void => {
        if (sides && (value === 'left' || value === 'right')) return;
        c.vec(value, at);
      };
      const rig = typeof step.actor === 'string' ? rigOf(step.actor) : undefined;
      switch (op) {
        case 'background':
          c.id(step.asset, `${path}.asset`);
          if (step.transition !== undefined && c.record(step.transition, `${path}.transition`)) {
            c.fields(step.transition, `${path}.transition`, ['type'], ['duration']);
            if (step.transition.type !== 'cut' && step.transition.type !== 'crossfade')
              c.error(ANIM_CODES.type, `${path}.transition.type`, 'Expected "cut" or "crossfade".');
            if (step.transition.duration !== undefined)
              c.number(step.transition.duration, `${path}.transition.duration`, 0, 10);
          }
          break;
        case 'camera':
          if ((step.preset === undefined) === (step.to === undefined))
            c.error(
              ANIM_CODES.required,
              path,
              'A camera step needs exactly one of "preset" or "to".',
            );
          if (
            step.preset !== undefined &&
            c.id(step.preset, `${path}.preset`) &&
            context.cameraPresets &&
            !context.cameraPresets.has(step.preset)
          )
            c.error(
              ANIM_CODES.reference,
              `${path}.preset`,
              `Unknown camera preset "${step.preset}".`,
            );
          if (step.to !== undefined && c.record(step.to, `${path}.to`)) {
            c.fields(step.to, `${path}.to`, ['x', 'y', 'zoom'], []);
            c.number(step.to.x, `${path}.to.x`);
            c.number(step.to.y, `${path}.to.y`);
            c.number(step.to.zoom, `${path}.to.zoom`, 0.25, 8);
          }
          if (step.cut !== undefined && typeof step.cut !== 'boolean')
            c.error(ANIM_CODES.type, `${path}.cut`, 'Expected a boolean.');
          break;
        case 'enter':
          placement(step.from, `${path}.from`, true);
          placement(step.to, `${path}.to`, false);
          break;
        case 'exit':
          placement(step.to, `${path}.to`, true);
          break;
        case 'move':
          if ((step.to === undefined) === (step.path === undefined))
            c.error(ANIM_CODES.required, path, 'A move needs exactly one of "to" or "path".');
          if (step.to !== undefined) placement(step.to, `${path}.to`, false);
          if (step.path !== undefined && c.array(step.path, `${path}.path`)) {
            if (step.path.length < 1)
              c.error(ANIM_CODES.required, `${path}.path`, 'A path needs points.');
            step.path.forEach((point, i) => c.vec(point, `${path}.path[${String(i)}]`));
          }
          if (step.speed !== undefined) c.number(step.speed, `${path}.speed`, 1, 100_000);
          if (step.speed !== undefined && step.duration !== undefined)
            c.error(ANIM_CODES.step, path, 'Give either "speed" or "duration", not both.');
          break;
        case 'pose':
          if (step.expression === undefined && step.clip === undefined && step.face === undefined)
            c.error(ANIM_CODES.required, path, 'A pose needs an expression, a clip or a facing.');
          if (step.expression !== undefined && rig && !rig.expressions?.[step.expression as string])
            c.error(
              ANIM_CODES.reference,
              `${path}.expression`,
              `Rig "${rig.id}" has no expression "${String(step.expression)}".`,
            );
          if (
            step.clip !== undefined &&
            c.id(step.clip, `${path}.clip`) &&
            context.clips &&
            !context.clips.has(step.clip)
          )
            c.error(ANIM_CODES.reference, `${path}.clip`, `Unknown clip "${step.clip}".`);
          if (step.face !== undefined && step.face !== 'left' && step.face !== 'right')
            c.error(ANIM_CODES.type, `${path}.face`, 'Expected "left" or "right".');
          break;
        case 'emote':
          if (c.id(step.emote, `${path}.emote`) && rig && !rig.emotes?.[step.emote])
            c.error(
              ANIM_CODES.reference,
              `${path}.emote`,
              `Rig "${rig.id}" has no emote "${step.emote}".`,
            );
          break;
        case 'line':
          if (c.id(step.line, `${path}.line`) && context.lines && !context.lines.has(step.line))
            c.error(
              ANIM_CODES.reference,
              `${path}.line`,
              `Line "${step.line}" has no registered caption.`,
            );
          if (step.advance !== undefined && step.advance !== 'input' && step.advance !== 'auto')
            c.error(ANIM_CODES.type, `${path}.advance`, 'Expected "input" or "auto".');
          break;
        case 'music':
        case 'atmosphere':
          if (step.asset !== null) c.id(step.asset, `${path}.asset`);
          if (step.fade !== undefined) c.number(step.fade, `${path}.fade`, 0, 5);
          break;
        case 'sfx':
          c.id(step.asset, `${path}.asset`);
          if (step.gain !== undefined) c.number(step.gain, `${path}.gain`, 0, 4);
          break;
        case 'effect':
          if (
            c.id(step.effect, `${path}.effect`) &&
            context.effects &&
            !context.effects.has(step.effect)
          )
            c.error(ANIM_CODES.reference, `${path}.effect`, `Unknown effect "${step.effect}".`);
          if (step.at !== undefined) c.vec(step.at, `${path}.at`);
          break;
        case 'transition':
          if (step.type !== 'fade' && step.type !== 'crossfade')
            c.error(ANIM_CODES.type, `${path}.type`, 'Expected "fade" or "crossfade".');
          if (
            step.color !== undefined &&
            (typeof step.color !== 'string' || !COLOR.test(step.color))
          )
            c.error(ANIM_CODES.type, `${path}.color`, 'Expected a #rrggbb colour.');
          break;
        case 'wait':
          if ((step.seconds === undefined) === (step.for === undefined))
            c.error(ANIM_CODES.required, path, 'A wait needs exactly one of "seconds" or "for".');
          if (step.seconds !== undefined) c.number(step.seconds, `${path}.seconds`, 0, 600);
          if (step.for !== undefined && step.for !== 'input')
            c.error(ANIM_CODES.type, `${path}.for`, 'Expected "input".');
          break;
        case 'marker':
          if (c.id(step.id, `${path}.id`)) {
            if (markers.has(step.id))
              c.error(ANIM_CODES.duplicate, `${path}.id`, `Duplicate marker "${step.id}".`);
            markers.add(step.id);
          }
          break;
      }
    });
  }
  return c.result(input);
}

export type AnimationDocument = AtlasFile | RigFile | ClipFile | CueTrackFile | CutsceneFile;

/** Dispatch on `format` with no cross-references. */
export function validateDocument(
  input: unknown,
  source?: string,
): ValidationResult<AnimationDocument> {
  const format = isObject(input) ? input.format : undefined;
  switch (format) {
    case 'aegis-atlas/1':
      return validateAtlas(input, { ...(source ? { source } : {}) });
    case 'aegis-rig/1':
      return validateRig(input, { ...(source ? { source } : {}) });
    case 'aegis-clip/1':
      return validateClip(input, { ...(source ? { source } : {}) });
    case 'aegis-cues/1':
      return validateCueTrack(input, { ...(source ? { source } : {}) });
    case 'aegis-cutscene/1':
      return validateCutscene(input, { ...(source ? { source } : {}) });
    default: {
      const c = new Checker(source);
      c.error(
        isObject(input) ? ANIM_CODES.format : ANIM_CODES.notObject,
        '$.format',
        'Not an animation document (aegis-atlas/1, aegis-rig/1, aegis-clip/1, aegis-cues/1 or aegis-cutscene/1).',
      );
      return c.result(input);
    }
  }
}

export interface AnimationBundle {
  documents: readonly { source: string; value: unknown }[];
  /** Line IDs with captions, e.g. from the consumer's audio packs. */
  lines?: ReadonlySet<string>;
  /** Decoded audio durations by line ID, to detect stale cue tracks. */
  audioDurations?: ReadonlyMap<string, number>;
  cameraPresets?: ReadonlySet<string>;
  effects?: ReadonlySet<string>;
}

/**
 * Validate a set of documents together: atlases first, then rigs against atlases, clips against
 * every rig that has the parts they animate, cue tracks against audio, cutscenes against rigs,
 * clips, lines, presets and effects.
 */
export function validateBundle(bundle: AnimationBundle): {
  ok: boolean;
  diagnostics: AnimationDiagnostic[];
  counts: Record<string, number>;
} {
  const diagnostics: AnimationDiagnostic[] = [];
  const counts: Record<string, number> = {};
  const byFormat = new Map<string, { source: string; value: Json }[]>();
  for (const document of bundle.documents) {
    const format = isObject(document.value) ? String(document.value.format) : 'unknown';
    counts[format] = (counts[format] ?? 0) + 1;
    if (!isObject(document.value) || !String(format).startsWith('aegis-')) {
      diagnostics.push(...validateDocument(document.value, document.source).diagnostics);
      continue;
    }
    const list = byFormat.get(format) ?? [];
    list.push({ source: document.source, value: document.value });
    byFormat.set(format, list);
  }
  const ids = new Map<string, string>();
  const unique = (kind: string, id: unknown, source: string): void => {
    if (typeof id !== 'string') return;
    const key = `${kind}:${id}`;
    const other = ids.get(key);
    if (other)
      diagnostics.push({
        code: ANIM_CODES.duplicate,
        severity: 'error',
        message: `${kind} "${id}" is also defined in ${other}.`,
        path: '$.id',
        source,
      });
    else ids.set(key, source);
  };
  const atlases = new Map<string, AtlasFile>();
  for (const { source, value } of byFormat.get('aegis-atlas/1') ?? []) {
    const result = validateAtlas(value, { source });
    diagnostics.push(...result.diagnostics);
    unique('atlas', value.id, source);
    if (result.value) atlases.set(result.value.id, result.value);
  }
  const rigs = new Map<string, RigFile>();
  for (const { source, value } of byFormat.get('aegis-rig/1') ?? []) {
    const result = validateRig(value, { source, atlases });
    diagnostics.push(...result.diagnostics);
    unique('rig', value.id, source);
    if (result.value) rigs.set(result.value.id, result.value);
  }
  const clips = new Set<string>();
  for (const { source, value } of byFormat.get('aegis-clip/1') ?? []) {
    const result = validateClip(value, { source });
    diagnostics.push(...result.diagnostics);
    unique('clip', value.id, source);
    if (!result.value) continue;
    clips.add(result.value.id);
    const clip = result.value;
    const targets = new Set(clip.tracks.flatMap((track) => (track.part ? [track.part] : [])));
    // A clip is checked in full against each rig that has all its parts (e.g. every species).
    for (const rig of rigs.values())
      if ([...targets].every((part) => rig.parts.some((item) => item.id === part)))
        diagnostics.push(
          ...validateClip(clip, { source: `${source} (rig ${rig.id})`, rig }).diagnostics,
        );
  }
  for (const { source, value } of byFormat.get('aegis-cues/1') ?? []) {
    const line = typeof value.line === 'string' ? value.line : undefined;
    const audioDuration = line ? bundle.audioDurations?.get(line) : undefined;
    diagnostics.push(
      ...validateCueTrack(value, {
        source,
        ...(audioDuration !== undefined ? { audioDuration } : {}),
      }).diagnostics,
    );
    unique('cue track', value.line, source);
    if (bundle.lines && line && !bundle.lines.has(line))
      diagnostics.push({
        code: ANIM_CODES.reference,
        severity: 'warning',
        message: `Cue track for unknown line "${line}".`,
        path: '$.line',
        source,
      });
  }
  for (const { source, value } of byFormat.get('aegis-cutscene/1') ?? []) {
    diagnostics.push(
      ...validateCutscene(value, {
        source,
        rigs,
        clips,
        ...(bundle.lines ? { lines: bundle.lines } : {}),
        ...(bundle.cameraPresets ? { cameraPresets: bundle.cameraPresets } : {}),
        ...(bundle.effects ? { effects: bundle.effects } : {}),
      }).diagnostics,
    );
    unique('cutscene', value.id, source);
  }
  for (const [format, list] of byFormat)
    if (
      ![
        'aegis-atlas/1',
        'aegis-rig/1',
        'aegis-clip/1',
        'aegis-cues/1',
        'aegis-cutscene/1',
      ].includes(format)
    )
      for (const { source, value } of list)
        diagnostics.push(...validateDocument(value, source).diagnostics);
  return { ok: !diagnostics.some((item) => item.severity === 'error'), diagnostics, counts };
}
