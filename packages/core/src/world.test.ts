import { describe, it, expect } from 'vitest';
import { createWorld } from './world.js';
import { defineComponent, defineTag, defineResource } from './component.js';
import { Name, Transform } from './components.js';
import { NULL_ENTITY } from './entity.js';

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
