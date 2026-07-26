import { describe, it, expect } from 'vitest';
import { createEventBus } from './events.js';
import { CLEAR_TICK } from './internal.js';
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
