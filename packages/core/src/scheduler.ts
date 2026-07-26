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
import { notImplemented } from './util.js';
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
  return notImplemented('createSchedule');
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
  return notImplemented('createSimulation');
}
