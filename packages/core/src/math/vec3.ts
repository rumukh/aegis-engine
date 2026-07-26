/**
 * 3D vector and quaternion types with pure, deterministic operations. Used by the fps mode,
 * the 3D transform, and the render adapter. Kept intentionally small — this is not a full
 * linear-algebra library.
 * @packageDocumentation
 */
import { notImplemented } from '../util.js';

/** A 3D vector. Plain data so it serialises directly into a world snapshot. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A quaternion `(x, y, z, w)` representing an orientation. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Construct a {@link Vec3}. */
export function vec3(x: number = 0, y: number = 0, z: number = 0): Vec3 {
  return { x, y, z };
}

/** The zero vector `(0, 0, 0)`. Do not mutate. */
export const VEC3_ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });

/** The identity quaternion (no rotation). Do not mutate. */
export const QUAT_IDENTITY: Readonly<Quat> = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

/** `a + b`. */
export function add3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/** `a - b`. */
export function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** `v * s`. */
export function scale3(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

/** Dot product `a · b`. */
export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Cross product `a × b`. */
export function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Squared length. */
export function lengthSq3(v: Vec3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

/** Euclidean length (uses deterministic sqrt). */
export function length3(v: Vec3): number {
  return notImplemented('vec3.length3');
}

/** Unit vector in the direction of `v`, or `(0,0,0)` if zero-length. */
export function normalize3(v: Vec3): Vec3 {
  return notImplemented('vec3.normalize3');
}

/** Build a quaternion from yaw/pitch/roll (radians), in Aegis's fixed rotation order. */
export function quatFromEuler(yaw: number, pitch: number, roll: number): Quat {
  return notImplemented('vec3.quatFromEuler');
}

/** Rotate `v` by quaternion `q`. */
export function rotateByQuat(v: Vec3, q: Quat): Vec3 {
  return notImplemented('vec3.rotateByQuat');
}
