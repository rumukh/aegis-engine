/**
 * Structural deep copy / deep freeze for plain simulation data.
 *
 * **Not** re-exported from `index.ts` — this is internal to `@aegis/core`.
 *
 * The world used to clone component and resource values with
 * `JSON.parse(JSON.stringify(v))`. That is not a structural copy, it is a *lossy round-trip*:
 * `JSON.stringify` maps `NaN` and `±Infinity` to `null`. Because `snapshot()` laundered every
 * value through it before {@link "./serialize".canonicalStringify} ever saw them, the
 * non-finite guard in the canonical encoder could never fire on the world path — the state
 * hash was blind to exactly the values you most want it to catch.
 *
 * ## Where non-finite values are caught, and why it takes two mechanisms
 *
 * Non-finite values — and everything else `serialisable.ts` rejects — are **refused at the write
 * boundary** (`spawn`, `add`, `setResource`, `ComponentType.create`, `EventWriter.emit`), so
 * they are unrepresentable in world state and the snapshot→restore question never arises. That
 * is also the best diagnostic: the error fires at the code that produced the `NaN`.
 *
 * But a system mutating a stored component in place — `world.get(e, C).v = 0 / 0`, the single
 * most common way a simulation produces `NaN` — touches no write boundary and no clone at all.
 * That is why these clones must still *preserve* non-finite values rather than launder them:
 * preserving is what makes the guard in `canonicalStringify` reachable from `snapshot()` and
 * `hash()`, which is the only place a live-mutated `NaN` can be caught without proxying every
 * component read. `snapshot()` turns that into a locating diagnostic naming the entity, the
 * component and the JSON path.
 *
 * Note what is deliberately *not* attempted: making snapshot→restore preserve a non-finite
 * value. `JSON.stringify({v: Infinity})` is `'{"v":null}'` by specification, and CHARTER
 * principle 4 requires the world to serialise to JSON, so a world that can hold a non-finite
 * value cannot round-trip. Rejecting at the boundary is what makes that contradiction moot.
 *
 * `-0` is the one deliberate normalisation: it is mapped to `0`, matching the canonical
 * encoder, so that stored state never holds a value the state hash cannot distinguish.
 *
 * ## Where the rules themselves live
 *
 * `serialisable.ts` states, once, what world state may hold, because `@aegis/content` has to
 * predict these rejections *before* a world exists — a scene that validates clean and then
 * throws on load is the defect that statement closes. `assertSerialisable` below calls it
 * directly. {@link deepCloneSerialisable} does **not**: it checks while it copies, in one pass,
 * because `snapshot()` runs it over every component of every entity on every `hash()` and the
 * harness hashes every tick, so a second traversal cost the fps PoC's acceptance test 29% of
 * its runtime — measured, not assumed. The price is that the rules are expressed twice, so
 * `serialisable.test.ts` holds the two together by comparing this path against
 * `findUnserialisable` over a corpus of hostile values, which is the only reason a second
 * expression is acceptable at all.
 * @packageDocumentation
 */
import { findUnserialisable, MAX_SERIALISABLE_DEPTH } from './serialisable.js';
import type { UnserialisableReason } from './serialisable.js';

/** Depth at which the cloner assumes it has met a cycle. ADR-0002 forbids cyclic data. */
const MAX_DEPTH = MAX_SERIALISABLE_DEPTH;

/**
 * Thrown when a value cannot be stored in world state, carrying the JSON path to the offender
 * and *which* rule it broke, so the caller can build a diagnostic naming the entity and
 * component too.
 */
export class UnserialisableValueError extends Error {
  /** JSON path from the checked root, e.g. `position.x` or `points[2].y`. */
  readonly path: string;
  /** Which rule was broken. Branch on this rather than on the message. */
  readonly reason: UnserialisableReason;
  /** Human-readable rendering of the offender (`NaN`, `undefined`, `a Date instance`). */
  readonly detail: string;

  constructor(path: string, reason: UnserialisableReason, detail: string) {
    super(`[aegis] ${reason} value (${detail}) at "${path || '<root>'}"`);
    this.name = 'UnserialisableValueError';
    this.path = path;
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Deep-copy plain, JSON-shaped data (ADR-0002: components are plain data — no class
 * instances, functions or cyclic refs).
 *
 * Preserves `NaN` and `±Infinity` exactly, so the serialisation guard can see them. Normalises
 * `-0` to `0` to match the canonical encoding — see {@link cloneValue}. Throws on anything that
 * is not plain data, because such a value cannot be serialised or hashed and would otherwise be
 * silently mangled — a `Date`, for instance, canonicalises to `{}`.
 */
export function deepClone<T>(value: T): T {
  return cloneValue(value, 0, false, '') as T;
}

/**
 * Like {@link deepClone}, but additionally rejects anything world state may not hold —
 * `NaN`/`±Infinity`, an explicit `undefined`, a cycle, a class instance — by throwing an
 * {@link UnserialisableValueError} naming the JSON path of the first offender.
 *
 * Checks and copies in **one** traversal. `snapshot()` calls this for every component of every
 * live entity on every `hash()`, and the harness hashes every tick, so walking twice is a
 * measurable tax on the whole engine: expressing it as `assertSerialisable` followed by
 * `deepClone` cost the fps PoC's acceptance test 29% of its runtime. The price of the single
 * pass is a second expression of the rules, so `serialisable.test.ts` compares this path
 * against {@link findUnserialisable} over a hostile corpus — the two are held together by a
 * test rather than by an inlined call.
 */
export function deepCloneSerialisable<T>(value: T): T {
  return cloneValue(value, 0, true, '') as T;
}

/**
 * Throw an {@link UnserialisableValueError} if `value` is not storable in world state, without
 * copying it.
 *
 * Used where a caller-supplied clone will run next: checking the *input* means a component that
 * supplies a lossy `clone` cannot hide a non-finite value by flattening it to `null` on the way
 * past the write boundary.
 *
 * Delegates to {@link findUnserialisable} with `limit: 1`, which is also what makes a cycle a
 * *diagnostic* rather than a `RangeError: Maximum call stack size exceeded`: the shared walk is
 * depth-capped and the hand-written pre-check it replaced was not.
 */
export function assertSerialisable(value: unknown, path = ''): void {
  const found = findUnserialisable(value, { path, limit: 1 });
  const first = found[0];
  if (first !== undefined) {
    throw new UnserialisableValueError(first.path, first.reason, first.detail);
  }
}

function cloneValue(value: unknown, depth: number, checked: boolean, path: string): unknown {
  if (depth > MAX_DEPTH) {
    throw new UnserialisableValueError(
      path,
      'too-deep',
      `nested deeper than ${MAX_DEPTH} levels — simulation data must be a finite, acyclic tree ` +
        `of plain JSON values (ADR-0002)`,
    );
  }
  if (value === null) return null;

  const t = typeof value;
  if (t === 'number') {
    const n = value as number;
    if (checked && !Number.isFinite(n)) {
      throw new UnserialisableValueError(path, 'non-finite', String(n));
    }
    // Normalise -0 to 0, exactly as `canonicalStringify` does (serialize.ts). This is
    // deliberate, not incidental: the state hash cannot distinguish -0 from 0 by design, so
    // letting -0 into stored state would put a value in the world that the determinism proof
    // is blind to — the same class of defect as laundering NaN, in the other direction. It
    // also keeps `world.clone()` and a JSON round-trip restore in agreement, which they are
    // not if -0 survives one path and not the other. `NaN` and `±Infinity` are a different
    // case entirely: those are *reported*, because they are never a legitimate state value.
    return Object.is(n, -0) ? 0 : n;
  }
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'undefined') {
    if (checked) throw new UnserialisableValueError(path, 'undefined', 'undefined');
    return value;
  }

  if (Array.isArray(value)) {
    const out = new Array<unknown>(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = cloneValue(value[i], depth + 1, checked, `${path}[${i}]`);
    }
    return out;
  }

  if (t === 'object') {
    const proto = Object.getPrototypeOf(value as object);
    if (proto !== Object.prototype && proto !== null) {
      throw new UnserialisableValueError(
        path,
        'non-plain',
        `a ${(value as object).constructor?.name ?? 'non-plain'} instance — simulation data must ` +
          `be plain JSON values (ADR-0002); behaviour lives in systems, never on components`,
      );
    }
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      const cloned = cloneValue(src[key], depth + 1, checked, path === '' ? key : `${path}.${key}`);
      if (key === '__proto__') {
        // A document may legitimately author a key named `__proto__` (JSON.parse makes it an
        // own property). Plain assignment would invoke the setter and re-parent the clone
        // instead of storing the value — turning authored data into a prototype.
        Object.defineProperty(out, key, {
          value: cloned,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        out[key] = cloned;
      }
    }
    return out;
  }

  throw new UnserialisableValueError(
    path,
    'unsupported',
    `a value of type "${t}" — components, resources and event payloads must be plain JSON values ` +
      `(ADR-0002)`,
  );
}

/**
 * Recursively freeze a plain data tree in place and return it.
 *
 * Used for recorded events: a log a consumer can rewrite is not an audit log.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
