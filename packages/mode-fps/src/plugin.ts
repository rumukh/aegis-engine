/**
 * The FPS {@link ModePlugin}: capsule movement with 3D gravity/jump, look accumulation,
 * capsule-vs-world collision, and hitscan resolution — projected through a perspective camera.
 * Its `init` extrudes the authored ASCII floorplan into collision geometry once per run; its
 * systems then resolve movement and rays against that geometry (ADR-0010, ADR-0006).
 * @packageDocumentation
 */
import { createSchedule } from '@aegis/core';
import type { Schedule, World } from '@aegis/core';
import type { ModePlugin } from '@aegis/harness';
import { FPS_COMPONENTS } from './components.js';
import { FPS_COLLISION, FPS_FLOORPLAN, extrudeFloorplan } from './geometry.js';
import { FPS_SYSTEMS } from './systems.js';
import { FpsViewProvider } from './view.js';

/** Build the FPS schedule from the mode's ordered systems. */
export function fpsSchedule(): Schedule {
  return createSchedule().addAll(FPS_SYSTEMS);
}

/**
 * Per-run setup: extrude the scene-supplied {@link FPS_FLOORPLAN} floorplan into a
 * {@link FPS_COLLISION} grid the physics and hitscan systems query. Runs once, after the scene is
 * instantiated and before tick 0. Deterministic — pure data transformation, no wall-clock or RNG.
 */
export function initFloorplan(world: World): void {
  const spec = world.getResource(FPS_FLOORPLAN);
  if (spec === undefined || spec.width === 0 || spec.height === 0) return;
  world.setResource(FPS_COLLISION, extrudeFloorplan(spec));
}

/** The FPS mode plugin. */
export const fpsPlugin: ModePlugin = {
  mode: 'fps',
  components: () => FPS_COMPONENTS,
  systems: () => fpsSchedule(),
  init: (world) => initFloorplan(world),
  view: () => new FpsViewProvider(),
};
