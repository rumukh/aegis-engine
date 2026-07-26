/**
 * The canonical-ASCII → mode-floorplan bridge for Sector Breach.
 *
 * CHARTER principle 1 says the level is authored as text: `levels/sector-breach.tilemap.json`
 * is the human-diffable source of truth (a `@aegis/content` {@link TilemapFile} whose
 * `collision` layer *is* the top-down floorplan). The mode, however, consumes its own
 * {@link FloorplanSpec} resource. This module performs that one, pure conversion so the two
 * representations can never silently drift — the game test extrudes both and compares them.
 *
 * Height is a function of *tile kind*, so rather than the spec's separate "parallel heights
 * layer" we carry floor/ceiling in each legend entry's `data` (`{ floor, ceil }`). One ASCII
 * grid, one legend; see the handoff note on this deviation.
 * @packageDocumentation
 */
import type { TilemapFile } from '@aegis/content';
import type { FloorplanSpec, FloorplanTileKind } from '@aegis/mode-fps';

/** The layer whose rows are the extruded floorplan. */
const COLLISION_LAYER = 'collision';

/** Default ceiling height (world y) for tiles that don't state one. Room headroom clears the
 * jump apex — see the handoff note on the 3 → 4 ceiling bump. */
const DEFAULT_CEIL = 4;

function numberField(
  data: Readonly<Record<string, unknown>> | undefined,
  key: string,
  fallback: number,
): number {
  const v = data?.[key];
  return typeof v === 'number' ? v : fallback;
}

function boolField(data: Readonly<Record<string, unknown>> | undefined, key: string): boolean {
  return data?.[key] === true;
}

/**
 * Convert a {@link TilemapFile} into the {@link FloorplanSpec} the FPS mode extrudes, positioning
 * the grid so cell `(col=0, row=height-1)` sits at `origin`. Throws if the tilemap has no
 * `collision` layer — a level with no floorplan is an authoring bug, not a silent empty room.
 */
export function floorplanFromTilemap(
  tilemap: TilemapFile,
  origin: { x: number; z: number },
): FloorplanSpec {
  const layer = tilemap.layers.find((l) => l.name === COLLISION_LAYER);
  if (layer === undefined) {
    throw new Error(
      `floorplanFromTilemap: tilemap "${tilemap.name}" has no "${COLLISION_LAYER}" layer ` +
        `(layers: ${tilemap.layers.map((l) => l.name).join(', ') || 'none'})`,
    );
  }

  const legend: Record<string, FloorplanTileKind> = {};
  for (const [key, def] of Object.entries(tilemap.legend)) {
    const kind: FloorplanTileKind = {
      solid: def.solid === true,
      floor: numberField(def.data, 'floor', 0),
      ceil: numberField(def.data, 'ceil', DEFAULT_CEIL),
    };
    if (boolField(def.data, 'door')) kind.door = true;
    if (boolField(def.data, 'hazard')) kind.hazard = true;
    legend[key] = kind;
  }

  return {
    width: tilemap.width,
    height: tilemap.height,
    tileSize: tilemap.tileSize,
    origin: { x: origin.x, z: origin.z },
    rows: [...layer.data],
    legend,
  };
}

/** Where Sector Breach's floorplan sits in world space: cell (0, height-1) centre. */
export const SECTOR_BREACH_ORIGIN: { x: number; z: number } = { x: -5, z: 0 };
