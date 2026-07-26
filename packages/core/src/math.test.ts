import { describe, it, expect } from 'vitest';
import {
  PI,
  TAU,
  SIN_DOMAIN_MAX,
  sin,
  cos,
  tan,
  atan2,
  asin,
  acos,
  sqrt,
  round,
  wrapAngle,
  clamp,
  lerp,
  approxEqual,
} from './math/scalar.js';
import { add2, sub2, scale2, dot2, length2, normalize2 } from './math/vec2.js';
import {
  add3,
  scale3,
  dot3,
  length3,
  normalize3,
  quatFromEuler,
  rotateByQuat,
  mulQuat,
} from './math/vec3.js';

const SQRT2_2 = 0.7071067811865476;

describe('deterministic scalar transcendentals — accuracy against known values', () => {
  it('sin/cos at cardinal angles', () => {
    expect(sin(0)).toBeCloseTo(0, 12);
    expect(cos(0)).toBeCloseTo(1, 12);
    expect(sin(PI / 6)).toBeCloseTo(0.5, 12);
    expect(cos(PI / 3)).toBeCloseTo(0.5, 12);
    expect(sin(PI / 4)).toBeCloseTo(SQRT2_2, 12);
    expect(cos(PI / 4)).toBeCloseTo(SQRT2_2, 12);
    expect(sin(PI / 2)).toBeCloseTo(1, 12);
    expect(cos(PI / 2)).toBeCloseTo(0, 12);
    expect(sin(PI)).toBeCloseTo(0, 12);
    expect(cos(PI)).toBeCloseTo(-1, 12);
  });

  it('tan at π/4 is 1', () => {
    expect(tan(PI / 4)).toBeCloseTo(1, 12);
  });

  it('atan2 covers all four quadrants', () => {
    expect(atan2(0, 1)).toBeCloseTo(0, 12);
    expect(atan2(1, 1)).toBeCloseTo(PI / 4, 12);
    expect(atan2(1, 0)).toBeCloseTo(PI / 2, 12);
    expect(atan2(1, -1)).toBeCloseTo((3 * PI) / 4, 12);
    expect(atan2(0, -1)).toBeCloseTo(PI, 12);
    expect(atan2(-1, 0)).toBeCloseTo(-PI / 2, 12);
    expect(atan2(-1, -1)).toBeCloseTo((-3 * PI) / 4, 12);
  });

  it('asin/acos at known points', () => {
    expect(asin(0)).toBeCloseTo(0, 10);
    expect(asin(0.5)).toBeCloseTo(PI / 6, 10);
    expect(asin(1)).toBeCloseTo(PI / 2, 10);
    expect(acos(1)).toBeCloseTo(0, 10);
    expect(acos(0)).toBeCloseTo(PI / 2, 10);
    expect(acos(-1)).toBeCloseTo(PI, 10);
  });

  it('respects the documented Pythagorean identity across a sweep', () => {
    for (let i = 0; i < 200; i++) {
      const x = -20 + i * 0.2;
      const s = sin(x);
      const c = cos(x);
      expect(Math.abs(s * s + c * c - 1)).toBeLessThan(1e-9);
    }
  });

  it('argument reduction stays accurate at large magnitudes (sin(x) == sin(x - k·τ))', () => {
    for (let i = 1; i <= 50; i++) {
      const x = i * 0.37;
      // Add many full turns; a correct reducer returns (nearly) the same value.
      const shifted = x + TAU * 25;
      expect(Math.abs(sin(x) - sin(shifted))).toBeLessThan(1e-9);
      expect(Math.abs(cos(x) - cos(shifted))).toBeLessThan(1e-9);
    }
  });

  it('argument reduction still holds at the very edge of the supported domain', () => {
    // The old test only reached |x| ≈ 175 — nowhere near where two-word Cody–Waite degrades.
    // Walk right up to SIN_DOMAIN_MAX, where a weaker reducer is visibly wrong.
    for (let i = 0; i < 200; i++) {
      const base = 0.31 + i * 0.017;
      const turns = Math.floor((SIN_DOMAIN_MAX - base) / TAU);
      const far = base + TAU * turns;
      expect(Math.abs(far)).toBeLessThanOrEqual(SIN_DOMAIN_MAX);
      expect(Math.abs(sin(far) - sin(base))).toBeLessThan(1e-9);
      expect(Math.abs(cos(far) - cos(base))).toBeLessThan(1e-9);
    }
  });
});

describe('sin/cos domain enforcement (M1)', () => {
  it('SIN_DOMAIN_MAX is exactly 2^20·π', () => {
    expect(SIN_DOMAIN_MAX).toBe(2 ** 20 * PI);
  });

  it('accepts the whole documented domain and stays within the ≤1e-9 contract there', () => {
    expect(() => sin(SIN_DOMAIN_MAX)).not.toThrow();
    expect(() => cos(-SIN_DOMAIN_MAX)).not.toThrow();
    let worst = 0;
    for (let i = 0; i <= 20000; i++) {
      const x = -SIN_DOMAIN_MAX + (i / 20000) * 2 * SIN_DOMAIN_MAX;
      worst = Math.max(worst, Math.abs(sin(x) - Math.sin(x)), Math.abs(cos(x) - Math.cos(x)));
    }
    expect(worst).toBeLessThan(1e-15);
  });

  it('throws instead of silently returning garbage outside the domain', () => {
    // Pre-fix these returned: 1.86e-9 error at 1.93e7, 6.2e-2 at 1e15,
    // sin(1e18) = 28079456485119104 (|sin| > 1!), and sin(1e150) = -Infinity.
    for (const x of [1e7, 1e9, 1e15, 1e17, 1e18, 1e150, -1e7, -1e18]) {
      expect(() => sin(x)).toThrow(RangeError);
      expect(() => cos(x)).toThrow(RangeError);
      expect(() => tan(x)).toThrow(RangeError);
    }
  });

  it('rejects NaN and ±Infinity rather than producing non-finite state', () => {
    for (const x of [NaN, Infinity, -Infinity]) {
      expect(() => sin(x)).toThrow(RangeError);
      expect(() => cos(x)).toThrow(RangeError);
    }
  });

  it('never returns a value outside [-1, 1] anywhere it accepts input', () => {
    for (let i = 0; i <= 20000; i++) {
      const x = -SIN_DOMAIN_MAX + (i / 20000) * 2 * SIN_DOMAIN_MAX;
      const s = sin(x);
      const c = cos(x);
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
      expect(c).toBeGreaterThanOrEqual(-1);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it('wrapAngle brings an out-of-domain accumulator back in', () => {
    for (const x of [1e7, 1e9, 1e15, -1e12]) {
      const w = wrapAngle(x);
      expect(Math.abs(w)).toBeLessThanOrEqual(PI);
      expect(() => sin(w)).not.toThrow();
    }
    expect(wrapAngle(PI / 3)).toBeCloseTo(PI / 3, 12);
    expect(wrapAngle(TAU + 1)).toBeCloseTo(1, 12);
    // Beyond 2^53 the sub-turn information is simply gone; refuse rather than fabricate.
    expect(() => wrapAngle(1e150)).toThrow(RangeError);
    expect(() => wrapAngle(NaN)).toThrow(RangeError);
  });
});

describe('round — half away from zero, no double rounding', () => {
  it('rounds halves away from zero, not half-up', () => {
    // `Math.floor(x + 0.5)` returns -2 and -0 here; the documented rule is away from zero.
    expect(round(2.5)).toBe(3);
    expect(round(-2.5)).toBe(-3);
    expect(round(0.5)).toBe(1);
    expect(round(-0.5)).toBe(-1);
    expect(round(1.5)).toBe(2);
    expect(round(-1.5)).toBe(-2);
  });

  it('does not double-round the largest double below one half', () => {
    // 0.49999999999999994 + 0.5 === 1 exactly, so the naive form returned 1.
    expect(round(0.49999999999999994)).toBe(0);
    expect(round(-0.49999999999999994)).toBe(-0);
  });

  it('agrees with the ordinary cases and passes non-finite input through', () => {
    expect(round(2.4)).toBe(2);
    expect(round(-2.4)).toBe(-2);
    expect(round(-0.3)).toBe(-0); // sign-preserving, matching Math.round(-0.3)
    expect(round(1e300)).toBe(1e300);
    expect(round(Infinity)).toBe(Infinity);
    expect(round(-Infinity)).toBe(-Infinity);
    expect(Number.isNaN(round(NaN))).toBe(true);
  });
});

describe('atan2 — IEEE-754 zero and infinity cases', () => {
  it('handles infinite arguments the way the standard specifies', () => {
    // Pre-fix: atan2(Inf, Inf) was NaN (Inf/Inf), not π/4.
    expect(atan2(Infinity, Infinity)).toBe(PI / 4);
    expect(atan2(-Infinity, Infinity)).toBe(-PI / 4);
    expect(atan2(Infinity, -Infinity)).toBe(Math.atan2(Infinity, -Infinity));
    expect(atan2(-Infinity, -Infinity)).toBe(Math.atan2(-Infinity, -Infinity));
    expect(atan2(Infinity, 5)).toBe(PI / 2);
    expect(atan2(-Infinity, 5)).toBe(-PI / 2);
    expect(atan2(1, Infinity)).toBe(0);
    expect(atan2(1, -Infinity)).toBe(PI);
    expect(atan2(-1, -Infinity)).toBe(-PI);
  });

  it('handles signed zeros the way the standard specifies', () => {
    // Pre-fix: atan2(0, -0) was 0 (should be π) and atan2(-0, -1) was +π (should be -π).
    expect(atan2(0, -0)).toBe(PI);
    expect(atan2(-0, -0)).toBe(-PI);
    expect(atan2(-0, -1)).toBe(-PI);
    expect(atan2(0, -1)).toBe(PI);
    expect(atan2(0, 0)).toBe(0);
    expect(Object.is(atan2(-0, 1), -0)).toBe(true);
    expect(Object.is(atan2(-0, 0), -0)).toBe(true);
  });

  it('propagates NaN', () => {
    expect(Number.isNaN(atan2(NaN, 1))).toBe(true);
    expect(Number.isNaN(atan2(1, NaN))).toBe(true);
  });

  it('matches the platform reference bit-for-bit on every zero/infinity combination', () => {
    // Only the special cases are pinned bit-for-bit; the finite path is a 1-ulp approximation
    // by design (that is the whole point of owning our own atan), so it gets a tolerance.
    const edges = [0, -0, Infinity, -Infinity];
    for (const y of edges) {
      for (const x of [...edges, 1, -1, 2.5, -2.5]) {
        expect(Object.is(atan2(y, x), Math.atan2(y, x))).toBe(true);
      }
    }
    for (const y of [1, -1, 2.5, -2.5]) {
      for (const x of edges) {
        expect(Object.is(atan2(y, x), Math.atan2(y, x))).toBe(true);
      }
    }
    for (const y of [1, -1, 2.5, -2.5]) {
      for (const x of [1, -1, 2.5, -2.5]) {
        expect(Math.abs(atan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-12);
      }
    }
  });
});

describe('deterministic scalar transcendentals — pinned golden values', () => {
  // These literals ARE the cross-machine contract. They were produced by this implementation
  // and verified against the platform `Math` reference to the last bit; they are checked in so
  // that changing a coefficient, a reduction step, or the kernel evaluation order fails here
  // instead of silently invalidating every stored replay and every game's GOLDEN_HASH.
  //
  // Do NOT regenerate these from the implementation. A diff here is either an approved
  // algorithm change or a bug.
  const SIN_GOLDEN: readonly (readonly [number, number])[] = [
    [0.1, 0.09983341664682815],
    [1, 0.8414709848078965],
    [2.5, 0.5984721441039564],
    [PI / 5, 0.5877852522924731],
    [12.34, -0.22444221895185537],
    [-8.9, -0.5010208564578846],
    [1000.123, 0.8896308316731366],
    [-777, 0.8555511930921242],
  ];
  const COS_GOLDEN: readonly (readonly [number, number])[] = [
    [0.1, 0.9950041652780257],
    [1, 0.5403023058681398],
    [2.5, -0.8011436155469337],
    [PI / 5, 0.8090169943749473],
    [12.34, 0.9744873987650982],
    [-8.9, -0.8654352092411123],
    [1000.123, 0.45668039517430925],
    [-777, -0.5177182206554476],
  ];
  const ATAN2_GOLDEN: readonly (readonly [number, number, number])[] = [
    [1, 1.5, 0.5880026035475675],
    [-3.3, 1.5, -1.1441688336680205],
    [0.1, 1.5, 0.06656816377582381],
    [2.5, -1.5, 2.1112158270654806],
    [-2.5, -1.5, -2.1112158270654806],
  ];

  it('sin matches its pinned golden values exactly', () => {
    for (const [x, expected] of SIN_GOLDEN) expect(sin(x)).toBe(expected);
  });

  it('cos matches its pinned golden values exactly', () => {
    for (const [x, expected] of COS_GOLDEN) expect(cos(x)).toBe(expected);
  });

  it('atan2 matches its pinned golden values exactly', () => {
    for (const [y, x, expected] of ATAN2_GOLDEN) expect(atan2(y, x)).toBe(expected);
  });

  it('agrees with the platform Math reference well inside the documented contract', () => {
    // The pinned literals above are only trustworthy if they are also *correct*. Compare
    // against the host libm across the supported domain — a rotated quadrant table, a zeroed
    // coefficient or a broken reduction step all fail here even if someone regenerated the
    // literals from a broken build.
    for (let i = 0; i <= 4000; i++) {
      const x = -SIN_DOMAIN_MAX + (i / 4000) * 2 * SIN_DOMAIN_MAX;
      expect(Math.abs(sin(x) - Math.sin(x))).toBeLessThan(1e-9);
      expect(Math.abs(cos(x) - Math.cos(x))).toBeLessThan(1e-9);
      const a = -1000 + i * 0.5;
      expect(Math.abs(atan2(a, 1.5) - Math.atan2(a, 1.5))).toBeLessThan(1e-9);
    }
  });
});

describe('scalar helpers', () => {
  it('clamp/lerp/approxEqual/sqrt', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(approxEqual(1, 1 + 1e-12)).toBe(true);
    expect(approxEqual(1, 1.1)).toBe(false);
    expect(sqrt(16)).toBe(4);
  });
});

describe('vec2', () => {
  it('arithmetic and normalization', () => {
    expect(add2({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
    expect(sub2({ x: 3, y: 4 }, { x: 1, y: 2 })).toEqual({ x: 2, y: 2 });
    expect(scale2({ x: 1, y: 2 }, 3)).toEqual({ x: 3, y: 6 });
    expect(dot2({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(0);
    expect(length2({ x: 3, y: 4 })).toBe(5);
    const n = normalize2({ x: 3, y: 4 });
    expect(n.x).toBeCloseTo(0.6, 12);
    expect(n.y).toBeCloseTo(0.8, 12);
  });

  it('normalizing a zero vector yields zero (no NaN)', () => {
    expect(normalize2({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('vec3 + quaternions', () => {
  it('arithmetic and normalization', () => {
    expect(add3({ x: 1, y: 2, z: 3 }, { x: 1, y: 1, z: 1 })).toEqual({ x: 2, y: 3, z: 4 });
    expect(scale3({ x: 1, y: 2, z: 3 }, 2)).toEqual({ x: 2, y: 4, z: 6 });
    expect(dot3({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBe(0);
    expect(length3({ x: 2, y: 3, z: 6 })).toBe(7);
    const n = normalize3({ x: 0, y: 0, z: 5 });
    expect(n).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('quatFromEuler + rotateByQuat rotates +X by 90° yaw to -Z', () => {
    const q = quatFromEuler(PI / 2, 0, 0); // yaw about +Y
    const v = rotateByQuat({ x: 1, y: 0, z: 0 }, q);
    expect(v.x).toBeCloseTo(0, 9);
    expect(v.y).toBeCloseTo(0, 9);
    expect(v.z).toBeCloseTo(-1, 9);
  });

  it('quaternion multiply by identity is a no-op', () => {
    const q = quatFromEuler(0.3, 0.4, 0.5);
    const id = { x: 0, y: 0, z: 0, w: 1 };
    const r = mulQuat(q, id);
    expect(r.x).toBeCloseTo(q.x, 12);
    expect(r.y).toBeCloseTo(q.y, 12);
    expect(r.z).toBeCloseTo(q.z, 12);
    expect(r.w).toBeCloseTo(q.w, 12);
  });
});
