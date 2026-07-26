/**
 * A small, typed builder for authoring scenes in code.
 *
 * JSON is the canonical, diffable format (ADR-0003), but tests and generators often prefer
 * to build a scene programmatically with type-checked component data and then emit the exact
 * same JSON. The builder is that bridge: fluent, type-safe, and lossless to {@link SceneFile}.
 * @packageDocumentation
 */
import type { ComponentType, GameMode } from '@aegis/core';
import type { ComponentData, EntityDecl, SceneFile } from './scene.js';

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

/** Mutable working state for one entity being built. */
interface EntityDraft {
  id: string;
  prefab?: string;
  tags: string[];
  components: Record<string, ComponentData>;
  children: EntityDraft[];
}

function makeEntityBuilder(id: string): { builder: EntityBuilder; draft: EntityDraft } {
  const draft: EntityDraft = { id, tags: [], components: {}, children: [] };
  const builder: EntityBuilder = {
    with<T>(type: ComponentType<T>, data?: Partial<T>): EntityBuilder {
      // Merge partial data over the component's own defaults, so the emitted document
      // carries a complete, canonical component value.
      draft.components[type.id] = type.create(data) as unknown as ComponentData;
      return builder;
    },
    tag(...tags: string[]): EntityBuilder {
      for (const t of tags) if (!draft.tags.includes(t)) draft.tags.push(t);
      return builder;
    },
    fromPrefab(name: string): EntityBuilder {
      draft.prefab = name;
      return builder;
    },
    child(childId: string, build: (e: EntityBuilder) => void): EntityBuilder {
      const { builder: cb, draft: cd } = makeEntityBuilder(childId);
      build(cb);
      draft.children.push(cd);
      return builder;
    },
  };
  return { builder, draft };
}

function draftToDecl(draft: EntityDraft): EntityDecl {
  const decl: {
    id: string;
    prefab?: string;
    tags?: readonly string[];
    components?: Readonly<Record<string, ComponentData>>;
    children?: readonly EntityDecl[];
  } = { id: draft.id };
  if (draft.prefab !== undefined) decl.prefab = draft.prefab;
  if (draft.tags.length > 0) decl.tags = draft.tags.slice();
  if (Object.keys(draft.components).length > 0) decl.components = { ...draft.components };
  if (draft.children.length > 0) decl.children = draft.children.map(draftToDecl);
  return decl as EntityDecl;
}

/** Start building a scene for `mode`. */
export function createSceneBuilder(name: string, mode: GameMode): SceneBuilder {
  const drafts: EntityDraft[] = [];
  const resources: Record<string, unknown> = {};

  const builder: SceneBuilder = {
    entity(id: string, build: (e: EntityBuilder) => void): SceneBuilder {
      const { builder: eb, draft } = makeEntityBuilder(id);
      build(eb);
      drafts.push(draft);
      return builder;
    },
    resource(id: string, value: unknown): SceneBuilder {
      resources[id] = value;
      return builder;
    },
    build(): SceneFile {
      const scene: {
        aegis: 'scene/1';
        name: string;
        mode: GameMode;
        resources?: Readonly<Record<string, unknown>>;
        entities: readonly EntityDecl[];
      } = {
        aegis: 'scene/1',
        name,
        mode,
        entities: drafts.map(draftToDecl),
      };
      if (Object.keys(resources).length > 0) scene.resources = { ...resources };
      return scene as SceneFile;
    },
  };
  return builder;
}
