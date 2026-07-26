import { describe, it, expect } from 'vitest';
import { createPrng, prngFromState } from './prng.js';

describe('seeded PRNG (sfc32) — pinned golden streams', () => {
  // sfc32 IS the reproducibility contract. Comparing two instances in one process proves only
  // that the code is a function; it would stay green if sfc32 were swapped for xorshift, or if
  // the SplitMix32 seed stretch or the 12-draw warm-up changed — while every stored replay and
  // every game's GOLDEN_HASH silently broke. These literals pin the actual stream.
  //
  // PROVENANCE: the two six-word streams below were derived from this implementation AND
  // cross-checked, digit for digit, against a table recorded independently by the audit before
  // any of this code was touched. That check is the point of M5 — a literal generated from the
  // implementation and never verified is exactly the defect M5 describes, not a fix for it.
  //
  // Do NOT regenerate from the implementation. A diff here is an approved algorithm change or
  // a bug. If a derived value ever disagrees with the recorded table, that is a finding to
  // report, not a number to overwrite.
  it("createPrng('canary') emits its pinned first six words", () => {
    const p = createPrng('canary');
    expect([
      p.nextUint32(),
      p.nextUint32(),
      p.nextUint32(),
      p.nextUint32(),
      p.nextUint32(),
      p.nextUint32(),
    ]).toEqual([2711998900, 1445806634, 4071225372, 3672052703, 2782830211, 4195305835]);
  });

  it('createPrng(42) emits its pinned first six words', () => {
    const p = createPrng(42);
    expect([
      p.nextUint32(),
      p.nextUint32(),
      p.nextUint32(),
      p.nextUint32(),
      p.nextUint32(),
      p.nextUint32(),
    ]).toEqual([3976162122, 2741447109, 1221645428, 3115966693, 491674442, 1768825807]);
  });

  it('derived helpers are pinned to the same stream', () => {
    const p = createPrng('canary');
    // nextFloat is nextUint32 / 2^32 — pinned so the divisor cannot change either.
    expect(p.nextFloat()).toBe(2711998900 / 4294967296);
    expect(createPrng(42).nextFloat()).toBe(3976162122 / 4294967296);
  });

  it('the seed expansion is pinned (state words after seeding)', () => {
    // Guards the FNV-1a-32 digest, the SplitMix32 stretch and the warm-up loop together.
    expect(createPrng('canary').save()).toEqual({
      s: [2361883112, 37630527, 3939484998, 312485261],
    });
    expect(createPrng(0).save()).toEqual({ s: [2695173805, 1801505024, 241347181, 3251959231] });
  });

  it("fork('sub') from a fresh seed is pinned", () => {
    const child = createPrng('canary').fork('sub');
    expect([child.nextUint32(), child.nextUint32(), child.nextUint32()]).toEqual([
      1501104017, 2679450520, 1860735835,
    ]);
  });
});

describe('seeded PRNG (sfc32)', () => {
  it('is deterministic for a given seed', () => {
    const a = createPrng(42);
    const b = createPrng(42);
    for (let i = 0; i < 1000; i++) expect(a.nextUint32()).toBe(b.nextUint32());
  });

  it('numeric and string seeds agree when they denote the same value', () => {
    const a = createPrng(1);
    const b = createPrng('1');
    for (let i = 0; i < 100; i++) expect(a.nextFloat()).toBe(b.nextFloat());
  });

  it('different seeds produce different streams', () => {
    const a = createPrng(1);
    const b = createPrng(2);
    let differ = false;
    for (let i = 0; i < 50; i++) if (a.nextUint32() !== b.nextUint32()) differ = true;
    expect(differ).toBe(true);
  });

  it('nextFloat is in [0, 1)', () => {
    const p = createPrng('floats');
    for (let i = 0; i < 10000; i++) {
      const f = p.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('int(lo, hi) stays in range and hits both ends', () => {
    const p = createPrng('ints');
    let sawLo = false;
    let sawHi = false;
    for (let i = 0; i < 20000; i++) {
      const n = p.int(3, 7); // {3,4,5,6}
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThan(7);
      if (n === 3) sawLo = true;
      if (n === 6) sawHi = true;
    }
    expect(sawLo && sawHi).toBe(true);
  });

  it('is reasonably well-distributed across buckets', () => {
    const p = createPrng('dist');
    const buckets = new Array(10).fill(0);
    const n = 100000;
    for (let i = 0; i < n; i++) buckets[Math.floor(p.nextFloat() * 10)]++;
    for (const b of buckets) {
      // Each bucket should hold ~10%. Allow a generous ±2% band.
      expect(b / n).toBeGreaterThan(0.08);
      expect(b / n).toBeLessThan(0.12);
    }
  });

  it('save/load round-trips the stream exactly', () => {
    const p = createPrng('snapshot');
    for (let i = 0; i < 37; i++) p.nextUint32();
    const state = p.save();
    const resumed = prngFromState(state);
    for (let i = 0; i < 100; i++) expect(resumed.nextUint32()).toBe(p.nextUint32());
  });

  it('save state is plain, serialisable data', () => {
    const p = createPrng(7);
    const state = p.save();
    expect(Array.isArray(state.s)).toBe(true);
    expect(state.s).toHaveLength(4);
    const round = JSON.parse(JSON.stringify(state));
    expect(round).toEqual(state);
  });

  it('fork is a pure function of (state, id) and does not advance the parent', () => {
    const parent = createPrng('parent');
    const beforeState = parent.save();
    const c1 = parent.fork('stream-a');
    const c2 = parent.fork('stream-a');
    const afterState = parent.save();
    // Forking did not consume the parent's stream.
    expect(afterState).toEqual(beforeState);
    // Two forks with the same id give identical children.
    for (let i = 0; i < 50; i++) expect(c1.nextUint32()).toBe(c2.nextUint32());
    // Different ids give different children.
    const c3 = parent.fork('stream-b');
    const c4 = parent.fork('stream-a');
    let differ = false;
    for (let i = 0; i < 50; i++) if (c3.nextUint32() !== c4.nextUint32()) differ = true;
    expect(differ).toBe(true);
  });

  it('fork reads the live parent state, so *when* you fork matters (documented caveat)', () => {
    // The docstring used to claim forking insulates a consumer from draw-order changes
    // elsewhere. It does not: the derivation mixes the parent's current words, so a fork taken
    // after one extra parent draw is a different stream. Fork once, at setup.
    const early = createPrng('parent').fork('sub').nextUint32();
    const later = (() => {
      const p = createPrng('parent');
      p.nextUint32(); // an unrelated consumer draws first
      return p.fork('sub').nextUint32();
    })();
    expect(later).not.toBe(early);
  });

  it('pick throws on an empty array', () => {
    const p = createPrng(0);
    expect(() => p.pick([])).toThrow();
  });
});
