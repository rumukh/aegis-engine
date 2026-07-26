/**
 * Authoritative acceptance test for the platformer slice. Lives in this owned package (auto-discovered
 * by the root vitest run) and drives the *game* — the composed `coyoteGapPlugin` from `games/platformer`
 * — through the spec's `defineGameTest` (CHARTER principle 7: the game is the mode's acceptance test).
 *
 * Wiring note for the PM: `games/*` is not part of the root workspaces / vitest include / tsconfig
 * references, so the game's own `.gametest.ts` is not auto-run. Until that is wired centrally, this
 * package hosts the authoritative run and imports the game by relative path. The mode `tsconfig.json`
 * excludes `*.test.ts`, so `tsc -b` never sees this cross-package import (no TS6059).
 */
import { describe, it, expect } from 'vitest';
import { runScene, runGameTest } from '@aegis/harness';
import coyoteGap from '../../../games/platformer/src/coyote-gap.gametest.js';

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
