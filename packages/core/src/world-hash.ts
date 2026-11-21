import { deepCloneSerialisable } from './clone.js';
import { canonicalStringify } from './serialize.js';

// World.get(), query views and getResource() hand systems mutable references. Identity, tick
// and write-boundary dirty flags cannot prove a cached encoding is still valid. Compare with
// the last *detached, checked* value. Its finite depth also bounds this walk on a new cycle.
function sameData(value: unknown, checked: unknown): boolean {
  if (value === checked) return true; // includes +0 / -0, which have the same canonical bytes
  if (
    value === null ||
    checked === null ||
    typeof value !== 'object' ||
    typeof checked !== 'object'
  )
    return false;
  if (Array.isArray(value)) {
    if (!Array.isArray(checked) || value.length !== checked.length) return false;
    for (let i = 0; i < value.length; i++) if (!sameData(value[i], checked[i])) return false;
    return true;
  }
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(checked) || (proto !== Object.prototype && proto !== null)) return false;
  const keys = Object.keys(value);
  if (keys.length !== Object.keys(checked).length) return false;
  for (const key of keys) {
    if (
      !Object.hasOwn(checked, key) ||
      !sameData((value as Record<string, unknown>)[key], (checked as Record<string, unknown>)[key])
    )
      return false;
  }
  return true;
}

/** Reuse validated component/resource encodings, never a digest keyed by object identity. */
export function worldValueEncoder(): (value: unknown) => string {
  const cache = new WeakMap<object, { checked: unknown; text: string }>();
  return (value) => {
    if (value === null || typeof value !== 'object')
      return canonicalStringify(deepCloneSerialisable(value));
    const previous = cache.get(value);
    if (previous !== undefined && sameData(value, previous.checked)) return previous.text;
    const checked = deepCloneSerialisable(value);
    const text = canonicalStringify(checked);
    cache.set(value, { checked, text });
    return text;
  };
}

/** Keys must be sorted even for integer-looking ids: native object enumeration isn't lexical. */
export function encodedRecord(values: Record<string, string>): string {
  return (
    '{' +
    Object.keys(values)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + values[key])
      .join(',') +
    '}'
  );
}
