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
import { FPS_SYSTEMS, HITSCAN_HIT, HITSCAN_MISS, WEAPON_FIRED } from './systems.js';
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

/** Authored resource vocabulary, shared by the mode and composed game plugins. */
const dimensions = {
  width: 'nonnegative-integer',
  height: 'nonnegative-integer',
  tileSize: 'positive-number',
  origin: { fields: { x: 'number', z: 'number' } },
} as const;
const tile = { solid: 'boolean', floor: 'number', ceil: 'number' } as const;
const flags = { door: 'boolean', hazard: 'boolean' } as const;
export const FPS_RESOURCES = [
  {
    ...FPS_FLOORPLAN,
    schema: {
      fields: {
        ...dimensions,
        rows: { array: 'string' },
        legend: { record: { fields: tile, optional: flags } },
      },
    },
  },
  {
    ...FPS_COLLISION,
    schema: {
      fields: {
        ...dimensions,
        cells: { array: { fields: { ...tile, ...flags, key: 'string' } } },
      },
    },
  },
] as const;

export const FPS_INPUTS = { actions: ['Fire', 'Jump'], axes: ['Forward', 'Strafe'] } as const;
export const FPS_EVENTS = {
  [WEAPON_FIRED]: { fields: { tick: 'number' } },
  [HITSCAN_MISS]: { fields: { tick: 'number' } },
  [HITSCAN_HIT]: { fields: { target: 'string', distance: 'number', tick: 'number' } },
} as const;

/** The FPS mode plugin. */
export const fpsPlugin: ModePlugin = {
  mode: 'fps',
  components: () => FPS_COMPONENTS,
  resources: () => FPS_RESOURCES,
  inputs: () => FPS_INPUTS,
  events: () => FPS_EVENTS,
  systems: () => fpsSchedule(),
  init: (world) => initFloorplan(world),
  view: () => new FpsViewProvider(),
};
