/**
 * Isometric-mode components: grid-anchored actors that move cell-to-cell along computed paths
 * (click-to-move). Pure data; behaviour lives in the mode's systems.
 * @packageDocumentation
 */
import { defineComponent, defineTag } from '@aegis/core';
import type { ComponentType, Tag } from '@aegis/core';

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

/** Marks a cell-occupying entity as impassable for pathfinding. */
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

/** All component types this mode contributes to the registry. */
export const ISO_COMPONENTS: readonly ComponentType<unknown>[] = [
  GridPosition,
  IsoActor,
  MoveOrder,
  Blocking,
  IsoCamera,
] as readonly ComponentType<unknown>[];
