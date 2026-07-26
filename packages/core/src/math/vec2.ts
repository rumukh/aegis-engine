/**
 * 2D vector type and pure, allocation-explicit operations. Used by the platformer and
 * iso modes and by the 2D semantic frame. All operations are deterministic.
 * @packageDocumentation
 */
import { notImplemented } from '../util.js';

/** A 2D vector. Plain data so it serialises directly into a world snapshot. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Construct a {@link Vec2}. */
export function vec2(x: number = 0, y: number = 0): Vec2 {
  return { x, y };
}

/** The zero vector `(0, 0)`. Do not mutate. */
export const VEC2_ZERO: Readonly<Vec2> = Object.freeze({ x: 0, y: 0 });

/** `a + b`. */
export function add2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

/** `a - b`. */
export function sub2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

/** `v * s`. */
export function scale2(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s };
}

/** Dot product `a · b`. */
export function dot2(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** Squared length. Cheaper than {@link length2} when only comparing magnitudes. */
export function lengthSq2(v: Vec2): number {
  return v.x * v.x + v.y * v.y;
}

/** Euclidean length (uses deterministic sqrt). */
export function length2(v: Vec2): number {
  return notImplemented('vec2.length2');
}

/** Unit vector in the direction of `v`, or `(0,0)` if `v` is zero-length. */
export function normalize2(v: Vec2): Vec2 {
  return notImplemented('vec2.normalize2');
}
