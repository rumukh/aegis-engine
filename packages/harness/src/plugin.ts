/**
 * The contract every mode module implements so the harness can run it without knowing the
 * mode's internals. This is the seam that keeps the dependency graph acyclic: `@aegis/mode-*`
 * depends on the harness to implement {@link ModePlugin}; the harness depends only on this
 * interface, never on a concrete mode.
 * @packageDocumentation
 */
import type { ComponentType, GameMode, ResourceType, Schedule, World } from '@aegis/core';
import type { PrefabFile } from '@aegis/content';
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
   * Resource IDs this plugin accepts in authored scenes, including game-owned resources.
   * Compose the mode's declarations with the game's. Omitted means no authored resources;
   * legacy callers may instead supply an explicit resource registry to the bootstrap/run.
   * Runtime resources created by systems do not need registration to be stored in a World.
   */
  resources?(): readonly (ResourceType<unknown> | string)[];
  /**
   * Reusable prefab documents, keyed by unique `name`. Available to every run path, including
   * CLI and live sessions. A caller-supplied PrefabResolver takes precedence over this catalog.
   */
  prefabs?(): readonly PrefabFile[];
  /**
   * Build the ordered systems for one simulation of this mode (movement, collision, camera).
   * Called once per run; must be pure with respect to global state.
   */
  systems(): Schedule;
  /**
   * Optional per-run setup, called **once** by the harness after the scene has been
   * instantiated into `world` and before tick 0. This is where a mode derives run-scoped
   * state that is cheaper to build once than every tick: the fps mode extrudes the authored
   * floorplan tilemap into collision geometry, the iso mode bakes a navigation grid, and the
   * platformer spawns its mode-owned moving platforms. Must be deterministic — use
   * `world.random` and `@aegis/core/math`, never wall-clock or `Math.random`.
   *
   * Optional (and therefore backwards-compatible): a mode with no setup omits it, or may
   * instead do first-tick work in a system guarded on `ctx.tick === 0`. Added in the freeze
   * pass on the evidence that all three PoC modes need a setup step; see ADR-0009.
   */
  init?(world: World): void;
  /** The projection used to produce semantic frames / ASCII views for this mode. */
  view(): ViewProvider;
}
