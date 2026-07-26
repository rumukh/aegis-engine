/**
 * The Sector Breach acceptance test — the FPS mode's dogfood, run headless with no pixels.
 *
 * Three things are proven here:
 *  1. **The playthrough completes as specified** — the spec's own `defineGameTest` (shoot the
 *     panel → open the door, jump the coolant pit, kill the grunt, reach the exit), with the
 *     tuned input script read from `play/sector-breach.input` so the script and the test can
 *     never disagree.
 *  2. **Determinism** — the same scene + script + seed hashes identically across two independent
 *     runs and under `replay()`. This matters most for `fps`: the run is dense with float math
 *     (perspective look vectors, ray/box intersection, the jump arc), all routed through
 *     `@aegis/core/math` (ADR-0001).
 *  3. **No floorplan drift** — the canonical ASCII tilemap and the scene-embedded `fps.floorplan`
 *     resource extrude to byte-identical collision grids, so the human-authored text and the
 *     runnable scene stay in lockstep.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defineGameTest, expectSim, runGameTest, runScene } from '@aegis/harness';
import type { TilemapFile } from '@aegis/content';
import { Health } from '@aegis/content';
import { Transform } from '@aegis/core';
import { extrudeFloorplan } from '@aegis/mode-fps';
import type { FloorplanSpec } from '@aegis/mode-fps';
import { SECTOR_BREACH_ORIGIN, floorplanFromTilemap, sectorBreachPlugin } from '../src/index.js';

const SCENE = 'games/fps/levels/sector-breach.scene.json';
const TILEMAP = 'games/fps/levels/sector-breach.tilemap.json';
const SCRIPT = readFileSync('games/fps/play/sector-breach.input', 'utf8');
const SEED = 'poc-fps';
const TICKS = 600;

/**
 * The spec's declarative game test (docs/games/fps.md), with two documented deviations:
 *  - the plugin is the composed {@link sectorBreachPlugin} (the harness builds its schedule from
 *    `plugin.systems()` alone, so the game's systems must ride in the plugin), and
 *  - the input frames are the *tuned* script from `play/sector-breach.input` (same beats, tuned
 *    ticks). See the handoff.
 */
const sectorBreach = defineGameTest({
  name: 'sector breach: shoot the door, jump the pit, kill the grunt, reach the exit',
  scene: SCENE,
  options: { plugin: sectorBreachPlugin, captureHistory: true },
  ticks: TICKS,
  seed: SEED,
  input: SCRIPT,
  expect(result) {
    expectSim(result)
      .eventEmitted('door.opened', 1)
      .eventEmitted('enemy.killed', 1)
      .eventEmitted('level.completed', 1)
      .eventNotEmitted('player.died')
      .entityExists({ has: ['Player'] })
      .holds(
        'player ended in the security room, past the grunt',
        (r) =>
          r
            .query({ has: ['Player', 'Transform'] })
            .one()
            .get(Transform).position.z >= 17,
      )
      .hashEquals(result.hash);

    result.assertInvariant(
      'player feet never dropped into the void',
      (w) =>
        w
          .query({ has: ['Player', 'Transform'] })
          .one()
          .get(Transform).position.y > -1,
    );

    result.assertInvariant(
      'player health stayed above the safe floor',
      (w) =>
        w
          .query({ has: ['Player', 'Health'] })
          .one()
          .get(Health).current >= 70,
    );
  },
});

describe('Sector Breach', () => {
  it('completes the playthrough exactly as the spec asserts', async () => {
    const outcome = await runGameTest(sectorBreach);
    if (!outcome.passed) throw outcome.error ?? new Error('game test failed');
    expect(outcome.passed).toBe(true);
  });

  it('is deterministic: identical hash across independent runs and on replay', async () => {
    const options = {
      plugin: sectorBreachPlugin,
      ticks: TICKS,
      seed: SEED,
      input: SCRIPT,
    } as const;
    const first = await runScene(SCENE, options);
    const second = await runScene(SCENE, options);
    expect(second.hash).toBe(first.hash);
    expect(first.replay().hash).toBe(first.hash);
    // Every per-tick hash matches too — determinism holds tick-by-tick, not just at the end.
    expect(second.tickHashes).toEqual(first.tickHashes);
  });

  it('tilemap and scene floorplans extrude to identical collision (no drift)', () => {
    const tilemap = JSON.parse(readFileSync(TILEMAP, 'utf8')) as TilemapFile;
    const scene = JSON.parse(readFileSync(SCENE, 'utf8')) as {
      resources: { 'fps.floorplan': FloorplanSpec };
    };
    const fromTilemap = extrudeFloorplan(floorplanFromTilemap(tilemap, SECTOR_BREACH_ORIGIN));
    const fromScene = extrudeFloorplan(scene.resources['fps.floorplan']);
    expect(fromScene.width).toBe(fromTilemap.width);
    expect(fromScene.height).toBe(fromTilemap.height);
    expect(fromScene.cells).toEqual(fromTilemap.cells);
  });
});
