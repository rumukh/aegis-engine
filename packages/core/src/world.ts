/**
 * The {@link World}: the entire simulation state as inspectable data.
 *
 * A world owns entities, their components, singleton resources, the event bus and the PRNG.
 * It is a pure data container with a query surface — it does not advance time; that is the
 * {@link "./scheduler".Simulation}'s job. Everything a world holds serialises to a
 * {@link WorldSnapshot} and restores from one exactly, which is what makes save/replay and
 * cross-machine hashing possible.
 * @packageDocumentation
 */
import { notImplemented } from './util.js';
import type { ComponentInstance, ComponentType, ResourceType } from './component.js';
import type { Entity } from './entity.js';
import type { EventBus } from './events.js';
import type { Prng } from './prng.js';
import type { QueryDescriptor, QueryResult } from './query.js';
import type { StateHash } from './hash.js';
import type { WorldSnapshot } from './serialize.js';

/** The mutable simulation state. */
export interface World {
  /** The tick this world's state currently represents. */
  readonly tick: number;
  /** The deterministic random stream bound to this world. */
  readonly random: Prng;
  /** The event bus for this world. */
  readonly events: EventBus;

  // --- entity lifecycle ---

  /** Spawn a new entity carrying the given component instances. */
  spawn(...components: ComponentInstance[]): Entity;
  /** Despawn an entity and all its components. No-op if already dead. */
  despawn(entity: Entity): void;
  /** Whether `entity` refers to a currently-live slot (generation-checked). */
  isAlive(entity: Entity): boolean;
  /** Number of live entities. */
  readonly entityCount: number;

  // --- components ---

  /** Attach or replace a component on an entity. */
  add<T>(entity: Entity, type: ComponentType<T>, value?: Partial<T>): void;
  /** Get a component value, or `undefined` if the entity lacks it. */
  get<T>(entity: Entity, type: ComponentType<T>): T | undefined;
  /** Get a component value, throwing if the entity lacks it. */
  getOrThrow<T>(entity: Entity, type: ComponentType<T>): T;
  /** Whether an entity has a component. */
  has(entity: Entity, type: ComponentType<unknown>): boolean;
  /** Remove a component from an entity. No-op if absent. */
  remove(entity: Entity, type: ComponentType<unknown>): void;

  // --- resources (singletons) ---

  /** Set a singleton resource value. */
  setResource<T>(type: ResourceType<T>, value: T): void;
  /** Get a singleton resource value, or `undefined` if unset. */
  getResource<T>(type: ResourceType<T>): T | undefined;

  // --- queries ---

  /** Select entities by component composition. See {@link QueryDescriptor}. */
  query(descriptor: QueryDescriptor): QueryResult;

  // --- serialisation / determinism ---

  /** Capture the full world state as a plain-JSON snapshot. */
  snapshot(): WorldSnapshot;
  /** Replace this world's state with a snapshot's. */
  restore(snapshot: WorldSnapshot): void;
  /** Deterministic digest of the current state. Equal iff snapshots are equal. */
  hash(): StateHash;
  /** A deep, independent copy of this world at its current tick. */
  clone(): World;
}

/** Options for {@link createWorld}. */
export interface WorldConfig {
  /** Seed for the world PRNG. */
  seed: number | string;
  /** Retain a full event log (needed by the harness for assertions). Default `false`. */
  recordEvents?: boolean;
}

/** Create an empty world. */
export function createWorld(config: WorldConfig): World {
  return notImplemented('createWorld');
}
