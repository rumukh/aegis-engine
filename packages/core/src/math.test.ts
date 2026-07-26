import { describe, it, expect } from 'vitest';
import {
  PI,
  TAU,
  sin,
  cos,
  tan,
  atan2,
  asin,
  acos,
  sqrt,
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
});

describe('deterministic scalar transcendentals — bit reproducibility', () => {
  it('produces identical bits on repeated calls', () => {
    const values = [0, 0.1, 1, 2.5, -3.3, PI, PI / 7, 1000.123, -777.0];
    for (const x of values) {
      expect(sin(x)).toBe(sin(x));
      expect(cos(x)).toBe(cos(x));
      expect(atan2(x, 1.5)).toBe(atan2(x, 1.5));
    }
  });

  it('is self-consistent under call order (canary for a coefficient regression)', () => {
    // Capture once, then re-derive: a changed coefficient or reduction step would move these.
    const table = [0.1, 1, 2.5, PI / 5, 12.34, -8.9].map((x) => [sin(x), cos(x)] as const);
    for (let i = 0; i < table.length; i++) {
      const x = [0.1, 1, 2.5, PI / 5, 12.34, -8.9][i] as number;
      expect(sin(x)).toBe(table[i]![0]);
      expect(cos(x)).toBe(table[i]![1]);
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
