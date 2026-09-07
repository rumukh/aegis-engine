/**
 * Test helpers: build a world from a scene the same way the harness does, and step it.
 *
 * The adapters are read-only consumers of a world, so their tests need a *real* world produced by
 * a real mode plugin — not a mock. This is the smallest honest way to get one.
 * @packageDocumentation
 */
import { createSchedule, createSimulation } from '@aegis/core';
import type { InputFrame, Simulation, World } from '@aegis/core';
import type { SceneFile } from '@aegis/content';
import { bootstrapScene } from '@aegis/harness';
import type { ModePlugin } from '@aegis/harness';

/** Instantiate `scene` with `plugin`, run the plugin's `init`, and return the pre-tick-0 world. */
export function buildTestWorld(scene: SceneFile, plugin: ModePlugin): World {
  return bootstrapScene(scene, { plugin }).world;
}

/** A simulation over `world` driven by `frames` (idle when the list runs out). */
export function simulationFor(
  world: World,
  plugin: ModePlugin,
  frames: readonly InputFrame[] = [],
): Simulation {
  const schedule = createSchedule();
  schedule.addAll(plugin.systems().resolved());
  return createSimulation({
    world,
    schedule,
    tickRate: 60,
    input: { frameFor: (tick) => frames[tick] ?? { ...IDLE, tick } },
  });
}

/** An input frame with nothing held. */
export const IDLE: InputFrame = {
  tick: 0,
  actions: {},
  pressed: [],
  released: [],
  axes: {},
  look: { dx: 0, dy: 0 },
  pointer: null,
};
