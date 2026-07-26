/**
 * The Sector Breach runner and the repository-level checks around it.
 *
 * The playthroughs themselves live in `src/sector-breach.gametest.ts` so that `aegis test` — whose
 * default glob is any `*.gametest.js` / `.mjs` / `.cjs` module over compiled output — actually discovers them.
 * They used to live here, in a directory `tsconfig.json` excludes from the build, which meant the
 * CLI gate reported a green summary covering the platformer alone.
 *
 * What stays here is everything that is about the *repository* rather than the playthrough:
 *  1. **Running the three specs** — the completing run, the coolant-pit lose run, and the wall
 *     collision probe.
 *  2. **Determinism** — the same scene + script + seed hashes identically across two independent
 *     runs and under `replay()`, against a pinned final hash **and** a pinned digest of the whole
 *     per-tick timeline. This matters most for `fps`: the run is dense with float math
 *     (perspective look vectors, ray/box intersection, the jump arc), all routed through
 *     `@aegis/core/math` (ADR-0001).
 *  3. **No floorplan drift** — the canonical ASCII tilemap and the scene-embedded `fps.floorplan`
 *     resource extrude to byte-identical collision grids.
 *  4. **No script drift** — `play/sector-breach.input` holds the same commands as the script the
 *     tests actually run.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runGameTest, runScene } from '@aegis/harness';
import type { GameTest } from '@aegis/harness';
import type { TilemapFile } from '@aegis/content';
import { extrudeFloorplan } from '@aegis/mode-fps';
import type { FloorplanSpec } from '@aegis/mode-fps';
import { SECTOR_BREACH_ORIGIN, floorplanFromTilemap, sectorBreachPlugin } from '../src/index.js';
import {
  GOLDEN_HASH,
  GOLDEN_TRAJECTORY,
  SCENE,
  SECTOR_BREACH_SCRIPT,
  SEED,
  TICKS,
  sectorBreach,
  sectorBreachPitDeath,
  sectorBreachWallSlide,
  trajectoryDigest,
} from '../src/sector-breach.gametest.js';

const TILEMAP = 'games/fps/levels/sector-breach.tilemap.json';

/** Run a game test and rethrow the harness's message verbatim on failure. */
async function expectGameTest(test: GameTest): Promise<void> {
  const outcome = await runGameTest(test);
  if (!outcome.passed) throw outcome.error ?? new Error('game test failed');
  expect(outcome.passed).toBe(true);
}

/** The bare commands of an input script: comments, blank lines and indentation removed, sorted. */
function commandsOf(script: string): string[] {
  return script
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
    .sort();
}

describe('Sector Breach', () => {
  it('completes the playthrough exactly as the spec asserts', async () => {
    await expectGameTest(sectorBreach);
  });

  it('dies in the coolant pit when the jump is missed', async () => {
    await expectGameTest(sectorBreachPitDeath);
  });

  it('is stopped by walls and slides along them', async () => {
    await expectGameTest(sectorBreachWallSlide);
  });

  it('is deterministic: identical hash across independent runs and on replay', async () => {
    const options = {
      plugin: sectorBreachPlugin,
      ticks: TICKS,
      seed: SEED,
      input: SECTOR_BREACH_SCRIPT,
    } as const;
    const first = await runScene(SCENE, options);
    const second = await runScene(SCENE, options);
    expect(second.hash).toBe(first.hash);
    expect(first.replay().hash).toBe(first.hash);
    // Every per-tick hash matches too — determinism holds tick-by-tick, not just at the end.
    expect(second.tickHashes).toEqual(first.tickHashes);
    // ...and the run is byte-stable against the recorded golden master, resting state and
    // trajectory alike.
    expect(first.hash).toBe(GOLDEN_HASH);
    expect(trajectoryDigest(first.tickHashes)).toBe(GOLDEN_TRAJECTORY);
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

  it('play/sector-breach.input mirrors the script the tests actually run (no drift)', () => {
    const onDisk = readFileSync('games/fps/play/sector-breach.input', 'utf8');
    expect(commandsOf(onDisk)).toEqual(commandsOf(SECTOR_BREACH_SCRIPT));
  });
});
