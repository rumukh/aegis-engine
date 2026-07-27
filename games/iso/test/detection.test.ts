/**
 * "Does a wall stop the guard seeing you?" — asserted directly, in both directions.
 *
 * Nothing in this repository asserted that. `lineOfSight` could be replaced with `return true` and
 * the only thing that went red was a *patrol* assertion in the acceptance test: with sight never
 * blocked the guard alerts on tick 0, stops patrolling, and the failure names the wrong
 * capability. That pin also rests entirely on a neighbour — re-time the patrol beats and
 * line-of-sight silently becomes unpinned again.
 *
 * Two halves, and the second is not optional. The wall-present half alone passes just as happily
 * if `lineOfSight` always returns *false*: "the guard did not see the operative" is satisfied by a
 * detector that can never fire at all. The wall-absent half is the positive control that gives the
 * first half its meaning, and the out-of-range case pins the other half of the same rule.
 *
 * The scenes run on the shipped {@link serverVaultPlugin} — the game's real composition, not a
 * bespoke one — so what is proven here is the behaviour the game actually has. The guard is placed
 * on row 5 at x=1 because that is where `patrolCell(t)` holds it for the first twenty ticks; these
 * runs are five ticks long, so the patrol is a constant and the geometry is the only variable.
 */
import { describe, expect, it } from 'vitest';
import type { SceneFile } from '@aegis/content';
import { runScene } from '@aegis/harness';
import { GUARD_ALERTED, patrolCell, serverVaultPlugin } from '../src/server-vault.js';

/** The guard's cell for the whole of every run below (one place, so the scenes can't drift). */
const GUARD_CELL = patrolCell(0);

/**
 * A 7x7 sight-line range: guard at (1,5), operative on the same row, optionally with one wall
 * cell at (2,5) standing between them. Everything else is open floor.
 */
function sightlineScene(opts: { readonly wall: boolean; readonly operativeX: number }): SceneFile {
  const open = '.......';
  const row5 = opts.wall ? '..#....' : open;
  return {
    aegis: 'scene/1',
    name: `sightline (${opts.wall ? 'wall between' : 'clear'}, operative at x=${opts.operativeX})`,
    mode: 'iso',
    seed: 'iso-sightline',
    resources: {
      IsoGrid: {
        width: 7,
        height: 7,
        tileSize: 1,
        walls: [open, open, open, open, open, row5, open],
      },
    },
    entities: [
      {
        id: 'guard',
        tags: ['Guard', 'Patrol'],
        components: {
          GridPosition: { cellX: GUARD_CELL.x, cellY: GUARD_CELL.y, progress: 0 },
          IsoActor: { speed: 4, moveMode: 'realtime' },
          Health: { current: 20, max: 20 },
          Attacker: { rangeCells: 3, damage: 5, cooldownTicks: 40, cooldownRemaining: 0 },
        },
      },
      {
        id: 'operative',
        tags: ['Operative', 'Controlled'],
        components: {
          GridPosition: { cellX: opts.operativeX, cellY: GUARD_CELL.y, progress: 0 },
          IsoActor: { speed: 4, moveMode: 'realtime' },
          Health: { current: 30, max: 30 },
          Attacker: { rangeCells: 3, damage: 10, cooldownTicks: 30, cooldownRemaining: 0 },
        },
      },
      {
        id: 'iso-camera',
        components: { IsoCamera: { target: 'operative', viewHeight: 16, yawDegrees: 45 } },
      },
    ],
  };
}

/** Did the guard raise the alarm in the first five ticks of this scene? */
async function guardSaw(scene: SceneFile): Promise<boolean> {
  const result = await runScene(scene, {
    plugin: serverVaultPlugin,
    ticks: 5,
    seed: 'iso-sightline',
  });
  return result.events.history().some((e) => e.type === GUARD_ALERTED);
}

describe('a wall blocks sight', () => {
  it('the guard does not see an operative three cells away with a wall between them', async () => {
    // Guard (1,5), operative (4,5): Chebyshev 3, so range is *not* what stops it. The wall at
    // (2,5) is.
    expect(await guardSaw(sightlineScene({ wall: true, operativeX: 4 }))).toBe(false);
  });

  it('positive control: remove that one wall cell and the same guard sees the same operative', async () => {
    expect(await guardSaw(sightlineScene({ wall: false, operativeX: 4 }))).toBe(true);
  });

  it('the wall is what stopped it, not distance: one cell further out is unseen with no wall', async () => {
    // (1,5) to (5,5) is Chebyshev 4, one past the guard's detection radius of 3.
    expect(await guardSaw(sightlineScene({ wall: false, operativeX: 5 }))).toBe(false);
  });

  it('sight is mutual at the scene level: the wall stops the shooting, not just the seeing', async () => {
    // If the guard cannot see the operative it cannot fire on it either, so a wall between them
    // means no shot is exchanged in either direction.
    const walled = await runScene(sightlineScene({ wall: true, operativeX: 4 }), {
      plugin: serverVaultPlugin,
      ticks: 5,
      seed: 'iso-sightline',
    });
    const clear = await runScene(sightlineScene({ wall: false, operativeX: 4 }), {
      plugin: serverVaultPlugin,
      ticks: 5,
      seed: 'iso-sightline',
    });
    expect(walled.events.count('attack.fired')).toBe(0);
    expect(clear.events.count('attack.fired')).toBeGreaterThan(0);
  });
});
