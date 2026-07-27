import { describe, it, expect } from 'vitest';
import {
  extrudeFloorplan,
  cellCenterWorld,
  worldToCell,
  cellAtWorld,
  circleHitsSolid,
  raycastGrid,
  rayBox,
  forwardFromLook,
  forwardHorizFromYaw,
  rightFromYaw,
} from './geometry.js';
import type { FloorplanSpec, CollisionGrid } from './geometry.js';
import type { Vec3 } from '@aegis/core';

/** A 5×5 walled room with an interior wall pillar at world (2, 2). */
function room(): CollisionGrid {
  const spec: FloorplanSpec = {
    width: 5,
    height: 5,
    tileSize: 1,
    origin: { x: 0, z: 0 },
    rows: [
      '#####', // row 0 = north, z = 4
      '#...#',
      '#.#.#', // interior pillar at col 2, row 2 -> world (2, 2)
      '#...#',
      '#####', // row 4 = south, z = 0
    ],
    legend: {
      '#': { solid: true, floor: 0, ceil: 4 },
      '.': { solid: false, floor: 0, ceil: 4 },
    },
  };
  return extrudeFloorplan(spec);
}

/** A 1×3 corridor with a knee-high wall in the middle: `o S o`, wall ceil = 1. */
function shortWallLine(): CollisionGrid {
  const spec: FloorplanSpec = {
    width: 3,
    height: 1,
    tileSize: 1,
    origin: { x: 0, z: 0 },
    rows: ['oSo'],
    legend: {
      o: { solid: false, floor: 0, ceil: 4 },
      S: { solid: true, floor: 0, ceil: 1 },
    },
  };
  return extrudeFloorplan(spec);
}

describe('extrudeFloorplan', () => {
  it('produces one cell per tile with legend-derived properties', () => {
    const grid = room();
    expect(grid.cells).toHaveLength(25);
    // north-west corner is a wall
    expect(cellAtWorld(grid, 0, 4).solid).toBe(true);
    // interior pillar
    expect(cellAtWorld(grid, 2, 2).solid).toBe(true);
    // open floor
    expect(cellAtWorld(grid, 1, 1).solid).toBe(false);
  });

  it('carries per-tile floor/ceiling heights (verticality)', () => {
    const spec: FloorplanSpec = {
      width: 1,
      height: 1,
      tileSize: 1,
      origin: { x: 0, z: 0 },
      rows: ['T'],
      legend: { T: { solid: false, floor: -3, ceil: 4 } },
    };
    const grid = extrudeFloorplan(spec);
    expect(cellAtWorld(grid, 0, 0).floor).toBe(-3);
    expect(cellAtWorld(grid, 0, 0).ceil).toBe(4);
  });

  it('throws on a tile key that is not in the legend', () => {
    const spec: FloorplanSpec = {
      width: 1,
      height: 1,
      tileSize: 1,
      origin: { x: 0, z: 0 },
      rows: ['?'],
      legend: { '.': { solid: false, floor: 0, ceil: 4 } },
    };
    expect(() => extrudeFloorplan(spec)).toThrow(/not in the legend/);
  });
});

describe('cell <-> world mapping', () => {
  it('round-trips cell centre through worldToCell', () => {
    const grid = room();
    for (const [col, r] of [
      [0, 0],
      [2, 2],
      [4, 4],
      [1, 3],
    ] as const) {
      const w = cellCenterWorld(grid, col, r);
      const back = worldToCell(grid, w.x, w.z);
      expect(back).toEqual({ col, row: r });
    }
  });

  it('places row 0 to the north (max z) and the last row to the south', () => {
    const grid = room();
    expect(cellCenterWorld(grid, 0, 0).z).toBe(4); // north
    expect(cellCenterWorld(grid, 0, 4).z).toBe(0); // south
  });
});

describe('circleHitsSolid', () => {
  it('is clear in the middle of an open cell', () => {
    const grid = room();
    expect(circleHitsSolid(grid, 1, 1, 0.4)).toBe(false);
  });

  it('detects overlap with a nearby wall within the radius', () => {
    const grid = room();
    // Interior pillar occupies [1.5, 2.5] in x and z. A circle just west of it.
    expect(circleHitsSolid(grid, 1.35, 2, 0.4)).toBe(true); // 1.35 + 0.4 = 1.75 > 1.5
    expect(circleHitsSolid(grid, 1.0, 2, 0.4)).toBe(false); // 1.0 + 0.4 = 1.4 < 1.5
  });

  // The cells to test are chosen from a `radius`-sized window, but the decision is a *circle*
  // test — so the two can disagree, and until this case nothing checked the disagreement. The
  // assertions above sit either well inside a cell or square-on to a wall face, where the window
  // alone decides the answer; inflate the distance comparison ninefold and they all still pass.
  // A corner is the one geometry where a solid cell is inside the scanned window and outside the
  // radius, which makes this the only place the distance test is load-bearing.
  it('judges a circle near a wall corner by distance, not by the cells it scanned', () => {
    const grid = room();
    // The pillar's nearest point to (1.2, 1.2) is its corner (1.5, 1.5), sqrt(0.3² + 0.3²) ≈
    // 0.4243 away: outside a 0.4 radius, inside a 0.45 one, with the pillar inside the scanned
    // window in both cases. The second assertion is the positive control — without it, a
    // `circleHitsSolid` that never reports a hit would satisfy the first.
    expect(circleHitsSolid(grid, 1.2, 1.2, 0.4)).toBe(false);
    expect(circleHitsSolid(grid, 1.2, 1.2, 0.45)).toBe(true);
  });
});

describe('raycastGrid', () => {
  const EYE = 0.5;

  it('hits a wall along the ray and reports the entry distance', () => {
    const grid = room();
    // From world (2, 1) fire north (+Z): the pillar face is at z = 1.5.
    const hit = raycastGrid(grid, { x: 2, y: EYE, z: 1 }, { x: 0, y: 0, z: 1 }, 100);
    expect(hit).toBeDefined();
    expect(hit!.distance).toBeCloseTo(0.5, 6);
  });

  it('misses when the wall is beyond maxDist', () => {
    const grid = room();
    // North wall face is at z = 3.5 (distance 2.5); cap the ray at 1.
    const hit = raycastGrid(grid, { x: 1, y: EYE, z: 1 }, { x: 0, y: 0, z: 1 }, 1);
    expect(hit).toBeUndefined();
  });

  it('is blocked by a wall at eye height but passes over a knee-high wall', () => {
    const grid = shortWallLine();
    const dir: Vec3 = { x: 1, y: 0, z: 0 };
    // At y = 0.5 (below the wall ceil of 1) the middle knee wall blocks the ray at 0.5.
    const low = raycastGrid(grid, { x: 0, y: 0.5, z: 0 }, dir, 10);
    expect(low).toBeDefined();
    expect(low!.distance).toBeCloseTo(0.5, 6);
    // At y = 2 (above the knee wall's ceil of 1) the ray clears it and only the far
    // boundary (at distance 2.5) stops it — proving the y-range gate let it pass through.
    const high = raycastGrid(grid, { x: 0, y: 2, z: 0 }, dir, 10);
    expect(high).toBeDefined();
    expect(high!.distance).toBeCloseTo(2.5, 6);
  });
});

// M6. `round` sends a coordinate sitting exactly on a cell boundary to the +side cell whatever way
// the ray points, so a west-bound ray opened its march inside the cell *behind* it and reported a
// distance-0 hit on the wall at its back. Every shot absorbed at range 0, every LOS probe failed.
describe('raycastGrid — an origin on a cell boundary', () => {
  /** A 3x3 walled room: only the centre cell is open. Boundaries fall on half-integer world x. */
  function pocket(originX: number): CollisionGrid {
    return extrudeFloorplan({
      width: 3,
      height: 3,
      tileSize: 1,
      origin: { x: originX, z: 0 },
      rows: ['###', '#.#', '###'],
      legend: {
        '#': { solid: true, floor: 0, ceil: 4 },
        '.': { solid: false, floor: 0, ceil: 4 },
      },
    });
  }

  it('does not report a hit on the wall behind a west-bound ray', () => {
    const grid = pocket(0);
    // x = 1.5 is the boundary between col 1 (open) and col 2 (the east wall).
    const hit = raycastGrid(grid, { x: 1.5, y: 1, z: 1 }, { x: -1, y: 0, z: 0 }, 10);
    expect(hit).toBeDefined();
    expect(hit!.col).toBe(0); // the west wall, ahead of the ray — not col 2 behind it
    expect(hit!.distance).toBeCloseTo(1, 6);
  });

  it('still reports the wall it is entering when the ray points the other way', () => {
    const grid = pocket(0);
    const hit = raycastGrid(grid, { x: 1.5, y: 1, z: 1 }, { x: 1, y: 0, z: 0 }, 10);
    expect(hit).toBeDefined();
    expect(hit!.col).toBe(2);
    expect(hit!.distance).toBeCloseTo(0, 6);
  });

  it('is symmetric about a boundary: opposite rays report opposite walls', () => {
    const grid = pocket(0);
    const west = raycastGrid(grid, { x: 1.5, y: 1, z: 1 }, { x: -1, y: 0, z: 0 }, 10);
    const east = raycastGrid(grid, { x: 1.5, y: 1, z: 1 }, { x: 1, y: 0, z: 0 }, 10);
    expect(west!.col).not.toBe(east!.col);
  });

  it('reaches shipped content: a negative grid origin puts actors on boundaries', () => {
    // Sector Breach's floorplan origin is x = -5, so any half-integer world x is a cell boundary.
    const grid = extrudeFloorplan({
      width: 11,
      height: 1,
      tileSize: 1,
      origin: { x: -5, z: 0 },
      rows: ['#.....#....'],
      legend: {
        '#': { solid: true, floor: 0, ceil: 4 },
        '.': { solid: false, floor: 0, ceil: 4 },
      },
    });
    // World x = 0.5 is the boundary between col 5 (open) and col 6 (a wall).
    const hit = raycastGrid(grid, { x: 0.5, y: 1.6, z: 0 }, { x: -1, y: 0, z: 0 }, 100);
    expect(hit).toBeDefined();
    expect(hit!.col).toBe(0); // the far west wall, face at x = -4.5
    expect(hit!.distance).toBeCloseTo(5, 6);
  });

  it('leaves a non-boundary origin exactly where it was', () => {
    // Regression guard on the seeding change: cell centres must resolve as before.
    const grid = pocket(0);
    const hit = raycastGrid(grid, { x: 1, y: 1, z: 1 }, { x: -1, y: 0, z: 0 }, 10);
    expect(hit!.col).toBe(0);
    expect(hit!.distance).toBeCloseTo(0.5, 6);
  });
});

// m17. `NaN > 0` and `NaN < 0` are both false, so a NaN component produced `step = 0`: the ray
// quietly marched along the remaining axes and returned a confident wrong answer.
describe('raycastGrid — a non-finite direction is a fault, not a degraded ray', () => {
  it('throws on a NaN direction component instead of marching the other axes', () => {
    const grid = room();
    expect(() => raycastGrid(grid, { x: 1, y: 0.5, z: 1 }, { x: NaN, y: 0, z: 1 }, 10)).toThrow(
      /finite/,
    );
  });

  it('throws on an infinite direction component', () => {
    const grid = room();
    expect(() =>
      raycastGrid(grid, { x: 1, y: 0.5, z: 1 }, { x: Number.POSITIVE_INFINITY, y: 0, z: 0 }, 10),
    ).toThrow(/finite/);
  });
});

describe('rayBox', () => {
  const center: Vec3 = { x: 3, y: 0, z: 0 };
  const half: Vec3 = { x: 0.5, y: 0.5, z: 0.5 };

  it('returns the entry distance for a ray that strikes the box', () => {
    const t = rayBox({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, center, half);
    expect(t).toBeCloseTo(2.5, 6);
  });

  it('returns undefined for a ray that misses the box', () => {
    const t = rayBox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, center, half);
    expect(t).toBeUndefined();
  });

  it('returns undefined when the box is entirely behind the origin', () => {
    const t = rayBox({ x: 0, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, center, half);
    expect(t).toBeUndefined();
  });

  // m15. The docstring promised 0 for an origin inside the box; the code returned `tmax`, the
  // *exit* distance. `resolveShot` picks the nearest hit by comparing these, so a shooter standing
  // inside a hit volume ranked that volume behind things genuinely further away.
  it('returns 0 — not the exit distance — when the origin is inside the box', () => {
    const t = rayBox({ x: 3, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, center, half);
    expect(t).toBe(0);
  });

  it('ranks a box the origin is inside ahead of a box further along the ray', () => {
    // The near box is tighter than the one the origin sits in, so returning the *exit* distance
    // for the enclosing box (the old behaviour, 0.5 here) mis-orders them.
    const inside = rayBox({ x: 3, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, center, half);
    const ahead = rayBox(
      { x: 3, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 3.3, y: 0, z: 0 },
      { x: 0.1, y: 0.5, z: 0.5 },
    );
    expect(inside).toBeDefined();
    expect(ahead).toBeDefined();
    expect(inside!).toBeLessThan(ahead!);
  });

  it('returns 0 rather than Infinity for a zero-length direction inside the box', () => {
    const t = rayBox({ x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, center, half);
    expect(t).toBe(0);
  });

  it('still returns undefined for a zero-length direction outside the box', () => {
    const t = rayBox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, center, half);
    expect(t).toBeUndefined();
  });
});

describe('look-direction basis vectors', () => {
  it('yaw 0 faces +Z and yaw 90 faces +X', () => {
    const f0 = forwardFromLook(0, 0);
    expect(f0.z).toBeCloseTo(1, 6);
    expect(f0.x).toBeCloseTo(0, 6);
    const f90 = forwardFromLook(90, 0);
    expect(f90.x).toBeCloseTo(1, 6);
    expect(f90.z).toBeCloseTo(0, 6);
  });

  it('positive pitch tilts the forward vector up (+Y)', () => {
    const f = forwardFromLook(0, 90);
    expect(f.y).toBeCloseTo(1, 6);
  });

  it('horizontal forward drops the pitch component', () => {
    const f = forwardHorizFromYaw(0);
    expect(f).toMatchObject({ y: 0 });
    expect(f.z).toBeCloseTo(1, 6);
  });

  it('right is +X at yaw 0', () => {
    const r = rightFromYaw(0);
    expect(r.x).toBeCloseTo(1, 6);
    expect(r.z).toBeCloseTo(0, 6);
  });
});
