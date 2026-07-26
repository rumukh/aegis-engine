import { describe, it, expect } from 'vitest';
import type { Cell, IsoGridConfig } from './components.js';
import {
  buildNavGrid,
  chebyshev,
  findAttackPath,
  findPath,
  inWeaponRange,
  lineOfSight,
  manhattan,
} from './grid.js';
import type { Blocked } from './grid.js';

/** A never-blocks predicate (only static walls apply). */
const OPEN: Blocked = () => false;

/** A tiny open grid of the given size, no static walls. */
function openGrid(width: number, height: number): IsoGridConfig {
  const walls = Array.from({ length: height }, () => '.'.repeat(width));
  return { width, height, tileSize: 1, walls };
}

describe('grid metrics', () => {
  it('chebyshev is the king-move distance', () => {
    expect(chebyshev({ x: 0, y: 0 }, { x: 3, y: 1 })).toBe(3);
    expect(chebyshev({ x: 2, y: 5 }, { x: 2, y: 5 })).toBe(0);
  });

  it('manhattan is the 4-neighbour distance', () => {
    expect(manhattan({ x: 0, y: 0 }, { x: 3, y: 1 })).toBe(4);
  });
});

describe('buildNavGrid', () => {
  it('bakes ASCII wall rows into a row-major bitmap', () => {
    const nav = buildNavGrid({
      width: 3,
      height: 2,
      tileSize: 1,
      walls: ['#.#', '..#'],
    });
    expect(nav.blocked).toEqual([true, false, true, false, false, true]);
  });

  it('treats missing/short rows as floor', () => {
    const nav = buildNavGrid({ width: 3, height: 2, tileSize: 1, walls: ['#'] });
    expect(nav.blocked).toEqual([true, false, false, false, false, false]);
  });
});

describe('findPath — correctness', () => {
  it('returns [] when start === goal', () => {
    const nav = buildNavGrid(openGrid(3, 3));
    expect(findPath(nav, OPEN, { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([]);
  });

  it('returns cells after the start, up to and including the goal', () => {
    const nav = buildNavGrid(openGrid(4, 1));
    expect(findPath(nav, OPEN, { x: 0, y: 0 }, { x: 3, y: 0 })).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
  });

  it('every returned step is in-bounds, adjacent and passable', () => {
    const nav = buildNavGrid(openGrid(5, 5));
    const start = { x: 0, y: 0 };
    const path = findPath(nav, OPEN, start, { x: 4, y: 3 });
    expect(path).not.toBeNull();
    let prev: Cell = start;
    for (const step of path!) {
      expect(manhattan(prev, step)).toBe(1); // 4-neighbour move
      prev = step;
    }
    expect(prev).toEqual({ x: 4, y: 3 });
    expect(path!.length).toBe(manhattan(start, { x: 4, y: 3 })); // shortest on an open grid
  });
});

describe('findPath — deterministic tie-breaking', () => {
  it('picks the same route among equal-cost alternatives every time', () => {
    const nav = buildNavGrid(openGrid(3, 3));
    const a = findPath(nav, OPEN, { x: 0, y: 0 }, { x: 2, y: 2 });
    const b = findPath(nav, OPEN, { x: 0, y: 0 }, { x: 2, y: 2 });
    expect(a).toEqual(b);
  });

  it('resolves the (f, then x, then y) tie-break to one canonical path', () => {
    // On an open 3x3 grid there are many length-4 routes from (0,0) to (2,2). The tie-break
    // rule (smallest f, then smallest x, then smallest y) pins exactly one. This is the
    // golden route; if the algorithm's ordering ever changes, this fails loudly.
    const nav = buildNavGrid(openGrid(3, 3));
    expect(findPath(nav, OPEN, { x: 0, y: 0 }, { x: 2, y: 2 })).toEqual([
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ]);
  });
});

describe('findPath — path.blocked / unreachable', () => {
  it('returns null when the goal cell itself is a static wall', () => {
    const nav = buildNavGrid({ width: 3, height: 1, tileSize: 1, walls: ['.#.'] });
    expect(findPath(nav, OPEN, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeNull();
  });

  it('returns null when the goal is out of bounds', () => {
    const nav = buildNavGrid(openGrid(3, 3));
    expect(findPath(nav, OPEN, { x: 0, y: 0 }, { x: 9, y: 9 })).toBeNull();
  });

  it('returns null when the goal is walled off entirely', () => {
    // A full wall column at x=2 isolates the right edge; (2,0) is unreachable from (0,0).
    const walled = buildNavGrid({
      width: 3,
      height: 3,
      tileSize: 1,
      walls: ['..#', '..#', '..#'],
    });
    expect(findPath(walled, OPEN, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull();
  });
});

describe('findPath — dynamic repath against a mutated grid', () => {
  it('re-resolves around a newly blocked cell rather than reusing a cached route', () => {
    const nav = buildNavGrid(openGrid(3, 3));
    const start = { x: 0, y: 0 };
    const goal = { x: 0, y: 2 };

    // With nothing blocking, the straight column is shortest (length 2).
    const before = findPath(nav, OPEN, start, goal);
    expect(before).toEqual([
      { x: 0, y: 1 },
      { x: 0, y: 2 },
    ]);

    // Mutate: (0,1) becomes impassable (a door slams). The pathfinder must detour.
    const doorShut: Blocked = (x, y) => x === 0 && y === 1;
    const after = findPath(nav, doorShut, start, goal);
    expect(after).not.toBeNull();
    expect(after!.some((c) => c.x === 0 && c.y === 1)).toBe(false); // never crosses the shut door
    expect(after!.length).toBeGreaterThan(before!.length); // the detour is longer
  });

  it('reports blocked once a dynamic obstacle fully seals the goal', () => {
    // A 1-wide corridor to the goal; block its only cell → unreachable.
    const nav = buildNavGrid({ width: 3, height: 3, tileSize: 1, walls: ['#.#', '#.#', '#.#'] });
    const open = findPath(nav, OPEN, { x: 1, y: 0 }, { x: 1, y: 2 });
    expect(open).toEqual([
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ]);
    const sealed: Blocked = (x, y) => x === 1 && y === 1;
    expect(findPath(nav, sealed, { x: 1, y: 0 }, { x: 1, y: 2 })).toBeNull();
  });
});

describe('lineOfSight', () => {
  it('is clear across open ground', () => {
    const nav = buildNavGrid(openGrid(5, 1));
    expect(lineOfSight(nav, { x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
  });

  it('is blocked by a wall strictly between the endpoints', () => {
    const nav = buildNavGrid({ width: 5, height: 1, tileSize: 1, walls: ['..#..'] });
    expect(lineOfSight(nav, { x: 0, y: 0 }, { x: 4, y: 0 })).toBe(false);
  });

  it('ignores walls on the endpoints themselves', () => {
    const nav = buildNavGrid({ width: 3, height: 1, tileSize: 1, walls: ['#.#'] });
    // Endpoints (0,0) and (2,0) are walls, but the cell between is clear.
    expect(lineOfSight(nav, { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(true);
  });
});

describe('inWeaponRange', () => {
  it('requires both Chebyshev range and clear line of sight', () => {
    const nav = buildNavGrid(openGrid(6, 1));
    expect(inWeaponRange(nav, { x: 0, y: 0 }, { x: 3, y: 0 }, 3)).toBe(true);
    expect(inWeaponRange(nav, { x: 0, y: 0 }, { x: 4, y: 0 }, 3)).toBe(false); // out of range
  });

  it('denies a target behind a wall even when in range', () => {
    const nav = buildNavGrid({ width: 4, height: 1, tileSize: 1, walls: ['.#..'] });
    expect(inWeaponRange(nav, { x: 0, y: 0 }, { x: 2, y: 0 }, 3)).toBe(false); // wall at (1,0)
  });
});

describe('findAttackPath', () => {
  it('returns [] when the start already has range and line of sight', () => {
    const nav = buildNavGrid(openGrid(6, 1));
    expect(findAttackPath(nav, OPEN, { x: 2, y: 0 }, { x: 4, y: 0 }, 3)).toEqual([]);
  });

  it('closes to the nearest cell within range and LOS of the target', () => {
    const nav = buildNavGrid(openGrid(8, 1));
    const start = { x: 0, y: 0 };
    const target = { x: 6, y: 0 };
    const path = findAttackPath(nav, OPEN, start, target, 2);
    expect(path).not.toBeNull();
    const last = path![path!.length - 1]!;
    expect(chebyshev(last, target)).toBeLessThanOrEqual(2);
    expect(last).not.toEqual(target); // never stands on the target's own cell
    // Shortest close-in: from x=0 the nearest in-range cell is x=4 (distance 2 from x=6).
    expect(last).toEqual({ x: 4, y: 0 });
  });

  it('returns null when no in-range, visible cell is reachable', () => {
    // Target sealed in a 1-cell pocket: reachable cells can never see or reach it.
    const nav = buildNavGrid({
      width: 3,
      height: 3,
      tileSize: 1,
      walls: ['###', '#.#', '###'],
    });
    // The attacker starts outside; (1,1) is the target, fully walled.
    expect(findAttackPath(nav, OPEN, { x: 1, y: 1 }, { x: 1, y: 1 }, 3)).toBeNull();
  });
});
