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
 * hash was blind to exactly the values you most want it to catch, and snapshot→restore was
 * silently lossy (a live `Infinity` came back as `null`, so `v * 2 + 1` was `Infinity` before
 * a round trip and `1` after, breaking the round-trip contract the determinism proof rests on).
 *
 * These clones preserve every value bit-for-bit — `NaN` and `±Infinity` included — so the
 * guard fires as designed and a NaN introduced by a divide-by-zero or a `sqrt` of a negative
 * surfaces at the next `snapshot()` instead of vanishing. `-0` is the one deliberate
 * exception: it is normalised to `0`, matching the canonical encoder, so that stored state
 * never holds a value the state hash cannot distinguish.
 * @packageDocumentation
 */

/** Depth at which the cloner assumes it has met a cycle. ADR-0002 forbids cyclic data. */
const MAX_DEPTH = 128;

/**
 * Thrown by {@link deepCloneSerialisable} on a non-finite number, carrying the JSON path to the
 * offender so the caller can build a diagnostic that names the entity and component too.
 */
export class NonFiniteValueError extends Error {
  /** JSON path from the cloned root, e.g. `position.x` or `points[2].y`. */
  readonly path: string;
  /** The offending value (`NaN`, `Infinity` or `-Infinity`). */
  readonly value: number;

  constructor(path: string, value: number) {
    super(`[aegis] non-finite number (${String(value)}) at "${path || '<root>'}"`);
    this.name = 'NonFiniteValueError';
    this.path = path;
    this.value = value;
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
 * Like {@link deepClone}, but additionally rejects `NaN`/`±Infinity` by throwing a
 * {@link NonFiniteValueError} naming the JSON path of the first offender.
 */
export function deepCloneSerialisable<T>(value: T): T {
  return cloneValue(value, 0, true, '') as T;
}

function cloneValue(value: unknown, depth: number, checked: boolean, path: string): unknown {
  if (depth > MAX_DEPTH) {
    throw new Error(
      `[aegis] deepClone: value nested deeper than ${MAX_DEPTH} levels at "${path}" — ` +
        `simulation data must be a finite, acyclic tree of plain JSON values (ADR-0002).`,
    );
  }
  if (value === null) return null;

  const t = typeof value;
  if (t === 'number') {
    const n = value as number;
    if (checked && !Number.isFinite(n)) throw new NonFiniteValueError(path, n);
    // Normalise -0 to 0, exactly as `canonicalStringify` does (serialize.ts). This is
    // deliberate, not incidental: the state hash cannot distinguish -0 from 0 by design, so
    // letting -0 into stored state would put a value in the world that the determinism proof
    // is blind to — the same class of defect as laundering NaN, in the other direction. It
    // also keeps `world.clone()` and a JSON round-trip restore in agreement, which they are
    // not if -0 survives one path and not the other. `NaN` and `±Infinity` are a different
    // case entirely: those are *reported*, because they are never a legitimate state value.
    return Object.is(n, -0) ? 0 : n;
  }
  if (t === 'string' || t === 'boolean' || t === 'undefined') return value;

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
      throw new Error(
        `[aegis] deepClone: value at "${path || '<root>'}" is a ` +
          `${(value as object).constructor?.name ?? 'non-plain'} instance. Simulation data must ` +
          `be plain JSON values — objects, arrays, numbers, strings, booleans and null ` +
          `(ADR-0002). Behaviour lives in systems, never on components.`,
      );
    }
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      out[key] = cloneValue(src[key], depth + 1, checked, path === '' ? key : `${path}.${key}`);
    }
    return out;
  }

  throw new Error(
    `[aegis] deepClone: value of type "${t}" at "${path || '<root>'}" is not simulation data. ` +
      `Components, resources and event payloads must be plain JSON values (ADR-0002).`,
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
