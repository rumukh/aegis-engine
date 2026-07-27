/**
 * Gameplay assertions and the portable game-test format (CHARTER principle 6).
 *
 * These assertions are runner-agnostic: they throw {@link GameAssertionError} on failure, so
 * they work identically under Vitest and under the `aegis test` CLI (which has no test
 * runner). A {@link GameTest} is a plain, declarative description of a headless playthrough
 * plus its expectations — the unit the CLI discovers and runs to prove that a scripted sequence
 * of **logical actions** drives the simulation to a named state.
 *
 * The design flows backwards from the ideal test in docs/architecture.md; read that first.
 *
 * ## What a green GameTest does not prove
 * Read this before writing one, and before believing one.
 *
 * A GameTest injects input as logical actions — `Right`, `Jump`, `Fire`, `Forward` — straight into
 * the simulation. A human's input arrives instead through a **binding table** that maps a key code
 * or a mouse delta onto those same action names (`packages/render-three/src/bindings.ts`), and
 * through a renderer that draws the result. **The harness sits downstream of both.** So a passing
 * GameTest says the simulation reaches the state; it says nothing whatsoever about whether a
 * person can get it there. Invisible to every assertion in this file, by construction:
 *
 * - an inverted or wrongly-signed look/move axis — the sign is applied identically on both sides
 *   of any comparison the harness can make, so it cancels;
 * - a key bound to the wrong action, or to nothing at all;
 * - anything about frame rate, input latency or what is actually drawn.
 *
 * This is not a gap to be closed here. Verifying a binding table needs an oracle **outside** the
 * loop that applies it — an independently-authored expectation of what a given key must do — and
 * that oracle belongs with the bindings, not with the simulation harness. What this file owes the
 * reader is that a green result never be mistaken for one. Criterion 5 was reopened because three
 * PoCs shipped with an inverted axis and a half-rate renderer while every instrument said they
 * were fine; the instruments were correct and were measuring the other loop.
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
 * Three silent ways this API used to report success without checking anything, all now loud:
 * a query naming a component that does not exist matched nothing rather than erroring (so
 * `entityCount({ has: ['Enmy'] }, 0)` passed on every world); an `expect` block that ran no
 * assertions at all was reported as a clean pass; and a **self-referential** check, whose expected
 * value is produced by the run it is checking, reported success for every possible run. See
 * `verification.ts` for the first two and {@link "./run".SelfReferentialCheckError} for the third.
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
  eventLogDisabled,
  explainUnknownRefs,
  nearMisses,
  recordAssertion,
  unknownComponentRefs,
} from './verification.js';

/** Thrown when a gameplay assertion fails. */
export class GameAssertionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
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

/**
 * Thrown when an event assertion cannot mean what it says.
 *
 * Two cases, both of which used to pass silently: a **typo** in a negative assertion
 * (`eventNotEmitted('player.jumpd')` on a run where `player.jumped` fired), and an assertion
 * against a run that kept **no event log** at all (`recordEvents: false`). Extends
 * {@link GameAssertionError} so it travels the runner-agnostic failure path, but is
 * distinguishable: this is a *broken test*, not a failing game.
 */
export class UnknownEventError extends GameAssertionError {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownEventError';
  }
}

/** Options shared by the event assertions. */
export interface EventAssertionOptions {
  /**
   * Accept a type that looks like a typo for one that really fired.
   *
   * The near-miss guard is a heuristic, and a heuristic with no override is a wall. Two genuinely
   * distinct event types can be one edit apart (`player.hit` / `player.hits`), and asserting that
   * one never fired while the other did is exactly what these assertions are for. Set this to say
   * "I know what it looks like; it is not a typo."
   */
  allowNearMiss?: boolean;
}

/** Fluent, readable assertions over a {@link SimResult}. Every method throws on failure. */
export interface GameplayAssertions {
  /** At least one entity matches the query. */
  entityExists(query: QueryDescriptor): this;
  /** Exactly `n` entities match the query. */
  entityCount(query: QueryDescriptor, n: number): this;
  /** An event of `type` was emitted (optionally exactly `times`). */
  eventEmitted(type: string, times?: number, options?: EventAssertionOptions): this;
  /** No event of `type` was ever emitted. */
  eventNotEmitted(type: string, options?: EventAssertionOptions): this;
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

/** Every distinct event type in the log, sorted. */
function emittedTypes(events: EventReader): string[] {
  return [...new Set(events.history().map((e) => e.type))].sort();
}

/**
 * Whether two one-edit-apart names differ **only in a digit** — `wave1.spawned` / `wave2.spawned`,
 * `p1.died` / `p2.died`.
 *
 * Numbering is how games name a family of distinct events, so a digit difference is the one
 * near-miss that is never a misspelling. Called only on pairs {@link nearMisses} already accepted,
 * so the shapes here are "same length, one substitution" or "one insertion/deletion".
 */
function differsOnlyByDigit(a: string, b: string): boolean {
  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  // The characters that actually differ, on each side. One of them is empty for an insertion.
  const fromA = a.slice(head, a.length - tail);
  const fromB = b.slice(head, b.length - tail);
  if (fromA.length > 1 || fromB.length > 1) return false;
  return isDigit(fromA[0]) || isDigit(fromB[0]);
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

  /**
   * Reject an event assertion the run cannot answer.
   *
   * `recordEvents: false` empties the log by construction, so **every** negative event assertion
   * against such a run passes and no positive one can ever pass. Either way the assertion is
   * describing the run options rather than the game.
   */
  const requireEventLog = (assertion: string, type: string): void => {
    if (!eventLogDisabled(result)) return;
    throw new UnknownEventError(
      `${assertion}("${type}") on a run created with recordEvents: false.\n` +
        `Its event log is empty by construction, so a negative assertion passes for every type ` +
        `(including one that really fired) and a positive one can never pass. Neither outcome ` +
        `says anything about the game.\n` +
        `Drop recordEvents: false — it defaults to true — or assert on world state instead.`,
    );
  };

  /**
   * Reject a **negative** event assertion whose type looks like a typo for one that really fired.
   *
   * The mirror of {@link requireResolvable}: an event type has no registry, so "absent" cannot be
   * distinguished from "misspelled" by lookup — only by neighbourhood. `eventNotEmitted` on a
   * genuinely absent type is the assertion's entire purpose and must keep passing; on a type one
   * letter away from a type that fired 3× it is a typo, and it was silently reporting success on
   * exactly the event it was written to forbid.
   *
   * Three things keep the heuristic from becoming a wall:
   *
   * 1. **It never speaks when the asserted type really fired.** `nearMisses` skips the exact
   *    match, so without this the guard fired on a run emitting both `p1.died` and `p2.died` —
   *    announcing "no event of that type exists in this run" about a type that fired twice, and
   *    swallowing the genuine failure that names the ticks.
   * 2. **A digit is not a typo.** `wave1.spawned` / `wave2.spawned` and `p1.died` / `p2.died` are
   *    one edit apart and are obviously distinct events, so a difference involving a digit is
   *    never treated as a misspelling.
   * 3. **`allowNearMiss` overrides it**, for the residual `player.hit` / `player.hits` case.
   */
  const rejectNearMiss = (
    assertion: string,
    type: string,
    options: EventAssertionOptions | undefined,
  ): void => {
    if (options?.allowNearMiss === true) return;
    // The guard is only about a type that is ABSENT. If it fired, the real assertion below has a
    // true and far more useful thing to say.
    if (result.events.count(type) > 0) return;
    const emitted = emittedTypes(result.events);
    const suggestions = nearMisses(type, emitted).filter((s) => !differsOnlyByDigit(type, s));
    if (suggestions.length === 0) return;
    const counts = suggestions
      .map((s) => `"${s}" (×${result.events.count(s)})`)
      .join(suggestions.length === 2 ? ' or ' : ', ');
    throw new UnknownEventError(
      `${assertion}("${type}") would pass — no event of that type was emitted — but ${counts} ` +
        `was, and the two names are one edit apart. That looks like a typo rather than a proven ` +
        `absence.\n` +
        `A negative assertion on a misspelled type passes on every world, including one where the ` +
        `event it was written to forbid fired on every tick.\n` +
        `If the name is right and the resemblance is a coincidence, say so: ` +
        `${assertion}("${type}", { allowNearMiss: true }).\n` +
        `Event types emitted by this run: ${emitted.length > 0 ? emitted.join(', ') : '(none)'}`,
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

    eventEmitted(
      type: string,
      times?: number,
      options?: EventAssertionOptions,
    ): GameplayAssertions {
      requireEventLog('eventEmitted', type);
      // `eventEmitted(type, 0)` is a negative assertion wearing a positive's clothes, and has the
      // same typo hole.
      if (times === 0) rejectNearMiss('eventEmitted', type, options);
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
        const suggestions = actual === 0 ? nearMisses(type, emittedTypes(result.events)) : [];
        const didYouMean =
          suggestions.length > 0
            ? `\nDid you mean ${suggestions.map((s) => `"${s}"`).join(' or ')}?`
            : '';
        fail(
          `Expected ${want} "${type}" event${times === 1 ? '' : 's'}, but ${actual} ` +
            `w${actual === 1 ? 'as' : 'ere'} emitted${at} during the ${result.tick}-tick run.` +
            didYouMean +
            `\nEvents that WERE emitted:\n${eventHistogram(result.events)}`,
        );
      }
      return assertions;
    },

    eventNotEmitted(type: string, options?: EventAssertionOptions): GameplayAssertions {
      requireEventLog('eventNotEmitted', type);
      rejectNearMiss('eventNotEmitted', type, options);
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
      const where = describeRun({ seed: result.seed, tick: result.tick });
      let raw: CheckResult;
      try {
        raw = predicate(result);
      } catch (err) {
        // A predicate that throws used to surface as its bare inner error — most often
        // `[aegis] QueryResult.one: expected exactly 1 match, got 0`, with no label, no seed, no
        // tick and no clue which of a dozen `holds` calls it came from. Every PoC predicate walks
        // `.query(...).one().get(...)`, so this fires whenever the entity it names is gone, and
        // it means the *test* is broken rather than the game.
        const inner = asError(err);
        throw new GameAssertionError(
          `The predicate for "${label}" threw while checking the final world (${where}).\n` +
            `  ${inner.name}: ${inner.message}\n` +
            `  world   : ${summariseWorld(result.world)}\n` +
            `This is a broken expectation, not a failing playthrough: the check never produced a ` +
            `verdict. A query that must match exactly one entity (\`.one()\`) throws when the ` +
            `entity has died, despawned or was never spawned — guard it, or assert on the count ` +
            `first with entityCount(...).`,
          { cause: inner },
        );
      }
      const outcome = toOutcome(raw);
      if (!outcome.ok) {
        // Only nudge when the predicate really did return a bare boolean. Deciding this from
        // `actual`/`expected` alone told a caller who returned { ok, detail } that they had
        // "returned a bare boolean, so nothing above names the offending value" — directly under
        // the detail line that named it.
        const said = typeof raw !== 'boolean';
        fail(
          `Expected "${label}" to hold on the final world (${where}), but it did not.` +
            renderOutcome(outcome) +
            (outcome.detail === undefined ? `\n  world   : ${summariseWorld(result.world)}` : '') +
            (said
              ? ''
              : `\nThe predicate returned a bare boolean, so nothing above names the offending ` +
                `value. Return { ok, actual, expected } instead and they are printed here.`),
        );
      }
      return assertions;
    },
  };
  return assertions;
}

// --- game tests ----------------------------------------------------------------------------

/**
 * A declarative, headless gameplay test.
 *
 * Scope, stated on the type rather than only in the module header: this drives the **simulation**
 * with logical actions. It is downstream of the key/mouse binding table and of the renderer, so a
 * green result cannot speak for either — see the module header for what that rules out.
 */
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
    // was verified, and the report says the playthrough is proven. The message states what the
    // harness *observed* — no assertion recorded against this result — rather than asserting what
    // the callback did: it cannot see the callback, and a message that describes the reader's
    // code wrongly sends them to debug a file that is fine.
    return {
      name: test.name,
      passed: false,
      error: new GameAssertionError(
        `Game test "${test.name}" ran ${test.ticks} ticks and recorded ZERO assertions against ` +
          `the SimResult it produced, so it proves nothing and cannot fail.\n` +
          `Add at least one real check inside expect(result) — e.g. ` +
          `expectSim(result).eventEmitted('level.completed', 1), or result.assertInvariant(...) — ` +
          `or declare live invariants on the run.\n` +
          `If your expectations DID run, check they were applied to the \`result\` argument this ` +
          `test was given: assertions made against a different SimResult (one built inside ` +
          `expect(), say) are recorded against that one and cannot vouch for this run.`,
      ),
      result,
      ticks: test.ticks,
      ...checked,
    };
  }
  return { name: test.name, passed: true, result, ticks: test.ticks, ...checked };
}
