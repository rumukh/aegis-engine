/**
 * Grid navigation: deterministic A\* pathfinding, line-of-sight and range helpers over the
 * baked {@link NavGridData}. Everything here is a pure function of its inputs — no world, no
 * randomness, no wall-clock — so it is trivially unit-testable and deterministic by construction
 * (CHARTER principle 3). Movement is 4-neighbour (no diagonals); ties are broken by (x then y).
 * @packageDocumentation
 */
import { abs, max } from '@aegis/core';
import type { Cell, IsoGridConfig, NavGridData } from './components.js';

/** A predicate over grid coordinates: `true` when the cell may not be entered. */
export type Blocked = (x: number, y: number) => boolean;

/** Row-major index of a cell. */
export function cellKey(width: number, x: number, y: number): number {
  return y * width + x;
}

/** Whether `(x,y)` lies within the grid bounds. */
export function inBounds(nav: NavGridData, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < nav.width && y < nav.height;
}

/** Whether `(x,y)` is a static wall (out-of-bounds counts as wall). */
export function isWallCell(nav: NavGridData, x: number, y: number): boolean {
  if (!inBounds(nav, x, y)) return true;
  return nav.blocked[cellKey(nav.width, x, y)] === true;
}

/** Chebyshev (king-move) distance — the metric used for weapon range. */
export function chebyshev(a: Cell, b: Cell): number {
  return max(abs(a.x - b.x), abs(a.y - b.y));
}

/** Manhattan distance — the A\* heuristic for a 4-neighbour grid. */
export function manhattan(a: Cell, b: Cell): number {
  return abs(a.x - b.x) + abs(a.y - b.y);
}

/** Bake an authored {@link IsoGridConfig} into a {@link NavGridData} passability bitmap. */
export function buildNavGrid(config: IsoGridConfig): NavGridData {
  const { width, height } = config;
  const blocked: boolean[] = new Array<boolean>(width * height).fill(false);
  for (let y = 0; y < height; y++) {
    const row = config.walls[y] ?? '';
    for (let x = 0; x < width; x++) {
      blocked[cellKey(width, x, y)] = row[x] === '#';
    }
  }
  return { width, height, tileSize: config.tileSize, blocked };
}

// 4-neighbour offsets. Order does not affect results (the open set is sorted), but is fixed.
const NEIGHBOURS: readonly Cell[] = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
];

/**
 * Deterministic A\* shortest path from `start` to `goal` over 4-neighbour cells, avoiding any
 * cell for which `blocked` returns `true`.
 *
 * Returns the path as cells **after** `start` up to and including `goal`, `[]` when
 * `start === goal`, or `null` when `start` is off-grid or inside static geometry, or when `goal`
 * is out of bounds, blocked, or unreachable.
 *
 * The `start` check comes first, and deliberately tests **static walls only**: an actor standing
 * inside geometry is a fault the caller must hear about (previously it got a happy path, or `[]`
 * — "already there, success" — when `start === goal`), whereas standing on a cell some other
 * {@link Blocked} entity also occupies is an ordinary transient state, not a fault.
 *
 * Tie-breaking is fully specified: the open node with the smallest `f = g + manhattan` is
 * expanded first; ties on `f` are broken by smaller `x`, then smaller `y`. Two runs therefore
 * always pick the same route among equal-cost alternatives.
 */
export function findPath(
  nav: NavGridData,
  blocked: Blocked,
  start: Cell,
  goal: Cell,
): Cell[] | null {
  if (isWallCell(nav, start.x, start.y)) return null;
  if (start.x === goal.x && start.y === goal.y) return [];
  if (isWallCell(nav, goal.x, goal.y) || blocked(goal.x, goal.y)) return null;

  const w = nav.width;
  const startKey = cellKey(w, start.x, start.y);
  const gScore = new Map<number, number>([[startKey, 0]]);
  const cameFrom = new Map<number, Cell>();
  const closed = new Set<number>();

  interface Node {
    x: number;
    y: number;
    g: number;
    f: number;
  }
  const open: Node[] = [{ x: start.x, y: start.y, g: 0, f: manhattan(start, goal) }];

  const better = (a: Node, b: Node): boolean =>
    a.f !== b.f ? a.f < b.f : a.x !== b.x ? a.x < b.x : a.y < b.y;

  while (open.length > 0) {
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) if (better(open[i]!, open[bestIdx]!)) bestIdx = i;
    const current = open.splice(bestIdx, 1)[0]!;
    const curKey = cellKey(w, current.x, current.y);
    if (current.x === goal.x && current.y === goal.y) {
      return reconstruct(w, cameFrom, current, start);
    }
    if (closed.has(curKey)) continue;
    closed.add(curKey);

    for (const off of NEIGHBOURS) {
      const nx = current.x + off.x;
      const ny = current.y + off.y;
      if (isWallCell(nav, nx, ny) || blocked(nx, ny)) continue;
      const nKey = cellKey(w, nx, ny);
      if (closed.has(nKey)) continue;
      const tentative = current.g + 1;
      const known = gScore.get(nKey);
      if (known === undefined || tentative < known) {
        gScore.set(nKey, tentative);
        cameFrom.set(nKey, { x: current.x, y: current.y });
        open.push({ x: nx, y: ny, g: tentative, f: tentative + manhattan({ x: nx, y: ny }, goal) });
      }
    }
  }
  return null;
}

/** Walk `cameFrom` (keyed by row-major index) back from `goal` to `start`. */
function reconstruct(width: number, cameFrom: Map<number, Cell>, goal: Cell, start: Cell): Cell[] {
  const path: Cell[] = [];
  let cur: Cell | undefined = { x: goal.x, y: goal.y };
  while (cur && !(cur.x === start.x && cur.y === start.y)) {
    path.push({ x: cur.x, y: cur.y });
    cur = cameFrom.get(cellKey(width, cur.x, cur.y));
  }
  path.reverse();
  return path;
}

/**
 * Line of sight between two cells: `true` when no static wall lies strictly between them.
 * Uses an integer Bresenham traversal; endpoints are excluded. Dynamic {@link Blocked} entities
 * are intentionally *not* treated as sight-blockers — only static geometry occludes.
 *
 * **Sight is symmetric, and this function guarantees it.** A raw Bresenham trace is not: on a
 * shallow diagonal it breaks ties toward whichever endpoint it started from, so a→b and b→a can
 * visit different cells and disagree — which in a tactical game means one actor can shoot another
 * that cannot shoot back (`inWeaponRange` is always asked attacker→target). The endpoints are
 * therefore **canonicalised** first: the trace always runs from the `(x, then y)` smaller cell,
 * whichever order the caller asked in. Endpoint exclusion is symmetric too, so both directions
 * return the identical answer by construction rather than by luck.
 */
export function lineOfSight(nav: NavGridData, a: Cell, b: Cell): boolean {
  const inOrder = a.x !== b.x ? a.x < b.x : a.y <= b.y;
  const from = inOrder ? a : b;
  const to = inOrder ? b : a;
  let x0 = from.x;
  let y0 = from.y;
  const x1 = to.x;
  const y1 = to.y;
  const dx = abs(x1 - x0);
  const dy = -abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    const atEndpoint = (x0 === from.x && y0 === from.y) || (x0 === x1 && y0 === y1);
    if (!atEndpoint && isWallCell(nav, x0, y0)) return false;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return true;
}

/** Whether `attacker` at `from` can hit `target` at `to`: within `range` (Chebyshev) and LOS. */
export function inWeaponRange(nav: NavGridData, from: Cell, to: Cell, range: number): boolean {
  return chebyshev(from, to) <= range && lineOfSight(nav, from, to);
}

/**
 * Shortest path to the *best* cell from which `attacker` can hit `target`: a reachable, passable
 * cell (not `target`'s own cell) within `range` and with line of sight. Returns `[]` when `start`
 * already qualifies, `null` when no such cell is reachable, and `null` when `start` is itself
 * off-grid or inside static geometry (same fault rule as {@link findPath} — an actor inside a wall
 * must not be told "already in position"). Deterministic: among equal-length options the cell with
 * the smallest `(distance, x, y)` wins.
 */
export function findAttackPath(
  nav: NavGridData,
  blocked: Blocked,
  start: Cell,
  target: Cell,
  range: number,
): Cell[] | null {
  if (isWallCell(nav, start.x, start.y)) return null;
  const qualifies = (c: Cell): boolean =>
    !(c.x === target.x && c.y === target.y) && inWeaponRange(nav, c, target, range);
  if (qualifies(start)) return [];

  // Breadth-first flood from start over passable cells; record distance and predecessor.
  const w = nav.width;
  const dist = new Map<number, number>([[cellKey(w, start.x, start.y), 0]]);
  const prev = new Map<number, Cell>();
  const queue: Cell[] = [{ x: start.x, y: start.y }];
  const best: { cell: Cell; dist: number } | null = { cell: { x: -1, y: -1 }, dist: Infinity };
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    const curKey = cellKey(w, cur.x, cur.y);
    const d = dist.get(curKey)!;
    if (qualifies(cur)) {
      if (
        d < best.dist ||
        (d === best.dist && (cur.x < best.cell.x || (cur.x === best.cell.x && cur.y < best.cell.y)))
      ) {
        best.cell = { x: cur.x, y: cur.y };
        best.dist = d;
      }
    }
    for (const off of NEIGHBOURS) {
      const nx = cur.x + off.x;
      const ny = cur.y + off.y;
      if (isWallCell(nav, nx, ny) || blocked(nx, ny)) continue;
      const nKey = cellKey(w, nx, ny);
      if (dist.has(nKey)) continue;
      dist.set(nKey, d + 1);
      prev.set(nKey, { x: cur.x, y: cur.y });
      queue.push({ x: nx, y: ny });
    }
  }
  if (best.dist === Infinity) return null;

  // Reconstruct from best back to start using prev.
  const path: Cell[] = [];
  let cur: Cell | undefined = best.cell;
  while (cur && !(cur.x === start.x && cur.y === start.y)) {
    path.push({ x: cur.x, y: cur.y });
    cur = prev.get(cellKey(w, cur.x, cur.y));
  }
  path.reverse();
  return path;
}
