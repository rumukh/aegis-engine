/**
 * **The decoupling claim, as a test** (CHARTER principle 2, ADR-0005).
 *
 * For each of the three modes: run a scene through the real headless harness, then run the
 * *identical* scene with a render adapter mounted and synced on the live world after every single
 * tick, and assert the state hashes match — not just at the end, but tick for tick. If the
 * adapter wrote so much as one field, or nudged the PRNG, or reordered a component store, a hash
 * would diverge and this test would name the exact tick.
 *
 * The adapter is handed the **live** world here, not a copy. That is deliberate: the browser
 * renders a restored snapshot and so is structurally unable to interfere, but the interesting
 * claim is that the adapter is read-only even when it *could* write.
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  createSchedule,
  createSimulation,
  createWorld,
  DiagnosticError,
  Name,
  Transform,
} from '@aegis/core';
import type { GameMode, InputFrame, StateHash, World } from '@aegis/core';
import {
  createRegistry,
  Dead,
  Health,
  instantiateScene,
  Light,
  Model,
  Sprite,
  Trigger,
  Triggered,
} from '@aegis/content';
import type { SceneFile } from '@aegis/content';
import { parseInputScript, runScene } from '@aegis/harness';
import type { ModePlugin } from '@aegis/harness';
import { platformerPlugin } from '@aegis/mode-platformer';
import { isoPlugin } from '@aegis/mode-iso';
import { fpsPlugin } from '@aegis/mode-fps';
import { createRenderAdapter } from './adapters/index.js';
import { FPS_SCENE, ISO_SCENE, PLATFORMER_SCENE } from './testing/scenes.js';

const TICKS = 90;

/** Input scripts that actually make each mode do something worth hashing. */
const SCRIPTS: Readonly<Record<GameMode, string>> = {
  platformer: ['axis MoveX 1 0..70', 'press Jump @10', 'press Jump @48'].join('\n'),
  iso: ['click 4,3 @2', 'click 1,3 @45'].join('\n'),
  fps: ['axis Forward 1 0..60', 'press Fire @12', 'aim 35 -8 @20'].join('\n'),
};

/** Compile a mode's script into the exact per-tick frames the harness would feed the simulation. */
function compile(script: string): readonly InputFrame[] {
  const parsed = parseInputScript(script);
  if (!parsed.ok || parsed.value === undefined) throw new DiagnosticError(parsed.diagnostics);
  return parsed.value.frames(TICKS);
}

/** Build a world exactly the way the harness does, so both paths start from identical state. */
function buildWorld(scene: SceneFile, plugin: ModePlugin): World {
  const world = createWorld({ seed: scene.seed ?? 0, recordEvents: true });
  const registry = createRegistry(
    Transform,
    Name,
    Sprite,
    Model,
    Light,
    Health,
    Trigger,
    Dead,
    Triggered,
  );
  registry.registerAll(plugin.components());
  const result = instantiateScene(world, structuredClone(scene), { registry });
  if (!result.ok) throw new DiagnosticError(result.diagnostics);
  plugin.init?.(world);
  return world;
}

/** Step a world tick by tick, optionally letting a render adapter look at it after every tick. */
function hashesFor(
  scene: SceneFile,
  plugin: ModePlugin,
  frames: readonly InputFrame[],
  withAdapter: boolean,
): StateHash[] {
  const world = buildWorld(scene, plugin);
  const schedule = createSchedule();
  schedule.addAll(plugin.systems().resolved());
  const simulation = createSimulation({
    world,
    schedule,
    tickRate: 60,
    input: { frameFor: (tick) => frames[tick] ?? frames[frames.length - 1]! },
  });

  const adapter = withAdapter ? createRenderAdapter(plugin.mode, { aspect: 16 / 9 }) : undefined;
  adapter?.mount(world);

  const hashes: StateHash[] = [];
  for (let tick = 0; tick < TICKS; tick++) {
    simulation.step();
    adapter?.sync(world);
    hashes.push(world.hash());
  }
  adapter?.dispose();
  return hashes;
}

const CASES: { scene: SceneFile; plugin: ModePlugin }[] = [
  { scene: PLATFORMER_SCENE, plugin: platformerPlugin },
  { scene: ISO_SCENE, plugin: isoPlugin },
  { scene: FPS_SCENE, plugin: fpsPlugin },
];

describe('rendering does not touch the simulation', () => {
  for (const { scene, plugin } of CASES) {
    it(`${plugin.mode}: per-tick hashes are identical with and without an adapter`, () => {
      const frames = compile(SCRIPTS[plugin.mode]);
      const headless = hashesFor(scene, plugin, frames, false);
      const rendered = hashesFor(scene, plugin, frames, true);

      expect(rendered).toHaveLength(TICKS);
      const divergence = headless.findIndex((hash, tick) => hash !== rendered[tick]);
      expect(divergence, `state diverged at tick ${divergence}`).toBe(-1);
    });

    it(`${plugin.mode}: an adapter-attached run matches the headless harness exactly`, async () => {
      const result = await runScene(scene, {
        plugin,
        ticks: TICKS,
        input: SCRIPTS[plugin.mode],
        captureTickHashes: true,
      });
      const rendered = hashesFor(scene, plugin, compile(SCRIPTS[plugin.mode]), true);

      expect(rendered[TICKS - 1]).toBe(result.hash);
      expect(rendered).toEqual([...result.tickHashes]);
    });
  }

  it('mounting and syncing an adapter leaves the world snapshot byte-identical', () => {
    const world = buildWorld(PLATFORMER_SCENE, platformerPlugin);
    const before = world.snapshot();
    const beforeHash = world.hash();

    const adapter = createRenderAdapter('platformer');
    adapter.mount(world);
    for (let i = 0; i < 5; i++) adapter.sync(world);
    adapter.dispose();

    expect(world.hash()).toBe(beforeHash);
    expect(world.snapshot()).toEqual(before);
  });

  it('every mode has an adapter, and an unknown mode is rejected', () => {
    for (const { plugin } of CASES) {
      const adapter = createRenderAdapter(plugin.mode);
      expect(adapter.mode).toBe(plugin.mode);
      adapter.dispose();
    }
    expect(() => createRenderAdapter('sidescroller' as GameMode)).toThrow(/unknown mode/);
  });
});
