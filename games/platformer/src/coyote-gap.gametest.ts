/**
 * "Coyote Gap" — the game's acceptance specification, expressed as a headless {@link defineGameTest}
 * (CHARTER principle 7: the game *is* the mode's acceptance test). Running this scene + input script
 * under the composed {@link coyoteGapPlugin} must complete the level, prove the four beat events, and
 * hold the whole-timeline physics invariants — with no pixels.
 *
 * Deviation from `docs/games/platformer.md` §"The gameplay assertions": the doc's block imports the
 * bare `platformerPlugin`. Game-semantic events (`enemy.killed`, `player.died`, `level.completed`)
 * are emitted by *game* systems, and `executeRun` composes the schedule solely from `plugin.systems()`
 * — so the run must use the composed `coyoteGapPlugin` (mode + content + game systems). The tuned tick
 * numbers below also replace the doc's design-intent numbers; both changes are recorded in the doc.
 * @packageDocumentation
 */
import { defineGameTest, expectSim } from '@aegis/harness';
import { Transform } from '@aegis/core';
import { coyoteGapPlugin } from './plugin.js';

export default defineGameTest({
  name: 'coyote gap: stomp, ride, coyote-jump, reach the flag',
  scene: 'games/platformer/levels/coyote-gap.scene.json',
  options: { plugin: coyoteGapPlugin, captureHistory: true },
  ticks: 400,
  seed: 'poc-platformer',
  input: `
    hold Right 0..360
    press Jump @28
    press Jump @74
    press Jump @238
    press Jump @266
  `,
  expect(result) {
    expectSim(result)
      .eventEmitted('level.completed', 1) // finished, exactly once
      .eventNotEmitted('player.died') // survived the whole run
      .eventEmitted('enemy.killed', 1) // the critter was actually stomped
      .eventEmitted('platform.boarded', 1) // the moving platform actually carried us
      .entityExists({ has: ['Player'] })
      .holds(
        'player ended on/past the goal pillar',
        (r) =>
          r
            .query({ has: ['Player', 'Transform'] })
            .one()
            .get(Transform).position.x >= 36,
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
  },
});
