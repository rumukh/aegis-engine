import { describe, it, expect } from 'vitest';
import { createWorld } from './world.js';
import { createSchedule, createSimulation } from './scheduler.js';
import type { Schedule, System, TickContext } from './scheduler.js';
import type { World } from './world.js';
import { defineComponent } from './component.js';
import { Name, Transform } from './components.js';
import type { StateHash } from './hash.js';

interface Vel {
  dx: number;
  dy: number;
}
const Velocity = defineComponent<Vel>({ id: 'Velocity', defaults: () => ({ dx: 0, dy: 0 }) });

/** Integrate movement for every mobile entity (deterministic ascending-order iteration). */
const movement: System = {
  name: 'movement',
  phase: 'physics',
  run(ctx: TickContext): void {
    for (const v of ctx.world.query({ has: [Transform, Velocity] })) {
      const t = v.get(Transform);
      const vel = v.get(Velocity);
      t.position = {
        x: t.position.x + vel.dx * ctx.dt,
        y: t.position.y + vel.dy * ctx.dt,
        z: t.position.z,
      };
    }
  },
};

/** Randomly spawn a burst of mobile entities, capped, using the world PRNG. */
const spawner: System = {
  name: 'spawner',
  phase: 'preUpdate',
  run(ctx: TickContext): void {
    const w = ctx.world;
    if (w.entityCount < 60 && w.random.bool(0.6)) {
      const burst = w.random.int(1, 4);
      for (let i = 0; i < burst; i++) {
        w.spawn(
          Name({ value: `e_${ctx.tick}_${i}` }),
          Transform({ position: { x: w.random.range(-1, 1), y: w.random.range(-1, 1), z: 0 } }),
          Velocity({ dx: w.random.range(-2, 2), dy: w.random.range(-2, 2) }),
        );
        w.events.emit('Spawned', { tick: ctx.tick });
      }
    }
  },
};

/** Despawn entities that leave a radius, plus an occasional random cull. */
const reaper: System = {
  name: 'reaper',
  phase: 'cleanup',
  run(ctx: TickContext): void {
    const w = ctx.world;
    const toKill: number[] = [];
    for (const v of w.query({ has: [Transform] })) {
      const t = v.get(Transform);
      if (t.position.x * t.position.x + t.position.y * t.position.y > 4) toKill.push(v.entity);
    }
    if (w.entityCount > 0 && w.random.bool(0.3)) {
      const all = w.query({ has: [Name] }).entities();
      if (all.length > 0) toKill.push(all[w.random.int(0, all.length)] as number);
    }
    for (const e of toKill) {
      if (w.isAlive(e as never)) w.events.emit('Despawned', { tick: ctx.tick });
      w.despawn(e as never);
    }
  },
};

function makeSchedule(): Schedule {
  return createSchedule().add(spawner).add(movement).add(reaper);
}

function seedInitial(world: World): void {
  // A few starting entities so tick 0 already has state.
  for (let i = 0; i < 5; i++) {
    world.spawn(
      Name({ value: `seed_${i}` }),
      Transform({ position: { x: (i - 2) * 0.1, y: 0, z: 0 } }),
      Velocity({ dx: 0.3 * (i - 2), dy: 0.2 }),
    );
  }
}

/** Run `ticks` steps from a fresh seeded world, returning the per-tick hash trace. */
function run(
  seed: string,
  ticks: number,
): {
  trace: StateHash[];
  final: StateHash;
  countSamples: number[];
  events: StateHash;
  eventCount: number;
} {
  const world = createWorld({ seed, recordEvents: true });
  seedInitial(world);
  const sim = createSimulation({ world, schedule: makeSchedule(), tickRate: 60 });
  const trace: StateHash[] = [];
  const countSamples: number[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.step();
    trace.push(sim.hash());
    countSamples.push(world.entityCount);
  }
  return {
    trace,
    final: sim.hash(),
    countSamples,
    events: world.events.digest(),
    eventCount: world.events.history().length,
  };
}

describe('DETERMINISM PROOF — the project canary', () => {
  const TICKS = 300;

  /**
   * The pinned end state of the canary run.
   *
   * Everything else in this file compares two runs *inside one process*, which proves only
   * repeatability — a much weaker property than the charter's "on any machine, every time".
   * This literal is the cross-machine half: it is the byte-for-byte state hash after 300 ticks
   * of PRNG-driven spawn/despawn churn and float integration, so it transitively pins sfc32,
   * FNV-1a-64, the canonical encoding, the entity allocator and the scheduler order together.
   *
   * If this moves, the engine's observable behaviour changed. That is either an approved
   * semantic change (and every stored replay and game GOLDEN_HASH must be re-pinned with it)
   * or a bug. Do NOT regenerate it to make the test pass.
   */
  const CANARY_FINAL_HASH = 'd8dbdd4f3900e148';
  /** Hash after the first tick — catches a divergence that later churn might mask. */
  const CANARY_TICK_1_HASH = '030de9d252cba762';
  /**
   * Digest of the canary's whole event stream.
   *
   * `world.hash()` deliberately covers component state only (see `events.ts`), so a build
   * whose spawn/despawn events diverged while component state converged would pass every
   * assertion above. This pins the other half.
   */
  const CANARY_EVENTS_DIGEST = '5a80e04e747797d9';

  it('matches its pinned golden hash (the cross-machine half of the proof)', () => {
    const { trace, final, events, eventCount } = run('canary-seed', TICKS);
    expect(trace[0]).toBe(CANARY_TICK_1_HASH);
    expect(final).toBe(CANARY_FINAL_HASH);
    expect(trace).toHaveLength(TICKS);
    expect(eventCount).toBeGreaterThan(100); // the run really does emit
    expect(events).toBe(CANARY_EVENTS_DIGEST);
  });

  it('the event stream is deterministic too, and the state hash alone would not prove it', () => {
    const a = run('canary-seed', TICKS);
    const b = run('canary-seed', TICKS);
    expect(a.events).toBe(b.events);
    const other = run('seed-A', TICKS);
    expect(other.events).not.toBe(a.events);
  });

  it('two independent runs with the same seed are byte-identical tick-for-tick', () => {
    const a = run('canary-seed', TICKS);
    const b = run('canary-seed', TICKS);
    expect(a.trace).toEqual(b.trace);
    expect(a.final).toBe(b.final);
  });

  it('the run actually exercises PRNG-driven spawn AND despawn churn', () => {
    const { countSamples } = run('canary-seed', TICKS);
    const max = Math.max(...countSamples);
    const min = Math.min(...countSamples);
    // Population must have both grown (spawns) and shrunk somewhere (despawns).
    expect(max).toBeGreaterThan(5);
    let fell = false;
    for (let i = 1; i < countSamples.length; i++) {
      if ((countSamples[i] as number) < (countSamples[i - 1] as number)) fell = true;
    }
    expect(fell).toBe(true);
    expect(min).toBeLessThan(max);
  });

  it('a different seed diverges (the hash is actually sensitive to state)', () => {
    const a = run('seed-A', TICKS);
    const b = run('seed-B', TICKS);
    expect(a.final).not.toBe(b.final);
  });

  it('serialise -> deserialise -> continue equals an uninterrupted run', () => {
    const uninterrupted = run('resume-seed', TICKS);

    // Run half, snapshot (through a JSON round-trip to prove losslessness), then resume in a
    // brand-new world + simulation and finish the remaining ticks.
    const HALF = TICKS / 2;
    const world = createWorld({ seed: 'resume-seed', recordEvents: true });
    seedInitial(world);
    const sim = createSimulation({ world, schedule: makeSchedule(), tickRate: 60 });
    for (let i = 0; i < HALF; i++) sim.step();

    const snapshot = JSON.parse(JSON.stringify(world.snapshot()));

    const resumedWorld = createWorld({ seed: 'unrelated', recordEvents: true });
    resumedWorld.restore(snapshot);
    expect(resumedWorld.hash()).toBe(uninterrupted.trace[HALF - 1]);

    const resumedSim = createSimulation({
      world: resumedWorld,
      schedule: makeSchedule(),
      tickRate: 60,
    });
    const resumedTrace: StateHash[] = [];
    for (let i = 0; i < TICKS - HALF; i++) {
      resumedSim.step();
      resumedTrace.push(resumedSim.hash());
    }

    // Every tick of the resumed second half matches the uninterrupted run.
    expect(resumedTrace).toEqual(uninterrupted.trace.slice(HALF));
    expect(resumedSim.hash()).toBe(uninterrupted.final);
  });
});
