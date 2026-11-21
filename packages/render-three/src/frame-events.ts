import type { EventReader, GameEvent } from '@aegis/core';
import type { EventLine } from './protocol.js';

export function toEventLines(
  events: readonly GameEvent[],
  withData = false,
  offset = 0,
): EventLine[] {
  return events.map((event, index) => ({
    type: event.type,
    tick: event.tick,
    ...(withData ? { data: event.data, sequence: offset + index } : {}),
  }));
}

/** Each consumer advances its own cursor within a session generation. */
export function drainEventLines(
  reader: EventReader,
  cursor: { eventCursor: number },
  withData: boolean,
): EventLine[] {
  const offset = cursor.eventCursor;
  const tail = reader.since(offset);
  cursor.eventCursor += tail.length;
  return toEventLines(tail, withData, offset);
}
