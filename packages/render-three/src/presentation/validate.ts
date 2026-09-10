import type { Diagnostic, Validated } from '@aegis/core';
import { ROLE_COLORS } from '../appearance.js';
import { isAssetPath, renderDiagnostic, RenderCode } from './diagnostics.js';
import { PRESENTATION_LIMITS } from './schema.js';
import type { PresentationManifest } from './schema.js';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** Validate presentation data without a filesystem, browser, GPU, or simulation. */
export function validatePresentation(
  input: unknown,
  sourceFile?: string,
): Validated<PresentationManifest> {
  const diagnostics: Diagnostic[] = [];
  const fail = (path: string, message: string, code: string = RenderCode.Shape): void => {
    diagnostics.push(
      renderDiagnostic(
        code,
        path,
        message,
        'Correct the named presentation field or reference.',
        sourceFile,
      ),
    );
  };
  const record = (value: unknown, path: string, keys: readonly string[]): RecordValue => {
    if (!object(value)) {
      fail(path, 'Expected an object.');
      return {};
    }
    for (const key of Object.keys(value))
      if (!keys.includes(key)) fail(`${path}.${key}`, `Unknown field "${key}".`);
    return value;
  };
  const text = (value: unknown, path: string, pattern?: RegExp): value is string => {
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      (pattern !== undefined && !pattern.test(value))
    ) {
      fail(path, 'Expected a nonempty string in the documented format.');
      return false;
    }
    return true;
  };
  const number = (
    value: unknown,
    path: string,
    min = -Infinity,
    max = Infinity,
  ): value is number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      fail(path, `Expected a finite number in [${min}, ${max}].`);
      return false;
    }
    return true;
  };
  const optional = (
    r: RecordValue,
    key: string,
    path: string,
    check: (v: unknown, p: string) => unknown,
  ): void => {
    if (r[key] !== undefined) check(r[key], `${path}.${key}`);
  };
  const enumeration = (v: unknown, p: string, values: readonly string[]): void => {
    if (typeof v !== 'string' || !values.includes(v))
      fail(p, `Expected one of ${values.join(', ')}.`);
  };
  const list = (v: unknown, p: string, max = Infinity): unknown[] => {
    if (!Array.isArray(v)) {
      fail(p, 'Expected an array.');
      return [];
    }
    if (v.length > max)
      fail(p, `The limit is ${max} entries; received ${v.length}.`, RenderCode.Budget);
    return v;
  };
  const vector = (v: unknown, p: string, size = 3): void => {
    const values = list(v, p);
    if (values.length !== size) fail(p, `Expected ${size} coordinates.`);
    values.forEach((n, i) => number(n, `${p}[${i}]`));
  };
  const color = (v: unknown, p: string): void => {
    text(v, p, COLOR);
  };
  const unit = (v: unknown, p: string): void => {
    number(v, p, 0, 1);
  };
  const nonnegative = (v: unknown, p: string): void => {
    number(v, p, 0);
  };
  const positive = (v: unknown, p: string): void => {
    number(v, p, Number.MIN_VALUE);
  };
  const bool = (v: unknown, p: string): void => {
    if (typeof v !== 'boolean') fail(p, 'Expected a boolean.');
  };
  const named = (v: unknown, p: string): void => {
    text(v, p, ID);
  };
  const root = record(input, 'presentation', [
    'aegis',
    'assets',
    'materials',
    'surfaces',
    'entities',
    'objects',
    'effects',
    'environment',
    'audio',
    'hud',
    'camera',
    'ui',
    'quality',
    'legacy',
  ]);
  enumeration(root.aegis, 'aegis', ['presentation/1']);
  optional(root, 'quality', 'presentation', (v, p) => enumeration(v, p, ['low', 'standard']));
  if (root.camera !== undefined) {
    const camera = record(root.camera, 'camera', ['framing', 'padding']);
    enumeration(camera.framing, 'camera.framing', ['follow', 'level']);
    optional(camera, 'padding', 'camera', nonnegative);
  }
  const assets = new Map<string, RecordValue>();
  const materials = new Set<string>();
  const objects = new Set<string>();
  const unique = (id: unknown, p: string, ids: Set<string>): void => {
    if (!text(id, p, ID)) return;
    if (ids.has(id)) fail(p, `Duplicate id "${id}".`, RenderCode.Reference);
    ids.add(id);
  };
  const assetIds = new Set<string>();
  for (const [i, value] of list(
    root.assets ?? [],
    'assets',
    PRESENTATION_LIMITS.assets,
  ).entries()) {
    const p = `assets[${i}]`;
    const a = record(value, p, [
      'id',
      'src',
      'kind',
      'provenance',
      'colorSpace',
      'filter',
      'frames',
    ]);
    unique(a.id, `${p}.id`, assetIds);
    enumeration(a.kind, `${p}.kind`, ['texture', 'gltf', 'audio']);
    if (text(a.src, `${p}.src`) && !isAssetPath(a.src))
      fail(
        `${p}.src`,
        'Use a relative local asset path without traversal, encoding, query, or fragment.',
        RenderCode.Path,
      );
    const provenance = record(a.provenance, `${p}.provenance`, ['author', 'license', 'source']);
    for (const field of ['author', 'license', 'source'])
      text(provenance[field], `${p}.provenance.${field}`);
    if (
      a.kind !== 'texture' &&
      ['colorSpace', 'filter', 'frames'].some((key) => a[key] !== undefined)
    )
      fail(p, 'Only texture assets may specify sampling or atlas frames.');
    optional(a, 'colorSpace', p, (v, at) => enumeration(v, at, ['srgb', 'linear']));
    optional(a, 'filter', p, (v, at) => enumeration(v, at, ['linear', 'nearest']));
    if (a.frames !== undefined) {
      if (!object(a.frames)) fail(`${p}.frames`, 'Expected named atlas rectangles.');
      else
        for (const [frame, rect] of Object.entries(a.frames)) {
          named(frame, `${p}.frames.${frame}`);
          vector(rect, `${p}.frames.${frame}`, 4);
          if (Array.isArray(rect) && rect.length === 4) {
            rect.forEach((n, index) => unit(n, `${p}.frames.${frame}[${index}]`));
            if (
              typeof rect[0] === 'number' &&
              typeof rect[1] === 'number' &&
              typeof rect[2] === 'number' &&
              typeof rect[3] === 'number' &&
              (rect[2] <= rect[0] || rect[3] <= rect[1])
            )
              fail(`${p}.frames.${frame}`, 'Atlas rectangles need positive width and height.');
          }
        }
    }
    if (typeof a.id === 'string') assets.set(a.id, a);
  }
  const asset = (v: unknown, p: string, kind: string): void => {
    if (!text(v, p)) return;
    if (assets.get(v)?.kind !== kind)
      fail(
        p,
        `Expected a declared ${kind} asset; "${v}" does not resolve to one.`,
        RenderCode.Reference,
      );
  };
  const material = (v: unknown, p: string): void => {
    if (text(v, p) && !materials.has(v)) fail(p, `Unknown material "${v}".`, RenderCode.Reference);
  };
  for (const [i, value] of list(root.materials ?? [], 'materials', 256).entries()) {
    const p = `materials[${i}]`;
    const m = record(value, p, [
      'id',
      'shading',
      'color',
      'map',
      'normalMap',
      'emissive',
      'emissiveIntensity',
      'roughness',
      'metalness',
      'opacity',
      'alphaTest',
      'doubleSided',
      'repeat',
    ]);
    unique(m.id, `${p}.id`, materials);
    enumeration(m.shading, `${p}.shading`, ['standard', 'unlit']);
    for (const k of ['color', 'emissive']) optional(m, k, p, color);
    for (const k of ['roughness', 'metalness', 'opacity', 'alphaTest']) optional(m, k, p, unit);
    optional(m, 'emissiveIntensity', p, nonnegative);
    optional(m, 'doubleSided', p, bool);
    for (const k of ['map', 'normalMap']) optional(m, k, p, (v, at) => asset(v, at, 'texture'));
    if (
      m.shading === 'unlit' &&
      ['normalMap', 'roughness', 'metalness', 'emissive', 'emissiveIntensity'].some(
        (k) => m[k] !== undefined,
      )
    )
      fail(p, 'Lighting fields require a standard material.');
    if (m.repeat !== undefined) {
      vector(m.repeat, `${p}.repeat`, 2);
      if (Array.isArray(m.repeat)) m.repeat.forEach((n, j) => positive(n, `${p}.repeat[${j}]`));
    }
  }
  const visual = (v: unknown, p: string): void => {
    const r = record(v, p, [
      'kind',
      'shape',
      'material',
      'texture',
      'frame',
      'mesh',
      'clip',
      'animations',
    ]);
    enumeration(r.kind, `${p}.kind`, ['primitive', 'sprite', 'model']);
    optional(r, 'material', p, material);
    if (r.kind === 'primitive') enumeration(r.shape, `${p}.shape`, ['box', 'plane']);
    if (r.kind === 'sprite') {
      asset(r.texture, `${p}.texture`, 'texture');
      const atlasFrame = (frame: unknown, at: string): void => {
        if (!text(frame, at)) return;
        const frames = typeof r.texture === 'string' ? assets.get(r.texture)?.frames : undefined;
        if (!object(frames) || !Object.hasOwn(frames, frame))
          fail(at, `Unknown atlas frame "${frame}".`, RenderCode.Reference);
      };
      optional(r, 'frame', p, atlasFrame);
      if (r.animations !== undefined) {
        const animations = record(r.animations, `${p}.animations`, [
          'idle',
          'move',
          'rise',
          'fall',
          'dead',
        ]);
        for (const [state, value] of Object.entries(animations)) {
          const at = `${p}.animations.${state}`;
          const sequence = record(value, at, ['frames', 'frameTicks']);
          const frames = list(sequence.frames, `${at}.frames`, 256);
          if (frames.length === 0) fail(`${at}.frames`, 'An animation needs at least one frame.');
          frames.forEach((frame, i) => atlasFrame(frame, `${at}.frames[${i}]`));
          positive(sequence.frameTicks, `${at}.frameTicks`);
        }
      }
    }
    if (r.kind === 'model') {
      asset(r.mesh, `${p}.mesh`, 'gltf');
      optional(r, 'clip', p, text);
      if (r.animations !== undefined) {
        const animations = record(r.animations, `${p}.animations`, [
          'idle',
          'move',
          'rise',
          'fall',
          'dead',
        ]);
        for (const [state, clip] of Object.entries(animations))
          text(clip, `${p}.animations.${state}`);
      }
    }
    const own =
      r.kind === 'primitive'
        ? ['shape']
        : r.kind === 'sprite'
          ? ['texture', 'frame', 'animations']
          : ['mesh', 'clip', 'animations'];
    for (const k of ['shape', 'texture', 'frame', 'mesh', 'clip', 'animations'])
      if (!own.includes(k) && r[k] !== undefined)
        fail(`${p}.${k}`, `Field does not apply to ${String(r.kind)}.`);
  };
  if (root.surfaces !== undefined) {
    const surfaces = record(root.surfaces, 'surfaces', Object.keys(ROLE_COLORS));
    for (const [role, id] of Object.entries(surfaces)) material(id, `surfaces.${role}`);
  }
  const pose = (v: unknown, p: string): void => {
    const r = record(v, p, ['position', 'rotation', 'scale']);
    for (const k of ['position', 'rotation', 'scale']) optional(r, k, p, vector);
    if (Array.isArray(r.scale)) r.scale.forEach((n, i) => positive(n, `${p}.scale[${i}]`));
  };
  const selectors = new Set<string>();
  for (const [i, value] of list(root.entities ?? [], 'entities', 256).entries()) {
    const p = `entities[${i}]`;
    const r = record(value, p, ['target', 'visual', 'pose', 'fit']);
    const t = record(r.target, `${p}.target`, ['name', 'role']);
    if ((t.name === undefined) === (t.role === undefined))
      fail(`${p}.target`, 'Specify exactly one name or role.');
    optional(t, 'name', `${p}.target`, text);
    optional(t, 'role', `${p}.target`, (v, at) => enumeration(v, at, Object.keys(ROLE_COLORS)));
    const key = JSON.stringify(t);
    if (selectors.has(key)) fail(`${p}.target`, 'Duplicate entity selector.', RenderCode.Reference);
    selectors.add(key);
    visual(r.visual, `${p}.visual`);
    optional(r, 'pose', p, pose);
    optional(r, 'fit', p, (v, at) => enumeration(v, at, ['bounds', 'authored']));
  }
  let instanceCount = 0;
  for (const [i, value] of list(
    root.objects ?? [],
    'objects',
    PRESENTATION_LIMITS.objects,
  ).entries()) {
    const p = `objects[${i}]`;
    const r = record(value, p, [
      'id',
      'visual',
      'anchor',
      'pose',
      'parallax',
      'motion',
      'instances',
    ]);
    unique(r.id, `${p}.id`, objects);
    visual(r.visual, `${p}.visual`);
    optional(r, 'pose', p, pose);
    optional(r, 'parallax', p, unit);
    if (object(r.anchor))
      text(record(r.anchor, `${p}.anchor`, ['entity']).entity, `${p}.anchor.entity`);
    else optional(r, 'anchor', p, (v, at) => enumeration(v, at, ['world', 'camera']));
    if (r.motion !== undefined) {
      const m = record(r.motion, `${p}.motion`, ['kind', 'axis', 'amplitude', 'periodTicks']);
      enumeration(m.kind, `${p}.motion.kind`, ['bob', 'spin', 'pulse']);
      enumeration(m.axis, `${p}.motion.axis`, ['x', 'y', 'z']);
      nonnegative(m.amplitude, `${p}.motion.amplitude`);
      positive(m.periodTicks, `${p}.motion.periodTicks`);
    }
    if (r.instances !== undefined) {
      const instances = list(r.instances, `${p}.instances`, PRESENTATION_LIMITS.instances);
      instanceCount += instances.length;
      instances.forEach((v, j) => pose(v, `${p}.instances[${j}]`));
      if (
        r.motion !== undefined ||
        (r.anchor !== undefined && r.anchor !== 'world') ||
        r.parallax !== undefined
      )
        fail(p, 'Instanced objects are static and world-anchored.');
      if (object(r.visual) && r.visual.clip !== undefined)
        fail(`${p}.visual.clip`, 'Instanced models cannot play a clip.');
    }
  }
  if (instanceCount > PRESENTATION_LIMITS.instances)
    fail('objects', 'Total static instances exceed 4096.', RenderCode.Budget);
  for (const [i, value] of list(root.effects ?? [], 'effects', 128).entries()) {
    const p = `effects[${i}]`;
    const r = record(value, p, [
      'event',
      'kind',
      'target',
      'durationTicks',
      'color',
      'count',
      'amount',
      'clip',
      'holdLast',
      'frames',
      'frameTicks',
    ]);
    text(r.event, `${p}.event`);
    enumeration(r.kind, `${p}.kind`, ['burst', 'pulse', 'recoil', 'clip', 'frames']);
    const t = record(r.target, `${p}.target`, ['entity', 'object', 'node']);
    if ((t.entity === undefined) === (t.object === undefined))
      fail(`${p}.target`, 'Specify exactly one entity or object.');
    optional(t, 'entity', `${p}.target`, text);
    optional(t, 'node', `${p}.target`, text);
    optional(t, 'object', `${p}.target`, (v, at) => {
      if (text(v, at) && !objects.has(v))
        fail(at, `Unknown presentation object "${v}".`, RenderCode.Reference);
    });
    if (r.kind === 'recoil' && t.object === undefined)
      fail(p, 'Recoil must target a presentation object, never gameplay pose.');
    positive(r.durationTicks, `${p}.durationTicks`);
    optional(r, 'color', p, color);
    optional(r, 'amount', p, nonnegative);
    if (r.kind === 'clip') {
      text(r.clip, `${p}.clip`);
    } else if (r.clip !== undefined) {
      fail(p, 'Clip fields require a clip effect.');
    }
    if (r.kind === 'frames') {
      const frames = list(r.frames, `${p}.frames`, 256);
      if (frames.length === 0) fail(`${p}.frames`, 'An effect needs at least one frame.');
      frames.forEach((v, i) => text(v, `${p}.frames[${i}]`));
      positive(r.frameTicks, `${p}.frameTicks`);
    } else if (r.frames !== undefined || r.frameTicks !== undefined) {
      fail(p, 'Frame fields require a frames effect.');
    }
    if (r.kind === 'clip' || r.kind === 'frames') optional(r, 'holdLast', p, bool);
    else if (r.holdLast !== undefined) fail(p, 'holdLast requires a clip or frames effect.');
    optional(r, 'count', p, (v, at) => {
      if (number(v, at, 1, 128) && !Number.isInteger(v)) fail(at, 'Count must be an integer.');
    });
  }
  if (root.environment !== undefined) {
    const p = 'environment';
    const r = record(root.environment, p, [
      'background',
      'ambient',
      'directional',
      'points',
      'fog',
    ]);
    optional(r, 'background', p, color);
    const light = (v: unknown, at: string, kind: string): void => {
      const l = record(v, at, [
        'color',
        'intensity',
        ...(kind !== 'ambient' ? ['position'] : []),
        ...(kind === 'point' ? ['distance'] : []),
      ]);
      color(l.color, `${at}.color`);
      nonnegative(l.intensity, `${at}.intensity`);
      if (kind !== 'ambient') vector(l.position, `${at}.position`);
      if (kind === 'point') positive(l.distance, `${at}.distance`);
    };
    optional(r, 'ambient', p, (v, at) => light(v, at, 'ambient'));
    optional(r, 'directional', p, (v, at) => light(v, at, 'directional'));
    if (r.points !== undefined)
      list(r.points, `${p}.points`, 8).forEach((v, i) => light(v, `${p}.points[${i}]`, 'point'));
    if (r.fog !== undefined) {
      const f = record(r.fog, `${p}.fog`, ['color', 'near', 'far']);
      color(f.color, `${p}.fog.color`);
      nonnegative(f.near, `${p}.fog.near`);
      positive(f.far, `${p}.fog.far`);
      if (typeof f.near === 'number' && typeof f.far === 'number' && f.near >= f.far)
        fail(`${p}.fog`, 'Fog far must exceed near.');
    }
  }
  if (root.audio !== undefined) {
    const r = record(root.audio, 'audio', ['volume', 'ambient', 'cues']);
    optional(r, 'volume', 'audio', unit);
    const cue = (v: unknown, p: string, ambient: boolean): void => {
      const c = record(
        v,
        p,
        ambient ? ['asset', 'volume'] : ['event', 'asset', 'volume', 'cooldownTicks'],
      );
      asset(c.asset, `${p}.asset`, 'audio');
      optional(c, 'volume', p, unit);
      if (!ambient) {
        text(c.event, `${p}.event`);
        optional(c, 'cooldownTicks', p, nonnegative);
      }
    };
    optional(r, 'ambient', 'audio', (v, p) => cue(v, p, true));
    if (r.cues !== undefined)
      list(r.cues, 'audio.cues', 128).forEach((v, i) => cue(v, `audio.cues[${i}]`, false));
  }
  if (root.hud !== undefined) {
    const r = record(root.hud, 'hud', ['playerName', 'winEvent', 'loseEvents', 'steps']);
    text(r.playerName, 'hud.playerName');
    text(r.winEvent, 'hud.winEvent');
    list(r.loseEvents, 'hud.loseEvents', 32).forEach((v, i) => text(v, `hud.loseEvents[${i}]`));
    const ids = new Set<string>();
    if (r.steps !== undefined)
      list(r.steps, 'hud.steps', 32).forEach((v, i) => {
        const p = `hud.steps[${i}]`;
        const s = record(v, p, ['id', 'label', 'event']);
        unique(s.id, `${p}.id`, ids);
        text(s.label, `${p}.label`);
        text(s.event, `${p}.event`);
      });
  }
  if (root.ui !== undefined) {
    const r = record(root.ui, 'ui', ['accent', 'eyebrow', 'cover']);
    optional(r, 'accent', 'ui', color);
    optional(r, 'eyebrow', 'ui', text);
    optional(r, 'cover', 'ui', (v, p) => asset(v, p, 'texture'));
  }
  if (root.legacy !== undefined) {
    const r = record(root.legacy, 'legacy', ['level', 'triggers']);
    optional(r, 'level', 'legacy', bool);
    optional(r, 'triggers', 'legacy', bool);
    if (
      (r.level === false || r.triggers === false) &&
      list(root.objects ?? [], 'objects').length === 0
    )
      fail(
        'legacy',
        'Hiding legacy level/trigger geometry requires declared replacement objects.',
        RenderCode.Reference,
      );
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: input as PresentationManifest, diagnostics };
}
