import { Name, Transform } from '@aegis/core';
import type { EntityView, GameMode, World } from '@aegis/core';
import type { StateCondition, StateField, PresentationManifest, Vec3 } from './schema.js';
import { visualError } from './runtime-visuals.js';
import { renderPosition } from './runtime-lights.js';

export function readDataPath(value: unknown, path: string): unknown {
  for (const key of path.split('.')) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      typeof value !== 'object' ||
      value === null ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function readStateField(
  view: EntityView | undefined,
  field: StateField,
): boolean | number | string {
  const value =
    view?.has(field.component) === true
      ? readDataPath(view.get(field.component), field.field)
      : undefined;
  if (
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  throw visualError(
    `${field.entity}.${field.component}.${field.field}`,
    'Presentation state binding does not resolve to a finite scalar.',
    'Initialize the named entity, component and scalar field before mounting presentation.',
  );
}

export function stateFields(manifest: PresentationManifest): StateField[] {
  return [
    ...(manifest.objects ?? []).flatMap((v) =>
      v.visibleWhen === undefined ? [] : [v.visibleWhen],
    ),
    ...(manifest.environment?.spots ?? []).flatMap((v) =>
      v.enabledWhen === undefined ? [] : [v.enabledWhen],
    ),
    ...(manifest.audio?.layers ?? []).flatMap((v) =>
      v.enabledWhen === undefined ? [] : [v.enabledWhen],
    ),
    ...Object.values(manifest.hud?.bindings ?? {}),
    ...[...(manifest.entities ?? []), ...(manifest.objects ?? [])].flatMap((entry) =>
      entry.visual.kind === 'model' ? (entry.visual.stateClips ?? []).map((clip) => clip.when) : [],
    ),
  ];
}

export function spatialEntities(manifest: PresentationManifest): string[] {
  return [
    ...(manifest.environment?.spots ?? []).flatMap((v) =>
      typeof v.anchor === 'object' ? [v.anchor.entity] : [],
    ),
    ...[...(manifest.audio?.layers ?? []), ...(manifest.audio?.cues ?? [])].flatMap((v) =>
      v.spatial !== undefined && 'entity' in v.spatial.target ? [v.spatial.target.entity] : [],
    ),
  ];
}

/** Retains only read handles into the renderer's mirror, never copies or mutates gameplay. */
export class PresentationState {
  readonly #names = new Map<string, EntityView>();
  constructor(readonly mode: GameMode) {}

  sync(world: World): void {
    this.#names.clear();
    for (const view of world.query({ has: [Name] }).views())
      this.#names.set(view.get(Name).value, view);
  }

  read(field: StateField): boolean | number | string {
    return readStateField(this.#names.get(field.entity), field);
  }

  matches(condition: StateCondition): boolean {
    const value = this.read(condition);
    if (typeof value !== typeof condition.equals)
      throw visualError(
        `${condition.entity}.${condition.component}.${condition.field}`,
        'Presentation equality compares different scalar types.',
        'Use an equals value with the same type as the initialized field.',
      );
    return value === condition.equals;
  }

  position(name: string): Vec3 {
    const transform = this.#names.get(name)?.tryGet(Transform);
    if (transform === undefined)
      throw visualError(
        name,
        'Spatial presentation target has no Transform.',
        'Initialize a named Transform entity before mounting spatial presentation.',
      );
    const at = renderPosition(this.mode, transform.position);
    return [at.x, at.y, at.z];
  }

  validate(manifest: PresentationManifest): void {
    for (const field of stateFields(manifest)) {
      if ('equals' in field) this.matches(field as StateCondition);
      else this.read(field);
    }
    for (const name of spatialEntities(manifest)) this.position(name);
  }
}
