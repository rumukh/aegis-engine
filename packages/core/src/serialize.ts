/**
 * Canonical world serialisation (CHARTER principle 4).
 *
 * At any tick the entire world serialises to a plain-JSON {@link WorldSnapshot}: agents can
 * diff two ticks, persist a save, or feed a snapshot to the renderer. Serialisation is
 * **canonical** — object keys are emitted in a fixed (sorted) order, `-0` is normalised to
 * `0`, and non-finite numbers (`NaN`, `±Infinity`) are rejected — so the byte stream depends
 * only on state, which is what makes {@link "./hash".hashSnapshot} reproducible.
 *
 * That property belongs to the *snapshot* as well as to {@link canonicalStringify}, and for a
 * while only the encoder had it: `World.snapshot` emitted each entity's components, and the
 * world's resources, in the order the world happened to learn them. Two worlds with an
 * identical `hash()` therefore wrote **different save bytes** after the same operations. The
 * hash was fine (it goes through the sorting encoder); the *save* was not, and a save that
 * differs while the state does not is the one thing a plain-JSON save must never do. `snapshot`
 * now sorts both maps. The surrounding fixed-shape structs (`version`/`tick`/`entities`/… and
 * `id`/`name`/`components`) keep declaration order: they come from object literals, so their
 * order is already invariant, and reading `version` first beats reading `allocator` first.
 * @packageDocumentation
 */
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
  /**
   * Entity-allocator state: the generation of every slot ever created and the free-slot
   * list. Capturing it makes {@link "./world".World.restore} reconstruct the allocator
   * exactly, so a restored world hands out the *same* future entity ids as an uninterrupted
   * run — the property the determinism proof relies on. (Addition to the original contract;
   * see the core handoff notes.)
   */
  readonly allocator: AllocatorSnapshot;
}

/** Serialised state of the entity allocator. */
export interface AllocatorSnapshot {
  /** Generation counter for every slot index `0..slots.length-1`. */
  readonly slots: readonly number[];
  /** Free slot indices, in pop order (the next spawn reuses the last element). */
  readonly free: readonly number[];
}

/**
 * Serialise `value` to a canonical JSON string: keys sorted, `-0`→`0`, and throws on
 * `NaN`/`Infinity`. This is the exact byte source the state hash is computed over.
 */
export function canonicalStringify(value: unknown): string {
  const out: string[] = [];
  encodeCanonical(value, out);
  return out.join('');
}

/** Recursively append the canonical encoding of `value` to `out`. */
function encodeCanonical(value: unknown, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  const t = typeof value;
  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new Error(
        `[aegis] canonicalStringify: non-finite number (${String(n)}) is not serialisable`,
      );
    }
    // Normalise -0 to 0 so the byte stream depends only on numeric value.
    out.push(JSON.stringify(Object.is(n, -0) ? 0 : n));
    return;
  }
  if (t === 'string' || t === 'boolean') {
    out.push(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(',');
      // JSON.stringify emits `null` for a hole or an undefined element; match it exactly so
      // the canonical encoding stays a faithful superset of JSON.
      if (value[i] === undefined) out.push('null');
      else encodeCanonical(value[i], out);
    }
    out.push(']');
    return;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    out.push('{');
    let first = true;
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) continue; // JSON drops undefined-valued keys
      if (!first) out.push(',');
      first = false;
      out.push(JSON.stringify(key));
      out.push(':');
      encodeCanonical(v, out);
    }
    out.push('}');
    return;
  }
  throw new Error(`[aegis] canonicalStringify: value of type "${t}" is not serialisable`);
}

/** Parse a canonical JSON string produced by {@link canonicalStringify}. */
export function canonicalParse<T = unknown>(text: string): T {
  return JSON.parse(text) as T;
}
