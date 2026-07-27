import { describe, it, expect } from 'vitest';
import type { Cell, IsoGridConfig, NavGridData } from './components.js';
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

// m16. Only the goal used to be validated, so an actor that ended up inside geometry was handed a
// happy path — and `start === goal` on a wall returned `[]`, i.e. "already there, success". Both
// must be a reported fault instead.
describe('findPath — an invalid start is a fault, not a route', () => {
  it('returns null when the start cell is a static wall', () => {
    const nav = buildNavGrid({ width: 3, height: 1, tileSize: 1, walls: ['#..'] });
    expect(findPath(nav, OPEN, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull();
  });

  it('returns null when the start is out of bounds', () => {
    const nav = buildNavGrid(openGrid(3, 3));
    expect(findPath(nav, OPEN, { x: -1, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });

  it('returns null — never [] — when start === goal inside a wall', () => {
    const nav = buildNavGrid({ width: 3, height: 1, tileSize: 1, walls: ['#..'] });
    expect(findPath(nav, OPEN, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });

  it('still allows a start that is only *dynamically* blocked (an actor on an occupied cell)', () => {
    // Dynamic blockers are other entities, and an actor legitimately shares a cell with one for a
    // tick. Only static geometry means "you are inside a wall".
    const nav = buildNavGrid(openGrid(3, 1));
    const selfBlocked: Blocked = (x, y) => x === 0 && y === 0;
    expect(findPath(nav, selfBlocked, { x: 0, y: 0 }, { x: 2, y: 0 })).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
  });

  it('findAttackPath applies the same rule instead of reporting "already in position"', () => {
    const nav = buildNavGrid({ width: 4, height: 1, tileSize: 1, walls: ['#...'] });
    expect(findAttackPath(nav, OPEN, { x: 0, y: 0 }, { x: 2, y: 0 }, 3)).toBeNull();
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

  // M4. Sight is a symmetric relation. A raw Bresenham trace is not — it breaks ties toward the
  // cell it started from — which lets a guard shoot an operative that cannot shoot back, because
  // `inWeaponRange` is always asked attacker -> target. Assert the *property* over every ordered
  // pair of a cluttered grid, not a handful of cases: on the pre-canonicalisation code this fails
  // with 194 of 1764 pairs disagreeing.
  it('is symmetric for every ordered pair of cells on a cluttered grid', () => {
    const walls = ['.#...#.', '..#....', '#...#..', '...#...', '..#..#.', '.#....#'];
    const nav = buildNavGrid({ width: 7, height: 6, tileSize: 1, walls });
    const cells: Cell[] = [];
    for (let y = 0; y < 6; y++) for (let x = 0; x < 7; x++) cells.push({ x, y });

    const disagreements: string[] = [];
    for (const a of cells) {
      for (const b of cells) {
        if (lineOfSight(nav, a, b) !== lineOfSight(nav, b, a)) {
          disagreements.push(`(${a.x},${a.y})<->(${b.x},${b.y})`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('is symmetric on an open grid too (no wall can excuse a direction-dependent trace)', () => {
    const nav = buildNavGrid(openGrid(9, 9));
    for (let ax = 0; ax < 9; ax++) {
      for (let ay = 0; ay < 9; ay++) {
        for (let bx = 0; bx < 9; bx++) {
          for (let by = 0; by < 9; by++) {
            const a = { x: ax, y: ay };
            const b = { x: bx, y: by };
            expect(lineOfSight(nav, a, b)).toBe(lineOfSight(nav, b, a));
          }
        }
      }
    }
  });

  it('agrees in both directions on the exact pair the audit reported', () => {
    // (0,0) -> (2,1) was `false` while (2,1) -> (0,0) was `true` on the pre-fix trace.
    const walls = ['.#...#.', '..#....', '#...#..', '...#...', '..#..#.', '.#....#'];
    const nav = buildNavGrid({ width: 7, height: 6, tileSize: 1, walls });
    expect(lineOfSight(nav, { x: 0, y: 0 }, { x: 2, y: 1 })).toBe(
      lineOfSight(nav, { x: 2, y: 1 }, { x: 0, y: 0 }),
    );
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

  // M4, at the altitude the systems actually use it: if A can shoot B, B can shoot A.
  it('is mutual: nobody can shoot someone who cannot shoot back', () => {
    const walls = ['.#...#.', '..#....', '#...#..', '...#...', '..#..#.', '.#....#'];
    const nav = buildNavGrid({ width: 7, height: 6, tileSize: 1, walls });
    for (let ax = 0; ax < 7; ax++) {
      for (let ay = 0; ay < 6; ay++) {
        for (let bx = 0; bx < 7; bx++) {
          for (let by = 0; by < 6; by++) {
            const a = { x: ax, y: ay };
            const b = { x: bx, y: by };
            expect(inWeaponRange(nav, a, b, 4)).toBe(inWeaponRange(nav, b, a, 4));
          }
        }
      }
    }
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
// ---------------------------------------------------------------------------------------------
// A* optimality — pinned by an independently derived oracle, not by a recorded route.
//
// Until this block, optimality was pinned only on an *open* grid (`findPath — correctness`, where
// the shortest path is the Manhattan distance by construction) and by one golden tie-break route
// on an open 3x3. Nothing asserted that a route around real geometry is as short as it could be.
// So the standard way A* is accidentally turned into a greedy search — weighting the heuristic —
// changed nothing any test could see, and a pathfinder returning a route many times longer than
// optimal is a gameplay bug that never throws: every step it returns is still adjacent,
// in-bounds and passable.
//
// The pin is deliberately not a recorded route. A golden captured from `findPath` shares its
// ancestor with the thing it checks, so it survives that ancestor being wrong and the next
// maintainer can re-record it without noticing. The oracle below is a plain breadth-first flood
// written from scratch over the authored ASCII rows — a different algorithm, provably optimal on
// a uniform-cost 4-neighbour grid — and the oracle is itself checked against costs worked out by
// hand before it is trusted to judge anything.
// ---------------------------------------------------------------------------------------------

/** The four 4-neighbour offsets, spelled out here so the oracle shares no code with `grid.ts`. */
const STEPS: readonly (readonly [number, number])[] = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

/**
 * Optimal 4-neighbour cost from `start` to `goal` over ASCII wall rows, by breadth-first search:
 * `0` when they are the same passable cell, `null` when either endpoint is a wall or off-grid, or
 * when no route exists.
 *
 * Independent of the module under test on purpose — it reads the authored rows rather than a
 * baked `NavGridData`, and brings its own bounds test, frontier and visited set. That
 * independence is the whole point: an equality between this and `findPath` is an oracle, whereas
 * an equality between `findPath` and a route recorded from `findPath` is a tautology.
 */
function bfsCost(walls: readonly string[], start: Cell, goal: Cell): number | null {
  const height = walls.length;
  const width = walls[0]?.length ?? 0;
  const isWall = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= width || y >= height || walls[y]?.[x] === '#';
  if (isWall(start.x, start.y) || isWall(goal.x, goal.y)) return null;
  if (start.x === goal.x && start.y === goal.y) return 0;

  const seen = new Set<string>([`${start.x},${start.y}`]);
  let frontier: Cell[] = [start];
  let cost = 0;
  while (frontier.length > 0) {
    cost += 1;
    const next: Cell[] = [];
    for (const c of frontier) {
      for (const [dx, dy] of STEPS) {
        const nx = c.x + dx;
        const ny = c.y + dy;
        if (isWall(nx, ny)) continue;
        const k = `${nx},${ny}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (nx === goal.x && ny === goal.y) return cost;
        next.push({ x: nx, y: ny });
      }
    }
    frontier = next;
  }
  return null;
}

/** A hand-drawn map whose optimal cost was worked out on paper, not recorded from a run. */
interface HandCheckedMap {
  readonly name: string;
  readonly walls: readonly string[];
  readonly start: Cell;
  readonly goal: Cell;
  /** The optimal 4-neighbour cost, or `null` when the goal cannot be reached. */
  readonly cost: number | null;
}

/**
 * Five maps with hand-computed answers. These are the L3 pins of this file: an expected value
 * authored independently of *both* implementations, which nothing can re-record. They are also
 * the oracle's negative control — `bfsCost` must reproduce all five before it is fit to judge the
 * exhaustive sweep.
 */
const HAND_CHECKED: readonly HandCheckedMap[] = [
  {
    // Open ground: the cost is exactly the Manhattan distance, 4 across and 2 down.
    name: 'open 5x3, (0,0) -> (4,2)',
    walls: ['.....', '.....', '.....'],
    start: { x: 0, y: 0 },
    goal: { x: 4, y: 2 },
    cost: 6,
  },
  {
    // A two-cell wall at x=2 seals the top rows; the only way across is the bottom row, so the
    // straight-line 4 becomes 2 down + 4 across + 2 up = 8.
    name: 'detour under a two-cell wall',
    walls: ['..#..', '..#..', '.....'],
    start: { x: 0, y: 0 },
    goal: { x: 4, y: 0 },
    cost: 8,
  },
  {
    // Two staggered walls force a full zig-zag: right to x=5 (5), down to row 2 (2), back left to
    // x=1 (4), down to row 4 (2), left to x=0 (1) = 14, against a Manhattan distance of 4.
    name: 'staggered zig-zag',
    walls: ['.......', '#####..', '.......', '..#####', '.......'],
    start: { x: 0, y: 0 },
    goal: { x: 0, y: 4 },
    cost: 14,
  },
  {
    // A spiral. The only way in is the outer ring to (8,6): 8 across + 6 down = 14; the row-6
    // corridor west to (2,6) = 6; up column 2 to (2,2) = 4; east along row 2 to (6,2) = 4; down
    // column 6 to (6,4) = 2; west to (4,4) = 2. Total 32, against a Manhattan distance of 8.
    name: 'spiral, (0,0) -> the heart at (4,4)',
    walls: [
      '.........',
      '.#######.',
      '.#.....#.',
      '.#.###.#.',
      '.#.#...#.',
      '.#.#####.',
      '.#.......',
      '.#######.',
      '.........',
    ],
    start: { x: 0, y: 0 },
    goal: { x: 4, y: 4 },
    cost: 32,
  },
  {
    // The same spiral, but a route that should NOT wind: straight down the open east column to
    // (8,6), then straight west along the row-6 corridor. 6 + 6 = 12, exactly the Manhattan
    // distance. This is the case a greedy search gets wrong — it dives into the spiral's mouth
    // and comes back out, and the shipped algorithm must not.
    name: 'spiral, (8,0) -> (2,6) down the east side and along the corridor',
    walls: [
      '.........',
      '.#######.',
      '.#.....#.',
      '.#.###.#.',
      '.#.#...#.',
      '.#.#####.',
      '.#.......',
      '.#######.',
      '.........',
    ],
    start: { x: 8, y: 0 },
    goal: { x: 2, y: 6 },
    cost: 12,
  },
  {
    // Two parallel corridors with no join: genuinely unreachable, not merely expensive.
    name: 'two sealed corridors',
    walls: ['#####', '#.#.#', '#.#.#', '#.#.#', '#####'],
    start: { x: 1, y: 1 },
    goal: { x: 3, y: 1 },
    cost: null,
  },
];

/** Build a nav grid straight from ASCII rows (width taken from the first row). */
function navOf(walls: readonly string[]): NavGridData {
  return buildNavGrid({
    width: walls[0]?.length ?? 0,
    height: walls.length,
    tileSize: 1,
    walls,
  });
}

describe('findPath — optimality against an independent oracle', () => {
  it('the BFS oracle reproduces every hand-computed cost (the oracle\u2019s own control)', () => {
    const wrong = HAND_CHECKED.filter((m) => bfsCost(m.walls, m.start, m.goal) !== m.cost).map(
      (m) =>
        `${m.name}: oracle said ${String(bfsCost(m.walls, m.start, m.goal))}, hand says ${String(m.cost)}`,
    );
    expect(wrong).toEqual([]);
  });

  it('returns a path of exactly the hand-computed optimal length on each map', () => {
    const wrong: string[] = [];
    for (const m of HAND_CHECKED) {
      const path = findPath(navOf(m.walls), OPEN, m.start, m.goal);
      const got = path === null ? null : path.length;
      if (got !== m.cost)
        wrong.push(`${m.name}: findPath cost ${String(got)}, optimal ${String(m.cost)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('agrees with the oracle on every ordered pair of cells in the spiral', () => {
    const walls = HAND_CHECKED[3]!.walls;
    const nav = navOf(walls);
    const cells: Cell[] = [];
    for (let y = 0; y < walls.length; y++) {
      for (let x = 0; x < (walls[0]?.length ?? 0); x++) cells.push({ x, y });
    }

    const disagreements: string[] = [];
    let detours = 0;
    for (const s of cells) {
      for (const g of cells) {
        const want = bfsCost(walls, s, g);
        const path = findPath(nav, OPEN, s, g);
        const got = path === null ? null : path.length;
        if (got !== want) {
          disagreements.push(
            `(${s.x},${s.y})->(${g.x},${g.y}): got ${String(got)}, optimal ${String(want)}`,
          );
        }
        if (want !== null && want > manhattan(s, g)) detours += 1;
      }
    }
    expect(disagreements).toEqual([]);
    // The sweep only means something if the map actually forces routes longer than the
    // straight-line distance: on an open grid every monotone route is optimal, so the same loop
    // would pass over a badly broken search. This is a non-degeneracy floor, not a recorded
    // value — a single winding corridor puts most of the 6561 ordered pairs above their
    // Manhattan distance, and any figure in the hundreds means the map is still a maze.
    expect(detours).toBeGreaterThan(500);
  });
});

describe('findAttackPath — closes by the shortest route', () => {
  it('reaches a nearest qualifying cell, at the oracle\u2019s cost', () => {
    // The `detour under a two-cell wall` map: attacker at (0,0), target at (4,0), range 1.
    // Cells that qualify (Chebyshev 1 of the target, not the target's own cell, LOS clear) are
    // (3,0), (3,1) and (4,1), at oracle costs 7, 6 and 7. The closing path must therefore be 6.
    const walls = ['..#..', '..#..', '.....'];
    const nav = navOf(walls);
    const start = { x: 0, y: 0 };
    const target = { x: 4, y: 0 };
    const range = 1;

    const path = findAttackPath(nav, OPEN, start, target, range);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(6);

    // …and the same number derived independently: the cheapest reachable cell that qualifies.
    let best: number | null = null;
    for (let y = 0; y < walls.length; y++) {
      for (let x = 0; x < (walls[0]?.length ?? 0); x++) {
        const c = { x, y };
        if (c.x === target.x && c.y === target.y) continue;
        if (!inWeaponRange(nav, c, target, range)) continue;
        const d = bfsCost(walls, start, c);
        if (d !== null && (best === null || d < best)) best = d;
      }
    }
    expect(path!.length).toBe(best);
  });

  it('breaks a tie among equally close firing positions by (x, then y)', () => {
    // A pillar at (2,2) splits the approach from (2,0) to a target at (2,4) into two mirror
    // routes. The nearest cells that can hit the target are (1,3) and (3,3), both exactly four
    // steps out — so the documented rule (smallest distance, then smallest x, then smallest y) is
    // the only thing that decides between them. Relax the comparison to `<=` and the answer
    // becomes whichever cell the flood happened to reach last, which is not a rule at all: it is
    // an implementation detail that a change to the neighbour scan order would silently move.
    const walls = ['.....', '.....', '..#..', '.....', '.....'];
    const nav = navOf(walls);
    const start = { x: 2, y: 0 };
    const target = { x: 2, y: 4 };

    // The tie is real, and established independently of the function under test.
    expect(bfsCost(walls, start, { x: 1, y: 3 })).toBe(4);
    expect(bfsCost(walls, start, { x: 3, y: 3 })).toBe(4);
    expect(inWeaponRange(nav, { x: 1, y: 3 }, target, 1)).toBe(true);
    expect(inWeaponRange(nav, { x: 3, y: 3 }, target, 1)).toBe(true);

    const path = findAttackPath(nav, OPEN, start, target, 1);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(4);
    expect(path![path!.length - 1]).toEqual({ x: 1, y: 3 });
  });
});
