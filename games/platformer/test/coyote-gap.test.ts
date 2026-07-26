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
import { readFileSync } from 'node:fs';
import { runScene, runGameTest } from '@aegis/harness';
import type { GameTest } from '@aegis/harness';
import coyoteGap, {
  corpseCannotFinishTest,
  critterGoreTest,
  fellOutOfWorldTest,
  GOLDEN_HASH,
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

/** The bare commands of an input script: comments, blank lines and indentation removed, sorted. */
function commandsOf(script: string): string[] {
  return script
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
    .sort();
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

  // "The dead thing stops participating" — the facet the game owns. The mode still steers, falls,
  // carries and even jumps the corpse (reported to the PM), but the level must not be completable
  // by one.
  it('does not let a corpse driven to the flag finish the level', async () => {
    await expectGameTest(corpseCannotFinishTest);
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

    // ...and both goldens are pinned against stored literals, not just compared run-to-run. The
    // final hash is asserted here as well as in the game test's own chain: the two fail
    // differently, and this one fails next to the per-tick comparison above, which says *when* the
    // run diverged rather than only that it did.
    expect(first.hash).toBe(GOLDEN_HASH);
    expect(trajectoryDigest(first.tickHashes)).toBe(GOLDEN_TRAJECTORY);
  });

  it('play/coyote-gap.input mirrors the script the test actually runs (no drift)', () => {
    // The doc and the playable script live in `play/`, the executed script is the game test's
    // `input`. They are two copies of one thing, so pin them together.
    const onDisk = readFileSync('games/platformer/play/coyote-gap.input', 'utf8');
    expect(commandsOf(onDisk)).toEqual(commandsOf(coyoteGap.input ?? ''));
  });
});
