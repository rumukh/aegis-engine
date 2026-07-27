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
  max,
  Name,
  Transform,
} from '@aegis/core';
import type {
  ComponentType,
  Diagnostic,
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
import { describeRun, renderValue, summariseWorld, toOutcome } from './report.js';
import type { CheckResult } from './report.js';
import {
  explainUnknownRefs,
  recordAssertion,
  registerKnownComponents,
  unknownComponentRefs,
} from './verification.js';
import type { AsciiView, SemanticFrame, ViewOptions, Viewport } from './view.js';

/** A named invariant checked every tick during a run. */
export interface Invariant {
  /** Human-readable name, surfaced in the failure message. */
  name: string;
  /**
   * Return `false` to fail the run at the current tick.
   *
   * Returning a {@link CheckResult} object instead of a bare boolean (`{ ok, actual, expected,
   * detail }`) puts the offending value straight into the {@link InvariantError} message, which
   * is the only thing an agent sees when a headless run fails.
   */
  check(world: World): CheckResult;
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
  /**
   * Full view options for {@link SimResult.frame} and {@link SimResult.ascii} — including
   * `includeOffscreen` and the ASCII grid size, which were previously unreachable because the
   * runner only ever forwarded `viewport`. {@link RunOptions.viewport} still works and wins if
   * both are given.
   */
  view?: ViewOptions;
  /** Invariants checked live, every tick. A failure throws {@link InvariantError}. */
  invariants?: readonly Invariant[];
  /**
   * Called with any diagnostics raised while compiling the input script against `ticks` —
   * statements the tick window swallowed, spans it clipped, `look` deltas it applied only a
   * fraction of, and order-sensitive overlaps. See {@link InputScript.check}.
   *
   * This is the whole fix for "a statement outside `[0, ticks)` vanishes silently": the run's
   * *behaviour* is unchanged (a script that did nothing still produces the same hash as no input
   * at all — that is correct), what changes is that the tooling now says so out loud.
   */
  onInputDiagnostics?: (diagnostics: readonly Diagnostic[]) => void;
  /**
   * Treat `error`-severity input diagnostics as fatal — i.e. abort with a `DiagnosticError` when
   * **no** statement in the script had any effect, making the run identical to one with no input.
   * Off by default: reporting is the fix, and running a prefix of a playthrough
   * (`aegis inspect --tick 90` on a 400-tick script) is a first-class workflow that must keep
   * working. Opt in for CI, where a script that silently evaporated is never intended.
   */
  strictInput?: boolean;
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
  /**
   * The semantic frame at `tick` (default: final). `options` overrides the run's
   * {@link RunOptions.view} for this call — this is how `includeOffscreen` is reached.
   */
  frame(tick?: number, options?: ViewOptions): SemanticFrame;
  /**
   * The ASCII view at `tick` (default: final), or `undefined` if the mode has none. `options`
   * overrides the run's {@link RunOptions.view} for this call (e.g. the character-grid size).
   */
  ascii(tick?: number, options?: ViewOptions): AsciiView | undefined;
  /**
   * Assert an invariant held on **every** captured tick. Requires `captureHistory`; throws a
   * helpful error if history was not captured, and throws rather than passing vacuously if the
   * run simulated no ticks at all.
   *
   * `check` may return `{ ok, actual, expected, detail }` instead of a bare boolean so the
   * failure message can name the value that broke it.
   */
  assertInvariant(name: string, check: (world: World) => CheckResult): void;
  /** Produce a portable {@link Recording} of this run. */
  recording(): Recording;
  /** Deterministically re-run with identical inputs; the result's `hash` must equal this one. */
  replay(): SimResult;
}

/** Reproduction context carried on an {@link InvariantError}, so the message alone is actionable. */
export interface InvariantContext {
  /** The scene the run loaded. */
  scene?: string;
  /** The seed the run used. */
  seed?: number | string;
  /** How many ticks the run simulated in total. */
  ticks?: number;
  /** The value the check observed, when it reported one. */
  actual?: unknown;
  /** The value the check required, when it reported one. */
  expected?: unknown;
  /** A description of the offending world at the failing tick. */
  detail?: string;
  /** Whether `result.at(tick)` can reconstruct the failing world (`captureHistory`). */
  historyAvailable?: boolean;
}

/**
 * Thrown when an {@link Invariant} fails, live during a run or post-hoc via
 * {@link SimResult.assertInvariant}.
 *
 * The message used to be eight words — `invariant "never fell out of the world" failed at tick 0`
 * — with no entity, no value, no threshold, no seed and no hint that the failing world could be
 * re-read. It now carries everything needed to reproduce and diagnose the failure from the string
 * alone.
 */
export class InvariantError extends Error {
  /** The invariant name. */
  readonly invariant: string;
  /** The tick on which it failed. */
  readonly tick: number;
  /** Reproduction context: scene, seed, observed value, world summary. */
  readonly context: InvariantContext;
  constructor(invariant: string, tick: number, context: InvariantContext = {}) {
    super(invariantMessage(invariant, tick, context));
    this.name = 'InvariantError';
    this.invariant = invariant;
    this.tick = tick;
    this.context = context;
  }
}

/** Build the {@link InvariantError} message: what failed, where, what it saw, how to re-read it. */
function invariantMessage(invariant: string, tick: number, context: InvariantContext): string {
  const where = describeRun({
    ...(context.scene !== undefined ? { scene: context.scene } : {}),
    ...(context.seed !== undefined ? { seed: context.seed } : {}),
    tick,
    ...(context.ticks !== undefined ? { ticks: context.ticks } : {}),
  });
  const lines = [`invariant "${invariant}" failed at ${where}.`];
  if (context.expected !== undefined) lines.push(`  expected: ${renderValue(context.expected)}`);
  if (context.actual !== undefined) lines.push(`  actual  : ${renderValue(context.actual)}`);
  if (context.detail !== undefined) lines.push(`  world   : ${context.detail}`);
  lines.push(
    context.historyAvailable === true
      ? `  re-read the failing world with result.at(${tick}), or diff it against result.at(${max(0, tick - 1)}).`
      : `  re-run with captureHistory: true to re-read the failing world via result.at(${tick}).`,
  );
  return lines.join('\n');
}

/**
 * Run one invariant check, converting a **throw** into a message that names the invariant and the
 * tick it happened on.
 *
 * A predicate that walks `.query(...).one().get(...)` throws the moment the entity it names is
 * gone. Unwrapped, that surfaced as a bare `[aegis] QueryResult.one: expected exactly 1 match,
 * got 0` from somewhere inside a 400-iteration loop: no invariant name, no tick, nothing to act
 * on — and it means the *check* is broken, not that the property was violated.
 */
function checkAt(
  name: string,
  check: (world: World) => CheckResult,
  world: World,
  tick: number,
  run: { sceneRef: string; seed: number | string; ticks: number },
): CheckResult {
  try {
    return check(world);
  } catch (err) {
    const inner = err instanceof Error ? err : new Error(String(err));
    const where = describeRun({
      scene: run.sceneRef,
      seed: run.seed,
      tick,
      ticks: run.ticks,
    });
    throw new Error(
      `[aegis] the check for invariant "${name}" threw at ${where}, so it produced no verdict.\n` +
        `  ${inner.name}: ${inner.message}\n` +
        `  world   : ${summariseWorld(world)}\n` +
        `  This is a broken check rather than a violated invariant: \`.one()\` throws when the ` +
        `entity has died, despawned or was never spawned. Guard the lookup, or narrow the query.`,
      { cause: inner },
    );
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
  view?: ViewOptions;
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

/** Turn the `input` option into a concrete frame list of length `ticks`, plus its diagnostics. */
function resolveInput(
  input: string | InputScript | readonly InputFrame[] | undefined,
  ticks: number,
): { frames: readonly InputFrame[]; script?: InputScript; diagnostics: readonly Diagnostic[] } {
  if (input === undefined) {
    const script = scriptFromCommands([]);
    return { frames: script.frames(ticks), script, diagnostics: [] };
  }
  if (typeof input === 'string') {
    const parsed = parseInputScript(input);
    if (!parsed.ok || !parsed.value) throw new DiagnosticError(parsed.diagnostics);
    const script = parsed.value;
    return {
      frames: script.frames(ticks),
      script,
      // Parse warnings (order-sensitive overlaps) and window warnings/errors are one channel.
      diagnostics: [...parsed.diagnostics, ...script.check(ticks)],
    };
  }
  // `in` rather than `Array.isArray`: the latter's `arg is any[]` signature does not remove a
  // `readonly InputFrame[]` from the union, which is what previously forced a cast here.
  if ('frames' in input) {
    return { frames: input.frames(ticks), script: input, diagnostics: input.check(ticks) };
  }
  return { frames: input, diagnostics: [] };
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
      const outcome = toOutcome(checkAt(inv.name, inv.check, world, t, run));
      if (outcome.ok) continue;
      throw new InvariantError(inv.name, t, {
        scene: run.sceneRef,
        seed: run.seed,
        ticks: run.ticks,
        ...(outcome.actual !== undefined ? { actual: outcome.actual } : {}),
        ...(outcome.expected !== undefined ? { expected: outcome.expected } : {}),
        detail: outcome.detail ?? summariseWorld(world),
        historyAvailable: run.captureHistory,
      });
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

  /** Merge the run's view options with a per-call override. `viewport` stays the legacy alias. */
  const viewOptions = (override?: ViewOptions): ViewOptions | undefined => {
    const merged: ViewOptions = { ...run.view, ...override };
    return Object.keys(merged).length > 0 ? merged : undefined;
  };

  const self: SimResult = {
    world,
    tick: run.ticks,
    seed: run.seed,
    hash: world.hash(),
    tickHashes,
    events: world.events,

    query(descriptor: QueryDescriptor): QueryResult {
      const misses = unknownComponentRefs(self, descriptor);
      if (misses.length > 0) {
        throw new Error(
          `[aegis] SimResult.query: this query can never match what it means.` +
            explainUnknownRefs(self, misses),
        );
      }
      return world.query(descriptor);
    },
    at(tick: number): World {
      return worldAt(tick);
    },
    frame(tick?: number, options?: ViewOptions): SemanticFrame {
      const w = tick === undefined ? world : worldAt(tick);
      return withEntityCensus(view.semanticFrame(w, viewOptions(options)), w);
    },
    ascii(tick?: number, options?: ViewOptions): AsciiView | undefined {
      const w = tick === undefined ? world : worldAt(tick);
      return view.asciiView(w, viewOptions(options));
    },
    assertInvariant(name: string, check: (w: World) => CheckResult): void {
      if (run.ticks === 0) {
        throw new Error(
          `[aegis] assertInvariant("${name}") on a 0-tick run: there is no tick to check, so this ` +
            `would pass for any predicate — including () => false. Give the run at least 1 tick.`,
        );
      }
      if (!run.captureHistory) {
        throw new Error(
          `[aegis] assertInvariant("${name}") needs captureHistory: true so every tick's state can be re-checked.`,
        );
      }
      for (let t = 0; t < run.ticks; t++) {
        const w = t === finalIndex ? world : worldFromSnapshot(run.seed, history[t]!);
        const outcome = toOutcome(checkAt(name, check, w, t, run));
        if (outcome.ok) continue;
        throw new InvariantError(name, t, {
          scene: run.sceneRef,
          seed: run.seed,
          ticks: run.ticks,
          ...(outcome.actual !== undefined ? { actual: outcome.actual } : {}),
          ...(outcome.expected !== undefined ? { expected: outcome.expected } : {}),
          detail: outcome.detail ?? summariseWorld(w),
          historyAvailable: true,
        });
      }
      recordAssertion(self, 'assertInvariant', `"${name}" held on all ${run.ticks} ticks`);
    },
    recording(): Recording {
      if (!run.script) {
        throw new Error(
          `[aegis] SimResult.recording(): this run was driven by explicit InputFrames, which the ` +
            `input-script DSL cannot express. Emitting an empty script would produce a recording ` +
            `that replays as "no input" and then fails its own determinism check. Re-run with a ` +
            `DSL string or an InputScript to record it.`,
        );
      }
      const rec: Recording = {
        aegis: 'recording/1',
        scene: run.sceneRef,
        seed: run.seed,
        ticks: run.ticks,
        input: formatInputScript(run.script),
        finalHash: world.hash(),
        ...(tickHashes.length > 0 ? { tickHashes } : {}),
      };
      return rec;
    },
    replay(): SimResult {
      return makeResult(run, executeRun(run));
    },
  };
  registerKnownComponents(self, run.registry, world);
  for (const inv of run.invariants) {
    recordAssertion(self, 'invariant', `"${inv.name}" held live on all ${run.ticks} ticks`);
  }
  return self;
}

/**
 * Fill in {@link SemanticFrame} entity counts the view provider left blank.
 *
 * A semantic frame lists only what the camera sees, so entities are routinely dropped — on
 * `server-vault` the world holds 6 and the frame reports 3, both mission objectives missing, with
 * nothing in the data to say so. `aegis inspect --view world` is honest about this (`entities: 3
 * of 6`); the frame must be too, or an agent reads "the objective does not exist". A provider that
 * computes its own (more precise) counts keeps them.
 */
function withEntityCensus(frame: SemanticFrame, world: World): SemanticFrame {
  if (frame.totalEntities !== undefined && frame.excludedEntities !== undefined) return frame;
  const total = frame.totalEntities ?? world.entityCount;
  return {
    ...frame,
    totalEntities: total,
    excludedEntities: frame.excludedEntities ?? total - frame.entities.length,
  };
}

/**
 * Reject anything that is not a live {@link ModePlugin} **before** the run touches it.
 *
 * `options.plugin` is typed, but the values that reach here at runtime are frequently untyped: a
 * `*.gametest.mjs` discovered from disk, a JSON-ish literal, a scaffolded template. Those name
 * their plugin as a **string** (`'platformer'`, `'./dist/game.js#gamePlugin'`) because only the
 * CLI can resolve one — the harness must not import a concrete `@aegis/mode-*`, which is the
 * package boundary ADR-0006 draws and `scripts/check-deps.mjs` enforces.
 *
 * Unguarded, a string got as far as `plugin.components()` and produced
 * `TypeError: plugin.components is not a function` with no mention of plugins, strings or who
 * resolves them. Naming the seam is the whole fix: the harness cannot resolve the string, and it
 * can say exactly who can.
 */
function requirePlugin(plugin: ModePlugin): void {
  if (
    typeof plugin === 'object' &&
    plugin !== null &&
    typeof plugin.components === 'function' &&
    typeof plugin.systems === 'function' &&
    typeof plugin.view === 'function'
  ) {
    return;
  }
  const named = typeof plugin === 'string' ? ` (got the string ${JSON.stringify(plugin)})` : '';
  const advice =
    typeof plugin === 'string'
      ? `A plugin *spec* string is resolved by the CLI — \`aegis test\`, \`--plugin ${plugin}\`, or ` +
        `{ "plugin": ${JSON.stringify(plugin)} } in an aegis.json beside the scene. The harness ` +
        `cannot resolve it itself: importing a concrete @aegis/mode-* would invert the package ` +
        `graph (ADR-0006). To run this test in-process, substitute the plugin object, e.g.\n` +
        `  import { platformerPlugin } from '@aegis/mode-platformer';\n` +
        `  await runGameTest({ ...spec, options: { ...spec.options, plugin: platformerPlugin } });`
      : `Pass the ModePlugin object itself — the value a mode package exports (platformerPlugin, ` +
        `isoPlugin, fpsPlugin) or your game's composed plugin.`;
  throw new TypeError(
    `[aegis] runScene: options.plugin is not a ModePlugin${named}. A ModePlugin is an object with ` +
      `components(), systems() and view() methods.\n${advice}`,
  );
}

/** Resolve raw {@link RunOptions} + a scene into a fully-resolved, executable run. */
function resolveRun(scene: SceneFile, sceneRef: string, options: RunOptions): ResolvedRun {
  requirePlugin(options.plugin);
  if (!Number.isInteger(options.ticks) || options.ticks < 0) {
    throw new RangeError(
      `[aegis] runScene: ticks must be a non-negative integer, got ${options.ticks}`,
    );
  }
  const seed = options.seed ?? scene.seed ?? 0;
  const ticks = options.ticks;
  const invariants = options.invariants ?? [];
  if (ticks === 0 && invariants.length > 0) {
    throw new RangeError(
      `[aegis] runScene: ticks: 0 with ${invariants.length} invariant${invariants.length === 1 ? '' : 's'} ` +
        `(${invariants.map((i) => `"${i.name}"`).join(', ')}). A zero-tick run never steps, so every ` +
        `invariant would "hold" without ever being evaluated — including () => false. Simulate at ` +
        `least 1 tick, or drop the invariants.`,
    );
  }
  const { frames, script, diagnostics } = resolveInput(options.input, ticks);
  if (diagnostics.length > 0) {
    options.onInputDiagnostics?.(diagnostics);
    if (options.strictInput === true) {
      const errors = diagnostics.filter((d) => d.severity === 'error');
      if (errors.length > 0) throw new DiagnosticError(errors);
    }
  }
  const view: ViewOptions = {
    ...options.view,
    ...(options.viewport ? { viewport: options.viewport } : {}),
  };
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
    ...(Object.keys(view).length > 0 ? { view } : {}),
    invariants,
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
