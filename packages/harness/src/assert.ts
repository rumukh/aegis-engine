/**
 * Gameplay assertions and the portable game-test format (CHARTER principle 6).
 *
 * These assertions are runner-agnostic: they throw {@link GameAssertionError} on failure, so
 * they work identically under Vitest and under the `aegis test` CLI (which has no test
 * runner). A {@link GameTest} is a plain, declarative description of a headless playthrough
 * plus its expectations — the unit the CLI discovers and runs to prove a PoC is completable.
 *
 * The design flows backwards from the ideal test in docs/architecture.md; read that first.
 *
 * ## Failure messages are the product
 * When a playthrough fails, the *only* thing an agent sees is the thrown message. So every
 * assertion reports **what was expected, what actually happened, and where** — never a bare
 * "expected 1, got 0". `eventEmitted` prints the histogram of events that *were* emitted;
 * `eventNotEmitted` prints the ticks it fired on; `entityCount` samples the matches;
 * `hashEquals` shows both hashes; and `holds` reports the value its predicate saw plus a census
 * of the world it rejected. An agent should be able to act on the message alone.
 *
 * ## An assertion that cannot fail is worse than no assertion
 * Two silent ways this API used to report success without checking anything, both now loud:
 * a query naming a component that does not exist matched nothing rather than erroring (so
 * `entityCount({ has: ['Enmy'] }, 0)` passed on every world), and an `expect` block that ran no
 * assertions at all was reported as a clean pass. See `verification.ts`.
 * @packageDocumentation
 */
import type { EventReader, GameEvent, QueryDescriptor, StateHash } from '@aegis/core';
import { runScene } from './run.js';
import type { RunOptions, SimResult } from './run.js';
import {
  asError,
  describeEntity,
  describeRun,
  renderOutcome,
  summariseWorld,
  toOutcome,
} from './report.js';
import type { CheckResult } from './report.js';
import {
  assertionsFor,
  explainUnknownRefs,
  recordAssertion,
  unknownComponentRefs,
} from './verification.js';

/** Thrown when a gameplay assertion fails. */
export class GameAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameAssertionError';
  }
}

/**
 * Thrown when a query names a component that cannot be resolved.
 *
 * Extends {@link GameAssertionError} so it still travels the runner-agnostic failure path, but is
 * distinguishable: this is a *broken test*, not a failing game.
 */
export class UnknownComponentError extends GameAssertionError {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownComponentError';
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
  /**
   * A predicate holds on the final world. `label` appears in the failure message.
   *
   * Return `{ ok, actual, expected, detail }` instead of a bare boolean and those values are
   * printed too — `holds` is the escape hatch every positional, health and score check funnels
   * through, and "the predicate returned false" is not a debuggable message.
   */
  holds(label: string, predicate: (result: SimResult) => CheckResult): this;
}

// --- message helpers -----------------------------------------------------------------------

/** A histogram of every event type in the log, most frequent first, as readable lines. */
function eventHistogram(events: EventReader): string {
  const log = events.history();
  if (log.length === 0) return '  (no events were emitted during the run)';
  const counts = new Map<string, number>();
  for (const e of log) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
    .map(([type, n]) => `  - ${type} ×${n}`)
    .join('\n');
}

/** The ascending list of ticks on which `type` was emitted. */
function ticksOf(events: EventReader, type: string): number[] {
  return events
    .history()
    .filter((e: GameEvent) => e.type === type)
    .map((e) => e.tick);
}

/** Sample up to `limit` entities matching `query`, as a readable, comma-separated line. */
function sampleMatches(result: SimResult, query: QueryDescriptor, limit = 8): string {
  // Deliberately the raw world query: the caller has already validated the refs and is building
  // its own message, so re-validating here would replace it with a less specific one.
  const entities = result.world.query(query).entities();
  if (entities.length === 0) return '  (none)';
  const shown = entities.slice(0, limit).map((e) => describeEntity(result.world, e));
  const extra = entities.length > limit ? `, … (+${entities.length - limit} more)` : '';
  return `  ${shown.join(', ')}${extra}`;
}

/** Render a query descriptor compactly for a message, e.g. `has:[Player,Health] none:[Dead]`. */
function describeQuery(query: QueryDescriptor): string {
  const part = (label: string, refs?: readonly (string | { id: string })[]): string | undefined =>
    refs && refs.length > 0
      ? `${label}:[${refs.map((r) => (typeof r === 'string' ? r : r.id)).join(',')}]`
      : undefined;
  const parts = [part('has', query.has), part('any', query.any), part('none', query.none)].filter(
    (p): p is string => p !== undefined,
  );
  return parts.length > 0 ? parts.join(' ') : '{any entity}';
}

// --- assertions ----------------------------------------------------------------------------

/** Build assertions bound to a run result. */
export function expectSim(result: SimResult): GameplayAssertions {
  const fail = (message: string): never => {
    throw new GameAssertionError(message);
  };

  /**
   * Reject a query the run cannot resolve, *before* it is evaluated.
   *
   * `opening` is the assertion's normal first clause, so the failure still reads as that
   * assertion failing — with the reason attached — rather than as an unrelated error.
   */
  const requireResolvable = (opening: string, query: QueryDescriptor): void => {
    const misses = unknownComponentRefs(result, query);
    if (misses.length === 0) return;
    throw new UnknownComponentError(
      `${opening}, but the query cannot be evaluated.${explainUnknownRefs(result, misses)}`,
    );
  };

  const assertions: GameplayAssertions = {
    entityExists(query: QueryDescriptor): GameplayAssertions {
      const opening = `Expected at least one entity matching ${describeQuery(query)}`;
      requireResolvable(opening, query);
      recordAssertion(
        result,
        'entityExists',
        `${describeQuery(query)} matches at least one entity`,
      );
      const count = result.query(query).count();
      if (count < 1) {
        fail(
          `${opening}, but found none ` +
            `(the final world at tick ${result.tick} has ${result.world.query({ has: [] }).count()} entities).\n` +
            `Entities present:\n${sampleMatches(result, { has: [] })}`,
        );
      }
      return assertions;
    },

    entityCount(query: QueryDescriptor, n: number): GameplayAssertions {
      const opening = `Expected exactly ${n} entit${n === 1 ? 'y' : 'ies'} matching ${describeQuery(query)}`;
      requireResolvable(opening, query);
      recordAssertion(result, 'entityCount', `${describeQuery(query)} matches exactly ${n}`);
      const actual = result.query(query).count();
      if (actual !== n) {
        fail(
          `${opening}, but found ${actual} at tick ${result.tick}.\n` +
            `Matched entities:\n${sampleMatches(result, query)}`,
        );
      }
      return assertions;
    },

    eventEmitted(type: string, times?: number): GameplayAssertions {
      recordAssertion(
        result,
        'eventEmitted',
        `"${type}" emitted ${times === undefined ? 'at least once' : `exactly ${times}×`}`,
      );
      const actual = result.events.count(type);
      const ok = times === undefined ? actual >= 1 : actual === times;
      if (!ok) {
        const want = times === undefined ? 'at least one' : `exactly ${times}`;
        const at =
          actual > 0
            ? ` (on tick${actual === 1 ? '' : 's'} ${ticksOf(result.events, type).join(', ')})`
            : '';
        fail(
          `Expected ${want} "${type}" event${times === 1 ? '' : 's'}, but ${actual} ` +
            `w${actual === 1 ? 'as' : 'ere'} emitted${at} during the ${result.tick}-tick run.\n` +
            `Events that WERE emitted:\n${eventHistogram(result.events)}`,
        );
      }
      return assertions;
    },

    eventNotEmitted(type: string): GameplayAssertions {
      recordAssertion(result, 'eventNotEmitted', `"${type}" never emitted`);
      const ticks = ticksOf(result.events, type);
      if (ticks.length > 0) {
        fail(
          `Expected no "${type}" event, but ${ticks.length} w${ticks.length === 1 ? 'as' : 'ere'} ` +
            `emitted on tick${ticks.length === 1 ? '' : 's'} ${ticks.join(', ')}.`,
        );
      }
      return assertions;
    },

    hashEquals(expected: StateHash): GameplayAssertions {
      recordAssertion(result, 'hashEquals', `final state hash is ${expected}`);
      if (result.hash !== expected) {
        fail(
          `Expected final state hash ${expected}, but got ${result.hash} after ${result.tick} ticks.\n` +
            `Either the golden hash is stale (update it) or a change altered simulation output.`,
        );
      }
      return assertions;
    },

    holds(label: string, predicate: (r: SimResult) => CheckResult): GameplayAssertions {
      recordAssertion(result, 'holds', label);
      const outcome = toOutcome(predicate(result));
      if (!outcome.ok) {
        const where = describeRun({ seed: result.seed, tick: result.tick });
        fail(
          `Expected "${label}" to hold on the final world (${where}), but it did not.` +
            renderOutcome(outcome) +
            (outcome.detail === undefined ? `\n  world   : ${summariseWorld(result.world)}` : '') +
            `\nReturn { ok, actual, expected } from the predicate (instead of a bare boolean) to ` +
            `have the offending value printed here.`,
        );
      }
      return assertions;
    },
  };
  return assertions;
}

// --- game tests ----------------------------------------------------------------------------

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
  /** Whether all assertions passed **and** at least one assertion actually ran. */
  passed: boolean;
  /** The failure, if any. */
  error?: GameAssertionError | Error;
  /** The underlying run result (present unless the run itself threw). */
  result?: SimResult;
  /** Wall-clock-free tick count actually simulated. */
  ticks: number;
  /**
   * How many gameplay assertions actually executed — `expectSim` calls, `assertInvariant`, and
   * live `Invariant`s. `0` means the test verified nothing and is reported as a failure.
   */
  assertions: number;
  /** One readable line per assertion that ran, in order — what the test actually checked. */
  checked: readonly string[];
}

/** What a run actually verified: the assertions recorded against it, as reportable fields. */
function auditOf(result: SimResult): Pick<GameTestResult, 'assertions' | 'checked'> {
  const records = assertionsFor(result);
  return {
    assertions: records.length,
    checked: records.map((r) => `${r.kind}: ${r.detail}`),
  };
}

/** Run a single {@link GameTest} headlessly and capture its outcome (never throws). */
export async function runGameTest(test: GameTest): Promise<GameTestResult> {
  let result: SimResult;
  try {
    result = await runScene(test.scene, {
      ...test.options,
      ticks: test.ticks,
      ...(test.seed !== undefined ? { seed: test.seed } : {}),
      ...(test.input !== undefined ? { input: test.input } : {}),
    });
  } catch (err) {
    return {
      name: test.name,
      passed: false,
      error: asError(err),
      ticks: test.ticks,
      assertions: 0,
      checked: [],
    };
  }
  try {
    await test.expect(result);
  } catch (err) {
    return {
      name: test.name,
      passed: false,
      error: asError(err),
      result,
      ticks: test.ticks,
      ...auditOf(result),
    };
  }
  const checked = auditOf(result);
  if (checked.assertions === 0) {
    // A green tick here would be the worst lie the harness can tell: the run completed, nothing
    // was verified, and the report says the playthrough is proven.
    return {
      name: test.name,
      passed: false,
      error: new GameAssertionError(
        `Game test "${test.name}" ran ${test.ticks} ticks and executed ZERO assertions, so it ` +
          `proves nothing and cannot fail.\n` +
          `Its expect(result) callback returned without calling a single expectSim(...) assertion ` +
          `or result.assertInvariant(...), and the run declared no live invariants.\n` +
          `Add at least one real check — e.g. expectSim(result).eventEmitted('level.completed', 1).`,
      ),
      result,
      ticks: test.ticks,
      ...checked,
    };
  }
  return { name: test.name, passed: true, result, ticks: test.ticks, ...checked };
}
