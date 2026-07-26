/**
 * The Sector Breach acceptance test — the FPS mode's dogfood, run headless with no pixels.
 *
 * Five things are proven here:
 *  1. **The playthrough completes as specified** — the spec's own `defineGameTest` (shoot the
 *     panel → open the door, jump the coolant pit, kill the grunt, reach the exit), with the
 *     tuned input script read from `play/sector-breach.input` so the script and the test can
 *     never disagree.
 *  2. **`raycastGrid` is load-bearing** — the run opens with a shot fired straight at the grunt
 *     through the *sealed* blast door, and takes a second shot pitched 40° down. Both must fail
 *     to reach the grunt. Neuter the DDA (or ignore pitch) and one of them lands, which shows up
 *     as a third `enemy.damaged`.
 *  3. **The lose path is real** — a second playthrough walks into the coolant pit and dies, so
 *     the winning run's `eventNotEmitted('player.died')` actually means something.
 *  4. **Determinism** — the same scene + script + seed hashes identically across two independent
 *     runs and under `replay()`, against a pinned final hash **and** a pinned digest of the whole
 *     per-tick timeline. This matters most for `fps`: the run is dense with float math
 *     (perspective look vectors, ray/box intersection, the jump arc), all routed through
 *     `@aegis/core/math` (ADR-0001).
 *  5. **No floorplan drift** — the canonical ASCII tilemap and the scene-embedded `fps.floorplan`
 *     resource extrude to byte-identical collision grids, so the human-authored text and the
 *     runnable scene stay in lockstep.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defineGameTest, expectSim, runGameTest, runScene } from '@aegis/harness';
import type { GameTest, SimResult } from '@aegis/harness';
import type { TilemapFile } from '@aegis/content';
import { Health } from '@aegis/content';
import { hashString, Transform } from '@aegis/core';
import type { StateHash } from '@aegis/core';
import { extrudeFloorplan } from '@aegis/mode-fps';
import type { FloorplanSpec } from '@aegis/mode-fps';
import { SECTOR_BREACH_ORIGIN, floorplanFromTilemap, sectorBreachPlugin } from '../src/index.js';

const SCENE = 'games/fps/levels/sector-breach.scene.json';
const TILEMAP = 'games/fps/levels/sector-breach.tilemap.json';
const SCRIPT = readFileSync('games/fps/play/sector-breach.input', 'utf8');
const SEED = 'poc-fps';
const TICKS = 600;

/**
 * The golden state hash of the completing run (seed `poc-fps`, 600 ticks, the tuned script). Pinned
 * as a literal — not `result.hash`, which is self-referential and can never fail — so an accidental
 * change to the mode's physics, the grunt AI, the scene, or the script is caught as a hash drift.
 * If you change the design on purpose, re-derive this from a run and update it deliberately.
 */
const GOLDEN_HASH = 'f86540b793f071a3';

/**
 * Golden digest of the **whole per-tick hash timeline**.
 *
 * `GOLDEN_HASH` alone is nearly blind to dynamics, because the run ends at rest — player parked in
 * the exit trigger, grunt dead, weapon cooled down — so two runs whose trajectories differ can
 * converge on an identical final state. Measured on this very level: adding the two occlusion
 * shots above changed four ticks' worth of weapon cooldown and look state and left `GOLDEN_HASH`
 * **byte-identical**. Digesting every tick's hash is what makes a changed trajectory go red.
 */
const GOLDEN_TRAJECTORY = '1ce5508ff97c0b75';

/**
 * Digest a run's per-tick hash timeline into one comparable value using core's frozen
 * {@link hashString} (the same FNV-1a the world hash uses).
 */
function trajectoryDigest(tickHashes: readonly StateHash[]): StateHash {
  return hashString(tickHashes.join('|'));
}

/** The `hitscan.hit` emitted on `tick`, if any. */
function hitOn(result: SimResult, tick: number): { target: string; distance: number } | undefined {
  const ev = result.events.history().find((e) => e.type === 'hitscan.hit' && e.tick === tick);
  return ev?.data as { target: string; distance: number } | undefined;
}

/** Whether any shot fired on `tick` reached the grunt. */
function hitTheGrunt(result: SimResult, tick: number): boolean {
  return hitOn(result, tick)?.target === 'grunt';
}

/** Run a game test and rethrow the harness's message verbatim on failure. */
async function expectGameTest(test: GameTest): Promise<void> {
  const outcome = await runGameTest(test);
  if (!outcome.passed) throw outcome.error ?? new Error('game test failed');
  expect(outcome.passed).toBe(true);
}

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
      // The damage exchange is a first-class beat, so pin it exactly: the grunt lands exactly one
      // shot. This fails if the grunt's targeting, LOS probe, cooldown, or damage application
      // breaks such that it fires zero times — or if it fires more than once.
      .eventEmitted('damage.taken', 1)
      .eventNotEmitted('player.died')
      .entityExists({ has: ['Player'] })
      // Five shots leave the barrel; exactly two of them reach the grunt. The other three are the
      // button and the two occlusion proofs below — so a ray that stops being blocked by geometry
      // shows up here as a third `enemy.damaged`.
      .eventEmitted('weapon.fired', 5)
      .eventEmitted('enemy.damaged', 2)
      .holds(
        'the opening shot stopped at the sealed blast door instead of reaching the grunt behind it',
        (r) => {
          const hit = hitOn(r, 4);
          // The player spawns at z=2 facing +Z; the door wall's south face is at z=7.5.
          return hit?.target === 'wall' && hit.distance > 5.4 && hit.distance < 5.6;
        },
      )
      .holds('the 40°-down shot at t100 passed under the grunt rather than through it', (r) => {
        // Pitch actually steers the ray: level, this shot has a clean line to the grunt's hitbox.
        return r.events.count('weapon.fired') > 0 && !hitTheGrunt(r, 100);
      })
      .holds(
        'player ended in the security room, past the grunt',
        (r) =>
          r
            .query({ has: ['Player', 'Transform'] })
            .one()
            .get(Transform).position.z >= 17,
      )
      // Exact final health (not a bound): 100 − one 10-damage grunt hit. Zero hits would leave 100,
      // two would leave 80 — both fail here. Together with the `damage.taken ×1` count above this
      // pins *the correct damage was taken*, per CHARTER §4.3, closing the "enemy fire silently
      // broke and the test still passed" gap.
      .holds(
        'player took exactly one grunt hit — final Health is 90',
        (r) =>
          r
            .query({ has: ['Player', 'Health'] })
            .one()
            .get(Health).current === 90,
      )
      .holds(
        'the per-tick hash timeline matches the golden trajectory (see GOLDEN_TRAJECTORY)',
        (r) => trajectoryDigest(r.tickHashes) === GOLDEN_TRAJECTORY,
      )
      .hashEquals(GOLDEN_HASH); // golden-master regression pin (see GOLDEN_HASH)

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

/**
 * The lose path: open the blast door, jog north, and never jump. The player walks off the south
 * lip of the coolant pit, drops to its floor at `y = -3` and the `hazard` `Trigger` kills it.
 * Input stops at the pit, as a fallen player's would.
 *
 * This exists because `eventNotEmitted('player.died')` in the winning run proves nothing on its
 * own — it passes even with the hazard system deleted, because no run in the suite ever emitted
 * a death. Pinning the death here, once and with the right `cause`, is what gives that assertion
 * its meaning, and it is the only test of "Lose: fell in the coolant pit" the doc promises.
 */
const sectorBreachPitDeath = defineGameTest({
  name: 'sector breach (lose): walk into the coolant pit without jumping',
  scene: SCENE,
  options: { plugin: sectorBreachPlugin, captureHistory: false },
  ticks: 240,
  seed: SEED,
  input: `
    aim 90 0 @8
    press Fire @20
    aim 0 0 @32
    axis Forward 1 40..150
  `,
  expect(result) {
    expectSim(result)
      // The run legitimately got as far as the corridor: the door really did open.
      .eventEmitted('door.opened', 1)
      .eventEmitted('player.died', 1)
      .eventNotEmitted('level.completed')
      .eventNotEmitted('enemy.killed')
      .holds('player.died reports cause "coolant" on the tick the feet enter the pit', (r) => {
        const ev = r.events.history().find((e) => e.type === 'player.died');
        const data = ev?.data as { cause: string; tick: number } | undefined;
        return data?.cause === 'coolant' && data.tick === 146;
      })
      .holds(
        'the player came to rest on the pit floor, three units below the datum',
        (r) =>
          r
            .query({ has: ['Player', 'Transform'] })
            .one()
            .get(Transform).position.y === -3,
      );
  },
});

describe('Sector Breach', () => {
  it('completes the playthrough exactly as the spec asserts', async () => {
    await expectGameTest(sectorBreach);
  });

  it('dies in the coolant pit when the jump is missed', async () => {
    await expectGameTest(sectorBreachPitDeath);
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
});
