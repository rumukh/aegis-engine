/**
 * Cross-module control hooks used *within* `@aegis/core` only.
 *
 * These symbols expose the small amount of mutation the scheduler needs to drive a world and
 * its event bus (advancing the tick, rolling the per-tick event buffer) without widening the
 * public {@link "./world".World} / {@link "./events".EventBus} interfaces. This module is
 * deliberately **not** re-exported from `index.ts`, so nothing here reaches the package's
 * public surface.
 * @packageDocumentation
 */
import type { EventBus } from './events.js';

/** Set the world's current tick (scheduler-only). */
export const SET_TICK = Symbol('aegis.setTick');

/**
 * Begin a new tick on the event bus: clear the per-tick buffer and set the tick that
 * subsequent {@link "./events".EventWriter.emit} calls are stamped with (scheduler-only).
 */
export const CLEAR_TICK = Symbol('aegis.clearTick');

/** A world with the scheduler-only tick control attached. */
export interface TickControlledWorld {
  [SET_TICK](tick: number): void;
}

/** An event bus with the scheduler-only per-tick buffer control attached. */
export interface ManagedEventBus extends EventBus {
  [CLEAR_TICK](tick: number): void;
}
