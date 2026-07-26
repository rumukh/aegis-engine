/**
 * Declarative *appearance* components.
 *
 * Appearance is content, not simulation: a scene says "this entity looks like sprite X" as
 * data, and the render adapter reads it. These components carry no behaviour and are never
 * required by the simulation — a headless run ignores them entirely (CHARTER principle 2).
 * They live in `@aegis/content` because they are part of the authored document; the renderer
 * (`@aegis/render-three`) consumes them alongside `Transform`.
 * @packageDocumentation
 */
import { defineComponent } from '@aegis/core';
import type { ComponentType } from '@aegis/core';
import { describeComponent } from '../schema.js';

/** Data of {@link Sprite}. */
export interface SpriteData {
  /** Texture/atlas id resolved by the render adapter. */
  texture: string;
  /** Optional atlas frame name. */
  frame?: string;
  /** Tint as `#rrggbb` (or `#rrggbbaa`). */
  tint?: string;
  /** Draw order within a layer; higher draws on top. */
  z?: number;
  /** Whether the sprite is currently drawn. */
  visible?: boolean;
}

/** 2D sprite appearance (platformer / iso). */
export const Sprite: ComponentType<SpriteData> = defineComponent<SpriteData>({
  id: 'Sprite',
  defaults: () => ({ texture: '', visible: true, z: 0 }),
});

// `frame` and `tint` are optional, so they never appear in the defaults schema validation
// derives; declaring them here keeps authoring them legal without weakening the field check.
describeComponent(Sprite, { optional: { frame: 'string', tint: 'string' } });

/** Data of {@link Model}. */
export interface ModelData {
  /** Mesh/gltf id resolved by the render adapter. */
  mesh: string;
  /** Optional material id override. */
  material?: string;
  /** Whether the model casts shadows (renderer hint). */
  castShadow?: boolean;
  /** Whether the model is currently drawn. */
  visible?: boolean;
}

/** 3D model appearance (fps). */
export const Model: ComponentType<ModelData> = defineComponent<ModelData>({
  id: 'Model',
  defaults: () => ({ mesh: '', visible: true }),
});

describeComponent(Model, { optional: { material: 'string', castShadow: 'boolean' } });

/** Data of {@link Light}. */
export interface LightData {
  /** Light kind. */
  kind: 'ambient' | 'directional' | 'point';
  /** Colour as `#rrggbb`. */
  color: string;
  /** Intensity multiplier. */
  intensity: number;
}

/** A light source described declaratively; positioned by the entity's `Transform`. */
export const Light: ComponentType<LightData> = defineComponent<LightData>({
  id: 'Light',
  defaults: () => ({ kind: 'point', color: '#ffffff', intensity: 1 }),
});

describeComponent(Light, { enums: { kind: ['ambient', 'directional', 'point'] } });
