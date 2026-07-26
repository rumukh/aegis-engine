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
import { entityGeneration, entityIndex, makeEntity, NULL_ENTITY } from './entity.js';
import { createEventBus } from './events.js';
import { createPrng } from './prng.js';
import { hashSnapshot } from './hash.js';
import { SET_TICK } from './internal.js';
import type { ComponentInstance, ComponentType, ResourceType } from './component.js';
import type { Entity } from './entity.js';
import type { EventBus } from './events.js';
import type { TickControlledWorld } from './internal.js';
import type { Prng } from './prng.js';
import type { ComponentRef, EntityView, QueryDescriptor, QueryResult } from './query.js';
import type { StateHash } from './hash.js';
import type { EntitySnapshot, WorldSnapshot } from './serialize.js';

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

/** Structural deep clone for plain component/resource data. */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A sparse-set store for one component type (ADR-0002). */
interface ComponentStore {
  /** slot index → dense index. `undefined` when the slot lacks the component. */
  sparse: (number | undefined)[];
  /** dense index → slot index. */
  dense: number[];
  /** dense index → component value (parallel to {@link ComponentStore.dense}). */
  values: unknown[];
}

function makeStore(): ComponentStore {
  return { sparse: [], dense: [], values: [] };
}

function storeHas(store: ComponentStore, slot: number): boolean {
  return store.sparse[slot] !== undefined;
}

function storeGet(store: ComponentStore, slot: number): unknown {
  const d = store.sparse[slot];
  return d === undefined ? undefined : store.values[d];
}

function storeSet(store: ComponentStore, slot: number, value: unknown): void {
  const d = store.sparse[slot];
  if (d === undefined) {
    store.sparse[slot] = store.dense.length;
    store.dense.push(slot);
    store.values.push(value);
  } else {
    store.values[d] = value;
  }
}

function storeRemove(store: ComponentStore, slot: number): void {
  const d = store.sparse[slot];
  if (d === undefined) return;
  const last = store.dense.length - 1;
  const lastSlot = store.dense[last] as number;
  // swap-remove to keep dense arrays packed
  store.dense[d] = lastSlot;
  store.values[d] = store.values[last];
  store.sparse[lastSlot] = d;
  store.dense.pop();
  store.values.pop();
  store.sparse[slot] = undefined;
}

function refId(ref: ComponentRef): string {
  return typeof ref === 'string' ? ref : ref.id;
}

/** Create an empty world. */
export function createWorld(config: WorldConfig): World {
  const recordEvents = config.recordEvents ?? false;

  let tick = 0;
  const random = createPrng(config.seed);
  const events = createEventBus({ record: recordEvents });

  // Entity allocator.
  const generations: number[] = []; // slot index → current generation
  const alive: boolean[] = []; // slot index → live?
  const free: number[] = []; // free slot indices, popped from the end
  let liveCount = 0;

  // Component + resource stores.
  const stores = new Map<string, ComponentStore>();
  const resources = new Map<string, unknown>();

  function store(id: string): ComponentStore {
    let s = stores.get(id);
    if (s === undefined) {
      s = makeStore();
      stores.set(id, s);
    }
    return s;
  }

  function isAlive(entity: Entity): boolean {
    if (entity === NULL_ENTITY) return false;
    const idx = entityIndex(entity);
    return alive[idx] === true && generations[idx] === entityGeneration(entity);
  }

  function allocSlot(): number {
    const reused = free.pop();
    if (reused !== undefined) {
      alive[reused] = true;
      return reused;
    }
    const idx = generations.length;
    generations[idx] = 1; // slots start at generation 1 so slot 0 never collides with NULL_ENTITY
    alive[idx] = true;
    return idx;
  }

  function handleFor(slot: number): Entity {
    return makeEntity(slot, generations[slot] as number);
  }

  function spawn(...components: ComponentInstance[]): Entity {
    const slot = allocSlot();
    liveCount++;
    for (const c of components) {
      storeSet(store(c.type.id), slot, deepClone(c.value));
    }
    return handleFor(slot);
  }

  function despawn(entity: Entity): void {
    if (!isAlive(entity)) return;
    const slot = entityIndex(entity);
    for (const s of stores.values()) storeRemove(s, slot);
    alive[slot] = false;
    generations[slot] = (generations[slot] as number) + 1;
    free.push(slot);
    liveCount--;
  }

  function add<T>(entity: Entity, type: ComponentType<T>, value?: Partial<T>): void {
    if (!isAlive(entity)) {
      throw new Error(`[aegis] World.add: entity ${String(entity)} is not alive`);
    }
    storeSet(store(type.id), entityIndex(entity), type.create(value));
  }

  function get<T>(entity: Entity, type: ComponentType<T>): T | undefined {
    if (!isAlive(entity)) return undefined;
    const s = stores.get(type.id);
    return s === undefined ? undefined : (storeGet(s, entityIndex(entity)) as T | undefined);
  }

  function getOrThrow<T>(entity: Entity, type: ComponentType<T>): T {
    const v = get(entity, type);
    if (v === undefined) {
      throw new Error(
        `[aegis] World.getOrThrow: entity ${String(entity)} lacks component "${type.id}"`,
      );
    }
    return v;
  }

  function has(entity: Entity, type: ComponentType<unknown>): boolean {
    if (!isAlive(entity)) return false;
    const s = stores.get(type.id);
    return s !== undefined && storeHas(s, entityIndex(entity));
  }

  function remove(entity: Entity, type: ComponentType<unknown>): void {
    if (!isAlive(entity)) return;
    const s = stores.get(type.id);
    if (s !== undefined) storeRemove(s, entityIndex(entity));
  }

  function setResource<T>(type: ResourceType<T>, value: T): void {
    // Deep-copy on the way in, symmetric with how `spawn` clones component values, so a
    // caller-owned object (e.g. a nested field of a SceneFile) is never aliased into world
    // state where the simulation would mutate it in place.
    resources.set(type.id, deepClone(value));
  }

  function getResource<T>(type: ResourceType<T>): T | undefined {
    return resources.get(type.id) as T | undefined;
  }

  function slotHas(id: string, slot: number): boolean {
    const s = stores.get(id);
    return s !== undefined && storeHas(s, slot);
  }

  function slotGet(id: string, slot: number): unknown {
    const s = stores.get(id);
    return s === undefined ? undefined : storeGet(s, slot);
  }

  function query(descriptor: QueryDescriptor): QueryResult {
    const hasIds = (descriptor.has ?? []).map(refId);
    const anyIds = (descriptor.any ?? []).map(refId);
    const noneIds = (descriptor.none ?? []).map(refId);

    // Candidate slots: the smallest `has` store narrows the scan; otherwise all live slots.
    let candidates: number[];
    if (hasIds.length > 0) {
      let smallest: ComponentStore | undefined;
      for (const id of hasIds) {
        const s = stores.get(id);
        if (s === undefined) {
          smallest = undefined;
          candidates = [];
          break;
        }
        if (smallest === undefined || s.dense.length < smallest.dense.length) smallest = s;
      }
      candidates = smallest === undefined ? [] : smallest.dense.slice();
    } else {
      candidates = [];
      for (let slot = 0; slot < alive.length; slot++) if (alive[slot]) candidates.push(slot);
    }

    const matched: number[] = [];
    for (const slot of candidates) {
      if (!alive[slot]) continue;
      let ok = true;
      for (const id of hasIds) {
        if (!slotHas(id, slot)) {
          ok = false;
          break;
        }
      }
      if (ok && anyIds.length > 0) {
        ok = anyIds.some((id) => slotHas(id, slot));
      }
      if (ok) {
        for (const id of noneIds) {
          if (slotHas(id, slot)) {
            ok = false;
            break;
          }
        }
      }
      if (ok) matched.push(slot);
    }
    // Deterministic ascending slot-index order, independent of insertion history.
    matched.sort((a, b) => a - b);
    return makeQueryResult(matched);
  }

  function makeView(slot: number): EntityView {
    const entity = handleFor(slot);
    const view: EntityView = {
      entity,
      get<T>(ref: ComponentType<T> | string): T {
        const id = typeof ref === 'string' ? ref : ref.id;
        const v = slotGet(id, slot);
        if (v === undefined) {
          throw new Error(
            `[aegis] EntityView.get: entity ${String(entity)} lacks component "${id}"`,
          );
        }
        return v as T;
      },
      tryGet<T>(type: ComponentType<T>): T | undefined {
        return slotGet(type.id, slot) as T | undefined;
      },
      has(ref: ComponentRef): boolean {
        return slotHas(refId(ref), slot);
      },
    };
    return view;
  }

  function makeQueryResult(slots: readonly number[]): QueryResult {
    const result: QueryResult = {
      [Symbol.iterator](): Iterator<EntityView> {
        let i = 0;
        return {
          next(): IteratorResult<EntityView> {
            if (i < slots.length) return { value: makeView(slots[i++] as number), done: false };
            return { value: undefined as unknown as EntityView, done: true };
          },
        };
      },
      count(): number {
        return slots.length;
      },
      entities(): readonly Entity[] {
        return slots.map((s) => handleFor(s));
      },
      views(): readonly EntityView[] {
        return slots.map((s) => makeView(s));
      },
      first(): EntityView | undefined {
        return slots.length > 0 ? makeView(slots[0] as number) : undefined;
      },
      one(): EntityView {
        if (slots.length !== 1) {
          throw new Error(`[aegis] QueryResult.one: expected exactly 1 match, got ${slots.length}`);
        }
        return makeView(slots[0] as number);
      },
      forEach(fn: (view: EntityView, i: number) => void): void {
        for (let i = 0; i < slots.length; i++) fn(makeView(slots[i] as number), i);
      },
    };
    return result;
  }

  function liveSlotsAscending(): number[] {
    const out: number[] = [];
    for (let slot = 0; slot < alive.length; slot++) if (alive[slot]) out.push(slot);
    return out;
  }

  function snapshot(): WorldSnapshot {
    const entities: EntitySnapshot[] = [];
    for (const slot of liveSlotsAscending()) {
      const components: Record<string, unknown> = {};
      let name: string | undefined;
      for (const [id, s] of stores) {
        if (!storeHas(s, slot)) continue;
        const value = storeGet(s, slot);
        components[id] = deepClone(value);
        if (id === 'Name') {
          const n = (value as { value?: unknown }).value;
          if (typeof n === 'string') name = n;
        }
      }
      const snap: EntitySnapshot =
        name === undefined
          ? { id: String(handleFor(slot)), components }
          : { id: String(handleFor(slot)), name, components };
      entities.push(snap);
    }

    const resourcesOut: Record<string, unknown> = {};
    for (const [id, value] of resources) resourcesOut[id] = deepClone(value);

    return {
      version: 1,
      tick,
      entities,
      resources: resourcesOut,
      prng: random.save(),
      allocator: { slots: generations.slice(), free: free.slice() },
    };
  }

  function restore(snap: WorldSnapshot): void {
    tick = snap.tick;

    // Rebuild the allocator exactly so future entity ids match an uninterrupted run.
    generations.length = 0;
    alive.length = 0;
    for (let i = 0; i < snap.allocator.slots.length; i++) {
      generations[i] = snap.allocator.slots[i] as number;
      alive[i] = false;
    }
    free.length = 0;
    for (const f of snap.allocator.free) free.push(f);

    stores.clear();
    resources.clear();
    liveCount = 0;

    for (const ent of snap.entities) {
      const handle = Number(ent.id) as Entity;
      const slot = entityIndex(handle);
      alive[slot] = true;
      liveCount++;
      for (const id of Object.keys(ent.components)) {
        storeSet(store(id), slot, deepClone(ent.components[id]));
      }
    }

    for (const id of Object.keys(snap.resources)) {
      resources.set(id, deepClone(snap.resources[id]));
    }

    random.load(snap.prng);
  }

  function hash(): StateHash {
    return hashSnapshot(snapshot());
  }

  function clone(): World {
    const copy = createWorld(config);
    copy.restore(snapshot());
    return copy;
  }

  const world: World & TickControlledWorld = {
    get tick() {
      return tick;
    },
    random,
    events,
    get entityCount() {
      return liveCount;
    },
    spawn,
    despawn,
    isAlive,
    add,
    get,
    getOrThrow,
    has,
    remove,
    setResource,
    getResource,
    query,
    snapshot,
    restore,
    hash,
    clone,
    [SET_TICK](t: number): void {
      tick = t;
    },
  };
  return world;
}
