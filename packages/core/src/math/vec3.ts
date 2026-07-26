/**
 * 3D vector and quaternion types with pure, deterministic operations. Used by the fps mode,
 * the 3D transform, and the render adapter. Kept intentionally small — this is not a full
 * linear-algebra library.
 * @packageDocumentation
 */
import { cos, sin, sqrt } from './scalar.js';

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
  return sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** Unit vector in the direction of `v`, or `(0,0,0)` if zero-length. */
export function normalize3(v: Vec3): Vec3 {
  const len = sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** Hamilton product `a ⊗ b` of two quaternions. */
export function mulQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/**
 * Build a quaternion from yaw/pitch/roll (radians), in Aegis's fixed rotation order:
 * yaw about `+Y`, then pitch about `+X`, then roll about `+Z` (composed `qYaw ⊗ qPitch ⊗
 * qRoll`). The result is a unit quaternion.
 */
export function quatFromEuler(yaw: number, pitch: number, roll: number): Quat {
  const hy = yaw * 0.5;
  const hp = pitch * 0.5;
  const hr = roll * 0.5;
  const qy: Quat = { x: 0, y: sin(hy), z: 0, w: cos(hy) };
  const qp: Quat = { x: sin(hp), y: 0, z: 0, w: cos(hp) };
  const qr: Quat = { x: 0, y: 0, z: sin(hr), w: cos(hr) };
  return mulQuat(mulQuat(qy, qp), qr);
}

/** Rotate `v` by quaternion `q`. */
export function rotateByQuat(v: Vec3, q: Quat): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
