/**
 * The mode's collision layer: turning an authored tilemap into a solid/hazard grid and the pure,
 * deterministic AABB-vs-tilemap resolution the physics systems use. Kept free of world/system
 * concerns so it is unit-testable on its own (see `collision.test.ts`).
 *
 * ## Coordinate convention (mode-wide)
 * `tileSize` is 1. World Y increases **upward**. A tile at grid `(col, row)` — row 0 at the top —
 * occupies the world-space box `x ∈ [col, col + 1]`, `y ∈ [H - 1 - row, H - row]` where `H` is the
 * grid height. So the bottom row `H - 1` sits on `y ∈ [0, 1]` and the top row `0` on `y ∈ [H-1, H]`.
 * @packageDocumentation
 */
import { abs, floor, max, min } from '@aegis/core';
import { defineResource } from '@aegis/core';
import type { ResourceType } from '@aegis/core';

/** One tile kind as the mode reads it (a structural subset of `@aegis/content`'s `TileDef`). */
export interface ModeTileDef {
  /** Whether the tile blocks movement. */
  solid?: boolean;
  /** Free-form data; the mode only reads `hazard`. */
  data?: Readonly<Record<string, unknown>>;
  /** Renderer sprite id (unused by collision). */
  sprite?: string;
}

/** One layer of a tilemap: fixed-width ASCII rows of legend keys. */
export interface ModeTilemapLayer {
  name: string;
  data: readonly string[];
}

/** The tilemap shape the mode consumes from the scene resource `platformer.tilemap`. */
export interface ModeTilemap {
  width: number;
  height: number;
  tileSize: number;
  legend: Readonly<Record<string, ModeTileDef>>;
  layers: readonly ModeTilemapLayer[];
}

/** A baked lookup of which cells are solid / hazardous, indexed `row * width + col`. */
export interface CollisionGrid {
  /** Grid width in tiles. */
  width: number;
  /** Grid height in tiles. */
  height: number;
  /** World size of one tile edge. */
  tileSize: number;
  /** `true` where the cell blocks movement. */
  solid: readonly boolean[];
  /** `true` where the cell is a hazard (spikes / lava). */
  hazard: readonly boolean[];
}

/** Scene-provided tilemap (set as a resource by the scene file). `undefined` until authored. */
export const PlatformerTilemap: ResourceType<ModeTilemap | undefined> = defineResource<
  ModeTilemap | undefined
>('platformer.tilemap', () => undefined);

/** The baked collision grid, built once in the mode's `init` from {@link PlatformerTilemap}. */
export const PlatformerCollision: ResourceType<CollisionGrid | undefined> = defineResource<
  CollisionGrid | undefined
>('platformer.collision', () => undefined);

/** An empty grid — a safe fallback when no tilemap was authored. */
export function emptyGrid(width = 0, height = 0, tileSize = 1): CollisionGrid {
  const n = width * height;
  return {
    width,
    height,
    tileSize,
    solid: new Array<boolean>(n).fill(false),
    hazard: new Array<boolean>(n).fill(false),
  };
}

/** Choose the collision layer (named `"collision"`), else the first layer. */
function collisionLayer(tilemap: ModeTilemap): ModeTilemapLayer | undefined {
  return tilemap.layers.find((l) => l.name === 'collision') ?? tilemap.layers[0];
}

/** Bake a tilemap into a {@link CollisionGrid} of solid/hazard flags. Pure and deterministic. */
export function buildCollisionGrid(tilemap: ModeTilemap): CollisionGrid {
  const { width, height } = tilemap;
  const solid = new Array<boolean>(width * height).fill(false);
  const hazard = new Array<boolean>(width * height).fill(false);
  const layer = collisionLayer(tilemap);
  if (layer) {
    for (let row = 0; row < height; row++) {
      const line = layer.data[row] ?? '';
      for (let col = 0; col < width; col++) {
        const ch = line[col];
        if (ch === undefined || ch === '.' || ch === ' ') continue;
        const def = tilemap.legend[ch];
        if (def === undefined) continue;
        const idx = row * width + col;
        if (def.solid === true) solid[idx] = true;
        if (def.data !== undefined && def.data['hazard'] === true) hazard[idx] = true;
      }
    }
  }
  return { width, height, tileSize: tilemap.tileSize, solid, hazard };
}

// --- world <-> cell mapping ----------------------------------------------------------------

/** Column index containing world x. */
export function colOf(x: number): number {
  return floor(x);
}

/** Row index (0 = top) containing world y, for a grid of `height` rows. */
export function rowOf(y: number, height: number): number {
  return height - 1 - floor(y);
}

/** Top edge (max y) of the cell in row `row`. */
export function cellTop(row: number, height: number): number {
  return height - row;
}

/** Bottom edge (min y) of the cell in row `row`. */
export function cellBottom(row: number, height: number): number {
  return height - 1 - row;
}

/** Whether `(col, row)` is in-bounds and solid. */
export function isSolidCell(grid: CollisionGrid, col: number, row: number): boolean {
  if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) return false;
  return grid.solid[row * grid.width + col] === true;
}

/** Whether the world point `(x, y)` falls inside a hazard cell. */
export function isHazardAt(grid: CollisionGrid, x: number, y: number): boolean {
  const col = colOf(x);
  const row = rowOf(y, grid.height);
  if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) return false;
  return grid.hazard[row * grid.width + col] === true;
}

// --- AABB resolution -----------------------------------------------------------------------

/** An axis-aligned solid box in world space. */
export interface SolidBox {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/** Small tolerance keeping "resting on a surface" from registering as an overlap. */
const EPS = 1e-6;

/** Solid tile boxes whose cells lie within `pad` of the box `[cx±hw, cy±hh]`. */
export function tileBoxesNear(
  grid: CollisionGrid,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  pad: number,
): SolidBox[] {
  const out: SolidBox[] = [];
  const cLo = colOf(cx - hw - pad);
  const cHi = colOf(cx + hw + pad);
  const rLo = rowOf(cy + hh + pad, grid.height);
  const rHi = rowOf(cy - hh - pad, grid.height);
  for (let row = min(rLo, rHi); row <= max(rLo, rHi); row++) {
    for (let col = cLo; col <= cHi; col++) {
      if (!isSolidCell(grid, col, row)) continue;
      out.push({
        left: col,
        right: col + 1,
        bottom: cellBottom(row, grid.height),
        top: cellTop(row, grid.height),
      });
    }
  }
  return out;
}

/** Vertical overlap of a box centred at `(_, cy)` with half-height `hh` against a solid box. */
function overlapsY(cy: number, hh: number, sb: SolidBox): boolean {
  return sb.top > cy - hh + EPS && sb.bottom < cy + hh - EPS;
}

/** Horizontal overlap of a box centred at `(cx, _)` with half-width `hw` against a solid box. */
function overlapsX(cx: number, hw: number, sb: SolidBox): boolean {
  return sb.right > cx - hw + EPS && sb.left < cx + hw - EPS;
}

/** Result of a one-axis move-and-resolve. */
export interface ResolveX {
  cx: number;
  hit: boolean;
}

/** Move the box centre `cx` by `dx` and resolve against `boxes`, stopping at the first blocker. */
export function resolveX(
  boxes: readonly SolidBox[],
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  dx: number,
): ResolveX {
  let nx = cx + dx;
  let hit = false;
  if (dx > 0) {
    let limit = Infinity;
    for (const sb of boxes) {
      if (!overlapsY(cy, hh, sb)) continue;
      if (sb.left >= nx + hw || sb.right <= cx - hw) continue;
      limit = min(limit, sb.left - hw);
    }
    if (limit < nx) {
      nx = limit;
      hit = true;
    }
  } else if (dx < 0) {
    let limit = -Infinity;
    for (const sb of boxes) {
      if (!overlapsY(cy, hh, sb)) continue;
      if (sb.right <= nx - hw || sb.left >= cx + hw) continue;
      limit = max(limit, sb.right + hw);
    }
    if (limit > nx) {
      nx = limit;
      hit = true;
    }
  }
  return { cx: nx, hit };
}

/** Result of a vertical move-and-resolve. */
export interface ResolveY {
  cy: number;
  grounded: boolean;
  ceiling: boolean;
}

/** Move the box centre `cy` by `dy` and resolve against `boxes`; report ground/ceiling contact. */
export function resolveY(
  boxes: readonly SolidBox[],
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  dy: number,
): ResolveY {
  let ny = cy + dy;
  let grounded = false;
  let ceiling = false;
  if (dy < 0) {
    let limit = -Infinity;
    for (const sb of boxes) {
      if (!overlapsX(cx, hw, sb)) continue;
      if (sb.top <= ny - hh || sb.bottom >= cy + hh) continue;
      limit = max(limit, sb.top + hh);
    }
    if (limit > ny) {
      ny = limit;
      grounded = true;
    }
  } else if (dy > 0) {
    let limit = Infinity;
    for (const sb of boxes) {
      if (!overlapsX(cx, hw, sb)) continue;
      if (sb.bottom >= ny + hh || sb.top <= cy - hh) continue;
      limit = min(limit, sb.bottom - hh);
    }
    if (limit < ny) {
      ny = limit;
      ceiling = true;
    }
  }
  return { cy: ny, grounded, ceiling };
}

/** Whether a solid box in `boxes` sits directly under the box's feet (within `eps`). */
export function restingOn(
  boxes: readonly SolidBox[],
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  eps: number,
): boolean {
  const feet = cy - hh;
  for (const sb of boxes) {
    if (!overlapsX(cx, hw, sb)) continue;
    if (abs(sb.top - feet) <= eps) return true;
  }
  return false;
}
