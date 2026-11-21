/**
 * The isometric {@link ModePlugin}: grid actors that click-to-move along deterministic A\* paths
 * and trade fire on a cooldown, projected 2:1 isometric. This module wires the mode's components,
 * systems, per-run nav-grid bake and view provider into the single object the harness runs.
 *
 * It also exports {@link isoSystems} and {@link isoInit} so a *game* built on this mode can
 * compose the mode's pipeline with its own semantic systems into one plugin — the frozen
 * `RunOptions` has no extra-systems hook, so a game ships a composed `ModePlugin` rather than
 * layering systems onto `isoPlugin` at run time. See the game package for that composition.
 * @packageDocumentation
 */
import { createSchedule } from '@aegis/core';
import type { ComponentType, Schedule, System, World } from '@aegis/core';
import { HEALTH_EVENTS, healthSystem } from '@aegis/content';
import type { ModePlugin, ViewProvider } from '@aegis/harness';
import { ISO_COMPONENTS, IsoGrid, NavGrid } from './components.js';
import { buildNavGrid } from './grid.js';
import { ISO_SYSTEM_LIST, TRIGGER_ENTERED_EVENT } from './systems.js';
import {
  ATTACK_FIRED,
  ATTACK_ORDERED,
  CELL_ENTERED,
  DAMAGE_TAKEN,
  ENEMY_DAMAGED,
  ENEMY_KILLED,
  MOVE_ORDERED,
  PATH_BLOCKED,
  PATH_RESOLVED,
} from './events.js';
import { IsoViewProvider } from './view.js';

export { IsoViewProvider } from './view.js';

/**
 * The mode's systems for one simulation: the iso pipeline plus `@aegis/content`'s generic
 * {@link healthSystem} (so `entity.died` fires when combat drops an actor to zero HP — the
 * signal a game maps to `player.died`). A game composes these with its own systems.
 */
export function isoSystems(): readonly System[] {
  return [...ISO_SYSTEM_LIST, healthSystem];
}

/**
 * Per-run setup: bake the authored {@link IsoGrid} resource into a {@link NavGrid} bitmap once,
 * before tick 0. Kept out of a system because the static grid never changes — dynamic obstacles
 * are layered per pathfinding query. No-op if the scene declared no `IsoGrid`.
 */
export function isoInit(world: World): void {
  const config = world.getResource(IsoGrid);
  if (config === undefined || config.width === 0) return;
  world.setResource(NavGrid, buildNavGrid(config));
}

/** Build the isometric schedule (mode systems only). */
export function isoSchedule(): Schedule {
  return createSchedule().addAll(isoSystems());
}

/** Authored resource vocabulary, shared by the mode and composed game plugins. */
const dimensions = {
  width: 'nonnegative-integer',
  height: 'nonnegative-integer',
  tileSize: 'positive-number',
} as const;
export const ISO_RESOURCES = [
  { ...IsoGrid, schema: { fields: { ...dimensions, walls: { array: 'string' } } } },
  { ...NavGrid, schema: { fields: { ...dimensions, blocked: { array: 'boolean' } } } },
] as const;

export const ISO_INPUTS = { actions: [], axes: [] } as const;
const cell = { fields: { x: 'number', y: 'number' } } as const;
const named = { nullable: 'string' } as const;
const targetCell = { fields: { entity: 'number', target: cell, tick: 'number' } } as const;
export const ISO_EVENTS = {
  ...HEALTH_EVENTS,
  [MOVE_ORDERED]: targetCell,
  [ATTACK_ORDERED]: { fields: { entity: 'number', target: 'number', tick: 'number' } },
  [PATH_RESOLVED]: { fields: { entity: 'number', length: 'number', tick: 'number' } },
  [PATH_BLOCKED]: targetCell,
  [CELL_ENTERED]: { fields: { entity: 'number', x: 'number', y: 'number', tick: 'number' } },
  [ATTACK_FIRED]: { fields: { attacker: 'number', target: 'number', tick: 'number' } },
  [DAMAGE_TAKEN]: { fields: { amount: 'number', source: 'number', remaining: 'number' } },
  [ENEMY_DAMAGED]: { fields: { name: named, amount: 'number', remaining: 'number' } },
  [ENEMY_KILLED]: { fields: { name: named, tick: 'number' } },
  [TRIGGER_ENTERED_EVENT]: {
    fields: { entity: 'number', name: named, kind: 'string', tick: 'number' },
    optional: { data: { record: 'any' } },
  },
} as const;

/** The isometric mode plugin. */
export const isoPlugin: ModePlugin = {
  mode: 'iso',
  components: (): readonly ComponentType<unknown>[] => ISO_COMPONENTS,
  resources: () => ISO_RESOURCES,
  inputs: () => ISO_INPUTS,
  events: () => ISO_EVENTS,
  systems: (): Schedule => isoSchedule(),
  init: (world: World): void => isoInit(world),
  view: (): ViewProvider => new IsoViewProvider(),
};
