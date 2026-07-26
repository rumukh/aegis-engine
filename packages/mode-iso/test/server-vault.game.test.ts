/**
 * Discovery shim: run "The Server Vault" game's acceptance test (its exported `defineGameTest`)
 * from inside the mode package's test suite, since the root vitest config only discovers
 * `packages/**` tests. This keeps the game honest against every mode change without waiting for
 * the PM to wire `games/**` into the config.
 *
 * It also adds three checks the game's own test can't cleanly express: a cross-run + `replay()`
 * determinism proof, the negative `path.blocked` case (an unreachable target while the vault door
 * is still sealed), and a consistency assertion that the scene's `IsoGrid.walls` on disk still
 * matches the game's in-code `WALL_ROWS`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runGameTest, runScene } from '@aegis/harness';
import serverVaultTest, {
  GOLDEN_HASH,
  serverVaultPlugin,
  WALL_ROWS,
} from '../../../games/iso/src/server-vault';

const SCENE = 'games/iso/levels/server-vault.scene.json';

describe('game: The Server Vault (mode-iso acceptance)', () => {
  it('passes its exported defineGameTest as specified', async () => {
    const outcome = await runGameTest(serverVaultTest);
    if (!outcome.passed) throw outcome.error;
    expect(outcome.passed).toBe(true);
  });

  it('is deterministic: identical hash across runs and under replay()', async () => {
    const opts = {
      plugin: serverVaultPlugin,
      ticks: serverVaultTest.ticks,
      seed: serverVaultTest.seed,
      input: serverVaultTest.input,
      captureHistory: true,
    } as const;
    const a = await runScene(SCENE, opts);
    const b = await runScene(SCENE, opts);
    expect(b.hash).toBe(a.hash);

    const replayed = a.replay();
    expect(replayed.hash).toBe(a.hash);
    expect(replayed.tickHashes).toEqual(a.tickHashes);

    expect(a.hash).toBe(GOLDEN_HASH);
  });

  it('reports path.blocked (never a silent half-move) for an unreachable target', async () => {
    // The exit (4,7) sits behind the sealed vault door; with the switch never flipped there is
    // no route, so an immediate click must honestly fail and the mission must not complete.
    const result = await runScene(SCENE, {
      plugin: serverVaultPlugin,
      ticks: 120,
      seed: serverVaultTest.seed,
      input: 'click 4,7 @5',
      captureHistory: true,
    });
    const blocked = result.events.history().filter((e) => e.type === 'path.blocked');
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(result.events.history().some((e) => e.type === 'mission.completed')).toBe(false);
  });

  it("scene IsoGrid.walls stays identical to the game's WALL_ROWS", () => {
    const scene = JSON.parse(readFileSync(SCENE, 'utf8')) as {
      resources: { IsoGrid: { walls: string[] } };
    };
    expect(scene.resources.IsoGrid.walls).toEqual([...WALL_ROWS]);
  });
});
