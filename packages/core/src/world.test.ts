import { describe, it, expect } from 'vitest';
import { createWorld } from './world.js';
import { defineComponent, defineTag, defineResource } from './component.js';
import { Name, Transform } from './components.js';
import { MAX_ENTITY_GENERATION, NULL_ENTITY, makeEntity } from './entity.js';
import { CoreDiagnosticCode } from './codes.js';
import { DiagnosticError } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
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
 * C1 — the state hash used to be blind to `NaN`/`±Infinity`.
 *
 * `deepClone` was `JSON.parse(JSON.stringify(v))`, and `snapshot()` laundered every value
 * through it *before* `canonicalStringify` saw them. JSON maps non-finite numbers to `null`, so
 * the guard in the canonical encoder could never fire on the world path. Measured pre-fix:
 * hash-with-Infinity === hash-with-NaN === hash-with-null === `1828ce18db63727f`.
 */
describe('World — non-finite state is visible to the hash (C1)', () => {
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

  it('stores non-finite component values instead of laundering them to null', () => {
    const w = createWorld({ seed: 1 });
    const e = w.spawn(V({ v: Infinity }));
    // Pre-fix this read back `{ v: null }`.
    expect(w.get(e, V)?.v).toBe(Infinity);
    const n = w.spawn(V({ v: NaN }));
    expect(Number.isNaN(w.get(n, V)?.v as number)).toBe(true);
    const z = w.spawn(V({ v: -0 }));
    expect(Object.is(w.get(z, V)?.v, -0)).toBe(true);
  });

  it('refuses to snapshot a world holding NaN, naming entity, component and path', () => {
    const w = createWorld({ seed: 1 });
    const e = w.spawn(Name({ value: 'hero' }), Transform());
    // Exactly how a sim breaks in practice: a divide-by-zero in a system.
    w.getOrThrow(e, Transform).position.x = 0 / 0;

    const d = diagnosticFrom(() => w.snapshot());
    expect(d.severity).toBe('error');
    expect(d.message).toContain('NaN');
    expect(d.location?.path).toBe(`entities[${String(e)}].components.Transform.position.x`);
    expect(d.data?.entity).toBe(String(e));
    expect(d.data?.entityName).toBe('hero');
    expect(d.data?.component).toBe('Transform');
    expect(d.fix).toBeTruthy();
  });

  it('refuses to hash a world holding ±Infinity (the guard now fires on the world path)', () => {
    const w = createWorld({ seed: 1 });
    const e = w.spawn(V());
    w.getOrThrow(e, V).v = 1 / 0;
    // Pre-fix: this returned a hash indistinguishable from `{ v: null }`.
    expect(() => w.hash()).toThrow(DiagnosticError);
    w.getOrThrow(e, V).v = -1 / 0;
    expect(() => w.hash()).toThrow(DiagnosticError);
  });

  it('distinguishes NaN, Infinity and null rather than collapsing all three', () => {
    const hashOf = (v: unknown): string | 'threw' => {
      const w = createWorld({ seed: 1 });
      w.spawn(V({ v: v as number }));
      try {
        return w.hash();
      } catch {
        return 'threw';
      }
    };
    // Pre-fix all four of these were the same 16-hex string.
    expect(hashOf(Infinity)).toBe('threw');
    expect(hashOf(NaN)).toBe('threw');
    expect(hashOf(null)).not.toBe('threw');
    expect(hashOf(1)).not.toBe(hashOf(null));
  });

  it('reports a non-finite resource with its resource path', () => {
    const Cfg = defineResource<{ gravity: { y: number } }>('Cfg', () => ({ gravity: { y: 0 } }));
    const w = createWorld({ seed: 1 });
    w.setResource(Cfg, { gravity: { y: -Infinity } });
    const d = diagnosticFrom(() => w.snapshot());
    expect(d.location?.path).toBe('resources.Cfg.gravity.y');
    expect(d.data?.entity).toBeNull();
  });

  it('reports the index of a non-finite array element', () => {
    const Path = defineComponent<{ pts: number[] }>({ id: 'Path', defaults: () => ({ pts: [] }) });
    const w = createWorld({ seed: 1 });
    const e = w.spawn(Path({ pts: [1, 2, NaN] }));
    const d = diagnosticFrom(() => w.snapshot());
    expect(d.location?.path).toBe(`entities[${String(e)}].components.Path.pts[2]`);
  });

  it('rejects non-plain data rather than silently canonicalising it to {}', () => {
    const w = createWorld({ seed: 1 });
    // A Date has no enumerable own keys, so it used to survive into state and hash as `{}`.
    expect(() => w.spawn(V({ v: new Date(0) as unknown as number }))).toThrow(/plain JSON/);
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
