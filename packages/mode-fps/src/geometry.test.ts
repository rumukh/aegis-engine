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
