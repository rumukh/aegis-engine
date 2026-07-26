import { describe, it, expect } from 'vitest';
import { createWorld, EMPTY_INPUT_FRAME, Name } from '@aegis/core';
import type { Entity, TickContext, Vec3, World } from '@aegis/core';
import {
  Dead,
  ENTITY_DIED,
  Health,
  healthSystem,
  pointInTrigger,
  TRIGGER_ENTERED,
  Trigger,
  Triggered,
} from './gameplay.js';
import type { EntityDiedEvent, TriggerData } from './gameplay.js';

function world(): World {
  return createWorld({ seed: 'gameplay', recordEvents: true });
}

/** Run `healthSystem` for one tick, exactly as the scheduler would. */
function tick(w: World, n = 0): void {
  const ctx: TickContext = { world: w, tick: n, dt: 1 / 60, input: EMPTY_INPUT_FRAME };
  healthSystem.run(ctx);
}

function died(w: World): readonly EntityDiedEvent[] {
  return w.events
    .history()
    .flatMap((e) => (e.type === ENTITY_DIED ? [e.data as EntityDiedEvent] : []));
}

function spawnMortal(w: World, name: string, current: number): Entity {
  const e = w.spawn(Name({ value: name }), Health({ current, max: 10 }));
  return e;
}

describe('Health', () => {
  it('has a stable id and a survivable default', () => {
    expect(Health.id).toBe('Health');
    expect(Health.create()).toEqual({ current: 1, max: 1 });
  });

  it('merges authored data over the defaults', () => {
    expect(Health.create({ current: 30, max: 30 })).toEqual({ current: 30, max: 30 });
  });
});

describe('healthSystem', () => {
  it('runs in postUpdate, after damage has been applied', () => {
    expect(healthSystem.phase).toBe('postUpdate');
    expect(healthSystem.name).toBe('content.health.death');
  });

  it('emits entity.died EXACTLY ONCE at zero health, and latches the entity Dead', () => {
    const w = world();
    const e = spawnMortal(w, 'grunt', 0);

    tick(w, 0);
    tick(w, 1);
    tick(w, 2);

    expect(w.events.count(ENTITY_DIED)).toBe(1);
    expect(died(w)).toEqual([{ entity: e, name: 'grunt' }]);
    expect(w.has(e, Dead)).toBe(true);
  });

  it('does not fire while health is above zero, and fires on the tick it reaches zero', () => {
    const w = world();
    const e = spawnMortal(w, 'grunt', 3);

    tick(w, 0);
    expect(w.events.contains(ENTITY_DIED)).toBe(false);
    expect(w.has(e, Dead)).toBe(false);

    w.getOrThrow(e, Health).current = 0;
    tick(w, 1);
    expect(w.events.count(ENTITY_DIED)).toBe(1);
  });

  it('treats negative health as dead (overkill damage still reports once)', () => {
    const w = world();
    spawnMortal(w, 'grunt', -25);
    tick(w);
    tick(w);
    expect(w.events.count(ENTITY_DIED)).toBe(1);
  });

  it('reports null for an entity with no Name rather than inventing one', () => {
    const w = world();
    const e = w.spawn(Health({ current: 0, max: 1 }));
    tick(w);
    expect(died(w)).toEqual([{ entity: e, name: null }]);
  });

  it('reports every dead entity in one tick, in deterministic entity order', () => {
    const w = world();
    spawnMortal(w, 'a', 0);
    spawnMortal(w, 'b', 5);
    spawnMortal(w, 'c', 0);
    tick(w);
    expect(died(w).map((d) => d.name)).toEqual(['a', 'c']);
  });

  it('ignores an entity already marked Dead (the latch is what makes it exactly-once)', () => {
    const w = world();
    const e = spawnMortal(w, 'corpse', 0);
    w.add(e, Dead);
    tick(w);
    expect(w.events.contains(ENTITY_DIED)).toBe(false);
  });

  it('ignores entities without Health', () => {
    const w = world();
    w.spawn(Name({ value: 'scenery' }));
    tick(w);
    expect(w.events.contains(ENTITY_DIED)).toBe(false);
  });
});

describe('event type constants', () => {
  it('are the stable, mode-agnostic spellings every game maps from', () => {
    expect(ENTITY_DIED).toBe('entity.died');
    expect(TRIGGER_ENTERED).toBe('trigger.entered');
  });
});

describe('Trigger', () => {
  it('has a stable id and defaults to a once-only unit goal box', () => {
    expect(Trigger.id).toBe('Trigger');
    expect(Trigger.create()).toEqual({
      kind: 'goal',
      shape: 'box',
      half: { x: 0.5, y: 0.5, z: 0.5 },
      radius: 0.5,
      once: true,
    });
    expect(Triggered.id).toBe('Triggered');
  });
});

describe('pointInTrigger', () => {
  const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
  const origin = at(0, 0, 0);
  const box = (half: Vec3): TriggerData => ({
    kind: 'goal',
    shape: 'box',
    half,
    radius: 0.5,
    once: true,
  });
  const sphere = (radius: number): TriggerData => ({
    kind: 'goal',
    shape: 'sphere',
    half: { x: 0.5, y: 0.5, z: 0.5 },
    radius,
    once: true,
  });

  describe('box', () => {
    const unit = box(at(1, 1, 1));

    it('contains the centre and interior points', () => {
      expect(pointInTrigger(unit, origin, origin)).toBe(true);
      expect(pointInTrigger(unit, origin, at(0.5, -0.5, 0.9))).toBe(true);
    });

    it('counts the boundary as inside, on every axis and both signs', () => {
      expect(pointInTrigger(unit, origin, at(1, 0, 0))).toBe(true);
      expect(pointInTrigger(unit, origin, at(-1, 0, 0))).toBe(true);
      expect(pointInTrigger(unit, origin, at(0, 1, 0))).toBe(true);
      expect(pointInTrigger(unit, origin, at(0, -1, 0))).toBe(true);
      expect(pointInTrigger(unit, origin, at(0, 0, 1))).toBe(true);
      expect(pointInTrigger(unit, origin, at(0, 0, -1))).toBe(true);
      expect(pointInTrigger(unit, origin, at(1, 1, 1))).toBe(true); // the corner
    });

    it('excludes a point just outside on any single axis', () => {
      expect(pointInTrigger(unit, origin, at(1.0001, 0, 0))).toBe(false);
      expect(pointInTrigger(unit, origin, at(0, -1.0001, 0))).toBe(false);
      expect(pointInTrigger(unit, origin, at(0, 0, 1.0001))).toBe(false);
    });

    it('is relative to the volume centre, not the world origin', () => {
      const centre = at(10, 5, -2);
      expect(pointInTrigger(unit, centre, at(10.5, 5, -2))).toBe(true);
      expect(pointInTrigger(unit, centre, at(0, 0, 0))).toBe(false);
    });

    it('honours non-cubic half-extents per axis', () => {
      const slab = box(at(3, 0.5, 1));
      expect(pointInTrigger(slab, origin, at(2.9, 0.4, 0.9))).toBe(true);
      expect(pointInTrigger(slab, origin, at(2.9, 0.6, 0.9))).toBe(false);
    });

    it('ignores radius', () => {
      const tiny = { ...box(at(1, 1, 1)), radius: 100 };
      expect(pointInTrigger(tiny, origin, at(5, 0, 0))).toBe(false);
    });

    it('a zero half-extent contains only its own plane — the degenerate volume is not silent', () => {
      const flat = box(at(1, 0, 1));
      expect(pointInTrigger(flat, origin, at(0, 0, 0))).toBe(true);
      expect(pointInTrigger(flat, origin, at(0, 0.001, 0))).toBe(false);
    });
  });

  describe('sphere', () => {
    const unit = sphere(2);

    it('contains the centre and interior points', () => {
      expect(pointInTrigger(unit, origin, origin)).toBe(true);
      expect(pointInTrigger(unit, origin, at(1, 1, 1))).toBe(true); // |p| = sqrt(3) < 2
    });

    it('counts the surface as inside and just beyond it as outside', () => {
      expect(pointInTrigger(unit, origin, at(2, 0, 0))).toBe(true);
      expect(pointInTrigger(unit, origin, at(0, -2, 0))).toBe(true);
      expect(pointInTrigger(unit, origin, at(2.0001, 0, 0))).toBe(false);
      expect(pointInTrigger(unit, origin, at(1.5, 1.5, 0))).toBe(false); // |p| = 2.12
    });

    it('is relative to the volume centre and ignores half', () => {
      const centre = at(-4, 0, 3);
      expect(pointInTrigger(unit, centre, at(-4, 1.9, 3))).toBe(true);
      expect(
        pointInTrigger({ ...unit, half: { x: 100, y: 100, z: 100 } }, origin, at(3, 0, 0)),
      ).toBe(false);
    });

    it('a zero radius contains only its centre', () => {
      expect(pointInTrigger(sphere(0), origin, origin)).toBe(true);
      expect(pointInTrigger(sphere(0), origin, at(0.001, 0, 0))).toBe(false);
    });
  });

  it('is pure: it never mutates the trigger, the centre or the point', () => {
    const trigger = box(at(1, 1, 1));
    const centre = at(1, 2, 3);
    const point = at(1, 2, 3);
    pointInTrigger(trigger, centre, point);
    expect(trigger).toEqual(box(at(1, 1, 1)));
    expect(centre).toEqual({ x: 1, y: 2, z: 3 });
    expect(point).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('the goal-volume failure this validation exists to prevent, made explicit', () => {
    // An authored `half: { x: 2 }` used to survive validation; core's shallow merge then
    // dropped y/z, so `az <= h.z` compared against `undefined` and the goal could never fire.
    const broken = { ...box(at(2, 2, 2)), half: { x: 2 } as unknown as Vec3 };
    expect(pointInTrigger(broken, origin, origin)).toBe(false);
    expect(pointInTrigger(box(at(2, 2, 2)), origin, origin)).toBe(true);
  });
});
