/**
 * Gameplay assertions and the portable game-test format (CHARTER principle 6).
 *
 * These assertions are runner-agnostic: they throw {@link GameAssertionError} on failure, so
 * they work identically under Vitest and under the `aegis test` CLI (which has no test
 * runner). A {@link GameTest} is a plain, declarative description of a headless playthrough
 * plus its expectations — the unit the CLI discovers and runs to prove a PoC is completable.
 *
 * The design flows backwards from the ideal test in docs/architecture.md; read that first.
 * @packageDocumentation
 */
import { notImplemented } from '@aegis/core';
import type { QueryDescriptor, StateHash } from '@aegis/core';
import type { RunOptions, SimResult } from './run.js';

/** Thrown when a gameplay assertion fails. */
export class GameAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameAssertionError';
  }
}

/** Fluent, readable assertions over a {@link SimResult}. Every method throws on failure. */
export interface GameplayAssertions {
  /** At least one entity matches the query. */
  entityExists(query: QueryDescriptor): this;
  /** Exactly `n` entities match the query. */
  entityCount(query: QueryDescriptor, n: number): this;
  /** An event of `type` was emitted (optionally exactly `times`). */
  eventEmitted(type: string, times?: number): this;
  /** No event of `type` was ever emitted. */
  eventNotEmitted(type: string): this;
  /** The final state hash equals `expected` (determinism / golden-master check). */
  hashEquals(expected: StateHash): this;
  /** A predicate holds on the final world. `label` appears in the failure message. */
  holds(label: string, predicate: (result: SimResult) => boolean): this;
}

/** Build assertions bound to a run result. */
export function expectSim(result: SimResult): GameplayAssertions {
  return notImplemented('expectSim');
}

/** A declarative, headless gameplay test. */
export interface GameTest {
  /** Human-readable test name. */
  name: string;
  /** Scene object or path to run. */
  scene: string;
  /** Run options minus the fields the test supplies (`ticks`, `input`, `seed`). */
  options: Omit<RunOptions, 'ticks' | 'input' | 'seed'>;
  /** How many ticks to simulate. */
  ticks: number;
  /** Seed override. */
  seed?: number | string;
  /** Input-script DSL text. */
  input?: string;
  /** The expectations, run after the simulation completes. May be async. */
  expect(result: SimResult): void | Promise<void>;
}

/** Identity helper giving a {@link GameTest} literal its type and enabling discovery. */
export function defineGameTest(test: GameTest): GameTest {
  return test;
}

/** Outcome of running a {@link GameTest}. */
export interface GameTestResult {
  /** The test name. */
  name: string;
  /** Whether all assertions passed. */
  passed: boolean;
  /** The failure, if any. */
  error?: GameAssertionError | Error;
  /** The underlying run result (present unless the run itself threw). */
  result?: SimResult;
  /** Wall-clock-free tick count actually simulated. */
  ticks: number;
}

/** Run a single {@link GameTest} headlessly and capture its outcome (never throws). */
export function runGameTest(test: GameTest): Promise<GameTestResult> {
  return notImplemented(`runGameTest(${test.name})`);
}
