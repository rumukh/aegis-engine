/**
 * Component types and instances.
 *
 * A **component** is plain, JSON-serialisable data attached to an entity. Components carry
 * no behaviour — behaviour lives in systems. A {@link ComponentType} is the registered
 * descriptor for one component: a stable string `id`, a default-producing factory, and a
 * clone used for snapshotting. Every component's data must be a plain tree of
 * `number | string | boolean | null | array | object` so it serialises deterministically.
 *
 * `ComponentType` is **callable**: calling it produces a {@link ComponentInstance} you can
 * pass to {@link World.spawn}. This reads fluently for agents:
 *
 * ```ts
 * const e = world.spawn(Transform({ position: { x: 4, y: 0, z: 0 } }), Player());
 * const t = world.get(e, Transform); // TransformData, fully typed
 * ```
 * @packageDocumentation
 */
import { deepClone } from './clone.js';

/** A component value paired with its type, ready to attach to an entity. */
export interface ComponentInstance<T = unknown> {
  readonly type: ComponentType<T>;
  readonly value: T;
}

/**
 * Registered descriptor for a component. Callable to build an instance.
 * @typeParam T - The component's data shape (must be plain, serialisable data).
 */
export interface ComponentType<T> {
  /** Build an instance, merging `init` over the defaults. */
  (init?: Partial<T>): ComponentInstance<T>;
  /** Stable, human-readable id used in queries and serialisation, e.g. `"Transform"`. */
  readonly id: string;
  /** Produce a fresh default value. */
  create(init?: Partial<T>): T;
  /** Deep-clone a value (used when snapshotting / restoring). */
  clone(value: T): T;
}

/** Definition passed to {@link defineComponent}. */
export interface ComponentDefinition<T extends object> {
  /** Stable, unique id. Convention: PascalCase. */
  id: string;
  /** Produce a fresh default value. Called with no arguments. */
  defaults: () => T;
  /**
   * Optional custom deep-clone. Defaults to a structural clone, which is correct for any
   * plain-data component; override only for performance.
   */
  clone?: (value: T) => T;
}

/**
 * Register a component type.
 *
 * This is the one piece of registration infrastructure `@aegis/core` implements outright:
 * downstream packages must be able to *declare* component types at module load. It carries
 * no gameplay behaviour. `create` applies a shallow *merge* of `init` over the defaults —
 * a nested object is replaced wholesale rather than deep-merged — and then deep-copies the
 * result so no caller-owned object is ever aliased into world state. `clone` defaults to a
 * **structural** deep copy that preserves `NaN`, `±Infinity` and `-0` exactly, and is the
 * single cloning path used by both `create` and snapshotting.
 *
 * It used to default to a JSON round-trip. That is lossy: `JSON.stringify` maps every
 * non-finite number to `null`, so a component built with a `NaN` in it was silently corrected
 * to `null` on the way into the world — the state hash could never see the NaN that broke the
 * sim, which is the exact failure the hash exists to catch. Non-plain data (a `Date`, a `Map`,
 * a class instance) is now rejected outright rather than canonicalised to `{}`.
 *
 * @typeParam T - The component's data shape.
 * @param def - Id, defaults factory and optional clone.
 * @returns A callable {@link ComponentType}.
 */
export function defineComponent<T extends object>(def: ComponentDefinition<T>): ComponentType<T> {
  const clone = def.clone ?? ((value: T): T => deepClone(value));
  const create = (init?: Partial<T>): T => {
    // Merge `init` over defaults, then deep-copy the result through `clone` so no
    // caller-owned nested object is ever retained by reference in world state. The spread
    // alone is shallow: two instances built from one literal would alias the same nested
    // objects, and the simulation would mutate the caller's data in place. Correctness over
    // the extra copy — deterministic, owned state is this engine's whole point.
    const base = def.defaults();
    const merged = init ? { ...base, ...init } : base;
    return clone(merged as T);
  };
  const type = ((init?: Partial<T>): ComponentInstance<T> => ({
    type,
    value: create(init),
  })) as ComponentType<T>;
  const mut = type as { id: string; create: typeof create; clone: typeof clone };
  mut.id = def.id;
  mut.create = create;
  mut.clone = clone;
  return type;
}

/** A component with no data — used purely as a queryable marker (e.g. `Player`). */
export type Tag = Record<string, never>;

/** Register a zero-data marker component. */
export function defineTag(id: string): ComponentType<Tag> {
  return defineComponent<Tag>({ id, defaults: () => ({}) });
}

/**
 * A **resource** is a singleton value stored on the world, not attached to any entity
 * (e.g. the active camera id, gravity, the current level name). Same serialisation rules
 * as components.
 */
export interface ResourceType<T> {
  readonly id: string;
  create(): T;
}

/** Register a resource type. */
export function defineResource<T>(id: string, defaults: () => T): ResourceType<T> {
  return { id, create: defaults };
}
