import { describe, it, expect } from 'vitest';
import { createSchedule, createSimulation } from './scheduler.js';
import type { System, TickContext } from './scheduler.js';
import { createWorld } from './world.js';
import { defineComponent } from './component.js';

interface Counter {
  n: number;
}
const CounterC = defineComponent<Counter>({ id: 'Counter', defaults: () => ({ n: 0 }) });

function recordingSystem(
  name: string,
  log: string[],
  phase?: System['phase'],
  deps?: Partial<System>,
): System {
  return {
    name,
    ...(phase ? { phase } : {}),
    ...(deps ?? {}),
    run(): void {
      log.push(name);
    },
  };
}

describe('scheduler ordering', () => {
  it('runs phases in the fixed order', () => {
    const log: string[] = [];
    const s = createSchedule();
    s.add(recordingSystem('cleanupSys', log, 'cleanup'));
    s.add(recordingSystem('inputSys', log, 'input'));
    s.add(recordingSystem('updateSys', log, 'update'));
    s.add(recordingSystem('physicsSys', log, 'physics'));
    const order = s.resolved().map((x) => x.name);
    expect(order).toEqual(['inputSys', 'updateSys', 'physicsSys', 'cleanupSys']);
  });

  it('orders within a phase by before/after, tie-broken by insertion', () => {
    const log: string[] = [];
    const s = createSchedule();
    s.add(recordingSystem('b', log, 'update', { after: ['a'] }));
    s.add(recordingSystem('a', log, 'update'));
    s.add(recordingSystem('c', log, 'update', { after: ['b'] }));
    expect(s.resolved().map((x) => x.name)).toEqual(['a', 'b', 'c']);
  });

  it('respects before constraints', () => {
    const s = createSchedule();
    s.add(recordingSystem('late', s2log(), 'update'));
    s.add(recordingSystem('early', s2log(), 'update', { before: ['late'] }));
    expect(s.resolved().map((x) => x.name)).toEqual(['early', 'late']);
  });

  it('throws on a cyclic constraint', () => {
    const s = createSchedule();
    s.add(recordingSystem('x', [], 'update', { after: ['y'] }));
    s.add(recordingSystem('y', [], 'update', { after: ['x'] }));
    expect(() => s.resolved()).toThrow();
  });

  it('throws on duplicate system names', () => {
    const s = createSchedule();
    s.add(recordingSystem('dup', [], 'update'));
    s.add(recordingSystem('dup', [], 'update'));
    expect(() => s.resolved()).toThrow();
  });
});

/**
 * Minor — a `before`/`after` entry naming no registered system used to be silently ignored, so
 * the constraint read as satisfied while the system quietly degraded to insertion order.
 */
describe('scheduler — unresolvable ordering constraints are not silent', () => {
  it('rejects a misspelled system name outright', () => {
    const s = createSchedule();
    s.add(recordingSystem('content.health.death', [], 'postUpdate'));
    s.add(recordingSystem('game.combat', [], 'postUpdate', { after: ['content.health.deth'] }));
    // Pre-fix: resolved() succeeded and quietly used insertion order.
    expect(() => s.resolved()).toThrow(/Did you mean "content\.health\.death"/);
  });

  it('rejects a misspelled name in `before` as well', () => {
    const s = createSchedule();
    s.add(recordingSystem('physics.integrate', [], 'physics'));
    s.add(recordingSystem('physics.forces', [], 'physics', { before: ['physics.integrat'] }));
    expect(() => s.resolved()).toThrow(/Did you mean "physics\.integrate"/);
  });

  it('reports a genuinely absent dependency as data instead of throwing', () => {
    // A partial schedule (a unit test registering some of a mode's systems) is legitimate.
    const s = createSchedule();
    s.add(recordingSystem('fps.intake', [], 'update', { after: ['fps.look'] }));
    expect(() => s.resolved()).not.toThrow();
    expect(s.unresolved()).toEqual([{ system: 'fps.intake', kind: 'after', name: 'fps.look' }]);
  });

  it('reports nothing for a complete schedule', () => {
    const s = createSchedule();
    s.add(recordingSystem('a', [], 'update'));
    s.add(recordingSystem('b', [], 'update', { after: ['a'] }));
    expect(s.unresolved()).toEqual([]);
  });

  it('accepts a cross-phase constraint without flagging it', () => {
    const s = createSchedule();
    s.add(recordingSystem('early', [], 'input'));
    s.add(recordingSystem('later', [], 'cleanup', { after: ['early'] }));
    expect(s.resolved().map((x) => x.name)).toEqual(['early', 'later']);
    expect(s.unresolved()).toEqual([]);
  });

  it('a short absent dependency is not a typo of a short registered one', () => {
    // The guard's threshold used to be a flat two edits regardless of length, so `after: ['aim']`
    // in a schedule containing `ai` — one edit, and two thirds of the shorter name — threw and
    // the schedule could not be built at all. The shared, length-scaled rule in `suggest.ts`
    // allows nothing below three characters.
    const s = createSchedule();
    s.add(recordingSystem('ai', [], 'update'));
    s.add(recordingSystem('game.aim', [], 'update', { after: ['aim'] }));
    expect(() => s.resolved()).not.toThrow();
    expect(s.unresolved()).toEqual([{ system: 'game.aim', kind: 'after', name: 'aim' }]);
  });

  it('but a typo of a *long* name is still rejected — the rule got tighter, not toothless', () => {
    // Negative control for the test above: if length-scaling had simply disabled the guard,
    // this would pass too, and the defect the guard exists for would be back.
    const s = createSchedule();
    s.add(recordingSystem('platformer.integrate', [], 'physics'));
    s.add(recordingSystem('platformer.forces', [], 'physics', { after: ['platformer.integrat'] }));
    expect(() => s.resolved()).toThrow(/Did you mean "platformer\.integrate"/);
  });

  it('unresolved() answers even when resolved() refuses — the escape hatch is reachable', () => {
    // The near-miss guard threw from inside the shared resolve step, so `unresolved()` threw
    // with it. The documented "reported as data rather than thrown" design was therefore
    // unreachable in the one situation a caller needs it: a schedule the guard will not build.
    const s = createSchedule();
    s.add(recordingSystem('content.health.death', [], 'postUpdate'));
    s.add(recordingSystem('game.combat', [], 'postUpdate', { after: ['content.health.deth'] }));
    expect(() => s.resolved()).toThrow();
    expect(s.unresolved()).toEqual([
      { system: 'game.combat', kind: 'after', name: 'content.health.deth' },
    ]);
    // And calling it in the other order must behave identically — the result is cached, so a
    // one-shot throw would leave the cache holding a half-built answer.
    const t = createSchedule();
    t.add(recordingSystem('content.health.death', [], 'postUpdate'));
    t.add(recordingSystem('game.combat', [], 'postUpdate', { after: ['content.health.deth'] }));
    expect(t.unresolved().length).toBe(1);
    expect(() => t.resolved()).toThrow();
    expect(t.unresolved().length).toBe(1);
  });
});

function s2log(): string[] {
  return [];
}

describe('simulation stepping', () => {
  it('advances the world tick deterministically and runs systems each tick', () => {
    const world = createWorld({ seed: 1 });
    const e = world.spawn(CounterC());
    const schedule = createSchedule();
    schedule.add({
      name: 'increment',
      run(ctx: TickContext): void {
        const c = ctx.world.getOrThrow(e, CounterC);
        c.n += 1;
      },
    });
    const sim = createSimulation({ world, schedule, tickRate: 60 });
    expect(sim.dt).toBeCloseTo(1 / 60, 12);
    expect(sim.tick).toBe(0);
    sim.run(10);
    expect(sim.tick).toBe(10);
    expect(world.tick).toBe(10);
    expect(world.get(e, CounterC)?.n).toBe(10);
  });

  it('passes the correct per-tick input frame and dt', () => {
    const world = createWorld({ seed: 1 });
    const seenTicks: number[] = [];
    const schedule = createSchedule();
    schedule.add({
      name: 'observe',
      run(ctx: TickContext): void {
        seenTicks.push(ctx.tick);
        expect(ctx.input.tick).toBe(ctx.tick);
      },
    });
    const sim = createSimulation({ world, schedule, tickRate: 30 });
    sim.run(3);
    expect(seenTicks).toEqual([0, 1, 2]);
  });

  it.each([0, -1, NaN, Infinity, -Infinity, Number.MIN_VALUE])(
    'rejects invalid tickRate %s',
    (tickRate) => {
      const world = createWorld({ seed: 1 });
      expect(() => createSimulation({ world, schedule: createSchedule(), tickRate })).toThrow();
      expect(world.tick).toBe(0);
    },
  );

  it('accepts finite positive fractional tick rates', () => {
    const world = createWorld({ seed: 1 });
    const simulation = createSimulation({ world, schedule: createSchedule(), tickRate: 59.94 });
    expect(simulation.dt).toBe(1 / 59.94);
  });
});
