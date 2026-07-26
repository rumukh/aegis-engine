/**
 * The platformer {@link ModePlugin}: 2D side-on movement with gravity, coyote time and
 * jump-buffering, AABB-vs-tilemap collision, kinematic moving solids that carry their rider, and
 * a dead-zone follow camera, projected to a semantic frame + ASCII view.
 *
 * The system pipeline (names, phases, ordering) is stable so parallel slices can rely on it:
 *
 * 1. `platformer.intake` (`input`) — map actions/axes to `Velocity.dx` and buffer a jump request.
 * 2. `platformer.gravity` (`update`) — integrate gravity into `Velocity.dy`, clamped to
 *    `maxFallSpeed`; consume coyote/jump-buffer windows to convert a request into `jumpSpeed`.
 * 3. `platformer.platform` (`physics`) — move kinematic platforms and carry riders.
 * 4. `platformer.integrate` (`physics`, after `platformer.platform`) — move colliders and resolve
 *    against solid tiles + platforms, updating `BodyState.grounded`.
 * 5. `platformer.camera` (`postUpdate`) — track the target within a dead-zone.
 * @packageDocumentation
 */
import { createSchedule } from '@aegis/core';
import type { GameMode, Schedule, World } from '@aegis/core';
import type { ModePlugin, ViewProvider } from '@aegis/harness';
import { PLATFORMER_COMPONENTS } from './components.js';
import { buildCollisionGrid, emptyGrid, PlatformerCollision, PlatformerTilemap } from './level.js';
import { PLATFORMER_SYSTEM_LIST } from './systems.js';
import { createPlatformerView } from './view.js';

/**
 * Declarative summary of the platformer pipeline (names + phases + ordering constraints). Kept
 * as data so tests and tooling can assert the schedule shape without executing it.
 */
export const PLATFORMER_SYSTEMS = [
  { name: 'platformer.intake', phase: 'input' },
  { name: 'platformer.gravity', phase: 'update' },
  { name: 'platformer.platform', phase: 'physics' },
  { name: 'platformer.integrate', phase: 'physics', after: ['platformer.platform'] },
  { name: 'platformer.camera', phase: 'postUpdate' },
] as const;

/** Build the platformer schedule (movement, gravity, platforms, collision, camera). */
export function platformerSchedule(): Schedule {
  return createSchedule().addAll(PLATFORMER_SYSTEM_LIST);
}

/**
 * Per-run setup: bake the authored tilemap (scene resource `platformer.tilemap`) into the
 * {@link PlatformerCollision} grid the physics and view read. Runs once, after the scene is
 * instantiated and before tick 0. Deterministic — no wall-clock, no RNG.
 */
export function platformerInit(world: World): void {
  const tilemap = world.getResource(PlatformerTilemap);
  world.setResource(PlatformerCollision, tilemap ? buildCollisionGrid(tilemap) : emptyGrid());
}

/** The projection used to produce semantic frames / ASCII views for this mode. */
export function platformerView(): ViewProvider {
  return createPlatformerView();
}

/** The platformer mode plugin. */
export const platformerPlugin: ModePlugin = {
  mode: 'platformer' as GameMode,
  components: () => PLATFORMER_COMPONENTS,
  init: platformerInit,
  systems: () => platformerSchedule(),
  view: () => platformerView(),
};
