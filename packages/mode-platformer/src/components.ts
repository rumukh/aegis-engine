/**
 * Platformer components: the data a 2D side-scroller entity carries. Behaviour lives in the
 * mode's systems (see `./plugin.ts`); these are pure data shapes with stable ids.
 * @packageDocumentation
 */
import { defineComponent } from '@aegis/core';
import type { ComponentType } from '@aegis/core';

/** Data of {@link Velocity}. */
export interface VelocityData {
  /** Horizontal velocity, world units per second. */
  dx: number;
  /** Vertical velocity, world units per second (positive = up). */
  dy: number;
}

/** Linear velocity for a platformer body. */
export const Velocity: ComponentType<VelocityData> = defineComponent<VelocityData>({
  id: 'Velocity',
  defaults: () => ({ dx: 0, dy: 0 }),
});

/** Data of {@link PlatformerController}: the tunables that define "feel". */
export interface PlatformerControllerData {
  /** Horizontal run speed, units/s. */
  moveSpeed: number;
  /** Upward speed applied on jump, units/s. */
  jumpSpeed: number;
  /** Downward acceleration, units/s². */
  gravity: number;
  /** Terminal fall speed, units/s. */
  maxFallSpeed: number;
  /** Grace ticks after leaving a ledge during which a jump still works (coyote time). */
  coyoteTicks: number;
  /** Ticks a jump press is buffered before landing. */
  jumpBufferTicks: number;
}

/** Movement tunables for a controllable platformer character. */
export const PlatformerController: ComponentType<PlatformerControllerData> =
  defineComponent<PlatformerControllerData>({
    id: 'PlatformerController',
    defaults: () => ({
      moveSpeed: 8,
      jumpSpeed: 16,
      gravity: 60,
      maxFallSpeed: 30,
      coyoteTicks: 6,
      jumpBufferTicks: 6,
    }),
  });

/** Data of {@link BodyState}: transient per-tick movement state. */
export interface BodyStateData {
  /** Whether the body was resting on solid ground at the end of the last tick. */
  grounded: boolean;
  /** Ticks since the body was last grounded (drives coyote time). */
  airborneTicks: number;
  /** Facing direction: `-1` left, `1` right. */
  facing: -1 | 1;
}

/** Runtime movement state maintained by the controller systems. */
export const BodyState: ComponentType<BodyStateData> = defineComponent<BodyStateData>({
  id: 'BodyState',
  defaults: () => ({ grounded: false, airborneTicks: 0, facing: 1 }),
});

/** Data of {@link TileCollider}: an axis-aligned box used against the tilemap. */
export interface TileColliderData {
  /** Half-width of the AABB, world units. */
  halfWidth: number;
  /** Half-height of the AABB, world units. */
  halfHeight: number;
  /** Centre offset from the entity's `Transform`, world units. */
  offsetX: number;
  /** Centre offset from the entity's `Transform`, world units. */
  offsetY: number;
}

/** An AABB collider resolved against solid tiles. */
export const TileCollider: ComponentType<TileColliderData> = defineComponent<TileColliderData>({
  id: 'TileCollider',
  defaults: () => ({ halfWidth: 0.5, halfHeight: 0.5, offsetX: 0, offsetY: 0 }),
});

/** Data of {@link PlatformerCamera}: a follow camera with a dead-zone. */
export interface PlatformerCameraData {
  /** Name of the entity to follow. */
  target: string;
  /** Half-size of the dead-zone box (camera stays still while target is inside), world units. */
  deadzoneX: number;
  /** Half-size of the dead-zone box, world units. */
  deadzoneY: number;
  /** World-space height the viewport spans (orthographic zoom). */
  viewHeight: number;
}

/** The platformer follow-camera rig. */
export const PlatformerCamera: ComponentType<PlatformerCameraData> =
  defineComponent<PlatformerCameraData>({
    id: 'PlatformerCamera',
    defaults: () => ({ target: '', deadzoneX: 2, deadzoneY: 1.5, viewHeight: 12 }),
  });

/** All component types this mode contributes to the registry. */
export const PLATFORMER_COMPONENTS: readonly ComponentType<unknown>[] = [
  Velocity,
  PlatformerController,
  BodyState,
  TileCollider,
  PlatformerCamera,
] as readonly ComponentType<unknown>[];
