/**
 * The render adapter contract: a one-way, read-only projection of world state onto a three.js
 * scene graph.
 *
 * Rendering is a pure *consumer* of the simulation (CHARTER principle 2, ADR-0005). An adapter
 * reads `Transform`, the mode's own components and the declarative appearance components, and
 * mirrors them into three.js objects. It never writes to the world, never advances it, and the
 * simulation neither knows nor cares whether an adapter exists — proven by
 * `noninterference.test.ts`, which hashes the same run with and without one attached.
 *
 * An adapter deliberately owns **no GPU state**: it builds a `THREE.Scene` and a `THREE.Camera`
 * and nothing else, so it constructs and runs headlessly in Node under vitest. Pixels are the
 * job of {@link "./view".RenderView}, which hosts a `WebGLRenderer` in a browser.
 * @packageDocumentation
 */
import { Scene, Color } from 'three';
import type { Camera, Object3D } from 'three';
import type { GameMode, World } from '@aegis/core';
import { MODE_BACKGROUNDS } from './appearance.js';

/** Options for constructing a {@link RenderAdapter}. */
export interface RenderAdapterOptions {
  /** Viewport aspect ratio (width / height). Defaults to `16 / 9`. */
  aspect?: number;
  /** Clear colour as `#rrggbb`. Defaults to the mode's convention. */
  background?: string;
}

/** A logical point the adapter resolved a pointer to, in the coordinates the mode reads. */
export interface PickedPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Mirrors world state onto a three.js scene. Lifecycle: {@link RenderAdapter.mount} once, then
 * {@link RenderAdapter.sync} for every frame you want to display, then
 * {@link RenderAdapter.dispose}.
 */
export interface RenderAdapter {
  /** The mode this adapter renders. */
  readonly mode: GameMode;
  /** The three.js scene it maintains. */
  readonly scene: Scene;
  /** The active camera, driven from the mode's camera rig. */
  readonly camera: Camera;
  /** Build the static scene graph (level geometry, lights) for `world`. Call once. */
  mount(world: World): void;
  /**
   * Reconcile the scene with the world's current state: add objects for new entities, update
   * transforms and appearance, drop despawned ones, and place the camera. A pure read of the
   * world.
   */
  sync(world: World): void;
  /** Update the camera projection for a new viewport size. */
  resize(width: number, height: number): void;
  /**
   * Resolve a normalised-device-coordinate pointer position (`x`, `y` both in `[-1, 1]`, `y` up)
   * to the logical world point the mode's input systems expect, or `null` when the mode has no
   * pointer semantics or the ray hits nothing.
   */
  pick(ndcX: number, ndcY: number): PickedPoint | null;
  /** Release geometry/material resources held by the scene graph. */
  dispose(): void;
}

/** Dispose every geometry and material under `root`, including `root` itself. */
export function disposeTree(root: Object3D): void {
  root.traverse((node) => {
    const holder = node as {
      geometry?: { dispose(): void };
      material?: { dispose(): void } | { dispose(): void }[];
    };
    holder.geometry?.dispose();
    const material = holder.material;
    if (Array.isArray(material)) for (const m of material) m.dispose();
    else material?.dispose();
  });
}

/**
 * Keyed reconciliation of `Object3D`s against a source of truth that changes every tick.
 *
 * Each `sync` opens a pass, claims the keys that should exist, then sweeps: anything not claimed
 * this pass is removed and disposed. This is the "reconcile three.js object lifetimes against
 * entity spawn/despawn" cost ADR-0005 predicted, isolated in one place.
 */
export class ObjectPool {
  readonly #parent: Object3D;
  readonly #objects = new Map<string, Object3D>();
  #claimed = new Set<string>();

  constructor(parent: Object3D) {
    this.#parent = parent;
  }

  /** Number of live objects in the pool. */
  get size(): number {
    return this.#objects.size;
  }

  /** The object registered under `key`, if any. */
  get(key: string): Object3D | undefined {
    return this.#objects.get(key);
  }

  /** Every live key, in insertion order. */
  keys(): readonly string[] {
    return [...this.#objects.keys()];
  }

  /** Begin a reconciliation pass. */
  begin(): void {
    this.#claimed = new Set<string>();
  }

  /**
   * Claim `key` for this pass, creating the object with `create` the first time it is seen.
   * Returns the object so the caller can update it.
   */
  claim<T extends Object3D>(key: string, create: () => T): T {
    this.#claimed.add(key);
    const existing = this.#objects.get(key);
    if (existing !== undefined) return existing as T;
    const created = create();
    created.name = key;
    this.#objects.set(key, created);
    this.#parent.add(created);
    return created;
  }

  /** Remove and dispose everything not claimed since the last {@link ObjectPool.begin}. */
  sweep(): void {
    for (const [key, object] of [...this.#objects]) {
      if (this.#claimed.has(key)) continue;
      this.#objects.delete(key);
      this.#parent.remove(object);
      disposeTree(object);
    }
  }

  /** Remove and dispose everything. */
  clear(): void {
    for (const object of this.#objects.values()) {
      this.#parent.remove(object);
      disposeTree(object);
    }
    this.#objects.clear();
    this.#claimed.clear();
  }
}

/** Create the shared, pre-configured scene for a mode. */
export function createModeScene(mode: GameMode, background?: string): Scene {
  const scene = new Scene();
  scene.name = `aegis:${mode}`;
  scene.background = new Color(background ?? MODE_BACKGROUNDS[mode]);
  return scene;
}

/** Aspect ratio from viewport pixels, guarding against a zero-height layout. */
export function aspectOf(width: number, height: number): number {
  return height > 0 ? width / height : 16 / 9;
}

/** Base implementation shared by the three mode adapters. */
export abstract class BaseAdapter implements RenderAdapter {
  abstract readonly mode: GameMode;
  abstract readonly scene: Scene;
  abstract readonly camera: Camera;

  abstract mount(world: World): void;
  abstract sync(world: World): void;
  abstract resize(width: number, height: number): void;

  /** Modes without pointer semantics resolve nothing. Overridden by the iso adapter. */
  pick(_ndcX: number, _ndcY: number): PickedPoint | null {
    return null;
  }

  dispose(): void {
    disposeTree(this.scene);
    this.scene.clear();
  }
}
