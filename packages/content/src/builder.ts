/**
 * A small, typed builder for authoring scenes in code.
 *
 * JSON is the canonical, diffable format (ADR-0003), but tests and generators often prefer
 * to build a scene programmatically with type-checked component data and then emit the exact
 * same JSON. The builder is that bridge: fluent, type-safe, and lossless to {@link SceneFile}.
 * @packageDocumentation
 */
import { notImplemented } from '@aegis/core';
import type { ComponentType, GameMode } from '@aegis/core';
import type { SceneFile } from './scene.js';

/** Fluent builder for a single entity within a {@link SceneBuilder}. */
export interface EntityBuilder {
  /** Attach typed component data (type-checked against the component's shape). */
  with<T>(type: ComponentType<T>, data?: Partial<T>): this;
  /** Add zero-data marker components. */
  tag(...tags: string[]): this;
  /** Instantiate from a prefab, then override with any `with`/`tag` calls. */
  fromPrefab(name: string): this;
  /** Add a nested child entity. */
  child(id: string, build: (e: EntityBuilder) => void): this;
}

/** Fluent builder for a whole scene. */
export interface SceneBuilder {
  /** Add an entity by id and configure it. */
  entity(id: string, build: (e: EntityBuilder) => void): this;
  /** Set a singleton resource value. */
  resource(id: string, value: unknown): this;
  /** Emit the canonical {@link SceneFile} — identical in shape to the on-disk JSON. */
  build(): SceneFile;
}

/** Start building a scene for `mode`. */
export function createSceneBuilder(name: string, mode: GameMode): SceneBuilder {
  return notImplemented(`createSceneBuilder(${name}, ${mode})`);
}
