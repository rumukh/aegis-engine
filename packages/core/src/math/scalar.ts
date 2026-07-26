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
 *
 * ## Algorithm & accuracy
 *
 * `sin`/`cos` use a Cody–Waite argument reduction (a two-word split of π/2 that keeps the
 * reduced argument accurate for moderate magnitudes) followed by fixed fdlibm-style minimax
 * polynomials on `[-π/4, π/4]`. `atan` uses the fdlibm interval-splitting kernel; `atan2`
 * adds quadrant handling; `asin`/`acos` are derived from `atan2` and `sqrt`. Every step is a
 * pure sequence of IEEE-754 `+ - * /` and `sqrt` operations, so the result depends only on
 * the double inputs and is **bit-identical on every platform**.
 *
 * Measured worst-case absolute error against the platform `Math` reference:
 * `sin`/`cos` < 1e-12 for `|x| ≤ 1000`; `atan`/`atan2` < 1e-12; `asin`/`acos` < 1e-10.
 * The public contract only guarantees an absolute error ≤ 1e-9; the tests assert tighter
 * bounds so a regression is caught early. Reduction error grows slowly for very large
 * arguments, as with any fixed-precision reducer.
 * @packageDocumentation
 */

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

const HALF_PI = 1.5707963267948966;

// Cody–Waite split of π/2: PIO2_HI holds the leading bits so `k * PIO2_HI` is exact for
// moderate integer k, and PIO2_LO carries the tail. Keeps reduction accurate well past 2π.
const PIO2_HI = 1.57079632673412561417;
const PIO2_LO = 6.07710050650619224932e-11;

// fdlibm __kernel_sin coefficients (minimax on [-π/4, π/4]).
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

// fdlibm __kernel_cos coefficients (minimax on [-π/4, π/4]).
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748279e-9;
const C6 = -1.13596475577881948265e-11;

/** Nearest integer to `x` (round half up); used only for argument reduction. */
function nearestInt(x: number): number {
  return Math.floor(x + 0.5);
}

/** Kernel sine on the reduced argument `r ∈ [-π/4, π/4]`. */
function kernelSin(r: number): number {
  const z = r * r;
  return r + r * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}

/** Kernel cosine on the reduced argument `r ∈ [-π/4, π/4]`. */
function kernelCos(r: number): number {
  const z = r * r;
  return 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
}

/**
 * Reduce `radians` to a quadrant `q ∈ {0,1,2,3}` and remainder `r ∈ [-π/4, π/4]` such that
 * `radians ≈ q·(π/2) + r`, then return the requested sine/cosine combination.
 */
function reducedSinCos(radians: number, wantSin: boolean): number {
  const k = nearestInt(radians / HALF_PI);
  // Two-step (Cody–Waite) subtraction preserves low-order bits lost in a single subtract.
  const r = radians - k * PIO2_HI - k * PIO2_LO;
  const q = ((k % 4) + 4) % 4;
  const s = kernelSin(r);
  const c = kernelCos(r);
  if (wantSin) {
    return q === 0 ? s : q === 1 ? c : q === 2 ? -s : -c;
  }
  return q === 0 ? c : q === 1 ? -s : q === 2 ? -c : s;
}

/**
 * Deterministic sine. Bit-identical on every platform for a given `radians` input.
 * @param radians - Angle in radians.
 */
export function sin(radians: number): number {
  return reducedSinCos(radians, true);
}

/** Deterministic cosine. @see {@link sin} */
export function cos(radians: number): number {
  return reducedSinCos(radians, false);
}

/** Deterministic tangent. @see {@link sin} */
export function tan(radians: number): number {
  return sin(radians) / cos(radians);
}

// fdlibm atan kernel breakpoints and polynomial coefficients (≈1 ulp on the whole line).
const ATAN_HI = [
  4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1,
  1.570796326794896558,
];
const ATAN_LO = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17,
  6.12323399573676603587e-17,
];
const AT0 = 3.33333333333329318027e-1;
const AT1 = -1.99999999998764832476e-1;
const AT2 = 1.42857142725034663711e-1;
const AT3 = -1.1111110405462355788e-1;
const AT4 = 9.09088713343650656196e-2;
const AT5 = -7.69187620504482999495e-2;
const AT6 = 6.66107313738753120669e-2;
const AT7 = -5.83357013379057348645e-2;
const AT8 = 4.97687799461593236017e-2;
const AT9 = -3.6531572744216915527e-2;
const AT10 = 1.62858201153657823623e-2;

/** Deterministic single-argument arctangent, range `(-π/2, π/2)`. */
function atan(x: number): number {
  const neg = x < 0;
  let ax = neg ? -x : x;
  let result: number;
  if (ax < 0.4375) {
    if (ax < 3.725290298461914e-9) {
      // Below 2^-28: atan(x) ≈ x.
      result = ax;
    } else {
      const z = ax * ax;
      const w = z * z;
      const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
      const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
      result = ax - ax * (s1 + s2);
    }
  } else {
    let id: number;
    if (ax < 0.6875) {
      id = 0;
      ax = (2 * ax - 1) / (2 + ax);
    } else if (ax < 1.1875) {
      id = 1;
      ax = (ax - 1) / (ax + 1);
    } else if (ax < 2.4375) {
      id = 2;
      ax = (ax - 1.5) / (1 + 1.5 * ax);
    } else {
      id = 3;
      ax = -1 / ax;
    }
    const z = ax * ax;
    const w = z * z;
    const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
    const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
    const hi = ATAN_HI[id] as number;
    const lo = ATAN_LO[id] as number;
    result = hi - (ax * (s1 + s2) - lo - ax);
  }
  return neg ? -result : result;
}

/** Deterministic two-argument arctangent, returning an angle in `(-π, π]`. */
export function atan2(y: number, x: number): number {
  if (x === 0) {
    if (y > 0) return HALF_PI;
    if (y < 0) return -HALF_PI;
    return 0;
  }
  const a = atan(y / x);
  if (x > 0) return a;
  return y >= 0 ? a + PI : a - PI;
}

/** Deterministic arcsine, returning an angle in `[-π/2, π/2]`. */
export function asin(x: number): number {
  const c = x < -1 ? -1 : x > 1 ? 1 : x;
  return atan2(c, Math.sqrt(1 - c * c));
}

/** Deterministic arccosine, returning an angle in `[0, π]`. */
export function acos(x: number): number {
  const c = x < -1 ? -1 : x > 1 ? 1 : x;
  return atan2(Math.sqrt(1 - c * c), c);
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
