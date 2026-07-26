/**
 * The Sector Breach {@link ModePlugin}: the FPS mode composed with the game's own vocabulary and
 * rules into a single plugin the harness can run.
 *
 * The harness builds a run's schedule from `plugin.systems()` alone, so a game that adds systems
 * must hand the harness a plugin whose schedule already contains them. Rather than mutate the
 * frozen `fpsPlugin`, this composes a new plugin that:
 *  - registers the mode's components **plus** the game markers/AI (`components()`),
 *  - runs the mode pipeline, then `@aegis/content`'s `healthSystem`, then the game systems
 *    (`systems()`), and
 *  - reuses the mode's floorplan extrusion (`init`) and perspective view (`view`).
 *
 * This is a documented deviation from the spec's literal `fpsPlugin` import — see the handoff.
 * @packageDocumentation
 */
import { createSchedule } from '@aegis/core';
import type { Schedule } from '@aegis/core';
import { healthSystem } from '@aegis/content';
import type { ModePlugin } from '@aegis/harness';
import { FPS_COMPONENTS, FPS_SYSTEMS, FpsViewProvider, initFloorplan } from '@aegis/mode-fps';
import { GAME_COMPONENTS } from './components.js';
import { SECTOR_BREACH_SYSTEMS } from './systems.js';

/**
 * Build the composed schedule: the FPS pipeline, then content's health/death resolution, then
 * the game's semantic systems. Ordering within each phase is still resolved by each system's
 * `after`/`before` — e.g. `game.grunt.ai` after `fps.integrate`, `game.death.map` after
 * `content.health.death`.
 */
export function sectorBreachSchedule(): Schedule {
  return createSchedule().addAll(FPS_SYSTEMS).add(healthSystem).addAll(SECTOR_BREACH_SYSTEMS);
}

/** The Sector Breach plugin: FPS mode + game rules, ready for `runScene` / `defineGameTest`. */
export const sectorBreachPlugin: ModePlugin = {
  mode: 'fps',
  components: () => [...FPS_COMPONENTS, ...GAME_COMPONENTS],
  systems: () => sectorBreachSchedule(),
  init: (world) => initFloorplan(world),
  view: () => new FpsViewProvider(),
};
