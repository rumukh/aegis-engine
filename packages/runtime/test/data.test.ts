import { describe, expect, it } from 'vitest';
import {
  applyBoundaryTransforms,
  checkJson,
  isRuntimeSnapshot,
  parseContentJson,
  requireValue,
  schema,
  success,
  validateContent,
  validateReferences,
  validateRuntimeSnapshot,
} from '../src/index.js';
import { config, configSchema, fixture, fixtureAdapter } from './fixture.js';
import type { BoundaryTransform } from '../src/index.js';

describe('DATA: schemas, staged revisions and boundary transforms', () => {
  it('DATA-01: external balance JSON enforces integer bounds and rule variants', () => {
    const registration = { schemaVersion: 1, schema: configSchema };
    expect(parseContentJson(JSON.stringify(config), registration)).toEqual(success(config));
    for (const invalid of [
      { ...config, data: { ...config.data, costs: { free: 0, wait: -1, two: 2 } } },
      { ...config, data: { ...config.data, costs: { free: 0, wait: 1.5, two: 2 } } },
      { ...config, data: { ...config.data, costs: { free: 0, wait: 1, two: 2 }, eval: 'run()' } },
      { ...config, schemaVersion: 90 },
      { ...config, id: '../not-an-id' },
    ]) {
      const result = parseContentJson(JSON.stringify(invalid), registration, 'balance.json');
      expect(result).toMatchObject({
        ok: false,
        error: { diagnostics: [{ file: 'balance.json' }] },
      });
    }
    expect(parseContentJson('{broken', registration)).toMatchObject({
      ok: false,
      error: { code: 'invalid-json' },
    });
    expect(parseContentJson(' '.repeat(11), registration, 'tiny.json', 10)).toMatchObject({
      ok: false,
      error: { code: 'data-limit' },
    });
  });

  it('DATA-01: identifies duplicate/missing references by catalog, record and field', () => {
    const records = [
      { id: 'recipe', references: ['missing'] },
      { id: 'recipe', references: ['known'] },
    ];
    const report = validateReferences(records, ['known'], 'recipes.json');
    expect(report).toEqual([
      {
        code: 'missing-reference',
        message: 'Unknown reference "missing".',
        file: 'recipes.json',
        recordId: 'recipe',
        path: 'references[0]',
      },
      {
        code: 'duplicate-id',
        message: 'Duplicate record ID.',
        file: 'recipes.json',
        recordId: 'recipe',
        path: 'id',
      },
    ]);
    const result = validateContent(config, {
      schemaVersion: 1,
      schema: configSchema,
      validate: () => report,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid-content', diagnostics: report },
    });
  });

  it('rejects closures, nonfinite values, accessors and lossy JSON data without invoking code', () => {
    let invoked = false;
    const getter = {
      get value() {
        invoked = true;
        return 4;
      },
    };
    const array: number[] & { extra?: number } = [1];
    array.extra = 2;
    const cycle: { loop?: unknown } = {};
    cycle.loop = cycle;
    for (const value of [
      { value: Number.NaN },
      { value: undefined },
      { value: () => 1 },
      getter,
      array,
      JSON.parse('{"__proto__":{"polluted":true}}'),
      cycle,
      new Map(),
    ])
      expect(checkJson(value).ok).toBe(false);
    expect(invoked).toBe(false);
    const report = validateContent(config, {
      schemaVersion: 1,
      schema: configSchema,
      validate() {
        throw new Error('broken cross-reference validator');
      },
    });
    expect(report).toMatchObject({ ok: false, error: { code: 'content-validation-failed' } });
  });

  it('K10/DATA-02: edits JSON, stages it and restarts under new balance without changing TypeScript', async () => {
    const host = fixture();
    const editedJson = JSON.stringify(config)
      .replace('"revision":"r1"', '"revision":"r2"')
      .replace('"price":3', '"price":7');
    const candidate = requireValue(
      parseContentJson(editedJson, { schemaVersion: 1, schema: configSchema }),
    );
    requireValue(host.stageContent(candidate));
    expect(host.inspect().content.data.price).toBe(3);
    const before = host.snapshot();
    expect(await host.activateContent(candidate, 'boundary')).toMatchObject({
      ok: false,
      error: { code: 'unsafe-boundary' },
    });
    expect(host.snapshot()).toEqual(before);
    requireValue(await host.activateContent(candidate, 'restart'));
    requireValue(await host.dispatch({ type: 'purchase' }));
    expect(host.inspect().state.charged).toBe(7);
    expect(host.snapshot()).toMatchObject({ turn: 0, revision: 2, content: { revision: 'r2' } });
  });

  it('DATA-02: preserves old rules on invalid, unstaged or revision-reusing candidates', async () => {
    const host = fixture();
    const original = host.snapshot();
    expect(host.stageContent({ ...config, data: { ...config.data, allowance: -1 } }).ok).toBe(
      false,
    );
    expect(host.stageContent({ ...config, data: { ...config.data, price: 8 } })).toMatchObject({
      ok: false,
      error: { code: 'content-revision-reused' },
    });
    expect(await host.activateContent({ ...config, revision: 'new' }, 'restart')).toMatchObject({
      ok: false,
      error: { code: 'unstaged-content' },
    });
    expect(host.snapshot()).toEqual(original);
  });

  it('DATA-02: safe boundary activation rejects pending jobs and actions rather than mixing revisions', async () => {
    const candidate = { ...config, revision: 'r2', data: { ...config.data, price: 4 } };
    const adapter = { ...fixtureAdapter(), canActivateContent: () => true };
    const host = fixture(undefined, { adapter });
    requireValue(await host.dispatch({ type: 'begin' }));
    requireValue(host.stageContent(candidate));
    expect(await host.activateContent(candidate, 'boundary')).toMatchObject({
      ok: false,
      error: { code: 'pending-jobs' },
    });
    requireValue(await host.dispatch({ type: 'phase' }));
    expect(await host.activateContent(candidate, 'boundary')).toMatchObject({
      ok: false,
      error: { code: 'pending-jobs' },
    });
    requireValue(await host.dispatch({ type: 'two' }));
    requireValue(await host.activateContent(candidate, 'boundary'));
    expect(host.inspect().content.revision).toBe('r2');
    expect(host.inspect().phase?.id).toBe('second');
  });

  it('DATA-03: retains exact installed content for old saves; fresh hosts reject mismatches', async () => {
    const original = fixture();
    requireValue(await original.dispatch({ type: 'begin' }));
    const saved = original.snapshot();
    const next = { ...config, revision: 'r2', data: { ...config.data, price: 5 } };
    requireValue(original.stageContent(next));
    requireValue(await original.activateContent(next, 'restart'));
    requireValue(await original.restore(saved));
    expect(original.inspect().content.data.price).toBe(3);
    const onlyNew = fixture(undefined, { content: next });
    expect(await onlyNew.restore(saved)).toMatchObject({
      ok: false,
      error: { code: 'incompatible-save' },
    });
    requireValue(onlyNew.stageContent(config));
    requireValue(await onlyNew.restore(saved));
    requireValue(await onlyNew.dispatch({ type: 'two' }));
    expect(onlyNew.inspect().state.charged).toBe(3);
  });

  it('K07: independent rules read a common pre-boundary state regardless of enumeration order', async () => {
    const state = { slots: [1, 2, 3] };
    const transforms: BoundaryTransform<typeof state>[] = [
      { id: 'left', evaluate: (before) => [{ path: ['slots', 0], value: before.slots[1] ?? 0 }] },
      { id: 'middle', evaluate: (before) => [{ path: ['slots', 1], value: before.slots[0] ?? 0 }] },
    ];
    expect(requireValue(applyBoundaryTransforms(state, transforms))).toEqual({ slots: [2, 1, 3] });
    expect(requireValue(applyBoundaryTransforms(state, [...transforms].reverse()))).toEqual({
      slots: [2, 1, 3],
    });
    expect(state).toEqual({ slots: [1, 2, 3] });
    const host = fixture();
    requireValue(await host.dispatch({ type: 'boundary' }));
    expect(host.inspect().state.slots).toEqual([2, 1, 3]);
    expect(host.getStatus()).toMatchObject({ turn: 0, revision: 1 });
  });

  it('K07: overlapping writes reject deterministically, including parent/child and equivalent array paths', () => {
    const state = { slots: [1, 2] };
    for (const path of [['slots', 0], ['slots'], ['slots', '0']] as const) {
      const rules: BoundaryTransform<typeof state>[] = [
        { id: 'a', evaluate: () => [{ path: ['slots', 0], value: 10 }] },
        { id: 'b', evaluate: () => [{ path, value: 20 }] },
      ];
      const forward = applyBoundaryTransforms(state, rules);
      expect(forward).toMatchObject({ ok: false, error: { code: 'boundary-conflict' } });
      expect(applyBoundaryTransforms(state, [...rules].reverse())).toEqual(forward);
      expect(state).toEqual({ slots: [1, 2] });
    }
    expect(
      applyBoundaryTransforms(state, [
        {
          id: 'bad',
          evaluate: () => [{ path: ['slots', 8], value: 2 }],
        },
      ]),
    ).toMatchObject({ ok: false, error: { code: 'invalid-path' } });
  });

  it('structural snapshot guards reject data errors but leave consumer references to the host', async () => {
    const host = fixture();
    const snapshot = host.snapshot();
    expect(isRuntimeSnapshot(snapshot)).toBe(true);
    expect(validateRuntimeSnapshot(snapshot)).toEqual(success(snapshot));
    expect(isRuntimeSnapshot({ ...snapshot, turn: 0.5 })).toBe(false);
    expect(
      isRuntimeSnapshot({ ...snapshot, world: { ...snapshot.world, prng: { s: [1, 2, 3] } } }),
    ).toBe(false);
    const wrongRegistry = { ...snapshot, adapter: 'other-consumer' };
    expect(isRuntimeSnapshot(wrongRegistry)).toBe(true);
    expect((await host.restore(wrongRegistry)).ok).toBe(false);
  });

  it('schema projections are independent mutable JSON values with exact field and variant checking', () => {
    const shape = schema.object({ count: schema.number({ min: 0, max: 5, integer: true }) });
    const parsed = requireValue(shape.parse({ count: 1 }));
    parsed.count = 2;
    expect(parsed).toEqual({ count: 2 });
    expect(shape.parse({ count: 1, typo: 2 }).ok).toBe(false);
    expect(schema.union(schema.literal('a'), schema.literal('b')).parse('c').ok).toBe(false);
    expect(schema.array(schema.boolean, { min: 2, max: 3 }).parse([true]).ok).toBe(false);
    expect(schema.record(shape).parse({ record: { count: 90 } }).ok).toBe(false);
  });
});
