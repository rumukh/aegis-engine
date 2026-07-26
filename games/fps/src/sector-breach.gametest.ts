/**
 * "Sector Breach" — the game's acceptance specification, expressed as headless
 * {@link defineGameTest}s (CHARTER principle 7: the game *is* the mode's acceptance test).
 *
 * ## Why this file is named `*.gametest.ts`
 * `aegis test` discovers, by default, any compiled module matching any `*.gametest.js` / `.mjs` / `.cjs` module
 * and runs **every** `GameTest` it exports. These blocks used to live inside the vitest file in
 * `test/`, which `tsconfig.json` excludes from the build — so they were never compiled, never
 * discovered, and `aegis test` reported a green summary covering the platformer alone. A green CLI
 * gate over one of three PoCs is a worse signal than the empty one it replaced, because it reads
 * as coverage. Living here, in `src/`, under the shared convention, fixes that; `test/` keeps the
 * vitest runner plus the checks that are about the *repository* rather than the playthrough
 * (determinism across runs, floorplan drift, script drift, discovery).
 *
 * Deliberately **not** re-exported from `index.ts`: `@aegis/game-fps`'s entry point is imported by
 * the browser renderer, and the game tests pull in the harness. Same arrangement as the platformer.
 *
 * ## The three playthroughs
 * - {@link sectorBreach} — the completing run: shoot the panel, jump the coolant pit, kill the
 *   grunt, reach the exit. It also carries the two shots that make `raycastGrid` and pitch
 *   load-bearing.
 * - {@link sectorBreachPitDeath} — the lose path, driven on into the exit trigger on purpose.
 * - {@link sectorBreachWallSlide} — a collision probe, because the winning run walks up the middle
 *   of a 3-wide corridor and never touches a wall.
 * @packageDocumentation
 */
import { defineGameTest, expectSim } from '@aegis/harness';
import type { SimResult } from '@aegis/harness';
import { Health } from '@aegis/content';
import { hashString, Transform } from '@aegis/core';
import { clamp, sqrt } from '@aegis/core/math';
import type { StateHash, World } from '@aegis/core';
import { CapsuleBody, FPS_COLLISION } from '@aegis/mode-fps';
import type { CollisionGrid } from '@aegis/mode-fps';
import { sectorBreachPlugin } from './plugin.js';

/** The scene the three playthroughs run, relative to the repository root. */
export const SCENE = 'games/fps/levels/sector-breach.scene.json';
/** The seed every Sector Breach run uses. */
export const SEED = 'poc-fps';
/** Tick budget of the completing run: `level.completed` lands at ~t240; the tail exercises the invariants. */
export const TICKS = 600;

/**
 * The tuned playthrough (ADR-0004 DSL), mirrored by `play/sector-breach.input`.
 *
 * Inlined rather than `readFileSync`-ed, so importing this module — which `aegis test` does, from
 * whatever directory it was invoked in — never touches the filesystem. The two copies are pinned
 * together by a drift test in `test/sector-breach.test.ts`, exactly as iso and the platformer do.
 */
export const SECTOR_BREACH_SCRIPT = `
  press Fire @4
  aim 90 0 @8
  press Fire @20
  aim 0 0 @32
  axis Forward 1 40..124
  aim 0 -40 @96
  press Fire @100
  aim 0 0 @108
  press Jump @124
  axis Forward 1 124..170
  press Fire @176
  press Fire @192
  axis Forward 1 210..320
`;

/**
 * The golden state hash of the completing run (seed `poc-fps`, 600 ticks, the tuned script). Pinned
 * as a literal — not `result.hash`, which is self-referential and can never fail — so an accidental
 * change to the mode's physics, the grunt AI, the scene, or the script is caught as a hash drift.
 * If you change the design on purpose, re-derive this from a run and update it deliberately.
 */
export const GOLDEN_HASH = 'f86540b793f071a3';

/**
 * Golden digest of the **whole per-tick hash timeline**.
 *
 * `GOLDEN_HASH` alone is nearly blind to dynamics, because the run ends at rest — player parked in
 * the exit trigger, grunt dead, weapon cooled down — so two runs whose trajectories differ can
 * converge on an identical final state. Measured on this very level: adding the two occlusion
 * shots above changed four ticks' worth of weapon cooldown and look state and left `GOLDEN_HASH`
 * **byte-identical**. Digesting every tick's hash is what makes a changed trajectory go red.
 */
export const GOLDEN_TRAJECTORY = '1ce5508ff97c0b75';

/**
 * Digest a run's per-tick hash timeline into one comparable value using core's frozen
 * {@link hashString} (the same FNV-1a the world hash uses).
 */
export function trajectoryDigest(tickHashes: readonly StateHash[]): StateHash {
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

// --- capsule-vs-geometry, checked independently of the mode's own solver -------------------

/**
 * How deep the player capsule is inside the nearest solid cell, in world units (0 when clear).
 *
 * Deliberately **re-derived** rather than delegated to the mode's `circleHitsSolid`: a test that
 * asks the collision solver whether the collision solver was right proves nothing. This walks the
 * grid's cell data — the extruded `solid` flags, which are level *data* — and does its own
 * point-to-AABB clamp. It also reads the grid out of the world snapshot for the tick being
 * checked, so the blast door counts as solid before it opens and passable afterwards.
 */
function wallPenetration(world: World): number {
  const grid = world.getResource(FPS_COLLISION) as CollisionGrid | undefined;
  if (grid === undefined) return 0;
  const view = world.query({ has: ['Player', 'Transform'] }).one();
  const p = view.get(Transform).position;
  const r = view.get(CapsuleBody).radius;
  const half = grid.tileSize * 0.5;
  let worst = 0;
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      const cell = grid.cells[row * grid.width + col];
      if (cell === undefined || !cell.solid) continue;
      const cx = grid.origin.x + col * grid.tileSize;
      const cz = grid.origin.z + (grid.height - 1 - row) * grid.tileSize;
      // Closest point of this cell's footprint to the capsule centre.
      const nx = clamp(p.x, cx - half, cx + half);
      const nz = clamp(p.z, cz - half, cz + half);
      const dx = p.x - nx;
      const dz = p.z - nz;
      const gap = sqrt(dx * dx + dz * dz);
      if (r - gap > worst) worst = r - gap;
    }
  }
  return worst;
}

/** The player's world position at `tick` (requires `captureHistory`). */
function playerAt(result: SimResult, tick: number): { x: number; y: number; z: number } {
  const p = result
    .at(tick)
    .query({ has: ['Player', 'Transform'] })
    .one()
    .get(Transform).position;
  return { x: p.x, y: p.y, z: p.z };
}

/**
 * The spec's declarative game test (docs/games/fps.md), with two documented deviations:
 *  - the plugin is the composed {@link sectorBreachPlugin} (the harness builds its schedule from
 *    `plugin.systems()` alone, so the game's systems must ride in the plugin), and
 *  - the input frames are the *tuned* script from `play/sector-breach.input` (same beats, tuned
 *    ticks). See the handoff.
 */
export const sectorBreach = defineGameTest({
  name: 'sector breach: shoot the door, jump the pit, kill the grunt, reach the exit',
  scene: SCENE,
  options: { plugin: sectorBreachPlugin, captureHistory: true },
  ticks: TICKS,
  seed: SEED,
  input: SECTOR_BREACH_SCRIPT,
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

    // Named, actionable capsule-collision check: if wall collision, the capsule radius, or the
    // integrator regresses so the player clips into (or through) level geometry, this fails at the
    // exact tick with a name — rather than surfacing as an unreadable "the golden hash moved".
    result.assertInvariant(
      'player capsule never overlapped a solid wall cell',
      (w) => wallPenetration(w) <= 1e-9,
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
 * lip of the coolant pit, drops to its floor at `y = -3`, and the `hazard` `Trigger` kills it —
 * and then the run **keeps driving Forward all the way to the exit**.
 *
 * That tail is the point. `fps.intake` has no `Dead` guard (reported to the PM), so the mode goes
 * on steering the corpse; it climbs out of the pit (the capsule snaps up to the next cell's floor)
 * and walks into the exit trigger. Before `hazardSystem` latched a real death and `goalSystem`
 * learned to ignore a dead player, this exact run emitted `player.died` **and** `level.completed`
 * — the documented win and lose conditions true at once. Now it emits only the death.
 *
 * It also exists because `eventNotEmitted('player.died')` in the winning run proves nothing on its
 * own: it passes even with the hazard system deleted, since no run in the suite would emit a death.
 */
export const sectorBreachPitDeath = defineGameTest({
  name: 'sector breach (lose): walk into the coolant pit without jumping',
  scene: SCENE,
  options: { plugin: sectorBreachPlugin, captureHistory: true },
  ticks: 300,
  seed: SEED,
  input: `
    aim 90 0 @8
    press Fire @20
    aim 0 0 @32
    axis Forward 1 40..280
  `,
  expect(result) {
    expectSim(result)
      // The run legitimately got as far as the corridor: the door really did open.
      .eventEmitted('door.opened', 1)
      .eventEmitted('player.died', 1)
      // Driven into the exit trigger and still not a win.
      .eventNotEmitted('level.completed')
      .eventNotEmitted('enemy.killed')
      // Reported, not merely asserted: `entityCount` prints the matched entities, so a failure
      // names the entity that is (or is not) dead rather than just a number.
      .entityCount({ has: ['Player', 'Dead'] }, 1)
      .holds('player.died reports cause "coolant" on the tick the feet enter the pit', (r) => {
        const ev = r.events.history().find((e) => e.type === 'player.died');
        const data = ev?.data as { cause: string; tick: number } | undefined;
        return data?.cause === 'coolant' && data.tick === 146;
      })
      .holds(
        'it really did drop into the pit — feet below the floor datum, inside the T cells',
        (r) => {
          // The pit's `T` cells span world z 11.5–13.5 with floor −3; the hazard volume sits in it.
          const at = playerAt(r, 146);
          return at.y < 0 && at.z > 11.5 && at.z < 13.5;
        },
      )
      .holds(
        'the corpse was then driven into the exit trigger, and it still did not count as a win',
        (r) => playerAt(r, 299).z >= 17,
      );
  },
});

/**
 * A third playthrough whose only job is to make **capsule-vs-wall collision, axis-separated wall
 * sliding and the capsule radius** fail by name.
 *
 * The winning run walks straight up the middle of a 3-wide corridor and never touches a wall, so
 * all three of those capabilities could only ever surface as golden-hash drift — the least
 * actionable signal the engine can produce (CHARTER principle 8). Here the player faces 45° and
 * holds Forward into the north-east corner of the antechamber, which forces all three:
 *
 *  - it must be **stopped** by the north wall (`z` face at 5.5) and the east wall (`x` face at 4.5);
 *  - between those two contacts it must keep sliding **east** while already pinned **north** —
 *    that is exactly what axis-separated resolution buys, and a solver that stops both axes on any
 *    contact freezes `x` at ~3.3 instead of reaching ~4.03;
 *  - each stop must land one **capsule radius** short of the wall face, not on it.
 */
export const sectorBreachWallSlide = defineGameTest({
  name: 'sector breach (probe): the capsule is stopped by walls and slides along them',
  scene: SCENE,
  options: { plugin: sectorBreachPlugin, captureHistory: true },
  ticks: 200,
  seed: SEED,
  input: `
    aim 45 0 @4
    axis Forward 1 10..160
  `,
  expect(result) {
    // Faces of the two walls the capsule runs into, and the tick-step it travels per axis.
    const NORTH_FACE = 5.5;
    const EAST_FACE = 4.5;
    const RADIUS = 0.4;
    const STEP = 0.0708; // 6 u/s * sin(45°) / 60 — one tick of travel on each axis

    expectSim(result)
      .holds(
        'the capsule was stopped by the north wall, one radius short of its face — not walked through it',
        (r) => {
          const end = playerAt(r, 199);
          return end.z <= NORTH_FACE - RADIUS && end.z > NORTH_FACE - RADIUS - STEP;
        },
      )
      .holds('the capsule was stopped by the east wall, one radius short of its face', (r) => {
        const end = playerAt(r, 199);
        return end.x <= EAST_FACE - RADIUS && end.x > EAST_FACE - RADIUS - STEP;
      })
      .holds(
        'it slid east along the north wall instead of sticking on first contact (axis-separated resolution)',
        (r) => {
          // t56 is after the north contact (z is already pinned) and well before the east contact.
          const early = playerAt(r, 56);
          const late = playerAt(r, 70);
          return early.z === late.z && late.x - early.x > 0.6;
        },
      )
      .eventNotEmitted('player.died')
      .eventNotEmitted('level.completed');

    result.assertInvariant(
      'player capsule never overlapped a solid wall cell',
      (w) => wallPenetration(w) <= 1e-9,
    );
  },
});
