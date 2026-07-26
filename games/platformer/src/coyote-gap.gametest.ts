/**
 * "Coyote Gap" — the game's acceptance specification, expressed as a headless {@link defineGameTest}
 * (CHARTER principle 7: the game *is* the mode's acceptance test). Running this scene + input script
 * under the composed {@link coyoteGapPlugin} must complete the level, prove the beat events, hold the
 * whole-timeline physics invariants, and demonstrate that carry is load-bearing — with no pixels.
 *
 * ## The composed plugin is the pattern (not a deviation)
 * The design doc's `plugin: platformerPlugin` was shorthand written before the pattern existed. A game
 * always composes the mode plugin into its *own* plugin: `coyoteGapPlugin` = mode systems + content
 * `healthSystem` + game systems (patrol, stomp, hazard, goal, death-mapping). Game-semantic events
 * (`enemy.killed`, `player.died`, `level.completed`) are emitted by game systems; the mechanical facts
 * (`player.jumped/landed`, `platform.boarded`) come from the mode. `ModePlugin` stays the single seam
 * through which systems enter the schedule — there is no second injection path. The tuned tick numbers
 * below are the real, measured playthrough; `docs/games/platformer.md` mirrors them.
 *
 * ## Carry is load-bearing
 * The lava gap (cols 20–26, 7 tiles) is wider than the ferry (3 tiles), so it never bridges: the player
 * *cannot* walk across. The script boards the ferry at its left dock, then **releases Right for ticks
 * 152–189** and stands still while the ferry carries it right. The `carried by the ferry` assertion
 * pins two ticks inside that window and requires the player's x to advance with no input — if carry
 * regressed, the ferry would slide out from under a stationary player, it would fall in the lava, and
 * both this assertion and `player.died` would fire. That is the point of the PoC.
 * @packageDocumentation
 */
import { defineGameTest, expectSim } from '@aegis/harness';
import type { SimResult } from '@aegis/harness';
import { abs, hashString, Transform } from '@aegis/core';
import type { StateHash } from '@aegis/core';
import { BodyState } from '@aegis/mode-platformer';
import { coyoteGapPlugin } from './plugin.js';

export default defineGameTest({
  name: 'coyote gap: stomp, ferry across the lava, coyote-jump, buffer onto the flag',
  scene: 'games/platformer/levels/coyote-gap.scene.json',
  options: { plugin: coyoteGapPlugin, captureHistory: true },
  ticks: 400,
  seed: 'poc-platformer',
  input: `
    hold Right 0..126
    press Jump @28
    press Jump @74
    hold Right 138..152
    hold Right 190..400
    press Jump @288
    press Jump @317
  `,
  expect(result) {
    expectSim(result)
      .eventEmitted('level.completed', 1) // finished, exactly once
      .eventNotEmitted('player.died') // survived the whole run
      .eventEmitted('enemy.killed', 1) // the critter was actually stomped
      .eventEmitted('platform.boarded', 1) // the ferry actually carried us
      .entityExists({ has: ['Player'] })
      .holds(
        'player ended on/past the goal pillar',
        (r) =>
          r
            .query({ has: ['Player', 'Transform'] })
            .one()
            .get(Transform).position.x >= 36,
      )
      .holds(
        'carried by the ferry while standing still (x advances with Right un-held, ticks 152–189)',
        (r) => {
          const sample = (tick: number) => {
            const v = r
              .at(tick)
              .query({ has: ['Player', 'Transform'] })
              .one();
            return { x: v.get(Transform).position.x, carriedBy: v.get(BodyState).carriedBy };
          };
          const before = sample(158);
          const after = sample(186);
          // On a moving solid (carriedBy != -1) with no horizontal input, only the carry can move x.
          return before.carriedBy !== -1 && after.carriedBy !== -1 && after.x > before.x;
        },
      )
      .hashEquals(result.hash); // pin the golden state hash (determinism)

    // Whole-timeline invariants (require captureHistory):
    result.assertInvariant(
      'never fell out of the world',
      (w) =>
        w
          .query({ has: ['Player', 'Transform'] })
          .one()
          .get(Transform).position.y > -4,
    );
    result.assertInvariant(
      'never tunnelled above the ceiling plane',
      (w) =>
        w
          .query({ has: ['Player', 'Transform'] })
          .one()
          .get(Transform).position.y <= 12,
    );

    // --- the trajectory, not just the resting state ------------------------------------------
    // Everything above (and the golden hash) describes where the run *ends*. A platformer
    // regression that changes the route but still parks the player on the pillar would sail
    // through all of it, so the beats and the whole per-tick hash timeline are pinned too.
    expectSim(result)
      .holds(
        'the coyote jump at t288 launched in mid-air (fromGround:false) — coyote time is real',
        (r) => {
          const jump = jumpAt(r, COYOTE_JUMP_TICK);
          return jump !== undefined && jump.fromGround === false;
        },
      )
      .holds(
        `the buffered press at t${BUFFERED_PRESS_TICK} was held and fired on the landing tick (fromGround:true)`,
        (r) => {
          // The press lands while still airborne: no jump on that tick, a landing on t320, and
          // the buffered jump firing from the ground on t321. Without jumpBufferTicks the press
          // is eaten and the player never mounts the goal pillar.
          const landed = r.events
            .history()
            .some((e) => e.type === 'player.landed' && e.tick === BUFFERED_LANDING_TICK);
          const buffered = jumpAt(r, BUFFERED_LANDING_TICK + 1);
          return (
            jumpAt(r, BUFFERED_PRESS_TICK) === undefined &&
            landed &&
            buffered !== undefined &&
            buffered.fromGround === true
          );
        },
      )
      .holds('the run hit its four beat waypoints (see WAYPOINTS)', (r) =>
        WAYPOINTS.every((w) => w.check(playerAt(r, w.tick))),
      )
      .holds(
        'the critter walked its triangle wave (x = 16.7 @t126, 15.75 @t145, 15.1 @t158, 16.3 @t186)',
        (r) =>
          CRITTER_WAVE.every(([tick, x]) => {
            const view = r
              .at(tick)
              .query({ has: ['Critter', 'Transform'] })
              .views()[0];
            return view !== undefined && abs(view.get(Transform).position.x - x) < 1e-9;
          }),
      )
      .holds(
        'the per-tick hash timeline matches the golden trajectory (see GOLDEN_TRAJECTORY)',
        (r) => trajectoryDigest(r.tickHashes) === GOLDEN_TRAJECTORY,
      );
  },
});

// --- trajectory pins -----------------------------------------------------------------------

/**
 * Golden digest of the **whole per-tick hash timeline**.
 *
 * The final state hash is nearly blind to dynamics here: the run ends at rest on the goal pillar
 * with zero velocity, so a regression whose route differs but whose resting state converges is
 * invisible to it. Digesting every tick's hash makes any changed trajectory — a different jump
 * arc, a critter that stops patrolling, a ferry that carries at the wrong rate — go red.
 */
export const GOLDEN_TRAJECTORY = '79d373c4785825ca';

/**
 * Digest a run's per-tick hash timeline into one comparable value, using core's frozen
 * {@link hashString} (the same FNV-1a the world hash uses), so the digest is as portable and as
 * deterministic as the hashes it summarises.
 */
export function trajectoryDigest(tickHashes: readonly StateHash[]): StateHash {
  return hashString(tickHashes.join('|'));
}

/** The scripted coyote press: fired *after* the player has run off the ledge at x=37. */
const COYOTE_JUMP_TICK = 288;
/** The scripted buffered press: made while still airborne, a few ticks before touchdown. */
const BUFFERED_PRESS_TICK = 317;
/** The touchdown the buffered press is waiting for. */
const BUFFERED_LANDING_TICK = 320;

/** The player's position and body state at `tick` (requires `captureHistory`). */
function playerAt(result: SimResult, tick: number): { x: number; y: number; grounded: boolean } {
  const v = result
    .at(tick)
    .query({ has: ['Player', 'Transform'] })
    .one();
  const p = v.get(Transform).position;
  return { x: p.x, y: p.y, grounded: v.get(BodyState).grounded };
}

/** The `player.jumped` emitted on `tick`, if any. */
function jumpAt(result: SimResult, tick: number): { fromGround: boolean } | undefined {
  const ev = result.events.history().find((e) => e.type === 'player.jumped' && e.tick === tick);
  return ev?.data as { fromGround: boolean } | undefined;
}

/**
 * Four sampled points of the critter's `patrolX` triangle wave (15 ⇄ 17 at 3 u/s, period 80
 * ticks), as literal world positions. Named, readable evidence that the deterministic patrol is
 * actually running — freeze it and this says "the critter stopped walking its wave", not "a hash
 * moved". Ticks are chosen where the wave value is unambiguous (16.0 recurs; these do not).
 */
const CRITTER_WAVE: readonly (readonly [number, number])[] = [
  [126, 16.7],
  [145, 15.75],
  [158, 15.1],
  [186, 16.3],
];

/**
 * Four mid-run waypoints, one per hard beat. These are what a human reads when the trajectory
 * digest moves: they say *where* the run stopped matching the design, in the level's own terms.
 */
const WAYPOINTS: readonly {
  tick: number;
  check: (p: { x: number; y: number; grounded: boolean }) => boolean;
}[] = [
  // Beat 2: the spike pit is behind us and we are standing on the critter plateau.
  { tick: 60, check: (p) => p.grounded && p.x > 10 && p.x < 12 && p.y === 5.5 },
  // Beat 4a: stopped on the plateau lip, on solid ground, short of the 7-tile lava gap at x=20.
  { tick: 126, check: (p) => p.grounded && p.x > 19 && p.x < 20 && p.y === 5.5 },
  // Beat 4b: mid-lava, riding the ferry (only carry can put us out here at all).
  { tick: 186, check: (p) => p.grounded && p.x > 22 && p.x < 24 && p.y === 5.5 },
  // Beat 5: airborne over the 2-tile coyote gap, past the ledge edge at x=37.
  { tick: 300, check: (p) => !p.grounded && p.x > 38 && p.x < 40 && p.y > 6 },
];

// --- the lose paths, proven ------------------------------------------------------------------
//
// `eventNotEmitted('player.died')` in the winning run proves *nothing* on its own: an event that
// is never emitted anywhere passes it, even if the emitter is deleted outright. These three runs
// are what give it meaning. They are also the only tests of the level's three lethal contacts —
// spikes, the void, and the critter's teeth — all three of which the docs claim and, until now,
// nothing verified. Each is the winning script with one thing taken away, so each also shows
// exactly which capability the win depends on.

/** Read the single `player.died` payload, if the run produced one. */
function deathOf(result: SimResult): { cause: string; tick: number } | undefined {
  const ev = result.events.history().find((e) => e.type === 'player.died');
  return ev?.data as { cause: string; tick: number } | undefined;
}

/**
 * Beat 2, failed: run right and never jump. The player runs off the plateau into the 3-tile
 * spike pit (cols 7–9) and its `hazard` `Trigger` kills it. Deleting the hazard branch of
 * `game.hazard` leaves the winning run green; it turns this one into a silent 120-tick fall.
 */
export const spikePitDeathTest = defineGameTest({
  name: 'coyote gap (lose): run into the spike pit without jumping',
  scene: 'games/platformer/levels/coyote-gap.scene.json',
  options: { plugin: coyoteGapPlugin, captureHistory: false },
  ticks: 120,
  seed: 'poc-platformer',
  input: `
    hold Right 0..120
  `,
  expect(result) {
    expectSim(result)
      .eventEmitted('player.died', 1)
      .eventEmitted('damage.taken', 1)
      .eventNotEmitted('level.completed')
      .eventNotEmitted('enemy.killed')
      .holds('player.died reports cause "hazard" on the tick it entered the spikes', (r) => {
        const death = deathOf(r);
        return death?.cause === 'hazard' && death.tick === 43;
      })
      .holds('the damage was attributed to the hazard, not the critter', (r) => {
        const dmg = r.events.history().find((e) => e.type === 'damage.taken');
        return (dmg?.data as { source: string } | undefined)?.source === 'hazard';
      });
  },
});

/**
 * Beats 5 and 6, failed: the winning script with **both** jumps at the coyote ledge removed. The
 * player runs off the ledge at x=37 into the 2-tile gap, which has no hazard volume under it, and
 * falls out of the world (`Transform.position.y < -4`).
 *
 * This pins the *other* death cause — the positional one — and doubles as the proof that the
 * coyote and buffer presses are load-bearing: with them the run completes, without them it dies.
 */
export const fellOutOfWorldTest = defineGameTest({
  name: 'coyote gap (lose): miss the coyote jump and fall out of the world',
  scene: 'games/platformer/levels/coyote-gap.scene.json',
  options: { plugin: coyoteGapPlugin, captureHistory: false },
  ticks: 360,
  seed: 'poc-platformer',
  input: `
    hold Right 0..126
    press Jump @28
    press Jump @74
    hold Right 138..152
    hold Right 190..400
  `,
  expect(result) {
    expectSim(result)
      // The run gets all the way to the ledge — the ferry still carried us — and only then fails.
      .eventEmitted('platform.boarded', 1)
      .eventEmitted('enemy.killed', 1)
      .eventEmitted('player.died', 1)
      .eventNotEmitted('level.completed')
      .holds('player.died reports cause "fell" once the player is below y = -4', (r) => {
        const death = deathOf(r);
        return death?.cause === 'fell' && death.tick === 319;
      })
      .holds(
        'no hazard volume was involved — this death is positional',
        (r) => r.events.count('damage.taken') === 0,
      );
  },
});

/**
 * Beat 3, failed: the winning script with the stomp press (`@74`) removed. The player runs into
 * the critter on the flat instead of dropping onto it, so `game.stompgore` takes the *gore*
 * branch. The discrimination is the point: this run must emit `player.died{cause:'critter'}` and
 * **no** `enemy.killed`, while the winning run emits `enemy.killed` and no death. Collapse the
 * branch either way and exactly one of the two runs goes red.
 */
export const critterGoreTest = defineGameTest({
  name: 'coyote gap (lose): walk into the critter instead of stomping it',
  scene: 'games/platformer/levels/coyote-gap.scene.json',
  options: { plugin: coyoteGapPlugin, captureHistory: false },
  ticks: 140,
  seed: 'poc-platformer',
  input: `
    hold Right 0..126
    press Jump @28
  `,
  expect(result) {
    expectSim(result)
      .eventEmitted('player.died', 1)
      .eventEmitted('damage.taken', 1)
      .eventNotEmitted('level.completed')
      // The critter survives: a side-on hit is a gore, never a stomp.
      .eventNotEmitted('enemy.killed')
      .holds('player.died reports cause "critter" on the tick of contact', (r) => {
        const death = deathOf(r);
        return death?.cause === 'critter' && death.tick === 91;
      })
      .holds('the damage was attributed to the critter, not a hazard', (r) => {
        const dmg = r.events.history().find((e) => e.type === 'damage.taken');
        return (dmg?.data as { source: string } | undefined)?.source === 'critter';
      });
  },
});
