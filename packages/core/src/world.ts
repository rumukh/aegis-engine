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
import { MAX_ENTITY_GENERATION } from './entity.js';
import { createEventBus } from './events.js';
import { createPrng } from './prng.js';
import { hashSnapshot } from './hash.js';
import { CoreDiagnosticCode } from './codes.js';
import { deepClone, deepCloneSerialisable, NonFiniteValueError } from './clone.js';
import { DiagnosticError } from './diagnostics.js';
import { RESET_LOG, SET_TICK } from './internal.js';
import type { ComponentInstance, ComponentType, ResourceType } from './component.js';
import type { Diagnostic } from './diagnostics.js';
import type { Entity } from './entity.js';
import type { EventBus } from './events.js';
import type { ManagedEventBus, TickControlledWorld } from './internal.js';
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

/** Build the structured diagnostic for a non-finite value found while snapshotting. */
function nonFiniteDiagnostic(
  err: NonFiniteValueError,
  where: string,
  subject: string,
  data: Readonly<Record<string, unknown>>,
): DiagnosticError {
  const path = err.path === '' ? where : `${where}.${err.path}`;
  const diagnostic: Diagnostic = {
    code: CoreDiagnosticCode.NonFiniteState,
    severity: 'error',
    message:
      `World state holds a non-finite number (${String(err.value)}) on ${subject}. ` +
      `The world cannot be serialised or hashed while it does.`,
    location: { path },
    fix:
      `Find the system that wrote ${path}. ${String(err.value)} almost always comes from a ` +
      `divide-by-zero, a sqrt of a negative, an uninitialised accumulator, or an out-of-domain ` +
      `angle. Guard the input rather than the output.`,
    data: { ...data, path, value: String(err.value) },
  };
  return new DiagnosticError([diagnostic]);
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

/** Raise a structured {@link CoreDiagnosticCode.InvalidSnapshot} for `path`. */
function invalidSnapshot(path: string, message: string, fix: string): DiagnosticError {
  return new DiagnosticError([
    {
      code: CoreDiagnosticCode.InvalidSnapshot,
      severity: 'error',
      message: `World.restore: ${message}`,
      location: { path },
      fix,
    },
  ]);
}

function isUint32(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}

/**
 * Structurally validate a snapshot before it is allowed to become world state.
 *
 * Cheap (linear in the snapshot) and worth it: `restore` is the boundary where hand-edited
 * saves, truncated files and cross-version snapshots enter the simulation, and an invalid one
 * used to produce a world that hashed successfully while containing `"id": "NaN"`.
 */
function validateSnapshot(snap: WorldSnapshot): void {
  if (snap === null || typeof snap !== 'object') {
    throw invalidSnapshot('<root>', 'snapshot is not an object.', 'Pass a WorldSnapshot.');
  }
  if (snap.version !== 1) {
    throw invalidSnapshot(
      'version',
      `unsupported snapshot version ${String(snap.version)}; this build reads version 1.`,
      'Re-capture the snapshot with this engine version.',
    );
  }
  if (!Number.isInteger(snap.tick) || snap.tick < 0) {
    throw invalidSnapshot(
      'tick',
      `tick must be a non-negative integer, got ${String(snap.tick)}.`,
      'Ticks are whole numbers counted from 0.',
    );
  }
  if (snap.prng === null || typeof snap.prng !== 'object' || !Array.isArray(snap.prng.s)) {
    throw invalidSnapshot(
      'prng.s',
      'PRNG state is missing or is not an array of words.',
      'Capture the snapshot with World.snapshot() rather than assembling it by hand.',
    );
  }
  const allocator = snap.allocator;
  if (
    allocator === null ||
    typeof allocator !== 'object' ||
    !Array.isArray(allocator.slots) ||
    !Array.isArray(allocator.free)
  ) {
    throw invalidSnapshot(
      'allocator',
      'allocator state is missing `slots` or `free`.',
      'Snapshots from before the allocator was captured cannot be restored exactly.',
    );
  }
  for (let i = 0; i < allocator.slots.length; i++) {
    const g = allocator.slots[i];
    if (typeof g !== 'number' || !Number.isInteger(g) || g < 1 || g > MAX_ENTITY_GENERATION) {
      throw invalidSnapshot(
        `allocator.slots[${i}]`,
        `slot generation must be an integer in [1, ${MAX_ENTITY_GENERATION}], got ${String(g)}.`,
        'Slots start at generation 1 and are bumped once per despawn.',
      );
    }
  }
  for (let i = 0; i < allocator.free.length; i++) {
    const f = allocator.free[i];
    if (typeof f !== 'number' || !Number.isInteger(f) || f < 0 || f >= allocator.slots.length) {
      throw invalidSnapshot(
        `allocator.free[${i}]`,
        `free-list entry must be a slot index in [0, ${allocator.slots.length}), got ${String(f)}.`,
        'The free list holds indices into `allocator.slots`.',
      );
    }
  }
  if (!Array.isArray(snap.entities)) {
    throw invalidSnapshot('entities', 'entities must be an array.', 'Use World.snapshot().');
  }

  const seen = new Set<number>();
  for (let i = 0; i < snap.entities.length; i++) {
    const ent = snap.entities[i] as EntitySnapshot | undefined;
    const at = `entities[${i}]`;
    if (ent === null || typeof ent !== 'object') {
      throw invalidSnapshot(at, 'entity entry is not an object.', 'Use World.snapshot().');
    }
    if (typeof ent.id !== 'string' || ent.id === '') {
      throw invalidSnapshot(
        `${at}.id`,
        `entity id must be a non-empty decimal string, got ${JSON.stringify(ent.id)}.`,
        'Entity ids are the decimal form of the packed index+generation handle.',
      );
    }
    const handle = Number(ent.id);
    if (!Number.isSafeInteger(handle) || handle <= 0) {
      throw invalidSnapshot(
        `${at}.id`,
        `entity id "${ent.id}" is not a positive safe integer, so it cannot be an entity handle.`,
        'A NULL/NaN id here is the signature of a hand-edited or truncated save file.',
      );
    }
    const slot = entityIndex(handle as Entity);
    const generation = entityGeneration(handle as Entity);
    if (slot >= allocator.slots.length) {
      throw invalidSnapshot(
        `${at}.id`,
        `entity ${ent.id} refers to slot ${slot}, but the allocator only has ` +
          `${allocator.slots.length} slot(s).`,
        'Restore the snapshot that captured this allocator, not a mismatched pair.',
      );
    }
    if (allocator.slots[slot] !== generation) {
      throw invalidSnapshot(
        `${at}.id`,
        `entity ${ent.id} claims generation ${generation}, but slot ${slot} is at generation ` +
          `${String(allocator.slots[slot])} — this handle is stale.`,
        'A live entity always matches its slot generation.',
      );
    }
    if (seen.has(slot)) {
      throw invalidSnapshot(
        `${at}.id`,
        `two live entities occupy slot ${slot}.`,
        'Each slot holds at most one live entity.',
      );
    }
    seen.add(slot);
    if (allocator.free.includes(slot)) {
      throw invalidSnapshot(
        `${at}.id`,
        `slot ${slot} is both live and on the free list.`,
        'A free slot has no live entity.',
      );
    }
    if (ent.components === null || typeof ent.components !== 'object') {
      throw invalidSnapshot(
        `${at}.components`,
        'components must be an object keyed by component id.',
        'Use World.snapshot().',
      );
    }
  }

  if (snap.resources === null || typeof snap.resources !== 'object') {
    throw invalidSnapshot(
      'resources',
      'resources must be an object keyed by resource id.',
      'Use World.snapshot().',
    );
  }
  for (const w of snap.prng.s) {
    if (!isUint32(w)) {
      throw invalidSnapshot(
        'prng.s',
        `PRNG state words must be unsigned 32-bit integers, got ${String(w)}.`,
        'Capture the snapshot with World.snapshot().',
      );
    }
  }
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
    const nextGeneration = (generations[slot] as number) + 1;
    if (nextGeneration > MAX_ENTITY_GENERATION) {
      // Past this point `makeEntity` can no longer represent index+generation exactly in a
      // float64, so two distinct entities would pack to the same handle on odd slots — an
      // alive-but-unaddressable entity. Refuse loudly rather than corrupt identity.
      throw new Error(
        `[aegis] World.despawn: slot ${slot} has been recycled ${MAX_ENTITY_GENERATION} times, ` +
          `the maximum an Entity handle can encode exactly. Pool and reuse entities instead of ` +
          `despawning and respawning them, or raise ENTITY_INDEX_BITS (a breaking change to ` +
          `every serialised snapshot).`,
      );
    }
    for (const s of stores.values()) storeRemove(s, slot);
    alive[slot] = false;
    generations[slot] = nextGeneration;
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
    // Materialise handles NOW: a slot index alone is not an identity once the free list
    // recycles it, and the free list is LIFO (see makeQueryResult).
    return makeQueryResult(matched.map(handleFor));
  }

  function makeView(entity: Entity): EntityView {
    const slot = entityIndex(entity);
    /**
     * Every read re-checks the generation. A `QueryResult` row is a *handle*, not a slot, so a
     * row whose entity was despawned mid-iteration can never resolve to whatever entity later
     * took its slot — it reports absent, or throws.
     */
    function live(): boolean {
      return alive[slot] === true && generations[slot] === entityGeneration(entity);
    }
    const view: EntityView = {
      entity,
      get<T>(ref: ComponentType<T> | string): T {
        const id = typeof ref === 'string' ? ref : ref.id;
        if (!live()) {
          throw new Error(
            `[aegis] EntityView.get: entity ${String(entity)} was despawned; this query row is ` +
              `stale. Re-run the query after despawning, or use tryGet/has to skip dead rows.`,
          );
        }
        const v = slotGet(id, slot);
        if (v === undefined) {
          throw new Error(
            `[aegis] EntityView.get: entity ${String(entity)} lacks component "${id}"`,
          );
        }
        return v as T;
      },
      tryGet<T>(type: ComponentType<T>): T | undefined {
        return live() ? (slotGet(type.id, slot) as T | undefined) : undefined;
      },
      has(ref: ComponentRef): boolean {
        return live() && slotHas(refId(ref), slot);
      },
    };
    return view;
  }

  /**
   * Build a {@link QueryResult} over handles materialised at `query()` time.
   *
   * Storing raw slot indices and packing a handle at *consumption* time was a use-after-despawn
   * bug wearing the costume of a safety feature: the free list is LIFO, so a despawn+spawn
   * inside a system loop reused the slot immediately and the pending row then packed the *new*
   * generation — handing the caller a live handle to a different entity, with real data and no
   * error. Handles are now fixed when the query runs, and every row is generation-checked
   * before it is yielded, so a despawned entity simply disappears from the result.
   */
  function makeQueryResult(handles: readonly Entity[]): QueryResult {
    const stillAlive = (): Entity[] => handles.filter(isAlive);

    const result: QueryResult = {
      [Symbol.iterator](): Iterator<EntityView> {
        let i = 0;
        return {
          next(): IteratorResult<EntityView> {
            // Re-check on each step: entities may die *during* iteration.
            while (i < handles.length) {
              const entity = handles[i++] as Entity;
              if (isAlive(entity)) return { value: makeView(entity), done: false };
            }
            return { value: undefined as unknown as EntityView, done: true };
          },
        };
      },
      count(): number {
        return stillAlive().length;
      },
      entities(): readonly Entity[] {
        return stillAlive();
      },
      views(): readonly EntityView[] {
        return stillAlive().map(makeView);
      },
      first(): EntityView | undefined {
        for (const entity of handles) if (isAlive(entity)) return makeView(entity);
        return undefined;
      },
      one(): EntityView {
        const live = stillAlive();
        if (live.length !== 1) {
          throw new Error(`[aegis] QueryResult.one: expected exactly 1 match, got ${live.length}`);
        }
        return makeView(live[0] as Entity);
      },
      forEach(fn: (view: EntityView, i: number) => void): void {
        let i = 0;
        for (const entity of handles) {
          if (isAlive(entity)) fn(makeView(entity), i++);
        }
      },
    };
    return result;
  }

  function liveSlotsAscending(): number[] {
    const out: number[] = [];
    for (let slot = 0; slot < alive.length; slot++) if (alive[slot]) out.push(slot);
    return out;
  }

  /**
   * Capture the world as plain JSON.
   *
   * Cloning is structural, so `NaN`/`±Infinity` survive into the snapshot instead of being
   * laundered into `null` by a JSON round-trip. Rather than letting the canonical encoder throw
   * a bare "non-finite number" from deep inside the hash, this reports a structured
   * {@link CoreDiagnosticCode.NonFiniteState} diagnostic naming the entity, its authoring name,
   * the component and the JSON path — so the answer to "where did the NaN come from?" is in the
   * error, not in a bisect.
   */
  function snapshot(): WorldSnapshot {
    const entities: EntitySnapshot[] = [];
    for (const slot of liveSlotsAscending()) {
      const components: Record<string, unknown> = {};
      const id = String(handleFor(slot));
      // Resolve Name first so a diagnostic can quote the authoring name of the culprit.
      let name: string | undefined;
      const nameStore = stores.get('Name');
      if (nameStore !== undefined && storeHas(nameStore, slot)) {
        const n = (storeGet(nameStore, slot) as { value?: unknown }).value;
        if (typeof n === 'string') name = n;
      }
      for (const [componentId, s] of stores) {
        if (!storeHas(s, slot)) continue;
        try {
          components[componentId] = deepCloneSerialisable(storeGet(s, slot));
        } catch (err) {
          if (err instanceof NonFiniteValueError) {
            throw nonFiniteDiagnostic(
              err,
              `entities[${id}].components.${componentId}`,
              `entity ${id}${name === undefined ? '' : ` ("${name}")`}, component "${componentId}"`,
              { entity: id, entityName: name ?? null, component: componentId },
            );
          }
          throw err;
        }
      }
      const snap: EntitySnapshot =
        name === undefined ? { id, components } : { id, name, components };
      entities.push(snap);
    }

    const resourcesOut: Record<string, unknown> = {};
    for (const [id, value] of resources) {
      try {
        resourcesOut[id] = deepCloneSerialisable(value);
      } catch (err) {
        if (err instanceof NonFiniteValueError) {
          throw nonFiniteDiagnostic(err, `resources.${id}`, `resource "${id}"`, {
            entity: null,
            entityName: null,
            component: id,
          });
        }
        throw err;
      }
    }

    return {
      version: 1,
      tick,
      entities,
      resources: resourcesOut,
      prng: random.save(),
      allocator: { slots: generations.slice(), free: free.slice() },
    };
  }

  /**
   * Replace this world's state with a snapshot's.
   *
   * The snapshot is validated first. It used to be trusted blindly, so a hand-edited or
   * truncated file produced a world whose own snapshot contained `"id": "NaN"` and which
   * hashed happily — a corrupt save that looked like a valid one. Every failure here is a
   * structured {@link CoreDiagnosticCode.InvalidSnapshot} diagnostic naming the offending path.
   */
  function restore(snap: WorldSnapshot): void {
    validateSnapshot(snap);
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
    // A restored world is a *replacement*, not a continuation: keeping the previous world's
    // recorded events would double-count every assertion made against the log.
    (events as ManagedEventBus)[RESET_LOG]();
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
