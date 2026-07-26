import { describe, it, expect } from 'vitest';
import { canonicalStringify, canonicalParse } from './serialize.js';
import { hashString, hashSnapshot } from './hash.js';
import type { WorldSnapshot } from './serialize.js';

describe('canonical serialisation', () => {
  it('sorts object keys regardless of construction order', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalStringify({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested keys and preserves array order', () => {
    const s = canonicalStringify({ z: [3, 2, 1], a: { y: 1, x: 2 } });
    expect(s).toBe('{"a":{"x":2,"y":1},"z":[3,2,1]}');
  });

  it('normalises -0 to 0', () => {
    expect(canonicalStringify(-0)).toBe('0');
    expect(canonicalStringify({ v: -0 })).toBe('{"v":0}');
  });

  it('drops undefined-valued keys (matching JSON)', () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalStringify(NaN)).toThrow();
    expect(() => canonicalStringify(Infinity)).toThrow();
    expect(() => canonicalStringify({ x: -Infinity })).toThrow();
  });

  it('round-trips through canonicalParse', () => {
    const value = { a: 1, b: [true, 'x', null], c: { d: 2 } };
    expect(canonicalParse(canonicalStringify(value))).toEqual(value);
  });
});

describe('hashing', () => {
  it('is 16 lowercase hex chars', () => {
    const h = hashString('hello');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable and collision-sensitive', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });

  it('hashSnapshot depends only on canonical content', () => {
    const a: WorldSnapshot = {
      version: 1,
      tick: 3,
      entities: [{ id: '1', components: { A: { x: 1 }, B: { y: 2 } } }],
      resources: { G: { y: -1 } },
      prng: { s: [1, 2, 3, 4] },
      allocator: { slots: [1], free: [] },
    };
    // Same logical content, different key insertion order.
    const b: WorldSnapshot = {
      allocator: { free: [], slots: [1] },
      prng: { s: [1, 2, 3, 4] },
      resources: { G: { y: -1 } },
      entities: [{ components: { B: { y: 2 }, A: { x: 1 } }, id: '1' }],
      tick: 3,
      version: 1,
    } as WorldSnapshot;
    expect(hashSnapshot(a)).toBe(hashSnapshot(b));
  });
});
