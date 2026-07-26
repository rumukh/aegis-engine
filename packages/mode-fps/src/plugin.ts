/**
 * The FPS {@link ModePlugin}: capsule movement with gravity/jump, mouse-look accumulation,
 * capsule-vs-world collision, and hitscan resolution — projected through a perspective camera.
 * The semantic frame is the primary view; the ASCII view is a coarse depth raster. Declares
 * the pipeline and projection contract; bodies are stubs.
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
import { FPS_COMPONENTS } from './components.js';

/**
 * The FPS system pipeline, in intended execution order.
 *
 * 1. `fps.look` (`input`) — integrate the tick's `look` delta into `LookState`, clamping pitch.
 * 2. `fps.intake` (`input`, after `fps.look`) — map movement actions into a desired horizontal
 *    velocity oriented by `LookState.yawDeg`; latch a jump request; latch a fire request from
 *    the `Fire` action.
 * 3. `fps.gravity` (`update`) — integrate `gravity` into `CapsuleBody.velocity.y`.
 * 4. `fps.integrate` (`physics`, after `fps.gravity`) — sweep the capsule and resolve against
 *    world geometry, updating `grounded`.
 * 5. `fps.hitscan` (`physics`, after `fps.integrate`) — on a fire request off cooldown, cast a
 *    ray from the camera eye along the look direction and apply `Hitscan.damage` to the first
 *    entity with `Health`.
 * 6. `fps.camera` (`postUpdate`) — place the `FpsCamera` at eye height with the look orientation.
 */
export const FPS_SYSTEMS = [
  { name: 'fps.look', phase: 'input' },
  { name: 'fps.intake', phase: 'input', after: ['fps.look'] },
  { name: 'fps.gravity', phase: 'update' },
  { name: 'fps.integrate', phase: 'physics', after: ['fps.gravity'] },
  { name: 'fps.hitscan', phase: 'physics', after: ['fps.integrate'] },
  { name: 'fps.camera', phase: 'postUpdate' },
] as const;

/** Build the FPS schedule. */
export function fpsSchedule(): Schedule {
  return createSchedule();
}

/**
 * Perspective projection producing the semantic frame. `asciiView` returns a coarse
 * depth/silhouette raster (fps relies primarily on the structured frame).
 */
export class FpsViewProvider implements ViewProvider {
  readonly mode: GameMode = 'fps';
  semanticFrame(world: World, options?: ViewOptions): SemanticFrame {
    return notImplemented('FpsViewProvider.semanticFrame');
  }
  asciiView(world: World, options?: ViewOptions): AsciiView | undefined {
    return notImplemented('FpsViewProvider.asciiView');
  }
}

/** The FPS mode plugin. */
export const fpsPlugin: ModePlugin = {
  mode: 'fps',
  components: () => FPS_COMPONENTS,
  systems: () => fpsSchedule(),
  view: () => new FpsViewProvider(),
};
