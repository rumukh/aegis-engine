/**
 * Parsing, validation and instantiation of content documents.
 *
 * The pipeline is: **text → parse → validate → instantiate**. Parsing and validation never
 * throw for content problems — they return a {@link Validated} carrying structured
 * {@link Diagnostic}s (CHARTER principle 8). Only truly exceptional conditions (a caller
 * passing a non-string) throw. Instantiation writes entities/components/resources into a
 * live {@link World} and reports what it created.
 * @packageDocumentation
 */
import { notImplemented } from '@aegis/core';
import type { Diagnostic, Entity, Validated, World } from '@aegis/core';
import type { PrefabFile, SceneFile, TilemapFile } from './scene.js';
import type { ComponentRegistry } from './registry.js';

/** Resolves a prefab name to its {@link PrefabFile}. */
export interface PrefabResolver {
  /** Resolve a prefab by name, or `undefined` if unknown. */
  resolve(name: string): PrefabFile | undefined;
}

/** Parse and validate a scene document from raw text. `file` is used in diagnostics only. */
export function parseScene(text: string, file?: string): Validated<SceneFile> {
  return notImplemented(`parseScene(${file ?? '<inline>'})`);
}

/** Parse and validate a prefab document from raw text. */
export function parsePrefab(text: string, file?: string): Validated<PrefabFile> {
  return notImplemented(`parsePrefab(${file ?? '<inline>'})`);
}

/** Parse and validate a tilemap document from raw text. */
export function parseTilemap(text: string, file?: string): Validated<TilemapFile> {
  return notImplemented(`parseTilemap(${file ?? '<inline>'})`);
}

/**
 * Validate an already-parsed scene object against the registry (unknown components, prefab
 * references, duplicate ids, mode). Separated from {@link parseScene} so callers holding a
 * scene built in code (see the builder) can validate without re-serialising.
 */
export function validateScene(scene: SceneFile, options: ValidateOptions): Validated<SceneFile> {
  return notImplemented('validateScene');
}

/** Options shared by validation and instantiation. */
export interface ValidateOptions {
  /** Registry used to resolve component ids. */
  registry: ComponentRegistry;
  /** Optional prefab resolver; required if any entity uses `prefab`. */
  prefabs?: PrefabResolver;
}

/** Options for {@link instantiateScene}. */
export interface InstantiateOptions extends ValidateOptions {
  /**
   * Validate before instantiating. Default `true`. Set `false` only when the scene was
   * already validated, to avoid duplicate work.
   */
  validate?: boolean;
}

/** The result of instantiating a scene into a world. */
export interface InstantiateResult {
  /** `true` when no error-severity diagnostics were produced. */
  ok: boolean;
  /** All diagnostics produced during validation/instantiation. */
  diagnostics: readonly Diagnostic[];
  /** Map from scene entity id to the spawned {@link Entity} handle. */
  entities: Readonly<Record<string, Entity>>;
}

/**
 * Instantiate a validated scene into `world`: apply resources, then spawn each entity
 * (resolving prefabs, merging component data over defaults, resolving child transforms).
 * Does not advance time.
 */
export function instantiateScene(
  world: World,
  scene: SceneFile,
  options: InstantiateOptions,
): InstantiateResult {
  return notImplemented('instantiateScene');
}
