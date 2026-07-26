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

describe('hashing — pinned golden digests', () => {
  // FNV-1a-64 IS the cross-machine reproducibility contract. `toMatch(/^[0-9a-f]{16}$/)` would
  // stay green if FNV_PRIME_64 or FNV_OFFSET_64 changed, or if the byte order flipped — while
  // every stored replay and every game's GOLDEN_HASH silently broke. These literals pin it.
  //
  // Do NOT regenerate from the implementation. A diff here is an approved algorithm change or
  // a bug.
  it('hashString matches its pinned digests', () => {
    expect(hashString('')).toBe('cbf29ce484222325'); // the FNV-1a-64 offset basis, unmixed
    expect(hashString('hello')).toBe('32964f71b2764b97');
    expect(hashString('a')).toBe('089be207b544f1e4');
    expect(hashString('{"a":1}')).toBe('4d11c27d39f25a19');
  });

  it('processes each UTF-16 code unit low byte first (byte order is pinned)', () => {
    // A non-ASCII character exercises the high byte, so swapping the two folds shows up here.
    expect(hashString('é')).toBe('0a6a1207b6cd9fac');
    expect(hashString('\u1234')).toBe('07ee9e07b4b1c883');
  });

  it('hashSnapshot matches its pinned digest for a fixed snapshot', () => {
    const snap: WorldSnapshot = {
      version: 1,
      tick: 3,
      entities: [{ id: '4294967296', name: 'hero', components: { A: { x: 1 }, B: { y: 2 } } }],
      resources: { G: { y: -1 } },
      prng: { s: [1, 2, 3, 4] },
      allocator: { slots: [1], free: [] },
    };
    expect(hashSnapshot(snap)).toBe('b7cff77d597af2e2');
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
