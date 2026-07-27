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
 * ## Domain of `sin`/`cos`/`tan`
 *
 * Two-word Cody–Waite reduction is only exact while `k · PIO2_HI` is exact, i.e. up to
 * `k ≈ 2^22`. Past that the reduction **collapses**, and it collapses quietly: the measured
 * absolute error is 1.1e-16 at `|x| ≤ 1e6`, but 1.9e-9 at `|x| ≈ 1.9e7` (already outside the
 * stated contract), 6.2e-2 at 1e15, and beyond `|x| ≈ 1.2e17` the result stops being a sine at
 * all (`sin(1e18)` computed naively is `2.8e16`; `sin(1e150)` is `-Infinity`). A silently wrong
 * `sin` feeds straight into world state, and `±Infinity` there is invisible to a JSON-laundering
 * hash — which is exactly the failure this module exists to prevent.
 *
 * `sin`/`cos`/`tan` therefore **enforce** a documented domain of `|x| ≤ 2^20·π`
 * ({@link SIN_DOMAIN_MAX} ≈ 3.294e6 radians ≈ 524288 full turns) and throw a
 * {@link RangeError} outside it, including for `NaN` and `±Infinity`. Inside the domain the
 * measured worst-case absolute error against the platform reference is **2.2e-16** for both
 * `sin` and `cos` — four orders tighter than the ≤ 1e-9 public contract. A game that reaches
 * the limit has an accumulator bug; failing loudly at the source beats poisoning the state hash
 * half a second later. Wrap the angle yourself ({@link wrapAngle}) if you genuinely need an
 * unbounded input.
 *
 * ## Exact symmetries
 *
 * `sin(-x) === -sin(x)` and `cos(-x) === cos(x)` hold **exactly**, for every accepted input,
 * not merely to within a tolerance — with one stated exception: `sin(-0)` is `+0`, not `-0`, so
 * the identity is exact under `===` but not under `Object.is`. Signed zero is unobservable in
 * world state anyway, because every write boundary normalises `-0` to `0`.
 *
 * This is a property of the tie rule in the argument reduction (see `nearestInt`) and is
 * asserted at the half-quadrant boundaries where it used to fail, not only at random samples —
 * a random sweep can never reach an exact tie, so it was green against an implementation that
 * was not odd.
 *
 * `atan`/`atan2`/`asin`/`acos` have no domain limit; `atan2` implements the IEEE-754 special
 * cases for zeros and infinities.
 *
 * Measured worst-case absolute error against the platform `Math` reference:
 * `sin`/`cos` < 1e-15 across the whole supported domain; `atan`/`atan2` < 1e-12;
 * `asin`/`acos` < 1e-10. The public contract guarantees an absolute error ≤ 1e-9; the tests
 * assert tighter bounds so a regression is caught early, and pin literal expected values so a
 * changed coefficient cannot pass.
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

/**
 * Largest `|radians|` that {@link sin}, {@link cos} and {@link tan} accept.
 *
 * `2^20·π` ≈ 3.294e6 radians ≈ 524288 full turns. Inside this range the Cody–Waite reduction
 * is exact enough for a measured worst-case absolute error of 2.2e-16; outside it the
 * reduction degrades without warning, so the functions throw instead. See the module doc.
 */
export const SIN_DOMAIN_MAX = 3294198.658330571; // 2 ** 20 * PI

const HALF_PI = 1.5707963267948966;
const QUARTER_PI = 0.7853981633974483;
const THREE_QUARTER_PI = 2.356194490192345;

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

/**
 * Nearest integer to `x`, ties **away from zero**; used **only** for argument reduction.
 *
 * The tie rule is not free choice, despite any consistent rule reducing correctly. It used to
 * be `Math.floor(x + 0.5)` — round half *up* — and that made `sin` measurably not odd:
 * `sin(3π/4)` and `-sin(-3π/4)` differ by 1 ulp, because `x/(π/2)` lands on `±1.5` and half-up
 * sends `1.5 → 2` but `-1.5 → -1`, so the two arguments are reduced through *different*
 * quadrants. A tie rule symmetric about zero gives `k(-x) === -k(x)` at every tie, and since
 * the reduction, the kernels (odd in `r` for sine, even for cosine) and the quadrant table are
 * all sign-symmetric, `sin(-x) === -sin(x)` and `cos(-x) === cos(x)` become **exact** for every
 * input rather than for almost every input.
 *
 * Half-up also double-rounds: `0.49999999999999994 + 0.5` is exactly `1` in float64, so the old
 * form returned `1` for an argument strictly below one half. {@link round} is exact for every
 * finite double and carries the away-from-zero rule, so it is reused rather than re-derived.
 *
 * Both differences are confined to exact ties and to that one double, so the results this
 * changes are the ones that were asymmetric; every other `sin`/`cos` value — and therefore
 * every stored replay that does not land exactly on a half-quadrant boundary — is bit-identical.
 */
function nearestInt(x: number): number {
  return round(x);
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
 *
 * @throws RangeError when `|radians| > {@link SIN_DOMAIN_MAX}`, or when `radians` is `NaN` or
 * `±Infinity` — outside that range two-word Cody–Waite reduction silently returns a value that
 * is not a sine at all (see the module doc).
 */
function reducedSinCos(radians: number, wantSin: boolean, fn: string): number {
  // `!(|x| <= MAX)` rather than `>` so NaN is rejected too.
  if (!(radians >= -SIN_DOMAIN_MAX && radians <= SIN_DOMAIN_MAX)) {
    throw new RangeError(
      `[aegis] ${fn}(${String(radians)}): argument is outside the supported domain ` +
        `|x| <= ${SIN_DOMAIN_MAX} (2^20·π). Argument reduction is not accurate beyond it, so ` +
        `the result would be silently wrong. Wrap the angle with wrapAngle() first, or fix the ` +
        `accumulator that produced this value.`,
    );
  }
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
 * @param radians - Angle in radians. Must satisfy `|radians| <= {@link SIN_DOMAIN_MAX}`.
 * @throws RangeError outside the supported domain (including `NaN`/`±Infinity`).
 */
export function sin(radians: number): number {
  return reducedSinCos(radians, true, 'sin');
}

/** Deterministic cosine. @see {@link sin} */
export function cos(radians: number): number {
  return reducedSinCos(radians, false, 'cos');
}

/** Deterministic tangent. @see {@link sin} */
export function tan(radians: number): number {
  return sin(radians) / cos(radians);
}

/**
 * Wrap an angle into `(-π, π]` using exact IEEE-754 arithmetic, so an unbounded accumulator can
 * be brought back inside the {@link sin} domain.
 *
 * ## Accuracy, and why the domain is what it is
 *
 * The wrapped value is `radians - floor(radians/τ)·τ`, and the subtracted product carries the
 * rounding error of a number the size of `radians`. The error therefore grows **linearly with
 * the input**, at roughly `|radians|·2⁻⁵²`. Measured against a two-word reduction of τ:
 *
 * | `\|radians\|` | error of the wrapped angle |
 * | ------------- | -------------------------- |
 * | 1e6           | 5.0e-11 rad                |
 * | 1e9           | 5.1e-8 rad                 |
 * | 1e12          | 3.2e-5 rad                 |
 * | 1e15          | 9.3e-3 rad (0.53°)         |
 * | 9e15          | 8.3e-1 rad (48°)           |
 *
 * The limit used to be 2^53 ≈ 9.0e15 on the stated rationale that "beyond 2^53 a double has no
 * sub-turn information". That rationale does not survive measurement in either direction: a
 * double still resolves ~3 points per turn at 2^53, yet the value this function returns there
 * is wrong by 48°. Silently returning an angle that is off by 48° is exactly the failure mode
 * `sin`'s own domain check exists to prevent, one function upstream.
 *
 * So the limit is `2^40` ({@link MAX_WRAPPABLE_ANGLE} ≈ 1.1e12) — about four orders of
 * magnitude tighter — chosen from the measurement rather than from an intuition: at 2^40 the
 * *input's* own ulp is 2^-12 ≈ 2.4e-4 rad, so the accumulator still pins its angle to better
 * than a hundredth of a degree and the wrapped result is good to the same. Past it the input
 * has already lost that much, and no wrapper can recover what was never there — refusing is the
 * only honest answer.
 *
 * @param radians - Angle in radians.
 * @throws RangeError when `radians` is `NaN`, `±Infinity`, or `|radians| >= 2^40`.
 */
export function wrapAngle(radians: number): number {
  // `!(|x| < MAX)` rather than `>=` so NaN is rejected too. Strictly less than the limit, which
  // is what both this function's doc and its own error message have always claimed; the
  // comparison was `<=`, so `wrapAngle(2^53)` returned a value while the contract said it threw.
  if (!(radians > -MAX_WRAPPABLE_ANGLE && radians < MAX_WRAPPABLE_ANGLE)) {
    throw new RangeError(
      `[aegis] wrapAngle(${String(radians)}): |x| must be < 2^40 (${MAX_WRAPPABLE_ANGLE}) for ` +
        `the wrapped angle to be accurate to better than 2.4e-4 rad; this value cannot be ` +
        `wrapped to a meaningful angle. Wrap at the point the angle is stored, not at the point ` +
        `it is used, so the accumulator never grows this large (ADR-0001).`,
    );
  }
  const turns = radians / TAU;
  const wrapped = radians - Math.floor(turns) * TAU; // [0, τ)
  return wrapped > PI ? wrapped - TAU : wrapped;
}

/**
 * Largest `|x|` {@link wrapAngle} accepts, exclusive: `2^40`.
 *
 * Beyond it the input's own ulp exceeds ~2.4e-4 radians, so the accumulator has already lost
 * the angle to worse than a hundredth of a degree. See {@link wrapAngle} for the measurements.
 */
const MAX_WRAPPABLE_ANGLE = 1099511627776; // 2 ** 40

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

/**
 * Deterministic two-argument arctangent, returning an angle in `[-π, π]`.
 *
 * Implements the IEEE-754 / C99 `atan2` special cases so signed zeros and infinities give the
 * mathematically correct quadrant rather than falling through the finite path:
 * `atan2(±0, +0) = ±0`, `atan2(±0, -0) = ±π`, `atan2(±y, -∞) = ±π`, `atan2(±∞, ∓∞) = ±3π/4`
 * or `±π/4`, and `NaN` propagates.
 */
export function atan2(y: number, x: number): number {
  if (Number.isNaN(y) || Number.isNaN(x)) return NaN;

  // Sign of y, treating -0 as negative — the whole point of the signed-zero cases.
  const ySign = y < 0 || Object.is(y, -0) ? -1 : 1;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    if (!Number.isFinite(y)) {
      // y = ±∞: x = ±∞ splits the quadrant diagonally, finite x collapses to ±π/2.
      if (!Number.isFinite(x)) return ySign * (x > 0 ? QUARTER_PI : THREE_QUARTER_PI);
      return ySign * HALF_PI;
    }
    // Finite y, x = ±∞.
    return x > 0 ? ySign * 0 : ySign * PI;
  }

  if (x === 0) {
    if (y !== 0) return ySign * HALF_PI;
    // y is ±0: the result carries y's sign and depends on the sign of the zero x.
    return Object.is(x, -0) ? ySign * PI : ySign * 0;
  }
  if (y === 0) return x > 0 ? ySign * 0 : ySign * PI;

  const a = atan(y / x);
  if (x > 0) return a;
  return ySign > 0 ? a + PI : a - PI;
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
 * Square root. ECMA-262 classifies `Math.sqrt` as implementation-approximated, but every
 * mainstream engine delegates to the hardware `sqrtsd`/`fsqrt` instruction, which IEEE-754
 * requires to be correctly rounded — so in practice it is bit-identical everywhere and this
 * thin wrapper is an allowed exception to the "own our transcendentals" rule (ADR-0001).
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

/**
 * Round half away from zero: `round(2.5) === 3`, `round(-2.5) === -3`.
 *
 * Deliberately **not** `Math.floor(x + 0.5)`: that is half-*up* (it rounds `-2.5` to `-2`) and
 * it double-rounds — `0.49999999999999994 + 0.5` is exactly `1` in float64, so the naive form
 * returns `1` for a value strictly below one half. Splitting off the integer part with
 * `Math.trunc` and comparing the remainder is exact for every finite double, and the remainder
 * carries the sign so the away-from-zero tie rule falls out directly.
 */
export function round(x: number): number {
  const t = Math.trunc(x); // toward zero, so `frac` carries x's sign
  const frac = x - t; // exact for every finite double
  if (frac > 0.5 || frac === 0.5) return t + 1;
  if (frac < -0.5 || frac === -0.5) return t - 1;
  return t;
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
