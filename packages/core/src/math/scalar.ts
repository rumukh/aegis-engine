/**
 * Deterministic scalar math.
 *
 * The platform `Math` transcendentals (`sin`, `cos`, `atan2`, `pow`, `exp`, `log`, …)
 * are **not** guaranteed to be bit-identical across operating systems and CPUs, because
 * they delegate to the host libm. Aegis therefore forbids them in simulation code
 * (see the ESLint config and docs/adr/0001-determinism-strategy.md) and provides its own
 * implementations here, computed with a fixed polynomial/reduction so the result depends
 * only on the IEEE-754 double inputs — never on the platform.
 *
 * `sqrt`, `abs`, `floor`, `ceil`, `round`, `min`, `max` are IEEE-754 correctly-rounded and
 * therefore safe to build on directly; they are re-exposed here so simulation code has a
 * single import surface and never reaches for the global `Math`.
 *
 * All functions operate on `number` (float64). See ADR-0001 for why fixed-point was rejected.
 * @packageDocumentation
 */
import { notImplemented } from '../util.js';

/** The circle constant π. */
export const PI = 3.141592653589793;
/** τ = 2π. */
export const TAU = 6.283185307179586;
/** Radians per degree. */
export const DEG2RAD = PI / 180;
/** Degrees per radian. */
export const RAD2DEG = 180 / PI;
/** Smallest difference treated as "equal" by {@link approxEqual}. */
export const EPSILON = 1e-9;

/**
 * Deterministic sine. Bit-identical on every platform for a given `radians` input.
 * @param radians - Angle in radians.
 */
export function sin(radians: number): number {
  return notImplemented(`math.sin(${radians})`);
}

/** Deterministic cosine. @see {@link sin} */
export function cos(radians: number): number {
  return notImplemented(`math.cos(${radians})`);
}

/** Deterministic tangent. @see {@link sin} */
export function tan(radians: number): number {
  return notImplemented(`math.tan(${radians})`);
}

/** Deterministic two-argument arctangent, returning an angle in `(-π, π]`. */
export function atan2(y: number, x: number): number {
  return notImplemented(`math.atan2(${y}, ${x})`);
}

/** Deterministic arcsine, returning an angle in `[-π/2, π/2]`. */
export function asin(x: number): number {
  return notImplemented(`math.asin(${x})`);
}

/** Deterministic arccosine, returning an angle in `[0, π]`. */
export function acos(x: number): number {
  return notImplemented(`math.acos(${x})`);
}

/**
 * IEEE-754 correctly-rounded square root. Deterministic across platforms, so this is a
 * thin, allowed wrapper.
 */
export function sqrt(x: number): number {
  return Math.sqrt(x);
}

/** Absolute value. */
export function abs(x: number): number {
  return Math.abs(x);
}

/** Sign of `x`: -1, 0, or 1. */
export function sign(x: number): number {
  return Math.sign(x);
}

/** Largest integer `<= x`. */
export function floor(x: number): number {
  return Math.floor(x);
}

/** Smallest integer `>= x`. */
export function ceil(x: number): number {
  return Math.ceil(x);
}

/** Round half away from zero — a fixed rule, unlike some libm variants. */
export function round(x: number): number {
  return Math.floor(x + 0.5);
}

/** Minimum of two numbers. */
export function min(a: number, b: number): number {
  return a < b ? a : b;
}

/** Maximum of two numbers. */
export function max(a: number, b: number): number {
  return a > b ? a : b;
}

/**
 * Clamp `x` into the inclusive range `[lo, hi]`.
 * @param x - Value to clamp.
 * @param lo - Lower bound.
 * @param hi - Upper bound.
 */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Linear interpolation. Returns `a` at `t=0` and `b` at `t=1`.
 * @param a - Start value.
 * @param b - End value.
 * @param t - Interpolant, not clamped.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Whether two numbers are within {@link EPSILON} (or `tolerance`) of each other. */
export function approxEqual(a: number, b: number, tolerance: number = EPSILON): boolean {
  return abs(a - b) <= tolerance;
}
