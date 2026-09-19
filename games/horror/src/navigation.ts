import { length3, normalize3, sub3 } from '@aegis/core/math';
import type { Vec3 } from '@aegis/core';
import { cellAt, cellCenterWorld, raycastGrid, worldToCell } from '@aegis/mode-fps';
import type { CollisionGrid } from '@aegis/mode-fps';

export function clearSight(grid: CollisionGrid, from: Vec3, to: Vec3): boolean {
  const difference = sub3(to, from);
  const distance = length3(difference);
  return (
    distance < 0.001 || raycastGrid(grid, from, normalize3(difference), distance) === undefined
  );
}

/** Cardinal breadth-first search: identical tie-breaking for patrol, pursuit and sound paths. */
export function stationPath(
  grid: CollisionGrid,
  from: { x: number; z: number },
  to: { x: number; z: number },
  maxSteps = grid.width * grid.height,
): { x: number; z: number }[] | undefined {
  const start = worldToCell(grid, from.x, from.z);
  const end = worldToCell(grid, to.x, to.z);
  if (cellAt(grid, start.col, start.row).solid || cellAt(grid, end.col, end.row).solid) {
    return undefined;
  }
  const first = start.row * grid.width + start.col;
  const last = end.row * grid.width + end.col;
  const parents = new Map<number, number>([[first, first]]);
  const queue = [{ index: first, steps: 0 }];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const next = queue[cursor];
    if (next === undefined) break;
    if (next.index === last) {
      const path: { x: number; z: number }[] = [];
      let index = last;
      while (index !== first) {
        path.push(cellCenterWorld(grid, index % grid.width, Math.floor(index / grid.width)));
        const parent = parents.get(index);
        if (parent === undefined) throw new Error('NULL MERIDIAN: incomplete navigation path');
        index = parent;
      }
      return path.reverse();
    }
    if (next.steps >= maxSteps) continue;
    const col = next.index % grid.width;
    const row = Math.floor(next.index / grid.width);
    for (const [dc, dr] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const c = col + dc;
      const r = row + dr;
      const index = r * grid.width + c;
      if (cellAt(grid, c, r).solid || parents.has(index)) continue;
      parents.set(index, next.index);
      queue.push({ index, steps: next.steps + 1 });
    }
  }
  return undefined;
}
