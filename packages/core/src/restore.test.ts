import { describe, expect, it } from 'vitest';
import { createSchedule, createSimulation } from './scheduler.js';
import { createWorld } from './world.js';
import { Name, Transform } from './components.js';
import { defineResource } from './component.js';
import { CoreDiagnosticCode } from './codes.js';
import { DiagnosticError } from './diagnostics.js';
import { entityIndex } from './entity.js';
import type { WorldSnapshot } from './serialize.js';

const Settings = defineResource('settings', () => ({ enabled: true }));

function sourceSnapshot(): WorldSnapshot {
  const world = createWorld({ seed: 'source' });
  world.spawn(Name({ value: 'replacement' }), Transform());
  const first = world.spawn();
  const second = world.spawn();
  world.despawn(first);
  world.despawn(second);
  return world.snapshot();
}

describe('World.restore atomic validation', () => {
  const invalid: {
    name: string;
    change: (snapshot: WorldSnapshot) => WorldSnapshot;
    path: string;
  }[] = [
    {
      name: 'duplicate free slot',
      change: (s) => ({ ...s, allocator: { ...s.allocator, free: [1, 2, 1] } }),
      path: 'allocator.free[2]',
    },
    {
      name: 'unaccounted dead slot',
      change: (s) => ({ ...s, allocator: { ...s.allocator, free: [2] } }),
      path: 'allocator.slots[1]',
    },
    {
      name: 'live slot on the free list',
      change: (s) => ({ ...s, allocator: { ...s.allocator, free: [1, 2, 0] } }),
      path: 'entities[0].id',
    },
    {
      name: 'duplicated live slot',
      change: (s) => ({ ...s, entities: [...s.entities, s.entities[0]!] }),
      path: 'entities[1].id',
    },
    {
      name: 'noncanonical entity handle',
      change: (s) => ({
        ...s,
        entities: [{ ...s.entities[0]!, id: '0x100000000' }],
      }),
      path: 'entities[0].id',
    },
    {
      name: 'unsafe tick',
      change: (s) => ({ ...s, tick: Number.MAX_SAFE_INTEGER + 1 }),
      path: 'tick',
    },
    {
      name: 'too few PRNG words',
      change: (s) => ({ ...s, prng: { s: [1, 2, 3] } }),
      path: 'prng.s',
    },
    {
      name: 'too many PRNG words',
      change: (s) => ({ ...s, prng: { s: [1, 2, 3, 4, 5] } }),
      path: 'prng.s',
    },
    {
      name: 'fractional PRNG word',
      change: (s) => ({ ...s, prng: { s: [1, 2, 3.5, 4] } }),
      path: 'prng.s',
    },
    {
      name: 'overflowed PRNG word',
      change: (s) => ({ ...s, prng: { s: [1, 2, 3, 0x100000000] } }),
      path: 'prng.s',
    },
    {
      name: 'nonfinite component value',
      change: (s) => ({
        ...s,
        entities: [{ ...s.entities[0]!, components: { position: { x: Infinity } } }],
      }),
      path: 'entities[0].components.position.x',
    },
    {
      name: 'non-JSON resource',
      change: (s) => ({ ...s, resources: { invalid: new Map() } }),
      path: 'resources.invalid',
    },
    {
      name: 'undefined resource value',
      change: (s) => ({ ...s, resources: { invalid: undefined } }),
      path: 'resources.invalid',
    },
    {
      name: 'nonfinite array resource element',
      change: (s) => ({ ...s, resources: { invalid: [NaN] } }),
      path: 'resources.invalid[0]',
    },
  ];

  it.each(invalid)('rejects $name without changing the previous world', ({ change, path }) => {
    const world = createWorld({ seed: 'original', recordEvents: true });
    const survivor = world.spawn(Name({ value: 'survivor' }), Transform());
    world.despawn(world.spawn());
    world.setResource(Settings, { enabled: false });
    createSimulation({ world, schedule: createSchedule(), tickRate: 60 }).step();
    world.events.emit('original.event', { value: 7 });
    const before = world.snapshot();
    const beforeHash = world.hash();
    const beforeEvents = [...world.events.history()];
    const reference = world.clone();

    expect(() => world.restore(change(sourceSnapshot()))).toThrowError(DiagnosticError);
    try {
      world.restore(change(sourceSnapshot()));
    } catch (error) {
      if (!(error instanceof DiagnosticError)) throw error;
      expect(error.diagnostics[0]?.code).toBe(CoreDiagnosticCode.InvalidSnapshot);
      expect(error.diagnostics[0]?.location?.path).toBe(path);
    }

    expect(world.snapshot()).toEqual(before);
    expect(world.hash()).toBe(beforeHash);
    expect(world.events.history()).toEqual(beforeEvents);
    expect(world.isAlive(survivor)).toBe(true);
    expect(world.random.nextUint32()).toBe(reference.random.nextUint32());
    expect(world.spawn()).toBe(reference.spawn());
  });

  it('never restores two future spawns to the same free slot', () => {
    const original = createWorld({ seed: 1 });
    original.despawn(original.spawn());
    const snapshot = original.snapshot();
    const corrupted: WorldSnapshot = {
      ...snapshot,
      allocator: { ...snapshot.allocator, free: [0, 0] },
    };
    const restored = createWorld({ seed: 2 });
    expect(() => restored.restore(corrupted)).toThrowError(DiagnosticError);
    restored.restore(snapshot);
    const first = restored.spawn();
    const second = restored.spawn();
    expect(first).not.toBe(second);
    expect([entityIndex(first), entityIndex(second)]).toEqual([0, 1]);
    expect(restored.query({}).count()).toBe(2);
    expect(restored.entityCount).toBe(2);
  });

  it('preserves free-list order, entity handles, PRNG stream and valid snapshot hashes', () => {
    const original = createWorld({ seed: 'valid' });
    const handles = Array.from({ length: 8 }, (_, i) =>
      original.spawn(Name({ value: `entity-${i}` }), Transform()),
    );
    for (const index of [5, 1, 7, 2]) original.despawn(handles[index]!);
    for (let i = 0; i < 11; i++) original.random.nextUint32();
    const snapshot = original.snapshot();
    const restored = createWorld({ seed: 'different' });
    restored.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.hash()).toBe(original.hash());
    expect(restored.query({}).entities()).toEqual([handles[0], handles[3], handles[4], handles[6]]);
    for (const slot of [2, 7, 1, 5, 8]) {
      const spawned = restored.spawn();
      expect(entityIndex(spawned)).toBe(slot);
      expect(spawned).toBe(original.spawn());
      expect(restored.random.nextUint32()).toBe(original.random.nextUint32());
    }
    expect(restored.hash()).toBe(original.hash());
  });

  it('accepts all four-word uint32 PRNG states, including zero and maximum words', () => {
    const world = createWorld({ seed: 1 });
    for (const words of [
      [0, 0, 0, 0],
      [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff],
    ]) {
      world.random.load({ s: words });
      const restored = createWorld({ seed: 2 });
      restored.restore(world.snapshot());
      expect(restored.random.save().s).toEqual(words);
      expect(restored.random.nextUint32()).toBe(world.random.nextUint32());
    }
  });
});
