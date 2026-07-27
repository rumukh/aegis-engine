/**
 * The write-boundary contract: what world state may hold, and the equivalence that makes
 * `@aegis/content`'s validator trustworthy.
 *
 * `findUnserialisable` exists so a *validator* can predict a *loader's* rejections. That is only
 * worth anything if the prediction is exact, so the central test here is not "does the checker
 * agree with itself" — it would, by construction, which is a tautology dressed as a test — but a
 * **differential** one: for a corpus of hostile values, `findUnserialisable(v).length === 0`
 * must agree, value for value, with what a *real world* does when the value is stored,
 * snapshotted, hashed, JSON round-tripped and restored.
 *
 * The corpus deliberately contains values that are fine, values that are not, and values that
 * only look fine (`-0`, a `__proto__` key, an empty object, a 128-deep chain that is legal
 * against a 129-deep one that is not), so a checker that simply answered "clean" or "dirty"
 * fails immediately.
 */
import { describe, expect, it } from 'vitest';
import {
  explainUnserialisable,
  findUnserialisable,
  MAX_SERIALISABLE_DEPTH,
} from './serialisable.js';
import { createWorld } from './world.js';
import { defineComponent } from './component.js';
import { DiagnosticError } from './diagnostics.js';
import { CoreDiagnosticCode } from './codes.js';
import { canonicalStringify } from './serialize.js';
import type { UnserialisableReason } from './serialisable.js';
import type { WorldSnapshot } from './serialize.js';

const Box = defineComponent<{ v: unknown }>({ id: 'Box', defaults: () => ({ v: 0 }) });

/** `{a:{a:{…}}}` nested `depth` levels deep, innermost value `1`. */
function chain(depth: number): Record<string, unknown> {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = { a: v };
  return v as Record<string, unknown>;
}

function cyclic(): Record<string, unknown> {
  const node: Record<string, unknown> = { name: 'loop' };
  node['self'] = node;
  return node;
}

/** The corpus. `storable` is the *independently authored* expectation, not a derived one. */
const CORPUS: readonly { label: string; value: unknown; storable: boolean }[] = [
  { label: 'a plain number', value: { v: 1 }, storable: true },
  { label: 'zero', value: { v: 0 }, storable: true },
  { label: 'negative zero (normalised, not rejected)', value: { v: -0 }, storable: true },
  { label: 'a string', value: { v: 'hello' }, storable: true },
  { label: 'a boolean', value: { v: false }, storable: true },
  { label: 'null', value: { v: null }, storable: true },
  { label: 'an empty object', value: { v: {} }, storable: true },
  { label: 'an empty array', value: { v: [] }, storable: true },
  { label: 'a nested tree of scalars', value: { v: { a: [1, 'x', { b: null }] } }, storable: true },
  { label: 'a key literally named __proto__', value: { v: JSON.parse('{"__proto__":1}') }, storable: true }, // prettier-ignore
  { label: 'the largest finite double', value: { v: Number.MAX_VALUE }, storable: true },
  { label: `${MAX_SERIALISABLE_DEPTH - 2} levels deep`, value: { v: chain(MAX_SERIALISABLE_DEPTH - 2) }, storable: true }, // prettier-ignore

  { label: 'NaN', value: { v: NaN }, storable: false },
  { label: 'Infinity', value: { v: Infinity }, storable: false },
  { label: '-Infinity', value: { v: -Infinity }, storable: false },
  { label: "JSON's 1e999, which parses to Infinity", value: JSON.parse('{"v":1e999}'), storable: false }, // prettier-ignore
  { label: 'NaN inside an array', value: { v: [1, 2, NaN] }, storable: false },
  { label: 'NaN three objects down', value: { v: { a: { b: { c: NaN } } } }, storable: false },
  { label: 'an explicit undefined', value: { v: undefined }, storable: false },
  { label: 'an explicit undefined in a nested object', value: { v: { a: undefined } }, storable: false }, // prettier-ignore
  { label: 'an undefined array element', value: { v: [1, undefined] }, storable: false },
  { label: 'a RegExp', value: { v: /x/ }, storable: false },
  { label: 'a Map', value: { v: new Map() }, storable: false },
  { label: 'a class instance', value: { v: new (class Foo {})() }, storable: false },
  { label: 'a function', value: { v: (): number => 1 }, storable: false },
  { label: 'a symbol', value: { v: Symbol('s') }, storable: false },
  { label: 'a bigint', value: { v: 10n }, storable: false },
  { label: 'a cycle', value: { v: cyclic() }, storable: false },
  { label: `${MAX_SERIALISABLE_DEPTH + 2} levels deep`, value: { v: chain(MAX_SERIALISABLE_DEPTH + 2) }, storable: false }, // prettier-ignore
];

/**
 * What a real world does with `value`: `'stored'` when it survives store → snapshot → hash →
 * JSON round trip → restore with an identical hash, `'rejected'` when any of that refuses.
 *
 * This is the oracle. It never consults `findUnserialisable`.
 */
function worldOutcome(value: unknown): 'stored' | 'rejected' {
  try {
    const w = createWorld({ seed: 'oracle' });
    w.spawn(Box(value as { v: unknown }));
    const before = w.hash();
    const restored = createWorld({ seed: 'oracle' });
    restored.restore(JSON.parse(JSON.stringify(w.snapshot())) as WorldSnapshot);
    return restored.hash() === before ? 'stored' : 'rejected';
  } catch {
    return 'rejected';
  }
}

describe('serialisable — the write-boundary contract', () => {
  it('agrees with a real world on every value in the corpus', () => {
    // Both columns are printed for every row rather than asserted one at a time, so a failure
    // names which values disagreed instead of stopping at the first.
    const disagreements = CORPUS.filter(
      ({ value }) =>
        (findUnserialisable(value).length === 0 ? 'stored' : 'rejected') !== worldOutcome(value),
    ).map(({ label }) => label);
    expect(disagreements).toEqual([]);
  });

  it('the corpus is the instrument, so it must contain both answers', () => {
    // Negative control for the test above: if every row were storable (or every row were not),
    // the agreement check would pass against `() => []` and against `() => [problem]` alike.
    const storable = CORPUS.filter((c) => c.storable).length;
    expect(storable).toBeGreaterThan(5);
    expect(CORPUS.length - storable).toBeGreaterThan(10);
    // And the hand-written expectation must match the oracle, or the corpus is mislabelled.
    for (const { label, value, storable: expected } of CORPUS) {
      expect(`${label}: ${worldOutcome(value)}`).toBe(
        `${label}: ${expected ? 'stored' : 'rejected'}`,
      );
    }
  });

  it('names the reason and the path of every problem, not just the first', () => {
    const found = findUnserialisable({
      ok: 1,
      bad: NaN,
      nested: { gone: undefined, list: [0, Infinity] },
    });
    expect(found.map((f) => `${f.path}:${f.reason}`)).toEqual([
      'bad:non-finite',
      'nested.gone:undefined',
      'nested.list[1]:non-finite',
    ]);
  });

  it('stops at `limit`, which is how the write boundary avoids collecting a whole tree', () => {
    const many = { a: NaN, b: NaN, c: NaN };
    expect(findUnserialisable(many).length).toBe(3);
    expect(findUnserialisable(many, { limit: 1 }).length).toBe(1);
  });

  it('prefixes the caller-supplied root path', () => {
    const [first] = findUnserialisable({ x: NaN }, { path: 'entities[0].components.T' });
    expect(first?.path).toBe('entities[0].components.T.x');
  });

  it('the depth cap is a boundary, checked on both sides of it', () => {
    // One-sided depth tests pass against an off-by-one in either direction.
    expect(findUnserialisable(chain(MAX_SERIALISABLE_DEPTH))).toEqual([]);
    expect(findUnserialisable(chain(MAX_SERIALISABLE_DEPTH + 1))[0]?.reason).toBe('too-deep');
  });

  it('a cycle is a diagnostic, not a stack overflow', () => {
    // The regression: `assertFinite` walked the value with no depth cap, so cyclic component
    // data produced `RangeError: Maximum call stack size exceeded` — no path, no component, no
    // entity — where the JSON round-trip it replaced had said "Converting circular structure".
    const w = createWorld({ seed: 1 });
    let thrown: unknown;
    try {
      w.spawn(Box({ v: cyclic() }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DiagnosticError);
    expect(thrown).not.toBeInstanceOf(RangeError);
    const d = (thrown as DiagnosticError).diagnostics[0];
    expect(d?.code).toBe(CoreDiagnosticCode.UnserialisableState);
    expect(d?.data?.['reason']).toBe('too-deep');
    expect(d?.location?.path).toContain('Box.v.self');
  });

  it('every reason has its own wording, so adding one cannot silently reuse another', () => {
    const reasons: UnserialisableReason[] = [
      'non-finite',
      'undefined',
      'too-deep',
      'non-plain',
      'unsupported',
    ];
    const whys = reasons.map((r) => explainUnserialisable(r, 'x').why);
    expect(new Set(whys).size).toBe(reasons.length);
    for (const r of reasons) {
      const e = explainUnserialisable(r, 'x');
      expect(e.what.length).toBeGreaterThan(0);
      expect(e.fix.length).toBeGreaterThan(0);
    }
  });
});

describe('serialisable — `undefined` at the write boundary', () => {
  it('is refused, with the code and reason an agent branches on', () => {
    const w = createWorld({ seed: 1 });
    let thrown: unknown;
    try {
      w.spawn(Box({ v: undefined }));
    } catch (err) {
      thrown = err;
    }
    const d = (thrown as DiagnosticError).diagnostics[0];
    expect(d?.code).toBe(CoreDiagnosticCode.UnserialisableState);
    expect(d?.data?.['reason']).toBe('undefined');
  });

  it('was invisible three separate ways, each of which is asserted here', () => {
    // Why this is a defect and not pedantry. Each `expect` names one of the three symptoms.

    // 1. It overwrote the default rather than merging over it: `{...{v:0}, ...{v:undefined}}`
    //    is `{v: undefined}`, so authoring the field "as absent" silently destroyed the default.
    expect({ ...{ v: 0 }, ...{ v: undefined } }).toEqual({ v: undefined });
    expect(() => Box({ v: undefined })).toThrow(DiagnosticError);

    // 2. The state hash could not see it: the canonical encoder skips undefined-valued keys
    //    exactly as JSON.stringify does, so `{v: undefined}` and `{}` hash identically — the
    //    determinism proof was blind to the difference.
    expect(canonicalStringify({ v: undefined })).toBe(canonicalStringify({}));

    // 3. A save/load round trip deleted the key outright, so a restored world had a different
    //    shape from the one that was saved.
    expect(JSON.stringify({ v: undefined })).toBe('{}');
    expect(Object.keys(JSON.parse(JSON.stringify({ v: undefined })) as object)).toEqual([]);
  });

  it('an *absent* key is still fine — the rule is about explicit undefined', () => {
    const w = createWorld({ seed: 1 });
    const e = w.spawn(Box());
    expect(w.getOrThrow(e, Box).v).toBe(0); // the default survived
    expect(() => w.hash()).not.toThrow();
  });
});
