/**
 * Acceptance test for "Coyote Gap" — the platformer PoC, run headless with no pixels.
 *
 * Discovered by the root vitest run (root `vitest.config.ts` globs every game's `test` directory),
 * so the game is exercised by `npm run verify` exactly like every package is. CHARTER principle 7:
 * the game is the mode's acceptance test, and CHARTER §4.3 requires the scripted playthrough to
 * run headlessly with gameplay assertions.
 *
 * The game's own `coyote-gap.gametest.ts` is a *specification* (an exported `defineGameTest`), not
 * a vitest file; this is the runner that executes it, plus the cross-run + `replay()` determinism
 * proof over the whole per-tick hash timeline.
 */
import { describe, it, expect } from 'vitest';
import { runScene, runGameTest } from '@aegis/harness';
import coyoteGap from '../src/coyote-gap.gametest.js';

describe('Coyote Gap — acceptance', () => {
  it('completes the level and satisfies every gameplay assertion', async () => {
    const outcome = await runGameTest(coyoteGap);
    if (!outcome.passed) {
      throw outcome.error ?? new Error('game test failed without an error');
    }
    expect(outcome.passed).toBe(true);
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
  });
});
