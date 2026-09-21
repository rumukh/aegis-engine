import { cloneData, freezeData, isRecord } from './data.js';
import type { DeepReadonly, JsonValue } from './data.js';
import { caughtFailure, failure, fault, success } from './outcome.js';
import type { Outcome } from './outcome.js';

export interface BoundaryWrite {
  readonly path: readonly (string | number)[];
  readonly value: JsonValue;
}

export interface BoundaryTransform<S> {
  readonly id: string;
  evaluate(before: DeepReadonly<S>): readonly BoundaryWrite[];
}

/** All rules read one immutable pre-boundary state. Overlapping writes are conflicts, not cascades. */
export function applyBoundaryTransforms<S>(
  state: S,
  transforms: readonly BoundaryTransform<S>[],
): Outcome<S> {
  try {
    const before = freezeData(cloneData(state));
    const ids = new Set<string>();
    const writes: { rule: string; write: BoundaryWrite }[] = [];
    for (const transform of [...transforms].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      if (ids.has(transform.id))
        return failure('duplicate-rule', 'Duplicate boundary rule.', { ruleId: transform.id });
      ids.add(transform.id);
      for (const write of transform.evaluate(before)) {
        if (write.path.length === 0)
          return failure('invalid-path', 'Boundary writes need a field path.', {
            ruleId: transform.id,
          });
        for (const prior of writes) {
          const overlap = prior.write.path
            .slice(0, Math.min(prior.write.path.length, write.path.length))
            .every((part, index) => String(part) === String(write.path[index]));
          if (overlap)
            return failure(
              'boundary-conflict',
              `Rules "${prior.rule}" and "${transform.id}" write overlapping paths.`,
              { path: write.path.join('.'), ruleId: transform.id },
            );
        }
        writes.push({ rule: transform.id, write: cloneData(write) });
      }
    }
    const next = cloneData(state);
    for (const { write } of writes) {
      let target: unknown = next;
      for (const [index, key] of write.path.entries()) {
        if ((!isRecord(target) && !Array.isArray(target)) || !Object.hasOwn(target, key)) {
          fault(
            'invalid-path',
            'Boundary writes must address an existing own field.',
            write.path.join('.'),
          );
        }
        if (Array.isArray(target)) {
          if (
            typeof key !== 'number' ||
            !Number.isSafeInteger(key) ||
            key < 0 ||
            key >= target.length
          ) {
            fault('invalid-path', 'Array boundary paths require in-range integer indices.');
          }
          if (index === write.path.length - 1) target[key] = cloneData(write.value);
          else target = target[key];
        } else {
          if (index === write.path.length - 1) {
            Object.defineProperty(target, key, {
              value: cloneData(write.value),
              enumerable: true,
              writable: true,
              configurable: true,
            });
          } else target = target[key];
        }
      }
    }
    return success(next);
  } catch (error) {
    return caughtFailure(error, 'boundary-failed');
  }
}
