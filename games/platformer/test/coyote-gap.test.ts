/**
 * Acceptance test for "Coyote Gap" — the platformer PoC, run headless with no pixels.
 *
 * Discovered by the root vitest run (root `vitest.config.ts` globs every game's `test` directory),
 * so the game is exercised by `npm run verify` exactly like every package is. CHARTER principle 7:
 * the game is the mode's acceptance test, and CHARTER §4.3 requires the scripted playthrough to
 * run headlessly with gameplay assertions.
 *
 * The game's own `coyote-gap.gametest.ts` is a *specification* (exported `defineGameTest`s), not
 * a vitest file; this is the runner that executes them — the winning run and the three lose runs —
 * plus the cross-run + `replay()` determinism proof over the whole per-tick hash timeline.
 */
import { describe, it, expect } from 'vitest';
import { runScene, runGameTest } from '@aegis/harness';
import type { GameTest } from '@aegis/harness';
import coyoteGap, {
  critterGoreTest,
  fellOutOfWorldTest,
  GOLDEN_TRAJECTORY,
  spikePitDeathTest,
  trajectoryDigest,
} from '../src/coyote-gap.gametest.js';

/** Run a game test and rethrow the harness's message verbatim on failure. */
async function expectGameTest(test: GameTest): Promise<void> {
  const outcome = await runGameTest(test);
  if (!outcome.passed) {
    throw outcome.error ?? new Error('game test failed without an error');
  }
  expect(outcome.passed).toBe(true);
}

describe('Coyote Gap — acceptance', () => {
  it('completes the level and satisfies every gameplay assertion', async () => {
    await expectGameTest(coyoteGap);
  });

  // The lose paths. Without these, `eventNotEmitted('player.died')` above is vacuous — it passes
  // even if the death emitter is deleted, because no run in the suite ever produced one.
  it('dies in the spike pit when the first jump is missed', async () => {
    await expectGameTest(spikePitDeathTest);
  });

  it('falls out of the world when the coyote jump is missed', async () => {
    await expectGameTest(fellOutOfWorldTest);
  });

  it('is gored (not a stomp) when the critter is walked into', async () => {
    await expectGameTest(critterGoreTest);
  });

  it('is deterministic: identical hash across independent runs and on replay', async () => {
    const runOnce = () =>
      runScene(coyoteGap.scene, {
        ...coyoteGap.options,
        ticks: coyoteGap.ticks,
        seed: coyoteGap.seed,
        input: coyoteGap.input,
      });

    const first = await runOnce();
    const second = await runOnce();

    // Same scene + script + seed must yield a bit-identical golden hash.
    expect(second.hash).toBe(first.hash);
    // The per-tick hash timeline must match tick-for-tick, not just at the end.
    expect(second.tickHashes).toEqual(first.tickHashes);

    // replay() re-runs the recorded inputs and must reproduce the same final hash.
    const replayed = first.replay();
    expect(replayed.hash).toBe(first.hash);
    expect(replayed.tickHashes).toEqual(first.tickHashes);

    // ...and the trajectory is pinned against a stored golden, not just compared run-to-run.
    expect(trajectoryDigest(first.tickHashes)).toBe(GOLDEN_TRAJECTORY);
  });
});
