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
import { assertFinite, deepClone, deepCloneSerialisable, NonFiniteValueError } from './clone.js';
import { CoreDiagnosticCode } from './codes.js';
import { DiagnosticError } from './diagnostics.js';

/**
 * Build the structured rejection raised when a non-finite value is written into a component.
 *
 * Rejecting here rather than at `snapshot()` is the whole point of the write boundary: the
 * error fires at the code that produced the `NaN`, not several ticks later at the hash.
 */
export function nonFiniteAtWrite(
  componentId: string,
  err: NonFiniteValueError,
  entity?: string,
): DiagnosticError {
  const where =
    entity === undefined
      ? `${componentId}${err.path === '' ? '' : `.${err.path}`}`
      : `entities[${entity}].components.${componentId}${err.path === '' ? '' : `.${err.path}`}`;
  return new DiagnosticError([
    {
      code: CoreDiagnosticCode.NonFiniteState,
      severity: 'error',
      message:
        `Cannot write a non-finite number (${String(err.value)}) to ${where}. World state must ` +
        `serialise to JSON (CHARTER principle 4), and JSON has no representation for ` +
        `NaN or ±Infinity — it would be silently written out as null.`,
      location: { path: where },
      fix:
        `Guard the computation that produced ${String(err.value)} — a divide-by-zero, a sqrt of ` +
        `a negative, an uninitialised accumulator, or an out-of-domain angle. Clamp the input, ` +
        `or use a sentinel the format can hold (null, or a finite bound).`,
      data: {
        entity: entity ?? null,
        component: componentId,
        path: where,
        value: String(err.value),
      },
    },
  ]);
}

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
  /**
   * Deep-clone a value, used by {@link ComponentType.create}.
   *
   * This is **not** what guarantees the world is serialisable. `World.snapshot` clones the
   * stored value with core's own checked clone and never calls this, precisely so a component
   * supplying a lossy `clone` cannot opt out of the non-finite guard.
   */
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
   *
   * A custom clone **must** be structural: it must not alias the source, and it must not
   * silently alter values — in particular it must not be a `JSON.parse(JSON.stringify(…))`
   * round trip, which maps `NaN` and `±Infinity` to `null`. Supplying a lossy clone corrupts
   * your own component's data on the way into the world; it cannot, however, defeat the
   * engine's serialisation guarantee, because `World.snapshot` does not use it.
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
  const custom = def.clone;
  const clone = custom ?? ((value: T): T => deepClone(value));
  const create = (init?: Partial<T>): T => {
    // Merge `init` over defaults, then deep-copy the result so no caller-owned nested object
    // is ever retained by reference in world state. The spread alone is shallow: two instances
    // built from one literal would alias the same nested objects, and the simulation would
    // mutate the caller's data in place. Correctness over the extra copy — deterministic,
    // owned state is this engine's whole point.
    const base = def.defaults();
    const merged = (init ? { ...base, ...init } : base) as T;
    try {
      if (custom === undefined) {
        // Clone and check in one pass.
        return deepCloneSerialisable(merged);
      }
      // Check the *input* before handing it to a caller-supplied clone, so a lossy clone
      // cannot hide a non-finite value by flattening it to `null` on the way past.
      assertFinite(merged);
      return custom(merged);
    } catch (err) {
      if (err instanceof NonFiniteValueError) throw nonFiniteAtWrite(def.id, err);
      throw err;
    }
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
