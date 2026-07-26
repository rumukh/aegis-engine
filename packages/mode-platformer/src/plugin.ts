/**
 * The platformer {@link ModePlugin}: 2D side-on movement with gravity, coyote time and
 * jump-buffering, AABB-vs-tilemap collision, and a dead-zone follow camera. This module
 * declares the *contract* — the system pipeline (names, phases, ordering) and the projection —
 * so parallel implementers know exactly what to build. Bodies are stubs.
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
import { PLATFORMER_COMPONENTS } from './components.js';

/**
 * The platformer system pipeline, in intended execution order. Implementers register systems
 * with exactly these names and phases so ordering constraints across packages stay stable.
 *
 * 1. `platformer.intake` (`input`) — map the tick's actions/axes into `Velocity.dx` and a
 *    buffered jump request; refresh `BodyState.facing`.
 * 2. `platformer.gravity` (`update`) — integrate `gravity` into `Velocity.dy`, clamped to
 *    `maxFallSpeed`; consume coyote/jump-buffer windows to convert a request into `jumpSpeed`.
 * 3. `platformer.integrate` (`physics`, after `platformer.gravity`) — move the `TileCollider`
 *    by velocity and resolve against solid tiles, updating `BodyState.grounded`.
 * 4. `platformer.camera` (`postUpdate`) — move `PlatformerCamera` toward its target, honouring
 *    the dead-zone.
 */
export const PLATFORMER_SYSTEMS = [
  { name: 'platformer.intake', phase: 'input' },
  { name: 'platformer.gravity', phase: 'update' },
  { name: 'platformer.integrate', phase: 'physics', after: ['platformer.gravity'] },
  { name: 'platformer.camera', phase: 'postUpdate' },
] as const;

/** Build the platformer schedule. */
export function platformerSchedule(): Schedule {
  return createSchedule();
}

/** Orthographic side-on projection producing the semantic frame and ASCII view. */
export class PlatformerViewProvider implements ViewProvider {
  readonly mode: GameMode = 'platformer';
  semanticFrame(world: World, options?: ViewOptions): SemanticFrame {
    return notImplemented('PlatformerViewProvider.semanticFrame');
  }
  asciiView(world: World, options?: ViewOptions): AsciiView | undefined {
    return notImplemented('PlatformerViewProvider.asciiView');
  }
}

/** The platformer mode plugin. */
export const platformerPlugin: ModePlugin = {
  mode: 'platformer',
  components: () => PLATFORMER_COMPONENTS,
  systems: () => platformerSchedule(),
  view: () => new PlatformerViewProvider(),
};
