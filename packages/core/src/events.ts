/**
 * Deterministic event bus and per-run event log.
 *
 * Systems communicate gameplay facts ("PlayerJumped", "EnemyKilled", "DamageDealt") by
 * emitting events. Events are the primary surface gameplay assertions read (CHARTER
 * principle 6). Delivery is FIFO within a tick and the log preserves global emission order.
 *
 * Event `data` must be plain, serialisable data (same rule as components). The bus **owns the
 * copy**: `emit` deep-clones and deep-freezes the payload, and the reader methods hand out
 * frozen arrays. Storing the caller's object by reference made a recorded event alias live
 * world state, so the log was retroactively rewritten whenever the component it pointed at
 * moved later in the tick; returning the internal array meant `history().push(...)` forged
 * entries that `count()` believed. A rewritable audit log is not an audit log.
 *
 * ## Relationship to the state hash
 *
 * The event stream is **not** covered by {@link "./hash".StateHash}: `World.snapshot()` holds
 * components, resources, the PRNG and the allocator, and nothing else. Two runs that emit
 * completely different damage/kill/trigger events therefore still compare equal under
 * `hashEquals` if their component state converged. Use {@link EventReader.digest} to pin the
 * event stream as well — the harness and the determinism proof do, and a game that cares about
 * its event trace should too. See ADR-0001 for why the two digests are kept separate.
 * @packageDocumentation
 */
import { deepCloneSerialisable, deepFreeze, UnserialisableValueError } from './clone.js';
import { hashString } from './hash.js';
import { canonicalStringify } from './serialize.js';
import { CoreDiagnosticCode } from './codes.js';
import { DiagnosticError } from './diagnostics.js';
import { explainUnserialisable } from './serialisable.js';
import { CLEAR_TICK, RESET_LOG } from './internal.js';
import type { ManagedEventBus } from './internal.js';
import type { StateHash } from './hash.js';

/**
 * Rejection raised when an event payload holds something the digest cannot encode.
 *
 * `emit` was the one write boundary that skipped this check, and the consequence was
 * asymmetric in the worst way: `world.hash()` succeeded (the event stream is not part of the
 * state hash) while `events.digest()` died several ticks later with a bare, unaddressed
 * `Error: non-finite number (NaN) is not serialisable` from inside `canonicalStringify` — no
 * event type, no tick, no path. Checking at `emit` moves the failure to the system that
 * produced the value and names it.
 */
function unserialisableAtEmit(
  type: string,
  tick: number,
  err: UnserialisableValueError,
): DiagnosticError {
  const where = `events["${type}"].data${err.path === '' ? '' : `.${err.path}`}`;
  const field = err.path === '' ? '(the whole payload)' : err.path;
  const explained = explainUnserialisable(err.reason, err.detail);
  return new DiagnosticError([
    {
      code:
        err.reason === 'non-finite'
          ? CoreDiagnosticCode.NonFiniteState
          : CoreDiagnosticCode.UnserialisableState,
      severity: 'error',
      message:
        `Cannot emit ${explained.what} in the payload of "${type}" at ${where} — ` +
        `field "${field}", tick ${tick}. ${explained.why} The event log is hashed by ` +
        `EventReader.digest(), so an unencodable payload breaks the determinism proof for the ` +
        `whole run.`,
      location: { path: where },
      fix: explained.fix,
      data: { event: type, tick, field, path: where, reason: err.reason, value: err.detail },
    },
  ]);
}

/** A single emitted event, stamped with the tick on which it was emitted. */
export interface GameEvent<T = unknown> {
  /** Stable event type, e.g. `"PlayerLanded"`. */
  readonly type: string;
  /** Plain, serialisable payload. */
  readonly data: T;
  /** Tick on which the event was emitted. */
  readonly tick: number;
}

/** Write side of the bus, handed to systems during a tick. */
export interface EventWriter {
  /**
   * Emit an event of `type` carrying `data`.
   *
   * `data` is deep-copied and deep-frozen, so passing a live component is safe: the recorded
   * event keeps the values as they were at emission time and cannot be edited afterwards.
   */
  emit<T>(type: string, data: T): void;
}

/** Read side of the bus and the historical log. */
export interface EventReader {
  /** Events emitted on the current tick, in emission order. Frozen. */
  thisTick(): readonly GameEvent[];
  /** Events emitted on the current tick whose type is `type`. Frozen. */
  ofType<T = unknown>(type: string): readonly GameEvent<T>[];
  /**
   * The full recorded log across all ticks so far, frozen. Present only when the simulation
   * was created with event recording enabled (the harness enables it for assertions).
   */
  history(): readonly GameEvent[];
  /** Total number of events of `type` in {@link EventReader.history}. */
  count(type: string): number;
  /** Whether any event of `type` was ever emitted (across history). */
  contains(type: string): boolean;
  /**
   * Deterministic digest of the recorded event stream — same algorithm and shape as
   * {@link "./hash".StateHash}, computed over the canonical encoding of every recorded event
   * (type, tick and payload, in emission order).
   *
   * `World.hash()` covers component state only, so a build whose damage or kill events
   * diverged while component state happened to converge passes every state-hash assertion.
   * This is the digest that catches it. Returns the digest of an empty stream when recording
   * is disabled.
   */
  digest(): StateHash;
}

/** Both ends of the bus. */
export interface EventBus extends EventWriter, EventReader {}

/** Options controlling the bus. */
export interface EventBusOptions {
  /** Retain a full historical log (needed for assertions/replay analysis). Default `false`. */
  record?: boolean;
}

/** Create an event bus. */
export function createEventBus(options?: EventBusOptions): EventBus {
  const record = options?.record ?? false;
  let current: GameEvent[] = [];
  let log: GameEvent[] = [];
  let tick = 0;

  const bus: ManagedEventBus = {
    emit<T>(type: string, data: T): void {
      // The bus owns the copy. Systems routinely emit a live component (`data: trig.data`);
      // without this the recorded event would keep mutating with the world after the fact.
      // The *checked* clone, so a payload the digest cannot encode is refused here — at the
      // system that produced it — instead of at `digest()`, arbitrarily many ticks later.
      let copy: T;
      try {
        copy = deepCloneSerialisable(data);
      } catch (err) {
        if (err instanceof UnserialisableValueError) throw unserialisableAtEmit(type, tick, err);
        throw err;
      }
      const event: GameEvent<T> = deepFreeze({ type, data: deepFreeze(copy), tick });
      current.push(event as GameEvent);
      if (record) log.push(event as GameEvent);
    },
    thisTick(): readonly GameEvent[] {
      return Object.freeze(current.slice());
    },
    ofType<T = unknown>(type: string): readonly GameEvent<T>[] {
      return Object.freeze(current.filter((e) => e.type === type)) as readonly GameEvent<T>[];
    },
    history(): readonly GameEvent[] {
      return Object.freeze(log.slice());
    },
    count(type: string): number {
      let n = 0;
      for (const e of log) if (e.type === type) n++;
      return n;
    },
    contains(type: string): boolean {
      for (const e of log) if (e.type === type) return true;
      return false;
    },
    digest(): StateHash {
      // Same canonical encoding and 64-bit FNV-1a as the state hash, so the two digests are
      // directly comparable and equally reproducible across machines.
      return hashString(
        canonicalStringify(log.map((e) => ({ type: e.type, tick: e.tick, data: e.data }))),
      );
    },
    [CLEAR_TICK](nextTick: number): void {
      current = [];
      tick = nextTick;
    },
    [RESET_LOG](): void {
      current = [];
      log = [];
      tick = 0;
    },
  };
  return bus;
}
