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
import { healthSystem } from '@aegis/content';
import type { ModePlugin, ViewProvider } from '@aegis/harness';
import { ISO_COMPONENTS, IsoGrid, NavGrid } from './components.js';
import { buildNavGrid } from './grid.js';
import { ISO_SYSTEM_LIST } from './systems.js';
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
export const ISO_RESOURCES = [IsoGrid, NavGrid] as const;

/** The isometric mode plugin. */
export const isoPlugin: ModePlugin = {
  mode: 'iso',
  components: (): readonly ComponentType<unknown>[] => ISO_COMPONENTS,
  resources: () => ISO_RESOURCES,
  systems: (): Schedule => isoSchedule(),
  init: (world: World): void => isoInit(world),
  view: (): ViewProvider => new IsoViewProvider(),
};
