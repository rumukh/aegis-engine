import { createEventBus } from '@aegis/core';
import { expect, it, vi } from 'vitest';
import { drainEventLines } from './frame-events.js';

it('copies no old log entries on 100 idle drains, then only a three-event tail', () => {
  const bus = createEventBus({ record: true });
  for (let i = 0; i < 10_000; i++) bus.emit('station', i);
  const first = bus.history()[0];
  const cursor = { eventCursor: 10_000 };
  // Count actual reference copies by slice on this specific log (and copies of the log).
  // The former history().slice(cursor) is the positive control, not an estimate from timing.
  const slice = Array.prototype.slice;
  let copied = 0;
  const spy = vi.spyOn(Array.prototype, 'slice').mockImplementation(function (
    this: unknown[],
    start,
    end,
  ) {
    const result = slice.call(this, start, end);
    if (this[0] === first) copied += result.length;
    return result;
  });
  try {
    for (let i = 0; i < 100; i++) bus.history().slice(cursor.eventCursor);
    const control = copied;
    copied = 0;
    for (let i = 0; i < 100; i++) drainEventLines(bus, cursor, true);
    const idle = copied;
    for (const data of ['a', 'b', 'c']) bus.emit('burst', data);
    const batch = drainEventLines(bus, cursor, true);
    expect([control, idle, copied]).toEqual([1_000_000, 0, 3]);
    expect(batch.map((e) => [e.sequence, e.data])).toEqual([
      [10_000, 'a'],
      [10_001, 'b'],
      [10_002, 'c'],
    ]);
  } finally {
    spy.mockRestore();
  }
});
