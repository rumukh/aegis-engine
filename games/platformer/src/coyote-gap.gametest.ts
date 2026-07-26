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
import { Transform } from '@aegis/core';
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
      .hashEquals('d813e4e19db7444d'); // golden master, pinned as a literal (never result.hash — self-referential); re-derive deliberately if the design changes

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
  },
});
