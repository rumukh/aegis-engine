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

/**
 * What the determinism case costs, and why there is deliberately **no local timeout** on it.
 *
 * An earlier revision of this file carried `DETERMINISM_BUDGET_MS = 60_000`, justified in a
 * comment as "3x headroom over the in-suite figure". That budget was wrong, and wrong in the
 * dangerous direction — it is worth recording why rather than just deleting it.
 *
 * The number it was sized against was **inferred, not taken**: the alone figure was measured
 * post-change (13.1 s) and the in-suite figure was obtained by scaling the old in-suite
 * measurement by the same ratio (~17.8 s). Measured in-suite figures for this case, all on the
 * post-change code:
 *
 * | observer | conditions                              | duration  |
 * | -------- | --------------------------------------- | --------- |
 * | here     | 104-108 node procs, CPU pegged at 100 % | 12.4 s    |
 * | here     | 104-108 node procs, CPU pegged at 100 % | 12.4 s    |
 * | here     | 104-108 node procs, CPU pegged at 100 % | 13.5 s    |
 * | here     | full suite, lighter load                | 13.9 s    |
 * | PM       | 103 node procs, separate gate worktree  | **30.0 s** |
 *
 * Two observers, nominally comparable load, **2.4x apart** — and the high reading has never
 * reproduced here. That spread is the finding: a single wall-clock sample cannot bound a
 * wall-clock quantity, so no honestly-derived local budget is available. Sized at 3x the worst
 * observation it would be 90 s against a 120 s root, which is not meaningfully tighter than the
 * root and would have been kept for appearance.
 *
 * Worse, at 60 s it was a **CI hazard rather than a CI protection**. A hosted runner has 2-4 vCPU
 * against this box's 16; at the PM's 30 s reading a runner merely 2x slower breaches 60 s, and the
 * failure presents as "Sector Breach is not deterministic" — precisely the misattribution the
 * budget existed to prevent. The 120 s root remains and is the operative bound.
 *
 * **Why this case is expensive at all**, since that is the thing actually worth fixing: the
 * harness hashes the world once per tick to build `tickHashes`, and per-tick cost tracks
 * serialised world size almost linearly across the three PoCs — fps 10.9 ms/tick at a 19.6 kB
 * snapshot, platformer 5.1 ms/tick at 10.0 kB, iso 1.7 ms/tick at 2.6 kB. **86 % of the fps
 * snapshot (16.8 kB) is `fps.collision`**, whose `FloorplanCell[]` spends one object with six
 * fields on every tile, and which is constant for the whole run bar the tick the blast door
 * opens. A compact cell representation would take this case to roughly iso's cost. It is not done
 * here because `CollisionGrid.cells` is consumed by `packages/render-three` (`adapters/fps.ts`),
 * so the shape is a cross-package contract and not this session's to change alone. Reported.
 *
 * Re-derive rather than trust — and record what the machine was doing when you do:
 * `node node_modules/vitest/vitest.mjs run --reporter=json --outputFile=t.json`
 */
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

  /**
   * Two independent runs, not three.
   *
   * This used to run the playthrough three times: two `runScene` calls plus `first.replay()`.
   * `replay()` is `makeResult(run, executeRun(run))` — it re-executes the run that was **already
   * resolved**, reusing the parsed scene and the built registry. A second `runScene` re-reads the
   * scene from disk, re-validates it, re-instantiates the world and *then* re-executes, so it
   * proves everything `replay()` proves and the load path as well. The third run was strictly
   * weaker than one of the two it accompanied, and the `replay()` API itself is proven where it
   * belongs — in `packages/harness`, and end-to-end by `aegis record` / `aegis replay` in
   * `packages/cli`. Dropping it removes a third of the cost of this file's slowest case and
   * removes no claim.
   *
   * What remains is two claims with different provenance, which is the point: the first is two
   * live runs compared to each other (it catches non-determinism *inside this process*), and the
   * second is a run compared to a **pinned literal** (it catches drift *across* processes and
   * machines, which no pair of live runs can see).
   */
  it('is deterministic: two independent runs agree tick for tick, and match the pinned goldens', async () => {
    const options = {
      plugin: sectorBreachPlugin,
      ticks: TICKS,
      seed: SEED,
      input: SECTOR_BREACH_SCRIPT,
    } as const;
    const first = await runScene(SCENE, options);
    const second = await runScene(SCENE, options);
    expect(second.hash).toBe(first.hash);
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
