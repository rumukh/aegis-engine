/**
 * The query API (CHARTER principle 4: "the world is inspectable as data").
 *
 * A query selects entities by the components they carry and yields lightweight
 * {@link EntityView} rows for reading typed component data. Component references may be a
 * {@link ComponentType} (type-safe) or a string id (matches the charter's
 * `world.query({ has: ['Player'] })` form).
 *
 * Iteration order is deterministic: entities are visited in ascending slot-index order,
 * independent of insertion history, so two runs that reach the same world state iterate
 * identically.
 *
 * ## Rows are handles, not slots
 *
 * A {@link QueryResult} fixes its matched **entity handles** when `query()` runs, and
 * re-checks each handle's generation before yielding it. Despawning and respawning inside a
 * system loop is idiomatic, and the free list is LIFO — so if a result held raw slot indices,
 * a pending row would resolve to whatever entity next took the slot. It does not: a row whose
 * entity died between the query and its use simply **disappears** from the result, and an
 * {@link EntityView} kept past its entity's despawn reports the component as absent rather
 * than returning another entity's data.
 *
 * The practical consequence is that `count()` and `entities()` describe the world *now*, not
 * at query time: after despawning a match, the result shrinks.
 * @packageDocumentation
 */
import type { ComponentType } from './component.js';
import type { Entity } from './entity.js';

/** A component reference: either the type descriptor or its stable string id. */
export type ComponentRef = ComponentType<unknown> | string;

/** Selection criteria. All clauses are ANDed together. */
export interface QueryDescriptor {
  /** Entity must have **every** listed component. */
  has?: readonly ComponentRef[];
  /** Entity must have **at least one** listed component. */
  any?: readonly ComponentRef[];
  /** Entity must have **none** of the listed components. */
  none?: readonly ComponentRef[];
}

/** A read view over one matched entity. */
export interface EntityView {
  /**
   * The entity handle this row was created for. Stable — it never re-resolves to a different
   * entity, even after the slot is recycled.
   */
  readonly entity: Entity;
  /** Get a component's value by type (typed) — throws if absent or if the row is stale. */
  get<T>(type: ComponentType<T>): T;
  /** Get a component's value by string id — throws if absent or if the row is stale. */
  get<T = unknown>(id: string): T;
  /** Get a component's value, or `undefined` if absent or the entity has been despawned. */
  tryGet<T>(type: ComponentType<T>): T | undefined;
  /** Whether this entity is still alive and has the referenced component. */
  has(ref: ComponentRef): boolean;
}

/**
 * The result of a query: the entities that matched, as generation-checked handles.
 *
 * Every accessor filters out entities that have since been despawned, so a result can never
 * report a dead entity or a live impostor occupying its recycled slot.
 */
export interface QueryResult extends Iterable<EntityView> {
  /** Number of matches still alive. */
  count(): number;
  /** Matched entity handles still alive, in deterministic order. */
  entities(): readonly Entity[];
  /** Matched views still alive, in deterministic order. */
  views(): readonly EntityView[];
  /** First live match, or `undefined` if none. */
  first(): EntityView | undefined;
  /** Exactly one live match — throws if zero or more than one. Ideal for singletons. */
  one(): EntityView;
  /** Visit each live match in order. */
  forEach(fn: (view: EntityView, i: number) => void): void;
}
