/**
 * The contract every mode module implements so the harness can run it without knowing the
 * mode's internals. This is the seam that keeps the dependency graph acyclic: `@aegis/mode-*`
 * depends on the harness to implement {@link ModePlugin}; the harness depends only on this
 * interface, never on a concrete mode.
 * @packageDocumentation
 */
import type { ComponentType, GameMode, Schedule } from '@aegis/core';
import type { ViewProvider } from './view.js';

/** Everything a mode contributes to a simulation. */
export interface ModePlugin {
  /** Which mode this is. */
  readonly mode: GameMode;
  /**
   * Component types this mode defines (velocity, colliders, camera rig, …). The harness
   * registers these — together with the core and content components — before loading a scene.
   */
  components(): readonly ComponentType<unknown>[];
  /**
   * Build the ordered systems for one simulation of this mode (movement, collision, camera).
   * Called once per run; must be pure with respect to global state.
   */
  systems(): Schedule;
  /** The projection used to produce semantic frames / ASCII views for this mode. */
  view(): ViewProvider;
}
