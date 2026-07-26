/**
 * "Seeing" the game without a GPU (CHARTER principle 7).
 *
 * Two complementary text views of what a camera would show, both derived purely from world
 * state so they are deterministic and diffable:
 *
 * - {@link SemanticFrame} — a structured description of every entity the camera can see:
 *   its world position, its projected screen position, depth, layer, and whether it is
 *   occluded. This is the primary debugging surface for all three modes, and the exact data
 *   the renderer would draw. An agent reads it to answer "is the enemy on screen, and where?"
 * - {@link AsciiView} — a deterministic character-grid rasterisation for the 2D modes
 *   (platformer, iso). An agent reads it to *see the level* in text.
 *
 * Each mode implements a {@link ViewProvider}: projection is mode-specific (orthographic
 * side-on, isometric, perspective), so the provider lives with the mode, while these shared
 * types live in the harness that orchestrates them.
 * @packageDocumentation
 */
import type { Entity, GameMode, Quat, Vec3, World } from '@aegis/core';

/** A pixel position in the virtual viewport, origin at the top-left. */
export interface ScreenPos {
  x: number;
  y: number;
}

/** Virtual viewport dimensions, in pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/** The camera state at the moment a frame was captured. */
export interface CameraSnapshot {
  /** Which mode's rig produced this camera. */
  mode: GameMode;
  /** Camera world position. */
  position: Vec3;
  /** Camera orientation. */
  rotation: Quat;
  /** Projection kind: 2D modes are orthographic, fps is perspective. */
  projection: 'orthographic' | 'perspective';
  /** Vertical field of view in degrees (perspective only). */
  fovDegrees?: number;
  /** World-space height the viewport spans (orthographic only). */
  orthoHeight?: number;
  /** The viewport the projection targets. */
  viewport: Viewport;
}

/** One entity as the camera sees it. */
export interface VisibleEntity {
  /** The entity handle. */
  entity: Entity;
  /** The entity's `Name`, if any — the readable id used in assertions. */
  name?: string;
  /** Marker components present on the entity, for filtering ("Player", "Enemy", …). */
  tags: readonly string[];
  /** World-space position (from `Transform`). */
  world: Vec3;
  /** Projected position in the virtual viewport. */
  screen: ScreenPos;
  /** Distance from the camera along its view direction; used for sort/occlusion. */
  depth: number;
  /** Screen-space bounding-box size in pixels, when known. */
  bounds?: { width: number; height: number };
  /** Render/sort layer. */
  layer: number;
  /**
   * Whether the entity is fully hidden behind nearer geometry. **Optional** (frozen ruling):
   * only the fps mode computes occlusion; the 2D modes leave it `undefined`. Treat absent as
   * "not known to be occluded".
   */
  occluded?: boolean;
  /**
   * Fraction of the entity visible, `0` (hidden) … `1` (fully visible). **Optional** (frozen
   * ruling): fps-only, like {@link VisibleEntity.occluded}. Treat absent as fully visible.
   */
  visibleFraction?: number;
  /** Optional single-character glyph used when rasterising to {@link AsciiView}. */
  glyph?: string;
}

/** Structured description of a rendered frame, derived from world state. */
export interface SemanticFrame {
  /** Tick this frame represents. */
  tick: number;
  /** The mode that produced it. */
  mode: GameMode;
  /** The camera state. */
  camera: CameraSnapshot;
  /** The viewport. */
  viewport: Viewport;
  /**
   * Every visible entity, sorted deterministically: ascending `depth`, ties broken by
   * ascending `entity`. On-screen entities only (unless `includeOffscreen` was requested).
   */
  entities: readonly VisibleEntity[];
}

/** A deterministic character-grid view of the world (2D modes). */
export interface AsciiView {
  /** Tick this view represents. */
  tick: number;
  /** Width in character cells. */
  width: number;
  /** Height in character cells. */
  height: number;
  /** `height` rows, each exactly `width` characters. Row 0 is the top of the view. */
  rows: readonly string[];
  /** Glyph → human description, e.g. `{ "@": "player", "#": "solid tile" }`. */
  legend: Readonly<Record<string, string>>;
}

/** Options controlling how a view is produced. */
export interface ViewOptions {
  /** Virtual viewport size for the semantic frame. Defaults to the mode's convention. */
  viewport?: Viewport;
  /** Character-grid size for the ASCII view. Defaults to the mode's convention. */
  ascii?: { width: number; height: number };
  /** Include entities outside the viewport in {@link SemanticFrame.entities}. Default `false`. */
  includeOffscreen?: boolean;
}

/**
 * A mode's projection of world state into the shared view types. Implemented by each
 * `@aegis/mode-*` package. The harness calls it; it never mutates the world.
 */
export interface ViewProvider {
  /** The mode this provider renders. */
  readonly mode: GameMode;
  /** Produce the structured semantic frame for the world's current tick. */
  semanticFrame(world: World, options?: ViewOptions): SemanticFrame;
  /**
   * Produce the ASCII view for the world's current tick, or `undefined` if this mode does
   * not offer one (fps relies on the semantic frame; 2D modes always provide ASCII).
   */
  asciiView(world: World, options?: ViewOptions): AsciiView | undefined;
}
