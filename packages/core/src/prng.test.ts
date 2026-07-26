import { describe, it, expect } from 'vitest';
import { createPrng, prngFromState } from './prng.js';

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

  it('pick throws on an empty array', () => {
    const p = createPrng(0);
    expect(() => p.pick([])).toThrow();
  });
});
