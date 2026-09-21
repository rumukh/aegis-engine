import { describe, expect, it } from 'vitest';
import {
  createMinigame,
  createMinigameRegistry,
  exactQuantity,
  MinigameRegistry,
  projectMinigame,
  reduceMinigame,
  restoreMinigame,
  validateMinigame,
} from '../src/index.js';
import type { Json, MinigameAdapter, MinigameDefinition, MinigameState } from '../src/index.js';
import { matchingFixture, orderingFixture, ruleFixture, selectionFixture } from './fixtures.js';

describe('serializable minigame lifecycle', () => {
  const registry = createMinigameRegistry();
  const move = (definition: MinigameDefinition, state: MinigameState, value: Json) =>
    reduceMinigame(definition, state, { type: 'move', revision: state.revision, value }, registry);
  const restore = (definition: MinigameDefinition, state: MinigameState) =>
    restoreMinigame(definition, JSON.parse(JSON.stringify(state)), registry);

  it('selects scene targets non-punitively and emits one stable parent result', () => {
    const definition = selectionFixture(),
      initial = createMinigame(definition, 'selection-run', registry);
    const wrong = move(definition, initial, { target: 'square' });
    expect(wrong.status).toBe('active');
    expect(wrong.progress).toEqual({ found: [], last: 'square' });
    const first = move(definition, wrong, { target: 'circle' });
    const duplicate = move(definition, restore(definition, first), { target: 'circle' });
    expect(duplicate.progress).toEqual(first.progress);
    const final = move(definition, duplicate, { target: 'triangle' });
    expect(final.result).toEqual({
      id: 'selection-run:complete',
      definitionId: 'find-shapes',
      outputs: [{ kind: 'clue', id: 'shapes-clue' }],
    });
    expect(restore(definition, final)).toEqual(final);
    expect(() => move(definition, final, { target: 'triangle' })).toThrow(/already closed/);
    expect(initial.progress).toEqual({ found: [], last: null });
    expect(projectMinigame(definition, first, registry).view).toMatchObject({
      interaction: 'activate-target',
    });
  });

  it('preserves memory selections, requires explicit mismatch clear, and excludes hidden faces', () => {
    const definition = matchingFixture(),
      initial = createMinigame(definition, 'memory-run', registry);
    expect(JSON.stringify(projectMinigame(definition, initial, registry))).not.toContain(
      'secret-fern',
    );
    const first = move(definition, initial, { type: 'select', card: 'a1' });
    const mismatch = move(definition, restore(definition, first), { type: 'select', card: 'b1' });
    expect(mismatch.progress).toEqual({ open: ['a1', 'b1'], matched: [], attempts: 1 });
    expect(() => move(definition, mismatch, { type: 'select', card: 'a2' })).toThrow(
      /cannot be selected/,
    );
    const cleared = move(definition, restore(definition, mismatch), { type: 'clear' });
    expect(JSON.stringify(projectMinigame(definition, cleared, registry))).not.toContain('secret-');
    let state = move(definition, cleared, { type: 'select', card: 'a2' });
    state = move(definition, state, { type: 'select', card: 'a1' });
    expect(() => move(definition, state, { type: 'select', card: 'a1' })).toThrow(
      /cannot be selected/,
    );
    state = move(definition, restore(definition, state), { type: 'select', card: 'b1' });
    state = move(definition, state, { type: 'select', card: 'b2' });
    expect(state.status).toBe('completed');
    expect(state.progress).toEqual({ open: [], matched: ['a2', 'a1', 'b1', 'b2'], attempts: 3 });
    expect(restore(definition, state)).toEqual(state);
  });

  it('uses consumer-authored ordering rather than locale sorting or forced drag', () => {
    const definition = orderingFixture(),
      initial = createMinigame(definition, 'order-run', registry);
    const wrong = move(definition, initial, { type: 'submit' });
    expect(wrong.status).toBe('active');
    const placed = move(definition, wrong, { type: 'place', item: 'c', index: 2 });
    const restored = restore(definition, placed);
    expect(restored.progress).toEqual({ order: ['a', 'b', 'c'], submitted: false, attempts: 1 });
    expect(restored.status).toBe('active');
    const final = move(definition, restored, { type: 'submit' });
    expect(final.status).toBe('completed');
    expect(projectMinigame(definition, final, registry).view).toMatchObject({
      interaction: 'select-item-then-position',
    });
    expect(() => move(definition, initial, { type: 'place', item: 'missing', index: 0 })).toThrow(
      /Unknown reference/,
    );
    expect(() => move(definition, initial, { type: 'place', item: 'a', index: 20 })).toThrow(
      /integer/,
    );
  });

  it('supports explicit suspend, resume, cancel and stale-command rejection', () => {
    const definition = selectionFixture(),
      initial = createMinigame(definition, 'lifecycle', registry);
    const suspended = reduceMinigame(
      definition,
      initial,
      { type: 'suspend', revision: 0 },
      registry,
    );
    expect(() => move(definition, suspended, { target: 'circle' })).toThrow(/suspended/);
    const resumed = reduceMinigame(
      definition,
      restore(definition, suspended),
      { type: 'resume', revision: 1 },
      registry,
    );
    expect(resumed.progress).toEqual(initial.progress);
    expect(() =>
      reduceMinigame(
        definition,
        resumed,
        { type: 'move', revision: 0, value: { target: 'circle' } },
        registry,
      ),
    ).toThrow(/Stale/);
    const cancelled = reduceMinigame(
      definition,
      resumed,
      { type: 'cancel', revision: 2 },
      registry,
    );
    expect(cancelled.status).toBe('cancelled');
    expect(() => move(definition, cancelled, { target: 'circle' })).toThrow(/closed/);
    expect(restore(definition, cancelled)).toEqual(cancelled);
  });

  it('rejects forged completion, duplicated cards and missing configuration references', () => {
    const definition = matchingFixture(),
      initial = createMinigame(definition, 'safe', registry);
    expect(() =>
      restoreMinigame(definition, { ...initial, status: 'completed' }, registry),
    ).toThrow(/Completion disagrees/);
    expect(() =>
      restoreMinigame(
        definition,
        { ...initial, progress: { open: ['a1'], matched: ['a1'], attempts: 1 } },
        registry,
      ),
    ).toThrow(/both matched and open/);
    expect(() =>
      restoreMinigame(
        definition,
        { ...initial, progress: { open: [], matched: ['a1'], attempts: 1 } },
        registry,
      ),
    ).toThrow(/Incomplete matched pair/);
    expect(() => validateMinigame({ ...definition, adapterSchema: 2 }, registry)).toThrow(
      /version mismatch/,
    );
    expect(() => validateMinigame({ ...definition, kind: 'missing' }, registry)).toThrow(
      /Unregistered/,
    );
    expect(() =>
      validateMinigame(
        {
          ...definition,
          config: { cards: [{ id: 'only', pair: 'one', labelKey: 'one', backLabelKey: 'back' }] },
        },
        registry,
      ),
    ).toThrow(/exactly two/);
    expect(() =>
      restoreMinigame(definition, { ...initial, contentRevision: 'two' }, registry),
    ).toThrow(/mismatch/);
  });

  it.each(['quantity', 'causal', 'media', 'selection'] as const)(
    'executes the %s rule fixture through the same contract',
    (kind) => {
      const definition: MinigameDefinition = {
        schema: 1,
        id: kind,
        revision: 'one',
        kind: 'rule-table',
        adapterSchema: 1,
        config: JSON.parse(JSON.stringify(ruleFixture(kind))),
        outputs: [],
      };
      let state = createMinigame(definition, `${kind}-run`, registry);
      if (kind === 'quantity') {
        state = move(definition, state, { move: 'half' });
        expect(state.progress).toEqual({ at: 'two' });
        state = move(definition, restore(definition, state), { move: 'quarter' });
      } else {
        state = move(definition, state, { move: 'try' });
        const view = projectMinigame(definition, state, registry).view;
        expect(view).toMatchObject({ interaction: 'activate-choice' });
        expect(JSON.stringify(view)).toContain('alternativeKey');
        state = move(definition, restore(definition, state), { move: 'solve' });
      }
      expect(state.status).toBe('completed');
      expect(restore(definition, state)).toEqual(state);
    },
  );

  it('represents exact halves and quarters with bounded integer units', () => {
    expect(exactQuantity(1, 2, 4)).toBe(2);
    expect(exactQuantity(3, 4, 4)).toBe(3);
    expect(() => exactQuantity(1, 3, 4)).toThrow(/cannot be expressed/);
    expect(() => exactQuantity(0.5, 1, 4)).toThrow(/integer/);
    expect(() => exactQuantity(1, 0, 4)).toThrow(/integer/);
  });

  it('lets a consumer register a typed custom adapter without engine edits', () => {
    const adapter: MinigameAdapter<number, number, number, { count: number }> = {
      kind: 'counter',
      schema: 1,
      config: (value) => {
        if (value !== 2) throw new Error('bad config');
        return value;
      },
      state: (value) => {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2)
          throw new Error('bad state');
        return value;
      },
      action: (value) => {
        if (value !== 1) throw new Error('bad action');
        return value;
      },
      initial: () => 0,
      reduce: (_config, state, action) => state + action,
      project: (_config, state) => ({ count: state }),
      completed: (config, state) => state === config,
    };
    const custom = new MinigameRegistry().register(adapter);
    expect(() => custom.register(adapter)).toThrow(/already registered/);
    const definition: MinigameDefinition = {
      schema: 1,
      id: 'custom',
      revision: 'one',
      kind: 'counter',
      adapterSchema: 1,
      config: 2,
      outputs: [],
    };
    const state = createMinigame(definition, 'custom-run', custom);
    const one = reduceMinigame(definition, state, { type: 'move', revision: 0, value: 1 }, custom);
    const two = reduceMinigame(definition, one, { type: 'move', revision: 1, value: 1 }, custom);
    expect(two.result?.id).toBe('custom-run:complete');
    expect(projectMinigame(definition, two, custom).view).toEqual({ count: 2 });
  });
});
