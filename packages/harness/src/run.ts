/**
 * The simulation harness runner (CHARTER principle 6): run a scene for N ticks with an input
 * script, then inspect the result as data.
 *
 * `runScene` wires a {@link ModePlugin}'s systems, components and view provider to a world
 * loaded from a scene, compiles the input script to per-tick frames, and steps the
 * simulation deterministically. It returns a {@link SimResult} — the single object gameplay
 * tests and the CLI read from. No pixels are involved; a run is pure computation over data.
 * @packageDocumentation
 */
import { readFile } from 'node:fs/promises';
import {
  createSimulation,
  createSchedule,
  createWorld,
  DiagnosticError,
  EMPTY_INPUT_FRAME,
  Name,
  Transform,
} from '@aegis/core';
import type {
  ComponentType,
  EventReader,
  InputFrame,
  InputSource,
  QueryDescriptor,
  QueryResult,
  StateHash,
  World,
  WorldSnapshot,
} from '@aegis/core';
import {
  createRegistry,
  Dead,
  Health,
  instantiateScene,
  Light,
  Model,
  parseScene,
  Sprite,
  Trigger,
  Triggered,
} from '@aegis/content';
import type { ComponentRegistry, SceneFile } from '@aegis/content';
import { parseInputScript } from './input-script.js';
import type { InputScript } from './input-script.js';
import type { ModePlugin } from './plugin.js';
import type { Recording } from './replay.js';
import { formatInputScript, scriptFromCommands } from './input-script.js';
import type { AsciiView, SemanticFrame, Viewport } from './view.js';

/** A named invariant checked every tick during a run. */
export interface Invariant {
  /** Human-readable name, surfaced in the failure message. */
  name: string;
  /** Return `false` to fail the run at the current tick. */
  check(world: World): boolean;
}

/** Options for {@link runScene}. */
export interface RunOptions {
  /** The mode module supplying systems, components and the view provider. Required. */
  plugin: ModePlugin;
  /** How many ticks to simulate. Required. */
  ticks: number;
  /** Seed override. Defaults to the scene's `seed`, else `0`. */
  seed?: number | string;
  /** Input: DSL text, a parsed {@link InputScript}, or explicit per-tick frames. */
  input?: string | InputScript | readonly InputFrame[];
  /** Extra components to register beyond core, content-visual and the plugin's set. */
  registry?: ComponentRegistry;
  /** Fixed ticks per second. Defaults to `60`. */
  tickRate?: number;
  /** Record the full event log for assertions. Defaults to `true`. */
  recordEvents?: boolean;
  /**
   * Snapshot the world after every tick so {@link SimResult.at} and history-based invariant
   * checks work. Costs memory; defaults to `false`.
   */
  captureHistory?: boolean;
  /** Record a hash after every tick (cheap). Defaults to `true`. */
  captureTickHashes?: boolean;
  /** Viewport for {@link SimResult.frame}. Defaults to the mode's convention. */
  viewport?: Viewport;
  /** Invariants checked live, every tick. A failure throws {@link InvariantError}. */
  invariants?: readonly Invariant[];
}

/** The inspectable outcome of a run — the object every gameplay test reads. */
export interface SimResult {
  /** The world at the final tick. */
  readonly world: World;
  /** The final tick number (equals `ticks`). */
  readonly tick: number;
  /** The seed actually used. */
  readonly seed: number | string;
  /** Final deterministic state hash. */
  readonly hash: StateHash;
  /** Per-tick hashes (index = tick), when `captureTickHashes` was on. */
  readonly tickHashes: readonly StateHash[];
  /** The event log reader. */
  readonly events: EventReader;

  /** Convenience: query the final world. */
  query(descriptor: QueryDescriptor): QueryResult;
  /** The world at an earlier tick. Requires `captureHistory`; throws otherwise. */
  at(tick: number): World;
  /** The semantic frame at `tick` (default: final). */
  frame(tick?: number): SemanticFrame;
  /** The ASCII view at `tick` (default: final), or `undefined` if the mode has none. */
  ascii(tick?: number): AsciiView | undefined;
  /**
   * Assert an invariant held on **every** captured tick. Requires `captureHistory`; throws a
   * helpful error if history was not captured.
   */
  assertInvariant(name: string, check: (world: World) => boolean): void;
  /** Produce a portable {@link Recording} of this run. */
  recording(): Recording;
  /** Deterministically re-run with identical inputs; the result's `hash` must equal this one. */
  replay(): SimResult;
}

/** Thrown when a live {@link Invariant} fails during a run. */
export class InvariantError extends Error {
  /** The invariant name. */
  readonly invariant: string;
  /** The tick on which it failed. */
  readonly tick: number;
  constructor(invariant: string, tick: number) {
    super(`invariant "${invariant}" failed at tick ${tick}`);
    this.name = 'InvariantError';
    this.invariant = invariant;
    this.tick = tick;
  }
}

/** Core + content component types the harness always registers before a scene loads. */
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

/** A fully-resolved run description, sufficient to execute (and re-execute) deterministically. */
interface ResolvedRun {
  scene: SceneFile;
  sceneRef: string;
  plugin: ModePlugin;
  registry: ComponentRegistry;
  ticks: number;
  tickRate: number;
  seed: number | string;
  frames: readonly InputFrame[];
  script?: InputScript;
  recordEvents: boolean;
  captureHistory: boolean;
  captureTickHashes: boolean;
  viewport?: Viewport;
  invariants: readonly Invariant[];
}

/** Build the component registry spanning core, content, the plugin and any caller extras. */
function buildRegistry(plugin: ModePlugin, extra?: ComponentRegistry): ComponentRegistry {
  const registry = createRegistry(...BASE_COMPONENTS);
  registry.registerAll(plugin.components());
  if (extra) {
    for (const id of extra.ids()) {
      const type = extra.get(id);
      if (type) registry.register(type);
    }
  }
  return registry;
}

/** Turn the `input` option into a concrete frame list of length `ticks`. */
function resolveInput(
  input: string | InputScript | readonly InputFrame[] | undefined,
  ticks: number,
): { frames: readonly InputFrame[]; script?: InputScript } {
  if (input === undefined) {
    const script = scriptFromCommands([]);
    return { frames: script.frames(ticks), script };
  }
  if (typeof input === 'string') {
    const parsed = parseInputScript(input);
    if (!parsed.ok || !parsed.value) throw new DiagnosticError(parsed.diagnostics);
    return { frames: parsed.value.frames(ticks), script: parsed.value };
  }
  if (Array.isArray(input)) {
    const frames = input as readonly InputFrame[];
    return { frames };
  }
  const script = input as InputScript;
  return { frames: script.frames(ticks), script };
}

/** An input source that serves compiled frames, padding out-of-range ticks with an idle frame. */
function frameSource(frames: readonly InputFrame[]): InputSource {
  return {
    frameFor(tick: number): InputFrame {
      return frames[tick] ?? { ...EMPTY_INPUT_FRAME, tick };
    },
  };
}

/** The raw, replayable output of stepping a resolved run. */
interface RunTrace {
  world: World;
  tickHashes: StateHash[];
  history: WorldSnapshot[];
}

/**
 * Execute a resolved run synchronously and deterministically. Shared by {@link runScene} (which
 * first resolves the scene from disk) and {@link SimResult.replay} (which re-runs an already
 * resolved description). Any live invariant failure throws {@link InvariantError}.
 */
function executeRun(run: ResolvedRun): RunTrace {
  const world = createWorld({ seed: run.seed, recordEvents: run.recordEvents });

  // Instantiate from a deep copy of the scene. Core's `type.create` shallow-merges provided
  // component data, so the world would otherwise alias (and then mutate in place) the caller's
  // scene objects — corrupting any reuse, including `replay()` and callers who run the same
  // SceneFile twice. Cloning here makes every run start from pristine, isolated state.
  const scene = structuredClone(run.scene);
  const result = instantiateScene(world, scene, { registry: run.registry });
  if (!result.ok) throw new DiagnosticError(result.diagnostics);

  // Per-run mode setup (fps geometry, iso nav grid, platformer platforms) — before tick 0.
  run.plugin.init?.(world);

  // Compose the schedule from the plugin's systems.
  const schedule = createSchedule();
  schedule.addAll(run.plugin.systems().resolved());

  const sim = createSimulation({
    world,
    schedule,
    tickRate: run.tickRate,
    input: frameSource(run.frames),
  });

  const tickHashes: StateHash[] = [];
  const history: WorldSnapshot[] = [];
  for (let t = 0; t < run.ticks; t++) {
    sim.step();
    if (run.captureTickHashes) tickHashes.push(world.hash());
    if (run.captureHistory) history.push(world.snapshot());
    for (const inv of run.invariants) {
      if (!inv.check(world)) throw new InvariantError(inv.name, t);
    }
  }
  return { world, tickHashes, history };
}

/** Reconstruct a detached world from a captured snapshot. */
function worldFromSnapshot(seed: number | string, snap: WorldSnapshot): World {
  const w = createWorld({ seed, recordEvents: false });
  w.restore(snap);
  return w;
}

/** Wrap a {@link RunTrace} in the inspectable {@link SimResult} surface. */
function makeResult(run: ResolvedRun, trace: RunTrace): SimResult {
  const { world, tickHashes, history } = trace;
  const view = run.plugin.view();
  const finalIndex = run.ticks - 1;

  const worldAt = (tick: number): World => {
    if (!Number.isInteger(tick) || tick < 0 || tick >= run.ticks) {
      throw new RangeError(
        `[aegis] SimResult.at(${tick}): tick out of range [0, ${run.ticks - 1}].`,
      );
    }
    if (tick === finalIndex) return world;
    if (!run.captureHistory) {
      throw new Error(
        `[aegis] SimResult.at(${tick}) needs captureHistory: true (only the final tick ${finalIndex} is available otherwise).`,
      );
    }
    return worldFromSnapshot(run.seed, history[tick]!);
  };

  return {
    world,
    tick: run.ticks,
    seed: run.seed,
    hash: world.hash(),
    tickHashes,
    events: world.events,

    query(descriptor: QueryDescriptor): QueryResult {
      return world.query(descriptor);
    },
    at(tick: number): World {
      return worldAt(tick);
    },
    frame(tick?: number): SemanticFrame {
      const w = tick === undefined ? world : worldAt(tick);
      return view.semanticFrame(w, run.viewport ? { viewport: run.viewport } : undefined);
    },
    ascii(tick?: number): AsciiView | undefined {
      const w = tick === undefined ? world : worldAt(tick);
      return view.asciiView(w);
    },
    assertInvariant(name: string, check: (w: World) => boolean): void {
      if (!run.captureHistory) {
        throw new Error(
          `[aegis] assertInvariant("${name}") needs captureHistory: true so every tick's state can be re-checked.`,
        );
      }
      for (let t = 0; t < run.ticks; t++) {
        const w = t === finalIndex ? world : worldFromSnapshot(run.seed, history[t]!);
        if (!check(w)) throw new InvariantError(name, t);
      }
    },
    recording(): Recording {
      const rec: Recording = {
        aegis: 'recording/1',
        scene: run.sceneRef,
        seed: run.seed,
        ticks: run.ticks,
        input: run.script ? formatInputScript(run.script) : '',
        finalHash: world.hash(),
        ...(tickHashes.length > 0 ? { tickHashes } : {}),
      };
      return rec;
    },
    replay(): SimResult {
      return makeResult(run, executeRun(run));
    },
  };
}

/** Resolve raw {@link RunOptions} + a scene into a fully-resolved, executable run. */
function resolveRun(scene: SceneFile, sceneRef: string, options: RunOptions): ResolvedRun {
  if (!Number.isInteger(options.ticks) || options.ticks < 0) {
    throw new RangeError(
      `[aegis] runScene: ticks must be a non-negative integer, got ${options.ticks}`,
    );
  }
  const seed = options.seed ?? scene.seed ?? 0;
  const ticks = options.ticks;
  const { frames, script } = resolveInput(options.input, ticks);
  return {
    scene,
    sceneRef,
    plugin: options.plugin,
    registry: buildRegistry(options.plugin, options.registry),
    ticks,
    tickRate: options.tickRate ?? 60,
    seed,
    frames,
    script,
    recordEvents: options.recordEvents ?? true,
    captureHistory: options.captureHistory ?? false,
    captureTickHashes: options.captureTickHashes ?? true,
    viewport: options.viewport,
    invariants: options.invariants ?? [],
  };
}

/** Read and parse a scene document from disk, throwing structured diagnostics on failure. */
async function loadSceneFromPath(path: string): Promise<SceneFile> {
  const text = await readFile(path, 'utf8');
  const parsed = parseScene(text, path);
  if (!parsed.ok || !parsed.value) throw new DiagnosticError(parsed.diagnostics);
  return parsed.value;
}

/**
 * Run a scene headlessly.
 *
 * @param scene - A scene object, or a path to a `*.scene.json` file (read from disk).
 * @param options - Mode plugin, tick count, input and capture settings.
 * @returns The {@link SimResult}. Async because a path argument reads the filesystem; the
 *          simulation itself is synchronous and deterministic.
 */
export async function runScene(scene: string | SceneFile, options: RunOptions): Promise<SimResult> {
  const resolvedScene = typeof scene === 'string' ? await loadSceneFromPath(scene) : scene;
  const sceneRef = typeof scene === 'string' ? scene : resolvedScene.name;
  const run = resolveRun(resolvedScene, sceneRef, options);
  return makeResult(run, executeRun(run));
}

/** Replay a previously captured {@link Recording}, re-running the simulation from its script. */
export async function replayRecording(
  recording: Recording,
  options: RunOptions,
): Promise<SimResult> {
  const result = await runScene(recording.scene, {
    ...options,
    ticks: recording.ticks,
    seed: recording.seed,
    input: recording.input,
  });
  if (result.hash !== recording.finalHash) {
    const divergentTick = firstDivergentTick(recording.tickHashes, result.tickHashes);
    const where =
      divergentTick === undefined
        ? 'the final hash differs'
        : `first divergence at tick ${divergentTick}`;
    throw new Error(
      `[aegis] replay determinism check FAILED: expected final hash ${recording.finalHash}, got ${result.hash} (${where}). ` +
        `A recording must replay identically; this indicates non-determinism in a system.`,
    );
  }
  return result;
}

/** Find the first tick whose replay hash differs from the recorded one. */
function firstDivergentTick(
  recorded: readonly StateHash[] | undefined,
  actual: readonly StateHash[],
): number | undefined {
  if (!recorded) return undefined;
  const n = Math.min(recorded.length, actual.length);
  for (let t = 0; t < n; t++) {
    if (recorded[t] !== actual[t]) return t;
  }
  return undefined;
}
