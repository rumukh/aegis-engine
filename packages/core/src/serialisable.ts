/**
 * What world state is allowed to hold, stated once, as data.
 *
 * Three write boundaries (`spawn`/`add`/`setResource`, `ComponentType.create`, and
 * `EventWriter.emit`) reject values the world cannot serialise, and one *validator*
 * (`@aegis/content`'s `validateScene`) has to predict those rejections before the world
 * exists — because a document that validates clean and then throws on load is the worst shape
 * a defect can take in an agent-first engine: the tool that exists to catch the problem says
 * the problem is not there.
 *
 * Predicting a rejection with a second, hand-maintained rule list is how the two drift apart.
 * So the rules live here, once, as a traversal that *reports* rather than throws
 * ({@link findUnserialisable}); `clone.ts` turns the first report into the boundary throw, and
 * `@aegis/content` turns every report into a diagnostic. One definition, two presentations.
 *
 * ## What is rejected, and why each one is not merely pedantry
 *
 * | Reason           | Example                    | What it does if let through                                        |
 * | ---------------- | -------------------------- | ------------------------------------------------------------------ |
 * | `non-finite`     | `NaN`, `1e999` from JSON   | `JSON.stringify` writes `null`; the state hash cannot see it        |
 * | `undefined`      | `{ x: undefined }`         | survives the write, invisible to the hash, **deleted** by a save    |
 * | `too-deep`       | a cycle, or 200 levels     | unbounded recursion — a stack overflow, not a diagnostic            |
 * | `non-plain`      | `new Date()`, a `Map`      | canonicalises to `{}` — data silently becomes nothing               |
 * | `unsupported`    | a function, a `Symbol`     | not JSON at all                                                     |
 *
 * `-0` is deliberately **absent**: it is normalised to `0` on the way in (see `clone.ts`), not
 * rejected, because unlike the five above it has an exact, lossless representative.
 * @packageDocumentation
 */

/**
 * Depth at which a traversal assumes it has met a cycle.
 *
 * ADR-0002 forbids cyclic data, and nothing legitimate in a component nests this far, so the
 * cap doubles as the cycle detector: a cycle is simply data that never gets shallower. That
 * matters more than it sounds — the alternative is a `RangeError: Maximum call stack size
 * exceeded` with no path, no component and no entity in it.
 */
export const MAX_SERIALISABLE_DEPTH = 128;

/** Why a value cannot be stored in world state. */
export type UnserialisableReason =
  /** `NaN` or `±Infinity`. */
  | 'non-finite'
  /** An own property explicitly present with the value `undefined`. */
  | 'undefined'
  /** Nested deeper than {@link MAX_SERIALISABLE_DEPTH} — in practice, a cycle. */
  | 'too-deep'
  /** An object with a prototype other than `Object.prototype` or `null`. */
  | 'non-plain'
  /** A `function`, `symbol` or `bigint` — no JSON representation at all. */
  | 'unsupported';

/** One reason one value cannot be stored, with the JSON path that locates it. */
export interface UnserialisableValue {
  /** JSON path from the traversal root, e.g. `position.x` or `points[2].y`. Empty at the root. */
  readonly path: string;
  /** Which rule was broken. Branch on this; {@link UnserialisableValue.detail} is for humans. */
  readonly reason: UnserialisableReason;
  /** Human-readable description of the offending value, safe to put in a message. */
  readonly detail: string;
}

/** Options for {@link findUnserialisable}. */
export interface FindUnserialisableOptions {
  /** JSON path the traversal root sits at, prefixed onto every report. Default `''`. */
  path?: string;
  /** Stop after this many reports. Default: unlimited. The write boundary passes `1`. */
  limit?: number;
}

/** How a rejected value should be explained to whoever has to fix it. */
export interface UnserialisableExplanation {
  /** What was written, phrased to slot into "Cannot write …". */
  readonly what: string;
  /** Why the format cannot hold it. */
  readonly why: string;
  /** What to do about it. */
  readonly fix: string;
}

/**
 * The one place each rejection reason is put into words.
 *
 * Every write boundary and `@aegis/content`'s validator quote this, so "why can't I store a
 * `Date`?" has exactly one answer wherever it is asked, and adding a reason cannot leave one
 * caller silently describing it as something else.
 */
export function explainUnserialisable(
  reason: UnserialisableReason,
  detail: string,
): UnserialisableExplanation {
  switch (reason) {
    case 'non-finite':
      return {
        what: `a non-finite number (${detail})`,
        why:
          'World state must serialise to JSON (CHARTER principle 4), and JSON has no ' +
          'representation for NaN or ±Infinity — it would be silently written out as null.',
        fix:
          `Guard the computation that produced ${detail} — a divide-by-zero, a sqrt of a ` +
          `negative, an uninitialised accumulator, or an out-of-domain angle. Clamp the input, ` +
          `or use a sentinel the format can hold (null, or a finite bound).`,
      };
    case 'undefined':
      return {
        what: 'an explicit `undefined`',
        why:
          'JSON has no `undefined`: the key survives the write, is invisible to the state hash ' +
          '(the canonical encoder skips it, exactly as JSON.stringify does), and is then ' +
          'deleted by a save/load round trip — so the world silently changes shape across a ' +
          'restore. It also overwrites the default the field would otherwise have kept.',
        fix:
          'Omit the key entirely to keep the default, or write `null` if "no value" is a state ' +
          'the field is meant to hold.',
      };
    case 'too-deep':
      return {
        what: `a value ${detail}`,
        why:
          'Cyclic and unbounded data cannot be cloned, hashed or written to a save file ' +
          '(ADR-0002 requires a finite, acyclic tree).',
        fix:
          'Store a reference (an entity id or a key) instead of an object graph, and keep ' +
          'component data flat enough to read in a diff.',
      };
    case 'non-plain':
      return {
        what: detail,
        why:
          'Simulation data must be plain JSON values — objects, arrays, numbers, strings, ' +
          'booleans and null (ADR-0002). A class instance canonicalises to {}, so the data ' +
          'would silently become nothing.',
        fix: 'Store the plain fields you need, and keep behaviour in systems, never on components.',
      };
    case 'unsupported':
      return {
        what: detail,
        why: 'Components, resources and event payloads must be plain JSON values (ADR-0002).',
        fix: 'Store a plain JSON representation instead.',
      };
  }
}

/** Short, safe rendering of a value for a diagnostic message. */
function describe(value: unknown): string {
  const t = typeof value;
  if (t === 'function') return 'a function';
  if (t === 'symbol') return 'a symbol';
  if (t === 'bigint') return `a bigint (${String(value)}n)`;
  if (t === 'number') return String(value);
  if (t === 'undefined') return 'undefined';
  if (value === null) return 'null';
  const name = (value as object).constructor?.name;
  return `a ${name === undefined || name === '' ? 'non-plain' : name} instance`;
}

/**
 * Every reason `value` would be rejected by a world write boundary, in traversal order.
 *
 * Empty means the value is storable: it will clone, snapshot, hash, survive a JSON round trip
 * and restore identically. That equivalence is the contract, and it is asserted directly
 * against a real world in `serialisable.test.ts` rather than assumed.
 *
 * @param value - Any candidate component value, resource value or event payload.
 * @param options - Root path to prefix, and a cap on how many problems to collect.
 * @returns Problems found, in traversal order; empty when the value is storable.
 */
export function findUnserialisable(
  value: unknown,
  options: FindUnserialisableOptions = {},
): readonly UnserialisableValue[] {
  const out: UnserialisableValue[] = [];
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  walk(value, options.path ?? '', 0, out, limit);
  return out;
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  out: UnserialisableValue[],
  limit: number,
): void {
  if (out.length >= limit) return;
  if (depth > MAX_SERIALISABLE_DEPTH) {
    out.push({
      path,
      reason: 'too-deep',
      detail:
        `nested deeper than ${MAX_SERIALISABLE_DEPTH} levels — simulation data must be a ` +
        `finite, acyclic tree of plain JSON values (ADR-0002), so this is almost certainly a cycle`,
    });
    return;
  }
  if (value === null) return;

  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      out.push({ path, reason: 'non-finite', detail: describe(value) });
    }
    return;
  }
  if (t === 'string' || t === 'boolean') return;
  if (t === 'undefined') {
    out.push({ path, reason: 'undefined', detail: 'undefined' });
    return;
  }
  if (t !== 'object') {
    out.push({ path, reason: 'unsupported', detail: describe(value) });
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], `${path}[${i}]`, depth + 1, out, limit);
      if (out.length >= limit) return;
    }
    return;
  }

  const proto = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) {
    out.push({ path, reason: 'non-plain', detail: describe(value) });
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    walk(obj[key], path === '' ? key : `${path}.${key}`, depth + 1, out, limit);
    if (out.length >= limit) return;
  }
}
