/**
 * FPS world geometry: the ASCII-floorplan-to-collision pipeline plus the pure spatial queries
 * the mode's physics and hitscan resolve against.
 *
 * Per the PM's ruling (CHARTER principle 1), an FPS level is authored as an **ASCII tilemap
 * floorplan extruded into walls**, with per-tile floor/ceiling heights for verticality — never
 * as hand-placed 3D brushes. This module owns that representation ({@link FloorplanSpec}), the
 * extruded {@link CollisionGrid} it becomes, and the ray/circle tests both collision and hitscan
 * use. Everything here is a pure function of its inputs and uses only `@aegis/core/math`, so it
 * is deterministic and directly unit-testable without a world.
 *
 * ## Coordinate convention
 * Right-handed: `+X` east, `+Y` up, `+Z` north. The floorplan's row 0 is the northmost row
 * (largest z); the last row is the southmost (smallest z). `origin` is the world `(x, z)` of the
 * cell at `col = 0, row = height - 1` (the south-west corner cell centre). A cell spans
 * `tileSize` in x and z and is addressed by its centre.
 * @packageDocumentation
 */
import { defineResource } from '@aegis/core';
import type { ResourceType, Vec3 } from '@aegis/core';
import { DEG2RAD, abs, cos, max, min, round, sin } from '@aegis/core/math';

/** A legend entry describing one floorplan tile kind. */
export interface FloorplanTileKind {
  /** Whether the tile is a full-height blocking column (a wall). */
  solid: boolean;
  /** Floor height in world y. Negative values dig a pit below the datum. */
  floor: number;
  /** Ceiling height in world y. */
  ceil: number;
  /** Whether this tile is a controllable door (game layer may toggle {@link FloorplanCell.solid}). */
  door?: boolean;
  /** Whether this tile is a hazard (informational; hazard *detection* is a `Trigger`). */
  hazard?: boolean;
}

/**
 * A level floorplan: rows of single-character tile keys plus a legend mapping each key to a
 * {@link FloorplanTileKind}. This is the authoritative, text-authorable level format.
 */
export interface FloorplanSpec {
  /** Number of columns (x). */
  width: number;
  /** Number of rows (z). */
  height: number;
  /** World size of one tile in x and z. */
  tileSize: number;
  /** World `(x, z)` of the cell at `col = 0, row = height - 1`. */
  origin: { x: number; z: number };
  /** Tile rows, row 0 = north (max z). Each string is `width` characters. */
  rows: readonly string[];
  /** Map of tile key → kind. Every character appearing in {@link rows} must have an entry. */
  legend: Readonly<Record<string, FloorplanTileKind>>;
}

/** One extruded cell of a {@link CollisionGrid}. Mutable: a door cell's `solid` may flip. */
export interface FloorplanCell {
  /** Whether the cell currently blocks movement and rays. */
  solid: boolean;
  /** Floor height, world y. */
  floor: number;
  /** Ceiling height, world y. */
  ceil: number;
  /** Whether the cell is a door. */
  door: boolean;
  /** Whether the cell is a hazard. */
  hazard: boolean;
  /** The legend key this cell was extruded from. */
  key: string;
}

/**
 * The extruded, queryable form of a {@link FloorplanSpec}: a flat grid of {@link FloorplanCell}.
 * Stored as a world resource so it is part of the serialised, hashed world state — a door that
 * opens is deterministic simulation state, not hidden mode memory.
 */
export interface CollisionGrid {
  width: number;
  height: number;
  tileSize: number;
  origin: { x: number; z: number };
  /** Row-major, `index = row * width + col`. */
  cells: FloorplanCell[];
}

/** The floorplan a scene supplies for the mode to extrude in {@link initFloorplanResource}. */
export const FPS_FLOORPLAN: ResourceType<FloorplanSpec> = defineResource<FloorplanSpec>(
  'fps.floorplan',
  () => ({ width: 0, height: 0, tileSize: 1, origin: { x: 0, z: 0 }, rows: [], legend: {} }),
);

/** The extruded collision grid, produced from {@link FPS_FLOORPLAN} at init. */
export const FPS_COLLISION: ResourceType<CollisionGrid> = defineResource<CollisionGrid>(
  'fps.collision',
  () => ({ width: 0, height: 0, tileSize: 1, origin: { x: 0, z: 0 }, cells: [] }),
);

/** A cell treated as out-of-bounds: a full-height, floor-level solid wall. */
const OOB_CELL: Readonly<FloorplanCell> = Object.freeze({
  solid: true,
  floor: 0,
  ceil: 3,
  door: false,
  hazard: false,
  key: '#',
});

/**
 * Extrude a {@link FloorplanSpec} into a {@link CollisionGrid}. Every character in every row must
 * appear in the legend, or this throws — a level with an undeclared tile is a level authoring
 * bug, not something to paper over with a default.
 */
export function extrudeFloorplan(spec: FloorplanSpec): CollisionGrid {
  const { width, height, tileSize, legend } = spec;
  const cells: FloorplanCell[] = [];
  for (let row = 0; row < height; row++) {
    const line = spec.rows[row] ?? '';
    for (let col = 0; col < width; col++) {
      const key = line[col] ?? ' ';
      const kind = legend[key];
      if (kind === undefined) {
        throw new Error(
          `extrudeFloorplan: tile key ${JSON.stringify(key)} at row ${row}, col ${col} is not in the legend`,
        );
      }
      cells.push({
        solid: kind.solid,
        floor: kind.floor,
        ceil: kind.ceil,
        door: kind.door ?? false,
        hazard: kind.hazard ?? false,
        key,
      });
    }
  }
  return { width, height, tileSize, origin: { x: spec.origin.x, z: spec.origin.z }, cells };
}

/** World `(x, z)` of the centre of cell `(col, row)`. */
export function cellCenterWorld(
  grid: Pick<CollisionGrid, 'origin' | 'tileSize' | 'height'>,
  col: number,
  row: number,
): { x: number; z: number } {
  return {
    x: grid.origin.x + col * grid.tileSize,
    z: grid.origin.z + (grid.height - 1 - row) * grid.tileSize,
  };
}

/** The `(col, row)` whose cell contains world point `(x, z)`. May be out of `[0,width)×[0,height)`. */
export function worldToCell(
  grid: Pick<CollisionGrid, 'origin' | 'tileSize' | 'height'>,
  x: number,
  z: number,
): { col: number; row: number } {
  const col = round((x - grid.origin.x) / grid.tileSize);
  const zi = round((z - grid.origin.z) / grid.tileSize);
  return { col, row: grid.height - 1 - zi };
}

/** The cell at integer `(col, row)`, or {@link OOB_CELL} if outside the grid. */
export function cellAt(grid: CollisionGrid, col: number, row: number): FloorplanCell {
  if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) return OOB_CELL;
  return grid.cells[row * grid.width + col] ?? OOB_CELL;
}

/** The cell containing world `(x, z)`, or {@link OOB_CELL} if outside the grid. */
export function cellAtWorld(grid: CollisionGrid, x: number, z: number): FloorplanCell {
  const { col, row } = worldToCell(grid, x, z);
  return cellAt(grid, col, row);
}

/** Floor height at world `(x, z)` — the height a capsule there rests on. */
export function floorHeightAt(grid: CollisionGrid, x: number, z: number): number {
  return cellAtWorld(grid, x, z).floor;
}

/** Ceiling height at world `(x, z)`. */
export function ceilHeightAt(grid: CollisionGrid, x: number, z: number): number {
  return cellAtWorld(grid, x, z).ceil;
}

/**
 * Whether a circle of `radius` centred at world `(x, z)` overlaps any solid cell. This is the
 * horizontal capsule-vs-wall test: the capsule is a vertical cylinder, so at a given height its
 * footprint is a circle.
 */
export function circleHitsSolid(
  grid: CollisionGrid,
  x: number,
  z: number,
  radius: number,
): boolean {
  const half = grid.tileSize * 0.5;
  const minCol = round((x - radius - grid.origin.x) / grid.tileSize);
  const maxCol = round((x + radius - grid.origin.x) / grid.tileSize);
  const minZi = round((z - radius - grid.origin.z) / grid.tileSize);
  const maxZi = round((z + radius - grid.origin.z) / grid.tileSize);
  for (let zi = minZi; zi <= maxZi; zi++) {
    for (let col = minCol; col <= maxCol; col++) {
      const row = grid.height - 1 - zi;
      const cell = cellAt(grid, col, row);
      if (!cell.solid) continue;
      const cx = grid.origin.x + col * grid.tileSize;
      const cz = grid.origin.z + zi * grid.tileSize;
      // Closest point on the cell's AABB to the circle centre.
      const nearestX = max(cx - half, min(x, cx + half));
      const nearestZ = max(cz - half, min(z, cz + half));
      const dx = x - nearestX;
      const dz = z - nearestZ;
      if (dx * dx + dz * dz <= radius * radius) return true;
    }
  }
  return false;
}

/**
 * The unit forward vector for a look orientation. Yaw 0 faces `+Z`; increasing yaw turns toward
 * `+X`; positive pitch tilts up (`+Y`).
 */
export function forwardFromLook(yawDeg: number, pitchDeg: number): Vec3 {
  const y = yawDeg * DEG2RAD;
  const p = pitchDeg * DEG2RAD;
  const cp = cos(p);
  return { x: sin(y) * cp, y: sin(p), z: cos(y) * cp };
}

/** The horizontal (y = 0) forward vector for a yaw. */
export function forwardHorizFromYaw(yawDeg: number): Vec3 {
  const y = yawDeg * DEG2RAD;
  return { x: sin(y), y: 0, z: cos(y) };
}

/** The horizontal right vector for a yaw (90° clockwise from forward, toward `+X` at yaw 0). */
export function rightFromYaw(yawDeg: number): Vec3 {
  const y = yawDeg * DEG2RAD;
  return { x: cos(y), y: 0, z: -sin(y) };
}

/** Whether every component of `v` is a finite number. */
function isFinite3(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** A hit returned by {@link raycastGrid}. */
export interface GridRayHit {
  /** Distance from the ray origin to the wall entry point. */
  distance: number;
  /** Column of the struck cell. */
  col: number;
  /** Row of the struck cell. */
  row: number;
}

/**
 * The cell index containing `u` (measured in tiles, cell `k` spanning `[k - 0.5, k + 0.5]`) for a
 * ray whose step along that axis is `step`.
 *
 * A coordinate exactly on a cell boundary belongs to **two** cells, and `round` resolves that tie
 * to the `+side` unconditionally. For a ray travelling in `-side` that is the cell *behind* it: the
 * march then opens on a cell the ray is leaving, not entering, and reports a hit at distance 0 on
 * the wall at its back. The tie is therefore broken by the direction of travel — the ray is
 * entering the cell ahead of it. With no travel along the axis (`step === 0`) the ray runs along
 * the boundary plane and neither side is "ahead"; that keeps the `+side` tie-break
 * {@link worldToCell} uses, so the two functions never disagree about which cell a point is in.
 */
function originCell(u: number, step: number): number {
  const k = round(u);
  return step < 0 && k - u === 0.5 ? k - 1 : k;
}

/**
 * March a ray through the grid and return the first solid cell it enters within `maxDist`, or
 * `undefined` if it reaches `maxDist` (or leaves the grid) without hitting a wall.
 *
 * A 2D DDA over the x/z plane: walls are full columns, so only the horizontal crossing matters,
 * except that the ray's height at the crossing must lie within the cell's `[floor, ceil]` for the
 * column to actually block it (a ray angled over a short wall passes through). `dir` need not be
 * normalised for the traversal, but `distance` is only a true world distance when it is. It must
 * be finite: a `NaN` component would make both `> 0` and `< 0` false, silently reducing the ray to
 * the remaining axes and returning a confident wrong answer, so it throws instead.
 */
export function raycastGrid(
  grid: CollisionGrid,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
): GridRayHit | undefined {
  if (!isFinite3(dir)) {
    throw new Error(
      `raycastGrid: direction must be finite, got (${dir.x}, ${dir.y}, ${dir.z}). A NaN or ` +
        'infinite component cannot be stepped and would silently degrade the ray to the ' +
        'remaining axes.',
    );
  }
  const ts = grid.tileSize;
  const half = ts * 0.5;
  // Integer cell coords in a south-west-origin frame: col east, zi north.
  const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
  const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;
  let col = originCell((origin.x - grid.origin.x) / ts, stepX);
  let zi = originCell((origin.z - grid.origin.z) / ts, stepZ);
  // Distance along the ray to the first x / z cell boundary.
  const cellCenterX = grid.origin.x + col * ts;
  const cellCenterZ = grid.origin.z + zi * ts;
  let tMaxX =
    stepX !== 0 ? (cellCenterX + stepX * half - origin.x) / dir.x : Number.POSITIVE_INFINITY;
  let tMaxZ =
    stepZ !== 0 ? (cellCenterZ + stepZ * half - origin.z) / dir.z : Number.POSITIVE_INFINITY;
  const tDeltaX = stepX !== 0 ? abs(ts / dir.x) : Number.POSITIVE_INFINITY;
  const tDeltaZ = stepZ !== 0 ? abs(ts / dir.z) : Number.POSITIVE_INFINITY;

  let t = 0;
  const maxSteps = 2 * (grid.width + grid.height) + 2;
  for (let step = 0; step <= maxSteps; step++) {
    const row = grid.height - 1 - zi;
    const cell = cellAt(grid, col, row);
    if (cell.solid) {
      const y = origin.y + dir.y * t;
      if (y >= cell.floor - 1e-9 && y <= cell.ceil + 1e-9) {
        return { distance: t, col, row };
      }
    }
    if (tMaxX < tMaxZ) {
      t = tMaxX;
      if (t > maxDist) return undefined;
      col += stepX;
      tMaxX += tDeltaX;
    } else {
      t = tMaxZ;
      if (t > maxDist) return undefined;
      zi += stepZ;
      tMaxZ += tDeltaZ;
    }
    if (col < -1 || col > grid.width || zi < -1 || zi > grid.height) return undefined;
  }
  return undefined;
}

/**
 * Ray-vs-axis-aligned-box (slab method). Returns the distance from `origin` to the box entry
 * point, **`0` when the origin is already inside the box**, or `undefined` if the ray misses or
 * the box is entirely behind the origin. `dir` should be normalised for `distance` to be a world
 * distance; a zero `dir` therefore resolves to `0` inside the box and `undefined` outside it.
 *
 * The inside case must be `0`, not the far-slab distance: nearest-hit selection compares these
 * against each other (`resolveShot` picks the smallest), so returning the *exit* distance for a
 * shooter standing inside a hit volume ranks the volume it is inside behind things that are
 * genuinely further away.
 */
export function rayBox(origin: Vec3, dir: Vec3, center: Vec3, half: Vec3): number | undefined {
  let tmin = Number.NEGATIVE_INFINITY;
  let tmax = Number.POSITIVE_INFINITY;
  const oc: readonly [number, number, number] = [origin.x, origin.y, origin.z];
  const dc: readonly [number, number, number] = [dir.x, dir.y, dir.z];
  const cc: readonly [number, number, number] = [center.x, center.y, center.z];
  const hc: readonly [number, number, number] = [half.x, half.y, half.z];
  for (let a = 0; a < 3; a++) {
    const o = oc[a] as number;
    const d = dc[a] as number;
    const lo = (cc[a] as number) - (hc[a] as number);
    const hi = (cc[a] as number) + (hc[a] as number);
    if (abs(d) < 1e-12) {
      if (o < lo || o > hi) return undefined;
      continue;
    }
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return undefined;
  }
  if (tmax < 0) return undefined;
  return tmin >= 0 ? tmin : 0;
}
