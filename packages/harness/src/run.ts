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
import { notImplemented } from '@aegis/core';
import type {
  EventReader,
  InputFrame,
  QueryDescriptor,
  QueryResult,
  StateHash,
  World,
} from '@aegis/core';
import type { ComponentRegistry, SceneFile } from '@aegis/content';
import type { InputScript } from './input-script.js';
import type { ModePlugin } from './plugin.js';
import type { Recording } from './replay.js';
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

/**
 * Run a scene headlessly.
 *
 * @param scene - A scene object, or a path to a `*.scene.json` file (read from disk).
 * @param options - Mode plugin, tick count, input and capture settings.
 * @returns The {@link SimResult}. Async because a path argument reads the filesystem; the
 *          simulation itself is synchronous and deterministic.
 */
export function runScene(scene: string | SceneFile, options: RunOptions): Promise<SimResult> {
  return notImplemented('runScene');
}

/** Replay a previously captured {@link Recording}, re-running the simulation from its script. */
export function replayRecording(recording: Recording, options: RunOptions): Promise<SimResult> {
  return notImplemented('replayRecording');
}
