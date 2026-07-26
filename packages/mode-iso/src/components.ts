/**
 * Isometric-mode components and resources: grid-anchored actors that move cell-to-cell along
 * computed paths (click-to-move) and trade fire on a cooldown (click-to-attack). Pure data;
 * behaviour lives in the mode's systems.
 * @packageDocumentation
 */
import { defineComponent, defineResource, defineTag } from '@aegis/core';
import type { ComponentType, ResourceType, Tag } from '@aegis/core';

/** Data of {@link GridPosition}: an actor's location on the integer tile grid. */
export interface GridPositionData {
  /** Column (grid X). */
  cellX: number;
  /** Row (grid Y). */
  cellY: number;
  /**
   * Sub-cell interpolation `0..1` toward the next path cell, used to render smooth movement
   * while logical position stays integer. `0` = centred on (`cellX`,`cellY`).
   */
  progress: number;
}

/** An actor's discrete position on the isometric grid. */
export const GridPosition: ComponentType<GridPositionData> = defineComponent<GridPositionData>({
  id: 'GridPosition',
  defaults: () => ({ cellX: 0, cellY: 0, progress: 0 }),
});

/** Data of {@link IsoActor}: movement tunables for a grid mover. */
export interface IsoActorData {
  /** Cells traversed per second. */
  speed: number;
  /**
   * Movement discipline: `realtime` interpolates continuously; `turn` snaps one whole cell
   * per resolved step (for turn-based modes).
   */
  moveMode: 'realtime' | 'turn';
}

/** Marks an entity as a grid-moving actor and carries its movement tunables. */
export const IsoActor: ComponentType<IsoActorData> = defineComponent<IsoActorData>({
  id: 'IsoActor',
  defaults: () => ({ speed: 4, moveMode: 'realtime' }),
});

/** A single grid cell. */
export interface Cell {
  x: number;
  y: number;
}

/** Data of {@link MoveOrder}: a destination plus the resolved path to it. */
export interface MoveOrderData {
  /** Destination cell. */
  target: Cell;
  /**
   * The resolved path as a list of cells from current position to `target`, or an empty array
   * before pathfinding runs / when no path exists. Consumed front-to-back by the mover.
   */
  path: readonly Cell[];
  /** Whether pathfinding has run for the current `target`. */
  resolved: boolean;
}

/** A pending click-to-move command. Removed once the actor reaches `target`. */
export const MoveOrder: ComponentType<MoveOrderData> = defineComponent<MoveOrderData>({
  id: 'MoveOrder',
  defaults: () => ({ target: { x: 0, y: 0 }, path: [], resolved: false }),
});

/**
 * Data of {@link AttackOrder}: an attack-move command targeting another entity. The pathfinder
 * closes to within weapon range of `target`; the combat system then fires on cooldown.
 */
export interface AttackOrderData {
  /** The entity being attacked (a handle, tracked as it moves — not a fixed cell). */
  target: number;
  /** Resolved path to a cell within weapon range of `target`; empty when already in range. */
  path: readonly Cell[];
  /** Whether pathfinding has run this tick for the current target position. */
  resolved: boolean;
}

/** A pending click-to-attack command. Removed once the target is dead or gone. */
export const AttackOrder: ComponentType<AttackOrderData> = defineComponent<AttackOrderData>({
  id: 'AttackOrder',
  defaults: () => ({ target: 0, path: [], resolved: false }),
});

/** Data of {@link Attacker}: a real-time-with-cooldown weapon (ADR-0009, DA:O-style). */
export interface AttackerData {
  /** Maximum attack distance in cells (Chebyshev) with clear line of sight. */
  rangeCells: number;
  /** Damage applied to the target's `Health` per shot. */
  damage: number;
  /** Ticks between shots. */
  cooldownTicks: number;
  /** Ticks remaining until the next shot may fire; `0` means ready. */
  cooldownRemaining: number;
}

/** A weapon that fires at a target within range/line-of-sight on a fixed cooldown. */
export const Attacker: ComponentType<AttackerData> = defineComponent<AttackerData>({
  id: 'Attacker',
  defaults: () => ({ rangeCells: 1, damage: 1, cooldownTicks: 30, cooldownRemaining: 0 }),
});

/**
 * Marks the single actor the pointer controls (the "player"). Click-to-move / click-to-attack
 * orders attach to it; combat events are emitted from its perspective (a hit it lands is an
 * `enemy.*` event, a hit it takes is `damage.taken`).
 */
export const Controlled: ComponentType<Tag> = defineTag('Controlled');

/** Marks a cell-occupying entity as impassable for pathfinding (walls handled by the nav grid). */
export const Blocking: ComponentType<Tag> = defineTag('Blocking');

/** Data of {@link IsoCamera}: the isometric follow camera. */
export interface IsoCameraData {
  /** Name of the entity to follow. */
  target: string;
  /** World-space height the viewport spans (orthographic zoom). */
  viewHeight: number;
  /** Yaw of the isometric projection in degrees (classic 2:1 iso ≈ 45). */
  yawDegrees: number;
}

/** The isometric follow-camera rig. */
export const IsoCamera: ComponentType<IsoCameraData> = defineComponent<IsoCameraData>({
  id: 'IsoCamera',
  defaults: () => ({ target: '', viewHeight: 16, yawDegrees: 45 }),
});

/**
 * Authored grid resource (id `"IsoGrid"`): the static collision layer as ASCII rows plus grid
 * bounds. `#` is a wall, anything else is floor. A scene sets it under `resources`; the mode's
 * `init` bakes it into a {@link NavGrid}. Mirrors the tilemap's collision layer so it diffs well.
 */
export interface IsoGridConfig {
  /** Grid width in cells. */
  width: number;
  /** Grid height in cells. */
  height: number;
  /** World-space size of one tile edge. */
  tileSize: number;
  /** `height` rows of single-character cells; `#` = wall, otherwise floor. */
  walls: readonly string[];
}

/** The authored static-collision resource, baked into a {@link NavGrid} at run start. */
export const IsoGrid: ResourceType<IsoGridConfig> = defineResource<IsoGridConfig>(
  'IsoGrid',
  () => ({
    width: 0,
    height: 0,
    tileSize: 1,
    walls: [],
  }),
);

/** Data of the baked {@link NavGrid}: static passability as a row-major bitmap. */
export interface NavGridData {
  /** Grid width in cells. */
  width: number;
  /** Grid height in cells. */
  height: number;
  /** World-space size of one tile edge. */
  tileSize: number;
  /** Row-major `width*height` flags; `true` = impassable static wall. */
  blocked: readonly boolean[];
}

/**
 * The baked navigation grid (id `"NavGrid"`): static walls only, derived once from {@link IsoGrid}
 * by the mode's `init`. Stored as plain data so it snapshots/hashes and survives `SimResult.at`
 * (which restores worlds without re-running `init`). Dynamic obstacles ({@link Blocking} entities
 * such as a sealed door) are layered on top per pathfinding query, giving free dynamic repath.
 */
export const NavGrid: ResourceType<NavGridData> = defineResource<NavGridData>('NavGrid', () => ({
  width: 0,
  height: 0,
  tileSize: 1,
  blocked: [],
}));

/** All component types this mode contributes to the registry. */
export const ISO_COMPONENTS: readonly ComponentType<unknown>[] = [
  GridPosition,
  IsoActor,
  MoveOrder,
  AttackOrder,
  Attacker,
  Controlled,
  Blocking,
  IsoCamera,
] as readonly ComponentType<unknown>[];
