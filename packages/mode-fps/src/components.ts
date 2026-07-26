/**
 * FPS-mode components: a capsule-bodied first-person actor with yaw/pitch look state and a
 * hitscan weapon. Pure data; behaviour lives in the mode's systems.
 * @packageDocumentation
 */
import { defineComponent } from '@aegis/core';
import type { ComponentType, Vec3 } from '@aegis/core';

/** Data of {@link CapsuleBody}: an upright capsule collider plus its velocity. */
export interface CapsuleBodyData {
  /** Capsule radius, world units. */
  radius: number;
  /** Capsule total height (tip to tip), world units. */
  height: number;
  /** Current velocity, world units per second. */
  velocity: Vec3;
  /** Whether the capsule rested on ground at the end of the last tick. */
  grounded: boolean;
}

/** The moving collision volume of an FPS actor. */
export const CapsuleBody: ComponentType<CapsuleBodyData> = defineComponent<CapsuleBodyData>({
  id: 'CapsuleBody',
  defaults: () => ({ radius: 0.4, height: 1.8, velocity: { x: 0, y: 0, z: 0 }, grounded: false }),
});

/** Data of {@link FpsController}: first-person movement and look tunables. */
export interface FpsControllerData {
  /** Ground move speed, units/s. */
  moveSpeed: number;
  /** Look sensitivity, degrees of rotation per unit of `look` delta. */
  lookSpeedDeg: number;
  /** Downward acceleration, units/s². */
  gravity: number;
  /** Upward speed applied on jump, units/s. */
  jumpSpeed: number;
  /** Pitch clamp in degrees, applied as `[-maxPitchDeg, +maxPitchDeg]`. */
  maxPitchDeg: number;
}

/** Movement/look tunables for a controllable FPS character. */
export const FpsController: ComponentType<FpsControllerData> = defineComponent<FpsControllerData>({
  id: 'FpsController',
  defaults: () => ({
    moveSpeed: 6,
    lookSpeedDeg: 0.15,
    gravity: 24,
    jumpSpeed: 8,
    maxPitchDeg: 89,
  }),
});

/** Data of {@link LookState}: the accumulated look orientation, in degrees. */
export interface LookStateData {
  /** Yaw (turn) in degrees, wrapping in `[0, 360)`. */
  yawDeg: number;
  /** Pitch (up/down) in degrees, clamped by {@link FpsControllerData.maxPitchDeg}. */
  pitchDeg: number;
}

/** Accumulated first-person look angles, maintained by the look system. */
export const LookState: ComponentType<LookStateData> = defineComponent<LookStateData>({
  id: 'LookState',
  defaults: () => ({ yawDeg: 0, pitchDeg: 0 }),
});

/** Data of {@link FpsCamera}: the eye the semantic frame is projected from. */
export interface FpsCameraData {
  /** Eye height above the capsule's feet, world units. */
  eyeHeight: number;
  /** Vertical field of view in degrees. */
  fovDegrees: number;
  /** Near clip distance, world units. */
  near: number;
  /** Far clip distance, world units. */
  far: number;
}

/** The first-person camera rig. */
export const FpsCamera: ComponentType<FpsCameraData> = defineComponent<FpsCameraData>({
  id: 'FpsCamera',
  defaults: () => ({ eyeHeight: 1.6, fovDegrees: 75, near: 0.1, far: 1000 }),
});

/** Data of {@link Hitscan}: an instantaneous ray weapon. */
export interface HitscanData {
  /** Maximum ray distance, world units. */
  range: number;
  /** Damage applied to the first entity hit. */
  damage: number;
  /** Minimum ticks between shots. */
  cooldownTicks: number;
  /** Ticks remaining until the weapon can fire again. */
  cooldownRemaining: number;
}

/** A hitscan weapon resolved by casting a ray from the camera. */
export const Hitscan: ComponentType<HitscanData> = defineComponent<HitscanData>({
  id: 'Hitscan',
  defaults: () => ({ range: 100, damage: 25, cooldownTicks: 12, cooldownRemaining: 0 }),
});

/** Data of {@link Health}: hit points for damageable entities. */
export interface HealthData {
  /** Current hit points. */
  current: number;
  /** Maximum hit points. */
  max: number;
}

/** Hit points; reaching `0` marks the entity dead (handled by mode systems). */
export const Health: ComponentType<HealthData> = defineComponent<HealthData>({
  id: 'Health',
  defaults: () => ({ current: 100, max: 100 }),
});

/** All component types this mode contributes to the registry. */
export const FPS_COMPONENTS: readonly ComponentType<unknown>[] = [
  CapsuleBody,
  FpsController,
  LookState,
  FpsCamera,
  Hitscan,
  Health,
] as readonly ComponentType<unknown>[];
