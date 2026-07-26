import { describe, it, expect } from 'vitest';
import { createEventBus } from './events.js';
import { createWorld } from './world.js';
import { defineComponent } from './component.js';
import { CLEAR_TICK } from './internal.js';
import type { GameEvent } from './events.js';
import type { ManagedEventBus } from './internal.js';

describe('event bus', () => {
  it('accumulates events for the current tick in emission order', () => {
    const bus = createEventBus() as ManagedEventBus;
    bus[CLEAR_TICK](0);
    bus.emit('A', { n: 1 });
    bus.emit('B', { n: 2 });
    bus.emit('A', { n: 3 });
    const all = bus.thisTick();
    expect(all.map((e) => e.type)).toEqual(['A', 'B', 'A']);
    expect(all.every((e) => e.tick === 0)).toBe(true);
    expect(bus.ofType('A').map((e) => (e.data as { n: number }).n)).toEqual([1, 3]);
  });

  it('clears the per-tick buffer at a tick boundary and re-stamps', () => {
    const bus = createEventBus() as ManagedEventBus;
    bus[CLEAR_TICK](0);
    bus.emit('X', {});
    expect(bus.thisTick()).toHaveLength(1);
    bus[CLEAR_TICK](1);
    expect(bus.thisTick()).toHaveLength(0);
    bus.emit('Y', {});
    expect(bus.thisTick()[0]?.tick).toBe(1);
  });

  it('records history only when enabled', () => {
    const off = createEventBus() as ManagedEventBus;
    off[CLEAR_TICK](0);
    off.emit('A', {});
    expect(off.history()).toHaveLength(0);

    const on = createEventBus({ record: true }) as ManagedEventBus;
    on[CLEAR_TICK](0);
    on.emit('A', {});
    on[CLEAR_TICK](1);
    on.emit('A', {});
    on.emit('B', {});
    expect(on.history()).toHaveLength(3);
    expect(on.count('A')).toBe(2);
    expect(on.contains('B')).toBe(true);
    expect(on.contains('Z')).toBe(false);
  });
});

/**
 * M2 — a recorded event used to alias live world state, and the log was publicly mutable.
 *
 * `emit` stored `data` by reference, so an event logged early in a tick was retroactively
 * rewritten when the component it pointed at moved later in the same tick; and `history()`
 * handed back the internal array, so `history().push({ type: 'FORGED' })` made
 * `count('FORGED') === 1`.
 */
describe('event bus — the bus owns the payload (M2)', () => {
  it('does not alias a live component that is mutated later in the tick', () => {
    const bus = createEventBus({ record: true }) as ManagedEventBus;
    bus[CLEAR_TICK](0);
    const live = { hp: 100, pos: { x: 1, y: 2 } };
    bus.emit('damage', live);

    live.hp = 0; // the component moves on, as components do
    live.pos.x = 999;

    // Pre-fix: { hp: 0, pos: { x: 999, y: 2 } } — the log rewrote itself.
    expect(bus.history()[0]?.data).toEqual({ hp: 100, pos: { x: 1, y: 2 } });
    expect(bus.thisTick()[0]?.data).toEqual({ hp: 100, pos: { x: 1, y: 2 } });
  });

  it('is safe when a system emits the live component object itself', () => {
    // Exactly the shipped pattern: `world.events.emit('trigger', { ... trig.data })` in one
    // place and `emit('trigger', trig.data)` in another. The bus makes both correct.
    const Trigger = defineComponent<{ kind: string; armed: boolean }>({
      id: 'Trigger',
      defaults: () => ({ kind: 'goal', armed: true }),
    });
    const w = createWorld({ seed: 1, recordEvents: true });
    const e = w.spawn(Trigger());
    const data = w.getOrThrow(e, Trigger);
    w.events.emit('trigger.entered', data);
    data.armed = false;
    expect(w.events.history()[0]?.data).toEqual({ kind: 'goal', armed: true });
  });

  it('hands out frozen arrays, so the log cannot be forged or truncated', () => {
    const bus = createEventBus({ record: true }) as ManagedEventBus;
    bus[CLEAR_TICK](0);
    bus.emit('real', {});

    const log = bus.history() as GameEvent[];
    // Pre-fix: this push landed in the internal array and count('FORGED') became 1.
    expect(() => log.push({ type: 'FORGED', data: {}, tick: 0 })).toThrow(TypeError);
    expect(bus.count('FORGED')).toBe(0);
    expect(bus.contains('FORGED')).toBe(false);
    expect(bus.history()).toHaveLength(1);

    const tickBuf = bus.thisTick() as GameEvent[];
    expect(() => tickBuf.pop()).toThrow(TypeError);
    expect(() => (bus.ofType('real') as GameEvent[]).push(tickBuf[0] as GameEvent)).toThrow(
      TypeError,
    );
    expect(bus.thisTick()).toHaveLength(1);
  });

  it('freezes the event and its payload, so a reader cannot rewrite history', () => {
    const bus = createEventBus({ record: true }) as ManagedEventBus;
    bus[CLEAR_TICK](0);
    bus.emit('hit', { amount: 5, source: { id: 'a' } });
    const ev = bus.history()[0] as GameEvent<{ amount: number; source: { id: string } }>;
    expect(() => ((ev as { type: string }).type = 'miss')).toThrow(TypeError);
    expect(() => (ev.data.amount = 9999)).toThrow(TypeError);
    expect(() => (ev.data.source.id = 'z')).toThrow(TypeError);
    expect(bus.history()[0]?.data).toEqual({ amount: 5, source: { id: 'a' } });
  });

  it('rejects a non-serialisable payload at the emission site', () => {
    const bus = createEventBus({ record: true }) as ManagedEventBus;
    bus[CLEAR_TICK](0);
    expect(() => bus.emit('bad', { at: new Date(0) })).toThrow(/plain JSON/);
  });
});

/**
 * M3 — `world.hash()` covers component state only.
 *
 * The module used to claim "the event stream is itself part of the deterministic state" while
 * `snapshot()` omitted events entirely, so a build whose damage/kill/trigger events diverged
 * completely still passed every `hashEquals` assertion. The claim is now scoped honestly and
 * the event stream has its own digest.
 */
describe('event stream digest (M3)', () => {
  const V = defineComponent<{ v: number }>({ id: 'V', defaults: () => ({ v: 0 }) });

  it('distinguishes runs whose component state converged but whose events did not', () => {
    const quiet = createWorld({ seed: 1, recordEvents: true });
    quiet.spawn(V({ v: 1 }));

    const loud = createWorld({ seed: 1, recordEvents: true });
    loud.spawn(V({ v: 1 }));
    for (let i = 0; i < 5; i++) loud.events.emit('EnemyKilled', { i });

    // The documented limit of the state hash: identical component state, identical digest.
    expect(loud.hash()).toBe(quiet.hash());
    // ...and the event digest is what actually catches the divergence.
    expect(loud.events.digest()).not.toBe(quiet.events.digest());
  });

  it('is order-sensitive and reproducible', () => {
    const make = (types: readonly string[]): string => {
      const w = createWorld({ seed: 1, recordEvents: true });
      for (const t of types) w.events.emit(t, { n: 1 });
      return w.events.digest();
    };
    expect(make(['A', 'B'])).toBe(make(['A', 'B']));
    expect(make(['A', 'B'])).not.toBe(make(['B', 'A']));
    expect(make([])).toBe(make([]));
    expect(make(['A'])).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is sensitive to the payload, not just the type', () => {
    const make = (amount: number): string => {
      const w = createWorld({ seed: 1, recordEvents: true });
      w.events.emit('DamageDealt', { amount });
      return w.events.digest();
    };
    expect(make(10)).not.toBe(make(11));
  });

  it('restore() clears the recorded log instead of double-counting it', () => {
    const w = createWorld({ seed: 1, recordEvents: true });
    w.spawn(V({ v: 1 }));
    const snap = w.snapshot();
    for (let i = 0; i < 3; i++) w.events.emit('Spawned', {});
    expect(w.events.count('Spawned')).toBe(3);

    // Pre-fix: restoring left the previous world's log in place, so every assertion made
    // afterwards counted the pre-restore events too.
    w.restore(snap);
    expect(w.events.count('Spawned')).toBe(0);
    expect(w.events.history()).toHaveLength(0);
    expect(w.events.thisTick()).toHaveLength(0);
    expect(w.events.digest()).toBe(createWorld({ seed: 1, recordEvents: true }).events.digest());
  });
});
