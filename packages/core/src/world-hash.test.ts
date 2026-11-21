import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, defineResource } from './component.js';
import { Name } from './components.js';
import { DiagnosticError } from './diagnostics.js';
import * as hashes from './hash.js';
import { canonicalStringify } from './serialize.js';
import { createWorld } from './world.js';

const Probe = defineComponent({
  id: '2',
  defaults: () => ({ nested: { x: 0 }, samples: [0, 1], label: '"\t\ud800界' }),
});
const Extra = defineComponent({
  id: '10',
  defaults: () => JSON.parse('{"2":1,"10":9,"__proto__":{"own":true}}') as Record<string, unknown>,
});
const Grid = defineResource('cells', () => ({ cells: [{ solid: true }] }));

describe('World.hash against the checked snapshot reference', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('matches every mutation, including retained references, key order, PRNG, recycled handles and restore', () => {
    const w = createWorld({ seed: 'station/界' });
    const input = vi.spyOn(hashes, 'hashString');
    const check = () => {
      const snapshot = w.snapshot();
      const reference = hashes.hashSnapshot(snapshot);
      expect(w.hash()).toBe(reference);
      expect(input).toHaveBeenLastCalledWith(canonicalStringify(snapshot));
      return reference;
    };
    const first = w.spawn(Name({ value: 'a\\\n' }), Probe(), Extra());
    const second = w.spawn(Probe());
    w.setResource(Grid, Grid.create());
    const initial = w.snapshot();
    const original = check();
    const probe = w
      .query({ has: [Name] })
      .one()
      .get(Probe);
    const cells = w.getResource(Grid)!.cells;
    for (let i = 0; i < 32; i++) {
      probe.nested.x = i % 2 === 0 ? -0 : w.random.nextFloat();
      probe.samples[i % 2] = i * 1e-9;
      cells[0]!.solid = !cells[0]!.solid;
      check();
    }
    const extra = w.getOrThrow(first, Extra);
    delete extra['2'];
    extra['same-length-new-key'] = null;
    const beforeReuse = check();
    w.despawn(first);
    w.remove(second, Probe);
    check();
    expect(w.spawn(Name({ value: 'replacement' }), Extra())).not.toBe(first);
    expect(check()).not.toBe(beforeReuse);
    w.restore(initial);
    expect(check()).toBe(original);
    probe.nested.x++; // the old reference is detached
    expect(check()).toBe(original);
    w.getOrThrow(first, Probe).nested.x++;
    expect(check()).not.toBe(original);
  });

  it('still locates illegal live writes after caching valid bytes', () => {
    const w = createWorld({ seed: 1 });
    const id = w.spawn(Name({ value: 'sensor' }), Extra());
    const mutable = w.getOrThrow(id, Extra);
    w.setResource(Grid, Grid.create());
    const resource = w.getResource(Grid)!;
    for (const bad of [undefined, NaN, Infinity, new Map(), 2n, mutable, Array(2)]) {
      w.hash();
      mutable['field'] = bad;
      expect(() => w.hash()).toThrow(DiagnosticError);
      expect(() => w.hash()).toThrow(/sensor.*component "10"|components\.10\.field/);
      delete mutable['field'];
    }
    w.hash();
    Object.assign(resource.cells[0]!, { solid: undefined });
    expect(() => w.hash()).toThrow(/resources\.cells\.cells\[0\]\.solid/);
  });
});
