/**
 * The two universal, engine-agnostic components every mode and the renderer can rely on.
 *
 * Mode-specific components (velocity, colliders, grid positions, camera rigs, renderable
 * appearance, …) are defined by their owning packages — `@aegis/mode-*`, `@aegis/content`.
 * `@aegis/core` deliberately defines only identity ({@link Name}) and spatial placement
 * ({@link Transform}), because those are meaningful in every mode and to the render adapter.
 * @packageDocumentation
 */
import { defineComponent } from './component.js';
import type { ComponentType } from './component.js';
import type { Quat, Vec3 } from './math/vec3.js';

/** Data of the {@link Transform} component. */
export interface TransformData {
  /** World-space position. 2D modes ignore `z` (or use it for depth sorting). */
  position: Vec3;
  /** Orientation as a quaternion. 2D modes typically only rotate about `z`. */
  rotation: Quat;
  /** Per-axis scale. */
  scale: Vec3;
}

/**
 * World-space placement of an entity. Universal across all three modes and the sole spatial
 * contract the renderer reads. Defaults to origin, identity rotation, unit scale.
 */
export const Transform: ComponentType<TransformData> = defineComponent<TransformData>({
  id: 'Transform',
  defaults: () => ({
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  }),
});

/** Data of the {@link Name} component. */
export interface NameData {
  /** Stable, human-and-agent-readable identifier, unique within a scene by convention. */
  value: string;
}

/**
 * A stable authoring name for an entity, echoed into snapshots. Lets scenes and assertions
 * refer to entities by a readable id instead of an opaque handle (CHARTER principle 1).
 */
export const Name: ComponentType<NameData> = defineComponent<NameData>({
  id: 'Name',
  defaults: () => ({ value: '' }),
});
