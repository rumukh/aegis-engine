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
 * `eventNotEmitted` prints the ticks it fired on; `entityCount` samples the matches; and
 * `hashEquals` shows both hashes. An agent should be able to act on the message alone.
 * @packageDocumentation
 */
import type {
  Entity,
  EventReader,
  GameEvent,
  QueryDescriptor,
  StateHash,
  World,
} from '@aegis/core';
import { entityGeneration, entityIndex, Name } from '@aegis/core';
import { runScene } from './run.js';
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

/**
 * Render a packed entity handle the way the CLI does (`packages/cli/src/format.ts`): `#<index>`
 * for the common case, `#<index>@<gen>` once a slot has been reused. Core packs `generation` into
 * the high 32 bits, so a raw handle like `4294967296` is really index 0, generation 1 — unreadable
 * and indistinguishable from its neighbour. An agent debugging a failed playthrough must see the
 * *same* name for an entity here as in `aegis inspect`, so the spelling is kept identical across
 * the whole tool. Presentation only — structured/hashed data keeps the raw packed handle.
 */
function formatEntity(handle: number): string {
  const e = handle as Entity;
  const generation = entityGeneration(e);
  return generation === 1 ? `#${entityIndex(e)}` : `#${entityIndex(e)}@${generation}`;
}

/** A short, readable label for one matched entity: `#0 "Name"` (or `#0@2` when reused). */
function describeEntity(world: World, entity: number): string {
  const view = world
    .query({ has: [] })
    .views()
    .find((v) => v.entity === entity);
  const name = view?.tryGet(Name)?.value;
  return name ? `${formatEntity(entity)} "${name}"` : formatEntity(entity);
}

/** Sample up to `limit` entities matching `query`, as a readable, comma-separated line. */
function sampleMatches(result: SimResult, query: QueryDescriptor, limit = 8): string {
  const entities = result.query(query).entities();
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

  const assertions: GameplayAssertions = {
    entityExists(query: QueryDescriptor): GameplayAssertions {
      const count = result.query(query).count();
      if (count < 1) {
        fail(
          `Expected at least one entity matching ${describeQuery(query)}, but found none ` +
            `(the final world at tick ${result.tick} has ${result.query({ has: [] }).count()} entities).\n` +
            `Entities present:\n${sampleMatches(result, { has: [] })}`,
        );
      }
      return assertions;
    },

    entityCount(query: QueryDescriptor, n: number): GameplayAssertions {
      const actual = result.query(query).count();
      if (actual !== n) {
        fail(
          `Expected exactly ${n} entit${n === 1 ? 'y' : 'ies'} matching ${describeQuery(query)}, ` +
            `but found ${actual} at tick ${result.tick}.\n` +
            `Matched entities:\n${sampleMatches(result, query)}`,
        );
      }
      return assertions;
    },

    eventEmitted(type: string, times?: number): GameplayAssertions {
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
      if (result.hash !== expected) {
        fail(
          `Expected final state hash ${expected}, but got ${result.hash} after ${result.tick} ticks.\n` +
            `Either the golden hash is stale (update it) or a change altered simulation output.`,
        );
      }
      return assertions;
    },

    holds(label: string, predicate: (r: SimResult) => boolean): GameplayAssertions {
      if (!predicate(result)) {
        fail(
          `Expected "${label}" to hold on the final world (tick ${result.tick}), but the ` +
            `predicate returned false.`,
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
export async function runGameTest(test: GameTest): Promise<GameTestResult> {
  let result: SimResult | undefined;
  try {
    result = await runScene(test.scene, {
      ...test.options,
      ticks: test.ticks,
      ...(test.seed !== undefined ? { seed: test.seed } : {}),
      ...(test.input !== undefined ? { input: test.input } : {}),
    });
  } catch (err) {
    return { name: test.name, passed: false, error: err as Error, ticks: test.ticks };
  }
  try {
    await test.expect(result);
    return { name: test.name, passed: true, result, ticks: test.ticks };
  } catch (err) {
    return { name: test.name, passed: false, error: err as Error, result, ticks: test.ticks };
  }
}
