/**
 * The isometric {@link ModePlugin}: click-to-move actors that path across a tile grid, with a
 * 2:1 isometric projection. Declares the system pipeline and projection contract; bodies are
 * stubs.
 * @packageDocumentation
 */
import { createSchedule, notImplemented } from '@aegis/core';
import type { GameMode, Schedule, World } from '@aegis/core';
import type {
  AsciiView,
  ModePlugin,
  SemanticFrame,
  ViewOptions,
  ViewProvider,
} from '@aegis/harness';
import { ISO_COMPONENTS } from './components.js';

/**
 * The isometric system pipeline, in intended execution order.
 *
 * 1. `iso.intake` (`input`) — unproject a `click` at a screen `point` back to a grid cell and
 *    attach a `MoveOrder` with that `target`.
 * 2. `iso.pathfind` (`preUpdate`) — for any unresolved `MoveOrder`, run deterministic A* over
 *    the grid (avoiding `Blocking` cells), fill `path`, set `resolved`.
 * 3. `iso.move` (`update`) — advance `GridPosition.progress` along `path` at `IsoActor.speed`;
 *    pop cells as they are reached; drop the `MoveOrder` at the destination.
 * 4. `iso.camera` (`postUpdate`) — follow the target with the `IsoCamera` rig.
 */
export const ISO_SYSTEMS = [
  { name: 'iso.intake', phase: 'input' },
  { name: 'iso.pathfind', phase: 'preUpdate', after: ['iso.intake'] },
  { name: 'iso.move', phase: 'update', after: ['iso.pathfind'] },
  { name: 'iso.camera', phase: 'postUpdate' },
] as const;

/** Build the isometric schedule. */
export function isoSchedule(): Schedule {
  return createSchedule();
}

/** Isometric (2:1) projection producing the semantic frame and a top-down ASCII grid. */
export class IsoViewProvider implements ViewProvider {
  readonly mode: GameMode = 'iso';
  semanticFrame(world: World, options?: ViewOptions): SemanticFrame {
    return notImplemented('IsoViewProvider.semanticFrame');
  }
  asciiView(world: World, options?: ViewOptions): AsciiView | undefined {
    return notImplemented('IsoViewProvider.asciiView');
  }
}

/** The isometric mode plugin. */
export const isoPlugin: ModePlugin = {
  mode: 'iso',
  components: () => ISO_COMPONENTS,
  systems: () => isoSchedule(),
  view: () => new IsoViewProvider(),
};
