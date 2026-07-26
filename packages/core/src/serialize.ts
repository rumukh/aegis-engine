/**
 * Canonical world serialisation (CHARTER principle 4).
 *
 * At any tick the entire world serialises to a plain-JSON {@link WorldSnapshot}: agents can
 * diff two ticks, persist a save, or feed a snapshot to the renderer. Serialisation is
 * **canonical** — object keys are emitted in a fixed (sorted) order, `-0` is normalised to
 * `0`, and non-finite numbers (`NaN`, `±Infinity`) are rejected — so the byte stream depends
 * only on state, which is what makes {@link "./hash".hashSnapshot} reproducible.
 * @packageDocumentation
 */
import { notImplemented } from './util.js';
import type { PrngState } from './prng.js';

/** Serialised form of one entity. */
export interface EntitySnapshot {
  /** The entity handle as a decimal string (packed index+generation). */
  readonly id: string;
  /** Optional stable authoring name, when the entity has a `Name` component. */
  readonly name?: string;
  /** Component id → component value, keys emitted in sorted order. */
  readonly components: Readonly<Record<string, unknown>>;
}

/** Serialised form of an entire world at one tick. */
export interface WorldSnapshot {
  /** Snapshot format version, for forward migration. */
  readonly version: 1;
  /** The tick at which this snapshot was taken. */
  readonly tick: number;
  /** All live entities, in ascending slot-index order. */
  readonly entities: readonly EntitySnapshot[];
  /** Resource id → resource value, keys in sorted order. */
  readonly resources: Readonly<Record<string, unknown>>;
  /** PRNG state, so a restored world continues the same stream. */
  readonly prng: PrngState;
}

/**
 * Serialise `value` to a canonical JSON string: keys sorted, `-0`→`0`, and throws on
 * `NaN`/`Infinity`. This is the exact byte source the state hash is computed over.
 */
export function canonicalStringify(value: unknown): string {
  return notImplemented('canonicalStringify');
}

/** Parse a canonical JSON string produced by {@link canonicalStringify}. */
export function canonicalParse<T = unknown>(text: string): T {
  return notImplemented('canonicalParse');
}
