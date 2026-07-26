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

  it('rejects a non-positive tickRate', () => {
    const world = createWorld({ seed: 1 });
    expect(() => createSimulation({ world, schedule: createSchedule(), tickRate: 0 })).toThrow();
  });
});
