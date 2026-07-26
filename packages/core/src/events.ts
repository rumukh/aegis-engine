/**
 * Deterministic event bus and per-run event log.
 *
 * Systems communicate gameplay facts ("PlayerJumped", "EnemyKilled", "DamageDealt") by
 * emitting events. Events are the primary surface gameplay assertions read (CHARTER
 * principle 6). Delivery is FIFO within a tick and the log preserves global emission order,
 * so the event stream is itself part of the deterministic state.
 *
 * Event `data` must be plain, serialisable data (same rule as components).
 * @packageDocumentation
 */
import { CLEAR_TICK } from './internal.js';
import type { ManagedEventBus } from './internal.js';

/** A single emitted event, stamped with the tick on which it was emitted. */
export interface GameEvent<T = unknown> {
  /** Stable event type, e.g. `"PlayerLanded"`. */
  readonly type: string;
  /** Plain, serialisable payload. */
  readonly data: T;
  /** Tick on which the event was emitted. */
  readonly tick: number;
}

/** Write side of the bus, handed to systems during a tick. */
export interface EventWriter {
  /** Emit an event of `type` carrying `data`. */
  emit<T>(type: string, data: T): void;
}

/** Read side of the bus and the historical log. */
export interface EventReader {
  /** Events emitted on the current tick, in emission order. */
  thisTick(): readonly GameEvent[];
  /** Events emitted on the current tick whose type is `type`. */
  ofType<T = unknown>(type: string): readonly GameEvent<T>[];
  /**
   * The full recorded log across all ticks so far. Present only when the simulation was
   * created with event recording enabled (the harness enables it for assertions).
   */
  history(): readonly GameEvent[];
  /** Total number of events of `type` in {@link EventReader.history}. */
  count(type: string): number;
  /** Whether any event of `type` was ever emitted (across history). */
  contains(type: string): boolean;
}

/** Both ends of the bus. */
export interface EventBus extends EventWriter, EventReader {}

/** Options controlling the bus. */
export interface EventBusOptions {
  /** Retain a full historical log (needed for assertions/replay analysis). Default `false`. */
  record?: boolean;
}

/** Create an event bus. */
export function createEventBus(options?: EventBusOptions): EventBus {
  const record = options?.record ?? false;
  let current: GameEvent[] = [];
  const log: GameEvent[] = [];
  let tick = 0;

  const bus: ManagedEventBus = {
    emit<T>(type: string, data: T): void {
      const event: GameEvent<T> = { type, data, tick };
      current.push(event as GameEvent);
      if (record) log.push(event as GameEvent);
    },
    thisTick(): readonly GameEvent[] {
      return current;
    },
    ofType<T = unknown>(type: string): readonly GameEvent<T>[] {
      return current.filter((e) => e.type === type) as GameEvent<T>[];
    },
    history(): readonly GameEvent[] {
      return log;
    },
    count(type: string): number {
      let n = 0;
      for (const e of log) if (e.type === type) n++;
      return n;
    },
    contains(type: string): boolean {
      for (const e of log) if (e.type === type) return true;
      return false;
    },
    [CLEAR_TICK](nextTick: number): void {
      current = [];
      tick = nextTick;
    },
  };
  return bus;
}
