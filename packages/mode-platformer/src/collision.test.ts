/**
 * Unit tests for the collision layer: baking a tilemap into a solid/hazard grid, the world↔cell
 * mapping, and AABB resolution from each of the four directions — proven directly on the pure
 * helpers, independent of any system, world, or game.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCollisionGrid,
  cellBottom,
  cellTop,
  colOf,
  isHazardAt,
  isSolidCell,
  resolveX,
  resolveY,
  restingOn,
  rowOf,
  tileBoxesNear,
} from './level.js';
import type { ModeTilemap } from './level.js';

/** Build a collision grid from ASCII rows (`#` solid, `^` hazard, `.` empty). */
function gridFrom(rows: string[]): ReturnType<typeof buildCollisionGrid> {
  const width = rows[0]?.length ?? 0;
  const tilemap: ModeTilemap = {
    width,
    height: rows.length,
    tileSize: 1,
    legend: {
      '#': { solid: true },
      '^': { solid: false, data: { hazard: true } },
    },
    layers: [{ name: 'collision', data: rows }],
  };
  return buildCollisionGrid(tilemap);
}

const HALF_W = 0.4;
const HALF_H = 0.5;

describe('collision grid + world↔cell mapping', () => {
  it('bakes solid and hazard cells and maps world coordinates to cells', () => {
    const grid = gridFrom([
      '......', // row 0  (y ∈ [5,6])
      '......', // row 1
      '......', // row 2
      '......', // row 3
      '..^...', // row 4  hazard at col 2
      '######', // row 5  floor (y ∈ [0,1])
    ]);
    expect(grid.width).toBe(6);
    expect(grid.height).toBe(6);
    expect(isSolidCell(grid, 0, 5)).toBe(true);
    expect(isSolidCell(grid, 2, 4)).toBe(false); // hazard is not solid
    expect(isSolidCell(grid, 2, 0)).toBe(false);

    // world → cell: a point just above the floor is in the floor row.
    expect(colOf(2.5)).toBe(2);
    expect(rowOf(0.5, grid.height)).toBe(5); // y∈[0,1] → bottom row
    expect(rowOf(5.5, grid.height)).toBe(0); // y∈[5,6] → top row
    expect(cellTop(5, grid.height)).toBe(1);
    expect(cellBottom(5, grid.height)).toBe(0);

    // the hazard cell occupies y ∈ [1,2] (row 4), x ∈ [2,3].
    expect(isHazardAt(grid, 2.5, 1.5)).toBe(true);
    expect(isHazardAt(grid, 3.5, 1.5)).toBe(false);
  });
});

describe('AABB resolution against tiles, from each direction', () => {
  it('lands on a floor when moving down (grounded)', () => {
    const grid = gridFrom(['......', '......', '......', '......', '......', '######']);
    const boxes = tileBoxesNear(grid, 2.5, 2, HALF_W, HALF_H, 3);
    const r = resolveY(boxes, 2.5, 2, HALF_W, HALF_H, -2);
    expect(r.grounded).toBe(true);
    expect(r.ceiling).toBe(false);
    expect(r.cy).toBeCloseTo(1.5, 9); // feet rest on floor top y=1
    expect(restingOn(boxes, 2.5, r.cy, HALF_W, HALF_H, 1e-6)).toBe(true);
  });

  it('stops at a ceiling when moving up', () => {
    const grid = gridFrom(['..#...', '......', '......', '......', '......', '......']);
    const boxes = tileBoxesNear(grid, 2.5, 4, HALF_W, HALF_H, 3);
    const r = resolveY(boxes, 2.5, 4, HALF_W, HALF_H, +2);
    expect(r.ceiling).toBe(true);
    expect(r.grounded).toBe(false);
    expect(r.cy).toBeCloseTo(4.5, 9); // head stops at ceiling bottom y=5
  });

  it('stops at a wall when moving right', () => {
    const grid = gridFrom(['......', '......', '....#.', '......', '......', '......']);
    const boxes = tileBoxesNear(grid, 3, 3, HALF_W, HALF_H, 3);
    const r = resolveX(boxes, 3, 3, HALF_W, HALF_H, +2);
    expect(r.hit).toBe(true);
    expect(r.cx).toBeCloseTo(3.6, 9); // right edge stops at wall left x=4
  });

  it('stops at a wall when moving left', () => {
    const grid = gridFrom(['......', '......', '.#....', '......', '......', '......']);
    const boxes = tileBoxesNear(grid, 3, 3, HALF_W, HALF_H, 3);
    const r = resolveX(boxes, 3, 3, HALF_W, HALF_H, -2);
    expect(r.hit).toBe(true);
    expect(r.cx).toBeCloseTo(2.4, 9); // left edge stops at wall right x=2
  });

  it('passes freely when nothing blocks the path', () => {
    const grid = gridFrom(['......', '......', '......', '......', '......', '######']);
    const boxes = tileBoxesNear(grid, 2.5, 4, HALF_W, HALF_H, 3);
    const rx = resolveX(boxes, 2.5, 4, HALF_W, HALF_H, +0.5);
    expect(rx.hit).toBe(false);
    expect(rx.cx).toBeCloseTo(3.0, 9);
    const ry = resolveY(boxes, 2.5, 4, HALF_W, HALF_H, -0.5);
    expect(ry.grounded).toBe(false);
    expect(ry.cy).toBeCloseTo(3.5, 9);
  });
});

// `restingOn`'s `eps` is what separates "standing on a surface" from "falling past it", and it is
// the caller's number — `platformer.integrate` passes 1e-4. Every other use of `restingOn` in this
// file feeds it a body exactly on the surface, where any tolerance at all answers `true`, so the
// size of the window was free to change by orders of magnitude unnoticed. These two cases straddle
// one specific tolerance from both sides, which is the only shape that pins a threshold.
describe('restingOn — the tolerance is a contract, not a hint', () => {
  const boxes = [{ left: 0, right: 4, bottom: 0, top: 2 }];

  it('a body within eps of the surface is resting on it', () => {
    // Feet at 2 + 5e-5, i.e. half the tolerance above the surface.
    expect(restingOn(boxes, 2, 2.5 + 5e-5, HALF_W, HALF_H, 1e-4)).toBe(true);
  });

  it('a body further than eps from the surface is not', () => {
    // Feet at 2 + 5e-4, five times the tolerance: airborne, however slightly.
    expect(restingOn(boxes, 2, 2.5 + 5e-4, HALF_W, HALF_H, 1e-4)).toBe(false);
  });

  it('needs horizontal overlap as well as vertical contact', () => {
    // Directly above the surface's east end but past it: nothing underfoot.
    expect(restingOn(boxes, 5, 2.5, HALF_W, HALF_H, 1e-4)).toBe(false);
  });
});
