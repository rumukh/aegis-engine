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
import { suggestName } from './suggest.js';
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
  /**
   * Names of systems that must run before this one. Cross-phase names are accepted but have
   * no effect (the fixed phase order already sequences those). A name that matches no
   * registered system is ignored and reported by {@link Schedule.unresolved}; a name that is
   * a near-miss of a registered one is rejected outright as a typo.
   */
  readonly after?: readonly string[];
  /** Names of systems that must run after this one. @see {@link System.after} */
  readonly before?: readonly string[];
  /** Execute one tick's worth of work. */
  run(ctx: TickContext): void;
}

/** A `before`/`after` entry naming a system that is not registered in the schedule. */
export interface UnresolvedConstraint {
  /** The system that declared the constraint. */
  readonly system: string;
  /** Which clause it appeared in. */
  readonly kind: 'before' | 'after';
  /** The name that matched no registered system. */
  readonly name: string;
}

/** An ordered, resolved collection of systems. */
export interface Schedule {
  /** Register a system. Returns `this` for chaining. */
  add(system: System): this;
  /** Register many systems. */
  addAll(systems: readonly System[]): this;
  /** The systems in fully-resolved execution order. Throws on a cyclic constraint. */
  resolved(): readonly System[];
  /**
   * `before`/`after` entries that named no registered system, and were therefore ignored.
   *
   * Empty for a complete schedule. Non-empty is legitimate for a partial one (a unit test
   * registering three of a mode's twelve systems), which is why it is reported as data rather
   * than thrown — but in a full game schedule every entry here is an ordering constraint that
   * silently did not happen.
   *
   * **This never throws**, including when {@link Schedule.resolved} would reject one of these
   * entries as a near-miss typo. It used to share `resolved`'s single resolve call and so threw
   * with it, which made the "reported as data" design unreachable in the one case a caller
   * actually needs it: a schedule the guard has decided not to build.
   */
  unresolved(): readonly UnresolvedConstraint[];
}

/** Create an empty schedule. */
export function createSchedule(): Schedule {
  const systems: System[] = [];
  let cache: {
    order: readonly System[];
    unresolved: readonly UnresolvedConstraint[];
    nearMiss: string | null;
  } | null = null;

  function resolve(): {
    order: readonly System[];
    unresolved: readonly UnresolvedConstraint[];
    nearMiss: string | null;
  } {
    if (cache === null) cache = resolveSystems(systems);
    return cache;
  }

  const schedule: Schedule = {
    add(system: System): typeof schedule {
      systems.push(system);
      cache = null;
      return schedule;
    },
    addAll(list: readonly System[]): typeof schedule {
      for (const s of list) systems.push(s);
      cache = null;
      return schedule;
    },
    resolved(): readonly System[] {
      const r = resolve();
      if (r.nearMiss !== null) throw new Error(r.nearMiss);
      return r.order;
    },
    unresolved(): readonly UnresolvedConstraint[] {
      return resolve().unresolved;
    },
  };
  return schedule;
}

/**
 * Deterministically order systems: group by the fixed phase order, then within each phase
 * topologically sort by `before`/`after`, breaking ties by insertion index (stable Kahn's).
 * Throws on a cyclic constraint; near-misses are collected as data and raised by
 * {@link Schedule.resolved} only — see {@link Schedule.unresolved}.
 */
function resolveSystems(systems: readonly System[]): {
  order: readonly System[];
  unresolved: readonly UnresolvedConstraint[];
  nearMiss: string | null;
} {
  const result: System[] = [];
  const unresolved: UnresolvedConstraint[] = [];
  let nearMiss: string | null = null;
  const byName = new Map<string, number>();
  systems.forEach((s, i) => {
    if (byName.has(s.name)) {
      throw new Error(`[aegis] Schedule: duplicate system name "${s.name}"`);
    }
    byName.set(s.name, i);
  });

  // A typo in a `before`/`after` entry used to be silently ignored, so the constraint read as
  // satisfied while the system quietly degraded to insertion order. Core cannot tell a typo
  // from a legitimately-absent optional dependency in general — a unit test that registers
  // three of a mode's twelve systems has unresolvable constraints by construction — so only a
  // *near-miss* of a registered name is treated as a mistake and reported.
  //
  // "Near" is the shared, length-scaled rule in `suggest.ts`, not a flat two edits: two edits
  // is most of a short name, and this guard *throws*, so being loose here made legitimate
  // schedules unbuildable. The message is recorded rather than thrown from inside the walk, so
  // `unresolved()` can still answer — it used to share this call and therefore threw too,
  // making the documented "reported as data" escape hatch unreachable in exactly the case it
  // exists for.
  for (const system of systems) {
    for (const [kind, names] of [
      ['after', system.after ?? []],
      ['before', system.before ?? []],
    ] as const) {
      for (const name of names) {
        if (byName.has(name)) continue;
        unresolved.push({ system: system.name, kind, name });
        if (nearMiss !== null) continue;
        const suggestion = suggestName(name, byName.keys());
        if (suggestion === undefined) continue;
        nearMiss =
          `[aegis] Schedule: system "${system.name}" declares ${kind}: ["${name}"], but no ` +
          `system by that name is registered. Did you mean "${suggestion}"? An unresolvable ` +
          `constraint is silently ignored, so the ordering you asked for would not happen. ` +
          `If "${name}" really is an optional dependency that is legitimately absent, read ` +
          `Schedule.unresolved() — it reports every such entry as data and does not throw.`;
      }
    }
  }

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
  return { order: result, unresolved, nearMiss };
}

/**
 * Closest registered name to `target`, when it is close enough to be a typo rather than a
 * different system.
 */

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

/** A fixed rate must produce a finite, positive timestep as well as be finite itself. */
export function isValidTickRate(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isFinite(1 / value)
  );
}

/** Create a simulation. */
export function createSimulation(config: SimulationConfig): Simulation {
  const { world, schedule, input } = config;
  if (!isValidTickRate(config.tickRate)) {
    throw new RangeError(
      `[aegis] createSimulation: tickRate must be a finite positive number with a finite timestep, got ${config.tickRate}`,
    );
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
