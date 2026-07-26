/**
 * The fixed-timestep scheduler and the {@link Simulation} that drives a world forward.
 *
 * Time is discrete and fixed: every {@link Simulation.step} advances the world by exactly
 * `dt = 1 / tickRate` seconds, regardless of wall-clock. Systems run once per tick in a
 * deterministic order: first grouped by {@link SystemPhase} (in the fixed phase order), then
 * within a phase topologically by their `before`/`after` constraints, with ties broken by a
 * stable insertion index. There is no async and no wall-clock inside the loop (CHARTER
 * principle 3). The threading/timing model is documented in docs/architecture.md.
 * @packageDocumentation
 */
import { CLEAR_TICK, SET_TICK } from './internal.js';
import { EMPTY_INPUT_FRAME } from './input.js';
import type { ManagedEventBus, TickControlledWorld } from './internal.js';
import type { InputFrame } from './input.js';
import type { StateHash } from './hash.js';
import type { World } from './world.js';

/**
 * The fixed, ordered phases every tick runs through. Systems declare which phase they belong
 * to; the scheduler always runs phases in this array order.
 *
 * - `input`     — translate the tick's {@link InputFrame} into intent components.
 * - `preUpdate` — timers, cooldowns, spawn/despawn requests resolved.
 * - `update`    — core gameplay: movement intent, AI decisions.
 * - `physics`   — integration and collision resolution against the world.
 * - `postUpdate`— reactions to resolved positions: camera follow, triggers.
 * - `events`    — systems that consume events emitted earlier this tick.
 * - `cleanup`   — end-of-tick bookkeeping.
 */
export const SYSTEM_PHASES = [
  'input',
  'preUpdate',
  'update',
  'physics',
  'postUpdate',
  'events',
  'cleanup',
] as const;

/** One of the fixed {@link SYSTEM_PHASES}. */
export type SystemPhase = (typeof SYSTEM_PHASES)[number];

/** Per-tick context passed to every system's `run`. */
export interface TickContext {
  /** The world being mutated. */
  readonly world: World;
  /** The current tick number (starts at 0). */
  readonly tick: number;
  /** Fixed seconds represented by this tick (`1 / tickRate`). Constant for the run. */
  readonly dt: number;
  /** The logical input for this tick. */
  readonly input: InputFrame;
}

/** A unit of per-tick behaviour. Stateless w.r.t. the world — all state lives in the world. */
export interface System {
  /** Unique, stable name; used for ordering constraints and diagnostics. */
  readonly name: string;
  /** Phase this system runs in. Defaults to `"update"` when omitted. */
  readonly phase?: SystemPhase;
  /** Names of systems that must run before this one (within the same phase). */
  readonly after?: readonly string[];
  /** Names of systems that must run after this one (within the same phase). */
  readonly before?: readonly string[];
  /** Execute one tick's worth of work. */
  run(ctx: TickContext): void;
}

/** An ordered, resolved collection of systems. */
export interface Schedule {
  /** Register a system. Returns `this` for chaining. */
  add(system: System): this;
  /** Register many systems. */
  addAll(systems: readonly System[]): this;
  /** The systems in fully-resolved execution order. Throws on a cyclic constraint. */
  resolved(): readonly System[];
}

/** Create an empty schedule. */
export function createSchedule(): Schedule {
  const systems: System[] = [];
  let resolvedCache: readonly System[] | null = null;

  const schedule: Schedule = {
    add(system: System): typeof schedule {
      systems.push(system);
      resolvedCache = null;
      return schedule;
    },
    addAll(list: readonly System[]): typeof schedule {
      for (const s of list) systems.push(s);
      resolvedCache = null;
      return schedule;
    },
    resolved(): readonly System[] {
      if (resolvedCache === null) resolvedCache = resolveSystems(systems);
      return resolvedCache;
    },
  };
  return schedule;
}

/**
 * Deterministically order systems: group by the fixed phase order, then within each phase
 * topologically sort by `before`/`after`, breaking ties by insertion index (stable Kahn's).
 * Throws on a cyclic constraint.
 */
function resolveSystems(systems: readonly System[]): readonly System[] {
  const result: System[] = [];
  const byName = new Map<string, number>();
  systems.forEach((s, i) => {
    if (byName.has(s.name)) {
      throw new Error(`[aegis] Schedule: duplicate system name "${s.name}"`);
    }
    byName.set(s.name, i);
  });

  for (const phase of SYSTEM_PHASES) {
    const group: { system: System; index: number }[] = [];
    systems.forEach((system, index) => {
      if ((system.phase ?? 'update') === phase) group.push({ system, index });
    });
    if (group.length === 0) continue;

    const inGroup = new Set(group.map((g) => g.system.name));
    const adj = new Map<string, Set<string>>(); // edge a→b: a runs before b
    const indeg = new Map<string, number>();
    for (const g of group) {
      adj.set(g.system.name, new Set());
      indeg.set(g.system.name, 0);
    }
    const addEdge = (from: string, to: string): void => {
      if (!inGroup.has(from) || !inGroup.has(to)) return; // cross-phase constraints are ignored
      const set = adj.get(from) as Set<string>;
      if (!set.has(to)) {
        set.add(to);
        indeg.set(to, (indeg.get(to) as number) + 1);
      }
    };
    for (const { system } of group) {
      for (const dep of system.after ?? []) addEdge(dep, system.name); // dep before system
      for (const succ of system.before ?? []) addEdge(system.name, succ); // system before succ
    }

    const insertionOf = new Map(group.map((g) => [g.system.name, g.index]));
    // Ready set as a list kept sorted by insertion index for stable tie-breaking.
    const ready: string[] = group
      .filter((g) => (indeg.get(g.system.name) as number) === 0)
      .map((g) => g.system.name)
      .sort((a, b) => (insertionOf.get(a) as number) - (insertionOf.get(b) as number));

    let emitted = 0;
    while (ready.length > 0) {
      const name = ready.shift() as string;
      result.push(group[group.findIndex((g) => g.system.name === name)]!.system);
      emitted++;
      const succs = [...(adj.get(name) as Set<string>)];
      for (const succ of succs) {
        indeg.set(succ, (indeg.get(succ) as number) - 1);
        if ((indeg.get(succ) as number) === 0) {
          // insert keeping `ready` sorted by insertion index
          const idx = insertionOf.get(succ) as number;
          let pos = ready.length;
          for (let i = 0; i < ready.length; i++) {
            if ((insertionOf.get(ready[i] as string) as number) > idx) {
              pos = i;
              break;
            }
          }
          ready.splice(pos, 0, succ);
        }
      }
    }
    if (emitted !== group.length) {
      throw new Error(`[aegis] Schedule: cyclic before/after constraint in phase "${phase}"`);
    }
  }
  return result;
}

/** A source of one {@link InputFrame} per tick (the harness's script, or a live adapter). */
export interface InputSource {
  /** Produce the input frame for `tick`. */
  frameFor(tick: number): InputFrame;
}

/** A world plus a schedule, steppable one fixed tick at a time. */
export interface Simulation {
  /** The world under simulation. */
  readonly world: World;
  /** The current tick (equals `world.tick`). */
  readonly tick: number;
  /** Fixed seconds per tick. */
  readonly dt: number;
  /**
   * Advance exactly one tick: build the tick context from `input` (or the configured
   * {@link InputSource}, or an empty frame) and run every system in resolved order.
   */
  step(input?: InputFrame): void;
  /** Advance `n` ticks. */
  run(ticks: number): void;
  /** Deterministic digest of the current world state. */
  hash(): StateHash;
}

/** Configuration for {@link createSimulation}. */
export interface SimulationConfig {
  /** The world to advance. */
  world: World;
  /** The systems to run each tick. */
  schedule: Schedule;
  /** Ticks per second; sets the fixed `dt = 1 / tickRate`. Common values: 30, 60. */
  tickRate: number;
  /** Optional per-tick input source. */
  input?: InputSource;
}

/** Create a simulation. */
export function createSimulation(config: SimulationConfig): Simulation {
  const { world, schedule, input } = config;
  if (!(config.tickRate > 0)) {
    throw new Error(`[aegis] createSimulation: tickRate must be > 0, got ${config.tickRate}`);
  }
  const dt = 1 / config.tickRate;
  const bus = world.events as ManagedEventBus;
  const tickWorld = world as World & TickControlledWorld;

  function step(frameInput?: InputFrame): void {
    const current = world.tick;
    const frame: InputFrame = frameInput ??
      input?.frameFor(current) ?? { ...EMPTY_INPUT_FRAME, tick: current };
    // Roll the event buffer into this tick before systems run.
    bus[CLEAR_TICK](current);
    const ctx: TickContext = { world, tick: current, dt, input: frame };
    for (const system of schedule.resolved()) system.run(ctx);
    tickWorld[SET_TICK](current + 1);
  }

  const sim: Simulation = {
    world,
    get tick() {
      return world.tick;
    },
    dt,
    step,
    run(ticks: number): void {
      for (let i = 0; i < ticks; i++) step();
    },
    hash(): StateHash {
      return world.hash();
    },
  };
  return sim;
}
