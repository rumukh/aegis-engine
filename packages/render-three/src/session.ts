/**
 * A **live** simulation session: the same deterministic world a headless `runScene` builds, but
 * stepped in real time from human input instead of a compiled script.
 *
 * `@aegis/harness`'s `runScene` is batch by design — it compiles a whole input script up front
 * and runs N ticks to completion — so real-time play needs this thin sibling. It wires the world
 * exactly the way `runScene` does (same base component registry, same scene instantiation, same
 * `plugin.init()` before tick 0, same schedule from `plugin.systems()`) and then exposes a single
 * `step()`. Time is still ticks: `advance()` converts wall-clock into a whole number of fixed
 * steps via {@link "./loop".FixedStepLoop}; the simulation never sees a variable `dt`.
 *
 * The session owns the world. Rendering is not mentioned here at all — that is the point.
 * @packageDocumentation
 */
import {
  DiagnosticError,
  Name,
  Transform,
  createSchedule,
  createSimulation,
  createWorld,
} from '@aegis/core';
import type { ComponentType, Simulation, StateHash, World, WorldSnapshot } from '@aegis/core';
import {
  Dead,
  Health,
  Light,
  Model,
  Sprite,
  Trigger,
  Triggered,
  createRegistry,
  instantiateScene,
} from '@aegis/content';
import type { ComponentRegistry, SceneFile } from '@aegis/content';
import type { ModePlugin } from '@aegis/harness';
import { createFixedStepLoop } from './loop.js';
import type { FixedStepLoop } from './loop.js';
import { createLiveInput } from './live-input.js';
import type { LiveInput } from './live-input.js';

/**
 * The core + content components the harness always registers before a scene loads. Mirrors
 * `@aegis/harness`'s private `BASE_COMPONENTS` so a live session and a headless run instantiate
 * a scene identically; every entry is a normal export of an allowed dependency.
 */
const BASE_COMPONENTS: readonly ComponentType<unknown>[] = [
  Transform,
  Name,
  Sprite,
  Model,
  Light,
  Health,
  Trigger,
  Dead,
  Triggered,
];

/** Options for {@link createLiveSession}. */
export interface LiveSessionOptions {
  /** The parsed scene document to instantiate. */
  scene: SceneFile;
  /** The composed game plugin (mode systems **plus** the game's own). */
  plugin: ModePlugin;
  /** Seed override. Defaults to the scene's `seed`, else `0`. */
  seed?: number | string;
  /** Fixed ticks per second. Defaults to `60`. */
  tickRate?: number;
  /** Extra components to register beyond the base and plugin sets. */
  registry?: ComponentRegistry;
  /** Maximum simulation steps per `advance` call. Defaults to the loop's own cap. */
  maxStepsPerFrame?: number;
}

/** A running, human-driven simulation. */
export interface LiveSession {
  /** The live world. */
  readonly world: World;
  /** The current tick. */
  readonly tick: number;
  /** Fixed seconds per tick. */
  readonly dt: number;
  /** The plugin driving it. */
  readonly plugin: ModePlugin;
  /** The live input source; feed it {@link "./live-input".InputPacket}s. */
  readonly input: LiveInput;
  /** Whether stepping is currently suspended. */
  paused: boolean;
  /** Advance exactly one fixed tick, regardless of {@link LiveSession.paused}. */
  step(): void;
  /** Convert `elapsedSeconds` of wall-clock into whole fixed steps. Returns the steps taken. */
  advance(elapsedSeconds: number): number;
  /** The world as plain JSON — what the browser renders from. */
  snapshot(): WorldSnapshot;
  /** Deterministic digest of the current state. */
  hash(): StateHash;
  /** Rebuild the world from the scene at tick 0 and clear pending input. */
  restart(): void;
}

/** Build a world from the scene and run the plugin's `init` — the pre-tick-0 state. */
function buildWorld(options: Required<Pick<LiveSessionOptions, 'plugin'>> & LiveSessionOptions): {
  world: World;
  simulation: Simulation;
  input: LiveInput;
} {
  const seed = options.seed ?? options.scene.seed ?? 0;
  const world = createWorld({ seed, recordEvents: true });

  const registry = createRegistry(...BASE_COMPONENTS);
  registry.registerAll(options.plugin.components());
  if (options.registry !== undefined) {
    for (const id of options.registry.ids()) {
      const type = options.registry.get(id);
      if (type) registry.register(type);
    }
  }

  // Instantiate from a deep copy: `type.create` shallow-merges, so a shared SceneFile would be
  // aliased (and then mutated) by the world — exactly the trap `runScene` guards against.
  const result = instantiateScene(world, structuredClone(options.scene), { registry });
  if (!result.ok) throw new DiagnosticError(result.diagnostics);

  options.plugin.init?.(world);

  const schedule = createSchedule();
  schedule.addAll(options.plugin.systems().resolved());

  const input = createLiveInput();
  const simulation = createSimulation({
    world,
    schedule,
    tickRate: options.tickRate ?? 60,
    input,
  });
  return { world, simulation, input };
}

/** Create a live session for a scene + composed game plugin. */
export function createLiveSession(options: LiveSessionOptions): LiveSession {
  let built = buildWorld(options);
  const loop: FixedStepLoop = createFixedStepLoop({
    tickRate: options.tickRate ?? 60,
    ...(options.maxStepsPerFrame !== undefined
      ? { maxStepsPerFrame: options.maxStepsPerFrame }
      : {}),
  });
  let paused = false;

  const session: LiveSession = {
    get world() {
      return built.world;
    },
    get tick() {
      return built.world.tick;
    },
    get dt() {
      return loop.dt;
    },
    plugin: options.plugin,
    get input() {
      return built.input;
    },
    get paused() {
      return paused;
    },
    set paused(value: boolean) {
      paused = value;
      if (value) loop.reset();
    },
    step(): void {
      built.simulation.step();
    },
    advance(elapsedSeconds: number): number {
      if (paused) {
        loop.reset();
        return 0;
      }
      return loop.advance(elapsedSeconds, () => built.simulation.step());
    },
    snapshot(): WorldSnapshot {
      return built.world.snapshot();
    },
    hash(): StateHash {
      return built.world.hash();
    },
    restart(): void {
      // Deliberately preserves `paused`: restart means "this scene again from tick 0", not "and
      // also start running". A human who paused, hit R and got a world already sprinting away
      // from them lost the thing they paused for; and automation that restarts to reach a known
      // tick 0 cannot do so at all if the simulation resumes underneath it.
      built = buildWorld(options);
      loop.reset();
    },
  };
  return session;
}
