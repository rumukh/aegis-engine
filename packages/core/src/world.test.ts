import { describe, it, expect } from 'vitest';
import { createWorld } from './world.js';
import { defineComponent, defineTag, defineResource } from './component.js';
import { Name, Transform } from './components.js';
import { MAX_ENTITY_GENERATION, NULL_ENTITY, entityIndex, makeEntity } from './entity.js';
import { CoreDiagnosticCode } from './codes.js';
import { DiagnosticError } from './diagnostics.js';
import { canonicalStringify } from './serialize.js';
import type { Diagnostic } from './diagnostics.js';
import type { ComponentInstance } from './component.js';
import type { EntityView, QueryResult } from './query.js';
import type { WorldSnapshot } from './serialize.js';

interface Vel {
  dx: number;
  dy: number;
}
const Velocity = defineComponent<Vel>({ id: 'Velocity', defaults: () => ({ dx: 0, dy: 0 }) });
const Player = defineTag('Player');
const Enemy = defineTag('Enemy');
const Gravity = defineResource<{ y: number }>('Gravity', () => ({ y: -9.8 }));

describe('World — entity lifecycle & generation safety', () => {
  it('spawns and despawns, tracking entityCount', () => {
    const w = createWorld({ seed: 1 });
    expect(w.entityCount).toBe(0);
    const a = w.spawn();
    const b = w.spawn();
    expect(w.entityCount).toBe(2);
    expect(w.isAlive(a)).toBe(true);
    w.despawn(a);
    expect(w.isAlive(a)).toBe(false);
    expect(w.entityCount).toBe(1);
    w.despawn(a); // idempotent
    expect(w.entityCount).toBe(1);
    expect(w.isAlive(b)).toBe(true);
  });

  it('NULL_ENTITY is never alive', () => {
    const w = createWorld({ seed: 1 });
    expect(w.isAlive(NULL_ENTITY)).toBe(false);
  });

  it('a stale handle never resolves after its slot is recycled', () => {
    const w = createWorld({ seed: 1 });
    const first = w.spawn(Velocity({ dx: 1, dy: 2 }));
    w.despawn(first);
    // Force reuse of the same slot index.
    const second = w.spawn(Velocity({ dx: 9, dy: 9 }));
    expect(second).not.toBe(first); // different generation packed in
    expect(w.isAlive(first)).toBe(false);
    expect(w.isAlive(second)).toBe(true);
    // The stale handle must NOT read the recycled entity's data.
    expect(w.get(first, Velocity)).toBeUndefined();
    expect(w.get(second, Velocity)).toEqual({ dx: 9, dy: 9 });
    // Mutations through a stale handle are refused.
    expect(() => w.add(first, Velocity, { dx: 0, dy: 0 })).toThrow();
  });

  it('components: add/get/has/remove/getOrThrow', () => {
    const w = createWorld({ seed: 1 });
    const e = w.spawn();
    expect(w.has(e, Velocity)).toBe(false);
    w.add(e, Velocity, { dx: 3 });
    expect(w.has(e, Velocity)).toBe(true);
    expect(w.get(e, Velocity)).toEqual({ dx: 3, dy: 0 });
    expect(w.getOrThrow(e, Velocity).dx).toBe(3);
    w.remove(e, Velocity);
    expect(w.has(e, Velocity)).toBe(false);
    expect(w.get(e, Velocity)).toBeUndefined();
    expect(() => w.getOrThrow(e, Velocity)).toThrow();
  });

  it('component values are stored independently of the caller object', () => {
    const w = createWorld({ seed: 1 });
    const inst = Velocity({ dx: 5, dy: 5 });
    const e = w.spawn(inst);
    (inst.value as Vel).dx = 999; // mutate the source after spawn
    expect(w.get(e, Velocity)).toEqual({ dx: 5, dy: 5 });
  });

  it('resources set/get', () => {
    const w = createWorld({ seed: 1 });
    expect(w.getResource(Gravity)).toBeUndefined();
    w.setResource(Gravity, { y: -20 });
    expect(w.getResource(Gravity)).toEqual({ y: -20 });
  });
});

describe('World — queries', () => {
  it('has / any / none filters with deterministic ascending order', () => {
    const w = createWorld({ seed: 1 });
    const e0 = w.spawn(Player(), Velocity());
    const e1 = w.spawn(Enemy(), Velocity());
    const e2 = w.spawn(Player());
    w.spawn(Enemy()); // e3, filtered out by `has Velocity`

    const moving = w.query({ has: ['Velocity'] });
    expect(moving.count()).toBe(2);
    expect(moving.entities()).toEqual([e0, e1]); // ascending slot order

    const players = w.query({ has: [Player] });
    expect(players.entities()).toEqual([e0, e2]);

    const anyKind = w.query({ any: ['Player', 'Enemy'] });
    expect(anyKind.count()).toBe(4);

    const playersNotMoving = w.query({ has: [Player], none: [Velocity] });
    expect(playersNotMoving.entities()).toEqual([e2]);
  });

  it('one() returns the sole match and throws otherwise', () => {
    const w = createWorld({ seed: 1 });
    const only = w.spawn(Player(), Name({ value: 'hero' }));
    w.spawn(Enemy());
    const view = w.query({ has: [Player] }).one();
    expect(view.entity).toBe(only);
    expect(view.get(Name).value).toBe('hero');
    expect(() => w.query({ has: [Enemy, Player] }).one()).toThrow(); // zero
    w.spawn(Player());
    expect(() => w.query({ has: [Player] }).one()).toThrow(); // two
  });

  it('EntityView get/tryGet/has and iteration', () => {
    const w = createWorld({ seed: 1 });
    w.spawn(Player(), Velocity({ dx: 1 }));
    const view = w.query({ has: [Player] }).first();
    expect(view?.has('Velocity')).toBe(true);
    expect(view?.tryGet(Velocity)).toEqual({ dx: 1, dy: 0 });
    expect(view?.tryGet(Enemy)).toBeUndefined();
    expect(() => view?.get(Enemy)).toThrow();

    let seen = 0;
    for (const v of w.query({ has: [Player] })) {
      expect(v.entity).toBeDefined();
      seen++;
    }
    expect(seen).toBe(1);
  });

  it('query order is independent of spawn/despawn history', () => {
    const w = createWorld({ seed: 1 });
    const a = w.spawn(Player());
    const b = w.spawn(Player());
    const c = w.spawn(Player());
    w.despawn(b); // free the middle slot
    const d = w.spawn(Player()); // reuses b's slot
    const ids = w.query({ has: [Player] }).entities();
    // Ascending slot index: a(0), d(reused slot 1), c(2)
    expect(ids).toEqual([a, d, c]);
  });
});

describe('World — serialisation, hashing, cloning', () => {
  it('round-trips: snapshot -> restore -> identical hash', () => {
    const w = createWorld({ seed: 'abc' });
    w.spawn(Name({ value: 'a' }), Transform(), Velocity({ dx: 1, dy: 2 }));
    w.spawn(Enemy(), Transform({ position: { x: 5, y: 0, z: 0 } }));
    w.setResource(Gravity, { y: -3 });
    w.random.nextUint32();

    const snap = w.snapshot();
    const h1 = w.hash();

    const w2 = createWorld({ seed: 'different-seed' });
    w2.restore(snap);
    expect(w2.hash()).toBe(h1);
    // JSON round-trip of the snapshot is lossless.
    const reparsed = JSON.parse(JSON.stringify(snap));
    const w3 = createWorld({ seed: 0 });
    w3.restore(reparsed);
    expect(w3.hash()).toBe(h1);
  });

  it('hash is stable regardless of component insertion order', () => {
    const w1 = createWorld({ seed: 1 });
    const e1 = w1.spawn();
    w1.add(e1, Velocity, { dx: 1 });
    w1.add(e1, Transform);

    const w2 = createWorld({ seed: 1 });
    const e2 = w2.spawn();
    w2.add(e2, Transform);
    w2.add(e2, Velocity, { dx: 1 });

    expect(w1.hash()).toBe(w2.hash());
  });

  it('clone produces an independent world with the same hash', () => {
    const w = createWorld({ seed: 7 });
    w.spawn(Player(), Velocity({ dx: 2, dy: 2 }));
    const c = w.clone();
    expect(c.hash()).toBe(w.hash());
    // Mutating the clone does not affect the original.
    c.spawn(Enemy());
    expect(c.hash()).not.toBe(w.hash());
  });

  it('snapshot captures Name for readable entity ids', () => {
    const w = createWorld({ seed: 1 });
    w.spawn(Name({ value: 'hero' }));
    const snap = w.snapshot();
    expect(snap.entities[0]?.name).toBe('hero');
  });
});

/**
 * C1 — non-finite values are rejected at the write boundary, and caught at `snapshot()` on the
 * one path that has no write boundary.
 *
 * Two mechanisms, because one is not enough:
 *
 * 1. **Reject at the write boundary** (`spawn`, `add`, `setResource`, `ComponentType.create`).
 *    Non-finite becomes unrepresentable in world state, so the snapshot→restore question is
 *    moot — and the error fires at the code that produced the `NaN`, which is the whole point
 *    of CHARTER principle 8.
 * 2. **Preserve in the clone, catch at `snapshot()`.** A system mutating a stored component in
 *    place (`world.get(e, C).v = 0 / 0`) touches no write boundary and no clone at all, and
 *    that is the most common way a sim produces `NaN`. Preserving is what makes the guard in
 *    `canonicalStringify` reachable, and `snapshot()` turns it into a *locating* diagnostic
 *    rather than a bare "hash threw".
 *
 * Explicitly **not** attempted: making snapshot→restore preserve a non-finite value.
 * `JSON.stringify({v: Infinity})` is `'{"v":null}'` by specification and principle 4 requires
 * a JSON world, so a world that can hold one cannot round-trip. Rejection at the boundary is
 * what dissolves that contradiction. Sentinel-encoding (`{"$nonfinite":"Infinity"}`) is also
 * rejected: it changes the snapshot format *and* the hash input, invalidating every stored
 * replay and every pinned `GOLDEN_HASH`.
 *
 * Hardening `canonicalStringify` is *neither* mechanism and fixes nothing: the guard at
 * `serialize.ts:72` already worked, it was simply unreachable behind two JSON launderers
 * (`world.ts` `deepClone` and `defineComponent`'s default `clone`).
 */
describe('World — non-finite state (C1)', () => {
  const V = defineComponent<{ v: number }>({ id: 'V', defaults: () => ({ v: 0 }) });

  /** Extract the single diagnostic from a thrown DiagnosticError. */
  function diagnosticFrom(fn: () => unknown): Diagnostic {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(DiagnosticError);
      const d = (err as DiagnosticError).diagnostics[0] as Diagnostic;
      expect(d.code).toBe(CoreDiagnosticCode.NonFiniteState);
      return d;
    }
    throw new Error('expected the call to throw a DiagnosticError');
  }

  it('rejects a non-finite value at every write boundary', () => {
    const Cfg = defineResource<{ v: number }>('Cfg', () => ({ v: 0 }));
    for (const bad of [NaN, Infinity, -Infinity]) {
      const w = createWorld({ seed: 1 });
      const e = w.spawn();
      expect(() => w.spawn(V({ v: bad }))).toThrow(DiagnosticError);
      expect(() => w.add(e, V, { v: bad })).toThrow(DiagnosticError);
      expect(() => V.create({ v: bad })).toThrow(DiagnosticError);
      expect(() => V({ v: bad })).toThrow(DiagnosticError);
      expect(() => w.setResource(Cfg, { v: bad })).toThrow(DiagnosticError);
      // Nothing partial was left behind by the rejected spawn.
      expect(w.entityCount).toBe(1);
      expect(w.has(e, V)).toBe(false);
    }
  });

  it('rejects a hand-built ComponentInstance at spawn(), before allocating a slot', () => {
    // `ComponentInstance` is a plain `{ type, value }` object, so it can be constructed without
    // going through the component factory — spawn must check for itself. And it must check
    // *before* allocSlot(), or a mid-spawn throw would leave the allocator holding a half-built
    // entity and shift every future entity id.
    const w = createWorld({ seed: 1 });
    const before = w.snapshot();
    const raw = { type: V, value: { v: NaN } } as ComponentInstance;
    expect(() => w.spawn(raw)).toThrow(DiagnosticError);
    expect(w.entityCount).toBe(0);
    // The allocator is untouched: the next spawn gets the id it would have got anyway.
    expect(w.snapshot()).toEqual(before);
    const clean = createWorld({ seed: 1 });
    expect(w.spawn(V({ v: 1 }))).toBe(clean.spawn(V({ v: 1 })));
  });

  it('names the entity, the component and the JSON path when add() rejects', () => {
    const w = createWorld({ seed: 1 });
    const e = w.spawn(Name({ value: 'hero' }));
    const d = diagnosticFrom(() => w.add(e, Transform, { position: { x: NaN, y: 0, z: 0 } }));
    expect(d.severity).toBe('error');
    expect(d.message).toContain('NaN');
    expect(d.location?.path).toBe(`entities[${String(e)}].components.Transform.position.x`);
    expect(d.data?.entity).toBe(String(e));
    expect(d.data?.component).toBe('Transform');
    expect(d.fix).toBeTruthy();
  });

  it('names the component and path when spawn() or create() rejects (no entity exists yet)', () => {
    const w = createWorld({ seed: 1 });
    const spawnDiag = diagnosticFrom(() =>
      w.spawn(Transform({ position: { x: 0, y: Infinity, z: 0 } })),
    );
    expect(spawnDiag.location?.path).toBe('Transform.position.y');
    expect(spawnDiag.data?.entity).toBeNull();

    const createDiag = diagnosticFrom(() => V.create({ v: -Infinity }));
    expect(createDiag.location?.path).toBe('V.v');
  });

  it('names the resource path when setResource rejects', () => {
    const Cfg = defineResource<{ gravity: { y: number } }>('Cfg', () => ({ gravity: { y: 0 } }));
    const w = createWorld({ seed: 1 });
    const d = diagnosticFrom(() => w.setResource(Cfg, { gravity: { y: -Infinity } }));
    expect(d.location?.path).toBe('resources.Cfg.gravity.y');
    expect(d.data?.entity).toBeNull();
  });

  it('reports the index of a non-finite array element', () => {
    const Path = defineComponent<{ pts: number[] }>({ id: 'Path', defaults: () => ({ pts: [] }) });
    const d = diagnosticFrom(() => Path({ pts: [1, 2, NaN] }));
    expect(d.location?.path).toBe('Path.pts[2]');
  });

  it('a custom clone cannot smuggle a non-finite value past the write boundary', () => {
    // `ComponentType.clone` is public API, so a component can supply the lossy JSON round trip
    // deliberately. The write-boundary check runs on the *input*, before the clone, so a lossy
    // clone cannot hide the value by flattening it to null on the way past.
    const Evil = defineComponent<{ x: number }>({
      id: 'Evil',
      defaults: () => ({ x: 0 }),
      clone: (value) => JSON.parse(JSON.stringify(value)) as { x: number },
    });
    expect(() => Evil({ x: NaN })).toThrow(DiagnosticError);
    const w = createWorld({ seed: 1 });
    const e = w.spawn();
    expect(() => w.add(e, Evil, { x: Infinity })).toThrow(DiagnosticError);
  });

  // --- the live-mutation path, which has no write boundary ---

  it('preserves a live-mutated non-finite value instead of laundering it to null', () => {
    // No clone runs on this path, so the clone cannot reject it — but the clone must still
    // *preserve* it, because that is what makes the snapshot guard reachable.
    const w = createWorld({ seed: 1 });
    const e = w.spawn(V({ v: 1 }));
    w.getOrThrow(e, V).v = 0 / 0;
    const stored = w.get(e, V)?.v as number;
    expect(typeof stored).toBe('number');
    expect(Number.isNaN(stored)).toBe(true);
    w.getOrThrow(e, V).v = 1 / 0;
    expect(w.get(e, V)?.v).toBe(Infinity);
  });

  it('refuses to snapshot a live-mutated NaN, naming entity, component and path', () => {
    const w = createWorld({ seed: 1 });
    const e = w.spawn(Name({ value: 'hero' }), Transform());
    w.getOrThrow(e, Transform).position.x = 0 / 0; // divide-by-zero inside a system

    const d = diagnosticFrom(() => w.snapshot());
    expect(d.location?.path).toBe(`entities[${String(e)}].components.Transform.position.x`);
    expect(d.data?.entity).toBe(String(e));
    expect(d.data?.entityName).toBe('hero');
    expect(d.data?.component).toBe('Transform');
    expect(d.fix).toBeTruthy();
  });

  it('refuses to hash or clone a live-mutated ±Infinity', () => {
    const w = createWorld({ seed: 1 });
    const e = w.spawn(V());
    w.getOrThrow(e, V).v = 1 / 0;
    expect(() => w.hash()).toThrow(DiagnosticError);
    expect(() => w.clone()).toThrow(DiagnosticError);
    w.getOrThrow(e, V).v = -1 / 0;
    expect(() => w.hash()).toThrow(DiagnosticError);
  });

  it('closes the live/restored divergence the hash could not see', () => {
    // Pre-fix: a live world holding Infinity and a world restored from its own snapshot
    // holding null hashed identically, so determinism.test.ts's "serialise -> deserialise ->
    // continue equals an uninterrupted run" was comparing two genuinely different worlds and
    // passing. There is now no snapshot to diverge *from*.
    const w = createWorld({ seed: 1 });
    const e = w.spawn(V({ v: 1 }));
    w.getOrThrow(e, V).v = Infinity;
    expect(w.get(e, V)?.v).toBe(Infinity);
    expect(() => w.snapshot()).toThrow(DiagnosticError);
    expect(() => w.hash()).toThrow(DiagnosticError);
    expect(() => w.clone()).toThrow(DiagnosticError);
  });

  it('a component cannot opt out of the snapshot guard with a custom clone', () => {
    // The live-mutation path bypasses every clone, so the guarantee cannot live in one.
    // `World.snapshot` clones the stored value with core's own checked clone and never calls
    // `type.clone`, so a lossy `clone` cannot produce a world that hashes over a NaN.
    const Evil = defineComponent<{ x: number }>({
      id: 'Evil',
      defaults: () => ({ x: 0 }),
      clone: (value) => JSON.parse(JSON.stringify(value)) as { x: number },
    });
    const w = createWorld({ seed: 1 });
    const e = w.spawn(Evil({ x: 1 }));
    w.getOrThrow(e, Evil).x = 0 / 0;
    const d = diagnosticFrom(() => w.snapshot());
    expect(d.location?.path).toBe(`entities[${String(e)}].components.Evil.x`);
  });

  it('rejects non-plain data rather than silently canonicalising it to {}', () => {
    const w = createWorld({ seed: 1 });
    // A Map has no enumerable own keys, so it used to survive into state and hash as `{}`.
    expect(() => w.spawn(V({ v: new Map() as unknown as number }))).toThrow(/plain JSON/);
    expect(() => w.spawn(V({ v: (() => 1) as unknown as number }))).toThrow(/not simulation data/);
  });

  it('normalises -0 to 0 on every path, so state never holds what the hash cannot see', () => {
    // Deliberate. The JSON round-trip collapsed -0 to 0 on every write path, which is why the
    // audit found no -0 hash divergence. A *faithful* structural clone would let -0 into live
    // state while `canonicalStringify` keeps normalising it (serialize.ts) — putting a value
    // in the world that the determinism proof is blind to, which is the same class of defect
    // as laundering NaN, only pointing the other way. So the clone normalises too.
    const viaSpawn = createWorld({ seed: 1 });
    const a = viaSpawn.spawn(V({ v: -0 }));
    expect(Object.is(viaSpawn.get(a, V)?.v, -0)).toBe(false);
    expect(viaSpawn.get(a, V)?.v).toBe(0);

    const viaAdd = createWorld({ seed: 1 });
    const b = viaAdd.spawn();
    viaAdd.add(b, V, { v: -0 });
    expect(Object.is(viaAdd.get(b, V)?.v, -0)).toBe(false);

    // world.clone() and a JSON round-trip restore must agree — with a faithful -0 they did not.
    const live = createWorld({ seed: 1 });
    const c = live.spawn(V({ v: 1 }));
    live.getOrThrow(c, V).v = -0; // live mutation runs no clone at all
    const cloned = live.clone();
    const restored = createWorld({ seed: 2 });
    restored.restore(JSON.parse(JSON.stringify(live.snapshot())) as WorldSnapshot);
    expect(Object.is(cloned.get(c, V)?.v, -0)).toBe(false);
    expect(Object.is(restored.get(c, V)?.v, -0)).toBe(false);
    expect(cloned.hash()).toBe(restored.hash());
  });

  it('leaves the pre-existing canonicalStringify guard doing its job', () => {
    // The guard was never broken — it was unreachable. It must stay exactly as strict.
    expect(() => canonicalStringify({ v: NaN })).toThrow();
    expect(() => canonicalStringify({ v: Infinity })).toThrow();
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('a clean world still snapshots, hashes and round-trips exactly', () => {
    const w = createWorld({ seed: 'ok' });
    w.spawn(Name({ value: 'a' }), Transform({ position: { x: 1.5, y: -0, z: 3 } }));
    const h = w.hash();
    const w2 = createWorld({ seed: 'other' });
    w2.restore(JSON.parse(JSON.stringify(w.snapshot())) as WorldSnapshot);
    expect(w2.hash()).toBe(h);
  });
});

/**
 * C2 — regression guard against the *half* fix and against the wrong acceptance criterion.
 *
 * The mechanism is **slot-reuse aliasing**: `makeQueryResult` retained only slot indices, and
 * every accessor re-derived a handle from the slot at call time against the *live* generation
 * table. A query result was a set of slots pretending to be a set of entities.
 *
 * That produces two manifestations with **opposite liveness signatures**, which is why a
 * liveness-based criterion cannot cover both:
 *
 * - **(a) view materialised _before_ the mutation** — `{get: IMPOSTOR, tryGet: IMPOSTOR,
 *   has: true, isAlive: false}`. The row's own handle is dead, yet it reads live data.
 * - **(b) query captured before, materialised _after_** — `{get: IMPOSTOR, tryGet: IMPOSTOR,
 *   has: true, isAlive: true}`, and the row's handle *equals* the reborn entity's. Nothing is
 *   dead; every accessor agrees; `count()` stays at the pre-mutation size and `entities()`
 *   reports the impostor as a member. Silent substitution, not a dropped row.
 *
 * A liveness fix closes (a) and leaves (b) wide open. So every assertion here is against the
 * impostor's sentinel value and the query-time handle — never against `isAlive`. Both variants
 * are covered: {@link afterSlotReuse} is (b), {@link eagerViewAfterReuse} is (a).
 */
describe('World — C2 acceptance criteria (slot-reuse aliasing: identity, not liveness)', () => {
  const Tag = defineComponent<{ v: number }>({ id: 'Tag', defaults: () => ({ v: 0 }) });
  const ORIGINAL = 1;
  const IMPOSTOR = 999;

  /**
   * Variant (b): query captured while the match was alive, consumed after its slot was reused.
   * Pre-fix every accessor reported the reborn entity as a live member of the result.
   */
  function afterSlotReuse(): {
    world: ReturnType<typeof createWorld>;
    result: ReturnType<ReturnType<typeof createWorld>['query']>;
    original: number;
    impostor: number;
  } {
    const world = createWorld({ seed: 1 });
    const original = world.spawn(Tag({ v: ORIGINAL }));
    const result = world.query({ has: [Tag] });
    world.despawn(original);
    const impostor = world.spawn(Tag({ v: IMPOSTOR }));
    expect(entityIndex(impostor as never)).toBe(entityIndex(original as never)); // same slot
    expect(impostor).not.toBe(original); // bumped generation
    expect(world.isAlive(impostor as never)).toBe(true); // nothing is dead when we read
    return { world, result, original, impostor };
  }

  /**
   * Variant (a): a view materialised *before* the mutation, still held afterwards. Pre-fix its
   * own handle was already dead (`isAlive: false`) while `has` still reported `true` — the
   * opposite liveness signature to variant (b).
   */
  function eagerViewAfterReuse(): {
    view: EntityView;
    original: number;
    impostor: number;
  } {
    const w = createWorld({ seed: 1 });
    const original = w.spawn(Tag({ v: ORIGINAL }));
    const view = w.query({ has: [Tag] }).views()[0]!;
    expect(view.get(Tag).v).toBe(ORIGINAL);
    w.despawn(original);
    const impostor = w.spawn(Tag({ v: IMPOSTOR }));
    expect(w.isAlive(impostor as never)).toBe(true);
    return { view, original, impostor };
  }

  it('the lazily-built row never materialises a handle to the current occupant', () => {
    // Pre-fix this row read {"entity":"8589934593","get":999,"tryGet":999,"has":true,
    // "isAlive":true} — a fresh, valid handle to the impostor, with every accessor agreeing.
    const { result, original, impostor } = afterSlotReuse();
    const view = result.first();
    if (view !== undefined) {
      expect(view.entity).toBe(original);
      expect(view.entity).not.toBe(impostor);
      expect(view.tryGet(Tag)?.v).not.toBe(IMPOSTOR);
      expect(view.has(Tag)).toBe(false);
      expect(() => view.get(Tag)).toThrow();
    }
    // Either the row is gone, or it still refers to the original. Never the impostor.
    expect(result.entities()).not.toContain(impostor);
  });

  for (const [name, extract] of [
    ['iteration', (r: QueryResult): number[] => [...r].map((v) => v.get(Tag).v)],
    ['views()', (r: QueryResult): number[] => r.views().map((v) => v.get(Tag).v)],
    [
      'forEach()',
      (r: QueryResult): number[] => {
        const out: number[] = [];
        r.forEach((v) => out.push(v.get(Tag).v));
        return out;
      },
    ],
    [
      'first()',
      (r: QueryResult): number[] => (r.first() === undefined ? [] : [r.first()!.get(Tag).v]),
    ],
    [
      'one()',
      (r: QueryResult): number[] => {
        try {
          return [r.one().get(Tag).v];
        } catch {
          return [];
        }
      },
    ],
  ] as const) {
    it(`${name} never yields the impostor's data`, () => {
      const { result } = afterSlotReuse();
      expect(extract(result)).not.toContain(IMPOSTOR);
      expect(extract(result)).toEqual([]);
    });
  }

  it('variant (b): a surviving sibling still resolves, only the reused row goes', () => {
    // The sharpest form of the criterion: pre-fix `count()` stayed at 2 and `entities()`
    // reported the reborn entity as a member — silent substitution. The result must now report
    // the untouched match exactly as before, and must not substitute anything for the other.
    const w = createWorld({ seed: 1 });
    const doomed = w.spawn(Tag({ v: ORIGINAL }));
    const survivor = w.spawn(Tag({ v: 7 }));
    const result = w.query({ has: [Tag] });
    expect(result.count()).toBe(2);

    w.despawn(doomed);
    const reborn = w.spawn(Tag({ v: IMPOSTOR }));
    expect(w.isAlive(reborn as never)).toBe(true); // nothing is dead when we read

    expect(result.count()).toBe(1);
    expect(result.entities()).toEqual([survivor]);
    expect(result.entities()).not.toContain(reborn);
    expect([...result].map((v) => v.get(Tag).v)).toEqual([7]);
    expect(result.views().map((v) => v.get(Tag).v)).toEqual([7]);
    expect(result.first()?.entity).toBe(survivor);
    expect(result.one().get(Tag).v).toBe(7);
    // And a fresh query does see the reborn entity — the result is scoped, not poisoned.
    expect(w.query({ has: [Tag] }).entities()).toEqual([reborn, survivor]);
  });

  it('covers every accessor on QueryResult — a new one cannot be added uncovered', () => {
    // The defect was five accessors each independently re-deriving the handle from the slot,
    // so five call sites leaked. `views()` in particular is the path @aegis/content's
    // healthSystem takes, so a fix applied to iteration alone would leave a shipped engine
    // system broken while looking correct. This asserts the surface itself, so adding a
    // sixth accessor without covering it fails here.
    const { result } = afterSlotReuse();
    const covered = new Set(['count', 'entities', 'views', 'first', 'one', 'forEach']);
    const actual = new Set(Object.keys(result));
    expect(actual).toEqual(covered);
    expect(typeof result[Symbol.iterator]).toBe('function');

    // And every one of them, in one place, reports the row as gone rather than as the impostor.
    const outcomes = {
      iteration: [...result].map((v) => v.get(Tag).v),
      views: result.views().map((v) => v.get(Tag).v),
      entities: result.entities(),
      first: result.first(),
      count: result.count(),
      forEach: (() => {
        const o: number[] = [];
        result.forEach((v) => o.push(v.get(Tag).v));
        return o;
      })(),
      one: (() => {
        try {
          return result.one().get(Tag).v;
        } catch {
          return 'refused';
        }
      })(),
    };
    expect(outcomes).toEqual({
      iteration: [],
      views: [],
      entities: [],
      first: undefined,
      count: 0,
      forEach: [],
      one: 'refused',
    });
  });

  it('views() is safe for the consumption shape @aegis/content healthSystem uses', () => {
    // `for (const view of world.query({...}).views()) { view.get(Health); world.get(view.entity, Name); }`
    // Reproduced here because core cannot depend on content (dependency boundary).
    const Health = defineComponent<{ current: number }>({
      id: 'Health',
      defaults: () => ({ current: 0 }),
    });
    const w = createWorld({ seed: 1 });
    const doomed = w.spawn(Name({ value: 'DOOMED' }), Health({ current: 0 }));
    const rows = w.query({ has: [Health] });
    w.despawn(doomed);
    w.spawn(Name({ value: 'BYSTANDER' }), Health({ current: 10 }));

    const reported = rows.views().map((v) => w.get(v.entity, Name)?.value ?? '<none>');
    expect(reported).not.toContain('BYSTANDER');
    expect(reported).toEqual([]);
  });

  it('entities() returns query-time handles, never a freshly packed one', () => {
    const { result, original, impostor } = afterSlotReuse();
    for (const e of result.entities()) {
      expect(e).not.toBe(impostor);
      expect(e).toBe(original);
    }
  });

  it('count() does not count the entity that took the slot', () => {
    const { result } = afterSlotReuse();
    expect(result.count()).toBe(0);
  });

  it('one() refuses rather than returning the impostor', () => {
    const { result } = afterSlotReuse();
    let value: number | 'threw';
    try {
      value = result.one().get(Tag).v;
    } catch {
      value = 'threw';
    }
    expect(value).not.toBe(IMPOSTOR);
  });

  it('an eagerly-built view keeps its own identity across the reuse', () => {
    const { view, original, impostor } = eagerViewAfterReuse();
    expect(view.entity).toBe(original);
    expect(view.entity).not.toBe(impostor);
  });

  // Asserted one accessor per test so a fix that guards only one fails by name. `has()` is
  // what guards most system code, so `get()` being correct on its own is not enough.
  it('has() on a reused-slot row does not claim the impostor’s component', () => {
    expect(eagerViewAfterReuse().view.has(Tag)).toBe(false);
    expect(eagerViewAfterReuse().view.has('Tag')).toBe(false);
  });

  it('tryGet() on a reused-slot row does not return the impostor’s data', () => {
    const { view } = eagerViewAfterReuse();
    expect(view.tryGet(Tag)?.v).not.toBe(IMPOSTOR);
    expect(view.tryGet(Tag)).toBeUndefined();
  });

  it('get() on a reused-slot row does not return the impostor’s data', () => {
    const { view } = eagerViewAfterReuse();
    let value: number | 'threw';
    try {
      value = view.get(Tag).v;
    } catch {
      value = 'threw';
    }
    expect(value).not.toBe(IMPOSTOR);
    expect(value).toBe('threw');
  });

  it('mid-iteration slot reuse does not swap a pending row (LIFO free list)', () => {
    const w = createWorld({ seed: 1 });
    w.spawn(Tag({ v: 10 }));
    w.spawn(Tag({ v: 20 }));
    const third = w.spawn(Tag({ v: 30 }));
    const seen: number[] = [];
    let i = 0;
    for (const view of w.query({ has: [Tag] })) {
      if (i === 1) {
        w.despawn(third);
        w.spawn(Tag({ v: IMPOSTOR })); // takes third's slot immediately
      }
      seen.push(view.get(Tag).v);
      i++;
    }
    expect(seen).not.toContain(IMPOSTOR);
    expect(seen).toEqual([10, 20]);
  });

  it('a live row is completely unaffected — the rule is identity, not "always refuse"', () => {
    const w = createWorld({ seed: 1 });
    const e = w.spawn(Tag({ v: 42 }));
    const view = w.query({ has: [Tag] }).one();
    expect(view.entity).toBe(e);
    expect(view.has(Tag)).toBe(true);
    expect(view.tryGet(Tag)).toEqual({ v: 42 });
    expect(view.get(Tag).v).toBe(42);
    expect(w.query({ has: [Tag] }).count()).toBe(1);
  });
});

/**
 * C2 — query iteration used to hand out handles to the wrong, live entity.
 *
 * `query()` stored raw slot indices and `makeView` packed a handle at *consumption* time from
 * whatever generation the slot held *then*. The free list is LIFO, so a despawn+spawn inside a
 * system loop reused the slot immediately and the pending row resolved to the impostor — real
 * data, wrong entity, no error.
 */
describe('World — query rows are handles, not slots (C2)', () => {
  const Tag = defineComponent<{ n: string; x: number }>({
    id: 'Tag',
    defaults: () => ({ n: '', x: 0 }),
  });

  it('never yields a recycled slot as if it were the matched entity', () => {
    const w = createWorld({ seed: 1 });
    w.spawn(Tag({ n: 'first', x: 10 }));
    w.spawn(Tag({ n: 'second', x: 20 }));
    const third = w.spawn(Tag({ n: 'third', x: 30 }));

    const seen: string[] = [];
    let i = 0;
    for (const view of w.query({ has: [Tag] })) {
      if (i === 1) {
        w.despawn(third);
        w.spawn(Tag({ n: 'IMPOSTOR', x: 999 })); // reuses third's slot (LIFO free list)
      }
      seen.push(view.get(Tag).n);
      i++;
    }
    // Pre-fix: ['first', 'second', 'IMPOSTOR'].
    expect(seen).toEqual(['first', 'second']);
  });

  it('entities() never manufactures a fresh handle from a recycled slot', () => {
    const w = createWorld({ seed: 1 });
    const a = w.spawn(Tag({ n: 'a' }));
    const b = w.spawn(Tag({ n: 'b' }));
    const result = w.query({ has: [Tag] });
    w.despawn(b);
    const impostor = w.spawn(Tag({ n: 'impostor' }));
    // Pre-fix: [a, impostor] — the impostor's handle, freshly packed from b's slot.
    expect(result.entities()).toEqual([a]);
    expect(result.entities()).not.toContain(impostor);
    expect(result.count()).toBe(1);
  });

  it('views(), first(), one() and forEach() all skip despawned rows', () => {
    const w = createWorld({ seed: 1 });
    const a = w.spawn(Tag({ n: 'a' }));
    const b = w.spawn(Tag({ n: 'b' }));
    const result = w.query({ has: [Tag] });
    w.despawn(a);
    w.spawn(Tag({ n: 'impostor' })); // reuses a's slot

    expect(result.views().map((v) => v.get(Tag).n)).toEqual(['b']);
    expect(result.first()?.entity).toBe(b);
    expect(result.one().get(Tag).n).toBe('b');
    const visited: string[] = [];
    result.forEach((v) => visited.push(v.get(Tag).n));
    expect(visited).toEqual(['b']);
  });

  it('a view held past its entity\u2019s despawn reports absent, never another entity', () => {
    const w = createWorld({ seed: 1 });
    const a = w.spawn(Tag({ n: 'a', x: 1 }));
    const view = w.query({ has: [Tag] }).one();
    expect(view.get(Tag).n).toBe('a');

    w.despawn(a);
    w.spawn(Tag({ n: 'impostor', x: 999 })); // same slot, new generation

    expect(view.tryGet(Tag)).toBeUndefined();
    expect(view.has(Tag)).toBe(false);
    expect(() => view.get(Tag)).toThrow(/stale/);
    expect(view.entity).toBe(a); // the handle it was created with, not the impostor's
  });

  it('despawning the row you are standing on is still safe', () => {
    const w = createWorld({ seed: 1 });
    for (const n of ['a', 'b', 'c']) w.spawn(Tag({ n }));
    const seen: string[] = [];
    for (const view of w.query({ has: [Tag] })) {
      seen.push(view.get(Tag).n);
      w.despawn(view.entity);
    }
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(w.entityCount).toBe(0);
  });
});

describe('World — restore validates its input (minor)', () => {
  function baseSnapshot(): WorldSnapshot {
    const w = createWorld({ seed: 1 });
    w.spawn(Name({ value: 'a' }));
    return JSON.parse(JSON.stringify(w.snapshot())) as WorldSnapshot;
  }

  function expectInvalid(mutate: (s: WorldSnapshot) => void, pathFragment: string): void {
    const snap = baseSnapshot();
    mutate(snap);
    const w = createWorld({ seed: 1 });
    try {
      w.restore(snap);
    } catch (err) {
      expect(err).toBeInstanceOf(DiagnosticError);
      const d = (err as DiagnosticError).diagnostics[0] as Diagnostic;
      expect(d.code).toBe(CoreDiagnosticCode.InvalidSnapshot);
      expect(d.location?.path).toContain(pathFragment);
      return;
    }
    throw new Error(`expected restore to reject the snapshot (${pathFragment})`);
  }

  it('rejects an out-of-range entity id instead of producing a world that hashes "NaN"', () => {
    // Pre-fix: restore accepted this and the resulting snapshot contained `"id": "NaN"`.
    expectInvalid((s) => ((s.entities[0] as { id: string }).id = '999999999999999'), 'id');
    expectInvalid((s) => ((s.entities[0] as { id: string }).id = 'not-a-number'), 'id');
    expectInvalid((s) => ((s.entities[0] as { id: string }).id = '0'), 'id');
  });

  it('rejects a stale generation, a duplicated slot and a live-but-free slot', () => {
    expectInvalid(
      (s) => ((s.entities[0] as { id: string }).id = String(makeEntity(0, 7))),
      'entities[0].id',
    );
    expectInvalid((s) => {
      (s.entities as unknown[]).push({ ...(s.entities[0] as object) });
    }, 'entities[1].id');
    expectInvalid((s) => ((s.allocator as { free: number[] }).free = [0]), 'entities[0].id');
  });

  it('rejects a malformed version, tick, allocator or PRNG state', () => {
    expectInvalid((s) => ((s as { version: number }).version = 2), 'version');
    expectInvalid((s) => ((s as { tick: number }).tick = -1), 'tick');
    expectInvalid((s) => ((s as { tick: number }).tick = 1.5), 'tick');
    expectInvalid((s) => ((s as { prng: unknown }).prng = { s: [1, 2, 3, -4] }), 'prng.s');
    expectInvalid((s) => ((s.allocator as { slots: number[] }).slots = [0]), 'allocator.slots[0]');
    expectInvalid((s) => ((s.allocator as { free: number[] }).free = [42]), 'allocator.free[0]');
  });

  it('still accepts every snapshot the world itself produces', () => {
    const w = createWorld({ seed: 1 });
    w.spawn(Name({ value: 'a' }), Transform());
    const b = w.spawn(Transform());
    w.despawn(b); // leave a free slot and a bumped generation behind
    w.spawn(Transform());
    const restored = createWorld({ seed: 2 });
    expect(() => restored.restore(w.snapshot())).not.toThrow();
    expect(restored.hash()).toBe(w.hash());
  });
});

describe('World — entity generation cannot silently overflow (minor)', () => {
  it('refuses to recycle a slot past the exactly-representable generation', () => {
    const w = createWorld({ seed: 1 });
    const e = w.spawn();
    // Fast-forward the allocator to the last generation a float64 handle encodes exactly.
    const snap = w.snapshot() as unknown as { allocator: { slots: number[] }; entities: unknown[] };
    snap.allocator.slots[0] = MAX_ENTITY_GENERATION;
    (snap.entities[0] as { id: string }).id = String(makeEntity(0, MAX_ENTITY_GENERATION));
    w.restore(snap as unknown as WorldSnapshot);

    const last = w.query({}).entities()[0] as number;
    // Pre-fix: the generation rolled past 2^21 and two distinct entities on an odd slot packed
    // to the same handle — an alive-but-unaddressable entity.
    expect(() => w.despawn(last as never)).toThrow(/recycled/);
    expect(String(e)).toBeTruthy();
  });

  it('makeEntity rejects a generation it cannot represent exactly', () => {
    expect(() => makeEntity(1, MAX_ENTITY_GENERATION + 1)).toThrow(RangeError);
    // The very last exactly-representable handle.
    expect(makeEntity(2 ** 32 - 1, MAX_ENTITY_GENERATION)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
