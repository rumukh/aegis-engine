/**
 * FPS-mode components: a capsule-bodied first-person actor with yaw/pitch look state and a
 * hitscan weapon, plus a box hit-volume for shootable entities. Pure data; behaviour lives in
 * the mode's systems.
 *
 * Health is intentionally **not** defined here — it is shared and owned by `@aegis/content`
 * (the harness registers it as a base component). Redefining it locally would collide on the
 * `"Health"` id at registration time.
 * @packageDocumentation
 */
import { defineComponent } from '@aegis/core';
import type { ComponentType, Vec3 } from '@aegis/core';

/** Data of {@link CapsuleBody}: an upright capsule collider plus its velocity. */
export interface CapsuleBodyData {
  /** Capsule radius, world units. */
  radius: number;
  /** Capsule total height (feet to head), world units. */
  height: number;
  /** Current velocity, world units per second. */
  velocity: Vec3;
  /** Whether the capsule rested on ground at the end of the last tick. */
  grounded: boolean;
}

/** The moving collision volume of an FPS actor. `Transform.position` is the capsule's feet. */
export const CapsuleBody: ComponentType<CapsuleBodyData> = defineComponent<CapsuleBodyData>({
  id: 'CapsuleBody',
  defaults: () => ({ radius: 0.4, height: 1.8, velocity: { x: 0, y: 0, z: 0 }, grounded: false }),
});

/** Data of {@link FpsController}: first-person movement tunables. */
export interface FpsControllerData {
  /** Ground move speed, units/s. */
  moveSpeed: number;
  /** Downward acceleration, units/s². */
  gravity: number;
  /** Upward speed applied on jump, units/s. */
  jumpSpeed: number;
  /** Pitch clamp in degrees, applied as `[-maxPitchDeg, +maxPitchDeg]`. */
  maxPitchDeg: number;
}

/**
 * Movement tunables for a controllable FPS character.
 *
 * There is deliberately **no** look-sensitivity field: the harness `aim`/`look` DSL already
 * emits `InputFrame.look` deltas in **degrees**, and the look system integrates them 1:1 so
 * that `aim 90 0` lands exactly on yaw 90°. A sensitivity multiplier here would silently break
 * every absolute `aim` in a script (see ADR-0004 and the handoff notes).
 */
export const FpsController: ComponentType<FpsControllerData> = defineComponent<FpsControllerData>({
  id: 'FpsController',
  defaults: () => ({ moveSpeed: 6, gravity: 24, jumpSpeed: 8, maxPitchDeg: 89 }),
});

/** Data of {@link LookState}: the accumulated look orientation, in degrees. */
export interface LookStateData {
  /** Yaw (turn) in degrees. 0 faces +Z; increasing yaw turns toward +X. */
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
  /** Damage applied to the first entity hit that has `Health`. */
  damage: number;
  /** Minimum ticks between shots. */
  cooldownTicks: number;
  /** Ticks remaining until the weapon can fire again. */
  cooldownRemaining: number;
}

/** A hitscan weapon resolved by casting a ray from the camera eye along the look direction. */
export const Hitscan: ComponentType<HitscanData> = defineComponent<HitscanData>({
  id: 'Hitscan',
  defaults: () => ({ range: 100, damage: 25, cooldownTicks: 12, cooldownRemaining: 0 }),
});

/** Data of {@link HitBox}: an axis-aligned box a hitscan ray can strike. */
export interface HitBoxData {
  /** Half-extents of the box, world units. */
  half: Vec3;
  /** Offset of the box centre from the entity's `Transform.position`. */
  offset: Vec3;
}

/**
 * A shootable axis-aligned box. Any entity a ray should be able to hit — the wall panel button,
 * the security grunt — carries one. Distinct from {@link CapsuleBody} (which is the mover) and
 * from a `Trigger` (which is volume-overlap detection, not ray intersection).
 */
export const HitBox: ComponentType<HitBoxData> = defineComponent<HitBoxData>({
  id: 'HitBox',
  defaults: () => ({ half: { x: 0.5, y: 0.5, z: 0.5 }, offset: { x: 0, y: 0, z: 0 } }),
});

/** All component types this mode contributes to the registry. */
export const FPS_COMPONENTS: readonly ComponentType<unknown>[] = [
  CapsuleBody,
  FpsController,
  LookState,
  FpsCamera,
  Hitscan,
  HitBox,
] as readonly ComponentType<unknown>[];
