/**
 * Regression tests for the shallow-merge aliasing footgun in `defineComponent`'s `create`
 * (and the symmetric one in `World.setResource`). Before the fix, a nested object passed in
 * `init` was aliased into world state rather than copied: two entities built from one literal
 * shared mutable state, and the simulation could mutate a caller's own object in place. Each
 * test below fails on the pre-fix code and passes once `create`/`setResource` deep-copy.
 */
import { describe, it, expect } from 'vitest';
import { createWorld } from './world.js';
import { defineComponent, defineResource } from './component.js';
import { Transform } from './components.js';

interface Nested {
  inner: { n: number };
  tag: string;
}
const Boxed = defineComponent<Nested>({
  id: 'Boxed',
  defaults: () => ({ inner: { n: 0 }, tag: '' }),
});

describe('defineComponent.create — defensive deep-copy (no caller aliasing)', () => {
  it('does not retain the caller-owned nested object in the built instance', () => {
    const inner = { n: 1 };
    const inst = Boxed({ inner });
    // The instance must own an independent copy, not the caller's object.
    expect(inst.value.inner).not.toBe(inner);
    inner.n = 999;
    expect(inst.value.inner.n).toBe(1);
  });

  it('two instances built from ONE literal do not share nested state', () => {
    const shared = { n: 1 };
    const a = Boxed({ inner: shared });
    const b = Boxed({ inner: shared });
    expect(a.value.inner).not.toBe(b.value.inner);
    a.value.inner.n = 42;
    expect(b.value.inner.n).toBe(1);
  });

  it('type.create() returns fully-owned data (used by World.add)', () => {
    const inner = { n: 5 };
    const v = Boxed.create({ inner });
    expect(v.inner).not.toBe(inner);
    inner.n = -1;
    expect(v.inner.n).toBe(5);
  });
});

describe('World.add — stores owned data, never the caller object', () => {
  it('mutating the caller literal after add does not affect stored state', () => {
    const w = createWorld({ seed: 1 });
    const e = w.spawn();
    const pos = { x: 1, y: 2, z: 3 };
    w.add(e, Transform, { position: pos });
    pos.x = 999;
    expect(w.getOrThrow(e, Transform).position.x).toBe(1);
    expect(w.getOrThrow(e, Transform).position).not.toBe(pos);
  });

  it('two entities added from ONE literal do not share nested state', () => {
    const w = createWorld({ seed: 1 });
    const a = w.spawn();
    const b = w.spawn();
    const pos = { x: 1, y: 2, z: 3 };
    w.add(a, Transform, { position: pos });
    w.add(b, Transform, { position: pos });
    w.getOrThrow(a, Transform).position.x = 42;
    expect(w.getOrThrow(b, Transform).position.x).toBe(1);
  });
});

describe('World.spawn — stores owned data (defence in depth)', () => {
  it('mutating the caller literal after spawn does not affect stored state', () => {
    const w = createWorld({ seed: 1 });
    const pos = { x: 7, y: 8, z: 9 };
    const e = w.spawn(Transform({ position: pos }));
    pos.y = 999;
    expect(w.getOrThrow(e, Transform).position.y).toBe(8);
  });

  it('two entities spawned from ONE instance-literal do not share nested state', () => {
    const w = createWorld({ seed: 1 });
    const pos = { x: 0, y: 0, z: 0 };
    const a = w.spawn(Transform({ position: pos }));
    const b = w.spawn(Transform({ position: pos }));
    w.getOrThrow(a, Transform).position.z = 5;
    expect(w.getOrThrow(b, Transform).position.z).toBe(0);
  });
});

describe('World.setResource — stores owned data, never the caller object', () => {
  it('mutating the caller object after setResource does not affect the resource', () => {
    const w = createWorld({ seed: 1 });
    const Cfg = defineResource<{ nested: { n: number } }>('Cfg', () => ({ nested: { n: 0 } }));
    const obj = { nested: { n: 1 } };
    w.setResource(Cfg, obj);
    obj.nested.n = 999;
    expect(w.getResource(Cfg)?.nested.n).toBe(1);
    expect(w.getResource(Cfg)).not.toBe(obj);
  });
});
