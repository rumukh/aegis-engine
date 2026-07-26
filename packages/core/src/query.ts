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
  /** The entity handle. */
  readonly entity: Entity;
  /** Get a component's value by type (typed) — throws if absent. */
  get<T>(type: ComponentType<T>): T;
  /** Get a component's value by string id — throws if absent. */
  get<T = unknown>(id: string): T;
  /** Get a component's value, or `undefined` if absent. */
  tryGet<T>(type: ComponentType<T>): T | undefined;
  /** Whether this entity has the referenced component. */
  has(ref: ComponentRef): boolean;
}

/** The lazily-evaluated result of a query. Iterable and reducible. */
export interface QueryResult extends Iterable<EntityView> {
  /** Number of matches. */
  count(): number;
  /** All matched entity handles, in deterministic order. */
  entities(): readonly Entity[];
  /** All matched views, in deterministic order. */
  views(): readonly EntityView[];
  /** First match, or `undefined` if none. */
  first(): EntityView | undefined;
  /** Exactly one match — throws if zero or more than one. Ideal for singletons. */
  one(): EntityView;
  /** Visit each match in order. */
  forEach(fn: (view: EntityView, i: number) => void): void;
}
