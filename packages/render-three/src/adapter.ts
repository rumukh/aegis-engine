/**
 * The render adapter contract: a one-way projection of world state onto a three.js scene.
 *
 * Rendering is a pure *consumer* of the simulation (CHARTER principle 2). An adapter reads
 * `Transform` and the appearance components (`Sprite`/`Model`/`Light`) plus the active mode's
 * camera rig, and mirrors them into three.js objects. It never writes back to the world, and
 * the simulation neither knows nor cares whether an adapter exists. `@aegis/core` must never
 * import this package; the dependency arrow points only inward.
 * @packageDocumentation
 */
import { notImplemented } from '@aegis/core';
import type { GameMode, World } from '@aegis/core';
import type { Camera, Scene, WebGLRenderer } from 'three';

/** Options for constructing a {@link RenderAdapter}. */
export interface RendererOptions {
  /** The mode whose camera rig and appearance conventions to honour. */
  mode: GameMode;
  /** The canvas to render into. When omitted, the adapter creates one (browser only). */
  canvas?: HTMLCanvasElement;
  /** Drawing-buffer size in device pixels. Defaults to the canvas client size. */
  size?: { width: number; height: number };
  /** Device pixel ratio override. Defaults to `1` for deterministic captures. */
  pixelRatio?: number;
  /** Clear colour as `#rrggbb`. */
  background?: string;
}

/**
 * Mirrors world state onto a three.js scene. Lifecycle: {@link mount} once, then {@link sync}
 * after every simulation tick you want to display, then {@link dispose}.
 */
export interface RenderAdapter {
  /** The mode this adapter renders. */
  readonly mode: GameMode;
  /** The underlying three.js scene (created on {@link mount}). */
  readonly scene: Scene;
  /** The active camera, driven from the mode's camera-rig component. */
  readonly camera: Camera;
  /** The three.js renderer. */
  readonly renderer: WebGLRenderer;
  /** Build three.js objects for the world's current entities. Call once. */
  mount(world: World): void;
  /**
   * Reconcile three.js objects with the world's current state (add new entities, update
   * transforms/appearance, remove despawned entities) and render one frame. Pure read of the
   * world.
   */
  sync(world: World): void;
  /** Resize the drawing buffer and camera projection. */
  resize(width: number, height: number): void;
  /** Release all GPU resources. */
  dispose(): void;
}

/**
 * Create a render adapter for `options.mode`. The concrete adapter picks the camera rig
 * component (`PlatformerCamera` / `IsoCamera` / `FpsCamera`) and appearance mapping
 * (`Sprite` for 2D, `Model` for 3D) appropriate to the mode.
 */
export function createRenderer(options: RendererOptions): RenderAdapter {
  return notImplemented(`createRenderer(${options.mode})`);
}
