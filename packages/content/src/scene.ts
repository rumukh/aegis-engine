/**
 * The declarative content format: scenes, prefabs and tilemaps (CHARTER principle 1).
 *
 * Everything an agent authors is a plain, diffable JSON document. Each document is tagged
 * with an `aegis` discriminator (`"scene/1"`, `"prefab/1"`, `"tilemap/1"`) carrying the
 * format version, so a loader can validate and migrate without guessing. Component data is
 * addressed by the same stable string ids used at runtime (`"Transform"`, `"Sprite"`, …),
 * so a scene reads the same way it queries.
 *
 * These are the on-disk shapes. See ADR-0003 for why JSON (not TS-as-data) is canonical.
 * @packageDocumentation
 */
import type { GameMode } from '@aegis/core';

/** Arbitrary component data as it appears in a document: a plain JSON value. */
export type ComponentData = Readonly<Record<string, unknown>>;

/** One entity declared in a scene or prefab. */
export interface EntityDecl {
  /** Stable id, unique within the document. Becomes the entity's `Name`. */
  id: string;
  /** Optional prefab to instantiate first; this decl's fields then override it. */
  prefab?: string;
  /** Zero-data marker components, e.g. `["Player", "Solid"]`. */
  tags?: readonly string[];
  /**
   * Component id → partial component data. Values are merged over the component's defaults
   * (and over the prefab, if any). Unknown ids are a validation error.
   */
  components?: Readonly<Record<string, ComponentData>>;
  /**
   * Nested children. By convention a child's `Transform` is authored relative to its parent
   * and resolved to world space at load time.
   */
  children?: readonly EntityDecl[];
}

/** A `*.scene.json` document: the root of a runnable world. */
export interface SceneFile {
  /** Format discriminator and version. */
  readonly aegis: 'scene/1';
  /** Human-readable scene name. */
  name: string;
  /** The mode this scene targets; selects the systems and camera rig to run. */
  mode: GameMode;
  /** Optional seed override for this scene (the run seed usually wins; see harness). */
  seed?: number | string;
  /** Singleton resource id → value, applied to the world before entities are spawned. */
  resources?: Readonly<Record<string, unknown>>;
  /** The entities that make up the scene, spawned in document order. */
  entities: readonly EntityDecl[];
  /** Free-form authoring metadata ignored by the runtime (author, description, …). */
  meta?: Readonly<Record<string, unknown>>;
}

/** A `*.prefab.json` document: a reusable entity template referenced by `EntityDecl.prefab`. */
export interface PrefabFile {
  /** Format discriminator and version. */
  readonly aegis: 'prefab/1';
  /** Stable prefab name, used as the `prefab` reference key. */
  name: string;
  /** Default tags for instances. */
  tags?: readonly string[];
  /** Default component data for instances. */
  components?: Readonly<Record<string, ComponentData>>;
  /** Default children for instances. */
  children?: readonly EntityDecl[];
}

/** Definition of one tile kind in a {@link TilemapFile} legend. */
export interface TileDef {
  /** Whether the tile blocks movement (mode-specific interpretation). */
  solid?: boolean;
  /** Optional sprite/texture id for the renderer. */
  sprite?: string;
  /** Free-form gameplay data (damage, friction, trigger id, …). */
  data?: Readonly<Record<string, unknown>>;
}

/** One named layer of a tilemap: fixed-width ASCII rows of legend keys. */
export interface TilemapLayer {
  /** Layer name, e.g. `"collision"`, `"decor"`. */
  name: string;
  /**
   * Rows top-to-bottom. Each row is a string of single-character legend keys; `.` (or a
   * space) means "empty". Rows are ASCII so a tilemap diffs beautifully in review.
   */
  data: readonly string[];
}

/** A `*.tilemap.json` document: a grid world addressed by a character legend. */
export interface TilemapFile {
  /** Format discriminator and version. */
  readonly aegis: 'tilemap/1';
  /** Human-readable name. */
  name: string;
  /** Grid width in tiles. */
  width: number;
  /** Grid height in tiles. */
  height: number;
  /** World-space size of one tile edge. */
  tileSize: number;
  /** Legend: single-character key → tile definition. */
  legend: Readonly<Record<string, TileDef>>;
  /** One or more layers. */
  layers: readonly TilemapLayer[];
}

/** Any Aegis content document. */
export type ContentFile = SceneFile | PrefabFile | TilemapFile;
