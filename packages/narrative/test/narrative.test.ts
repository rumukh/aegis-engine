import { describe, expect, it } from 'vitest';
import {
  advanceNarrative,
  createNarrativeState,
  projectNarrative,
  restoreNarrative,
  ToolkitError,
  validateNarrative,
} from '../src/index.js';
import type { ConsumerEffects, NarrativeGraph, NarrativeState } from '../src/index.js';
import { storyFixture } from './fixtures.js';

const choose = (
  graph: NarrativeGraph,
  state: NarrativeState,
  choice: string,
  handlers: ConsumerEffects = {},
) =>
  advanceNarrative(graph, state, { node: state.node, revision: state.revision, choice }, handlers);
const roundtrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('narrative graph and atomic story effects', () => {
  it('persists cross-period flags, consumes an item once, and fixes an exclusive ending', () => {
    const graph = storyFixture();
    const start = createNarrativeState(graph);
    expect(start.items.ticket).toBe(1);
    expect(start.collected.clue).toEqual(['clue-a']);
    const period = choose(graph, start, 'help');
    expect(period.flags).toEqual({ helped: true, later: true });
    const restored = restoreNarrative(graph, roundtrip(period));
    const end = choose(graph, restored, 'finish');
    expect(end.items.ticket).toBe(0);
    expect(end.ending).toBe('shared-walk');
    expect(end.collected.reward).toEqual(['paper-star']);
    expect(end.collected.completion).toEqual(['walk-complete']);
    expect(restoreNarrative(graph, roundtrip(end))).toEqual(end);
    expect(choose(graph, period, 'finish')).toEqual(end);
    expect(() => choose(graph, end, 'finish')).toThrow(/already ended/);
    expect(start.items.ticket).toBe(1);
    expect(start.flags.later).toBe(false);
  });

  it('selects the consumer ordered alternative ending without hardcoded campaign rules', () => {
    const graph = storyFixture();
    const state = choose(graph, choose(graph, createNarrativeState(graph), 'skip'), 'finish');
    expect(state.ending).toBe('quiet-walk');
    const reordered = { ...graph, endings: [...graph.endings].reverse() };
    const firstEligible = choose(
      reordered,
      choose(reordered, createNarrativeState(reordered), 'help'),
      'finish',
    );
    expect(firstEligible.ending).toBe('quiet-walk');
    expect(restoreNarrative(graph, firstEligible).ending).toBe('quiet-walk');
  });

  it('permits explicit manual revisits without replaying entry claims', () => {
    const graph = storyFixture();
    const start = createNarrativeState(graph);
    const revisited = choose(graph, choose(graph, choose(graph, start, 'look'), 'help'), 'back');
    expect(revisited.visits.room).toBe(3);
    expect(revisited.items.ticket).toBe(1);
    expect(revisited.claims.filter((key) => key === 'first-ticket')).toHaveLength(1);
    expect(restoreNarrative(graph, roundtrip(revisited))).toEqual(revisited);
    graph.nodes[0]!.revisit = 'forbid';
    expect(() => choose(graph, start, 'look')).toThrow(/cannot be revisited/);
  });

  it('rejects hidden, unknown and stale choices without partial changes', () => {
    const graph = storyFixture(),
      state = createNarrativeState(graph);
    const before = JSON.stringify(state);
    expect(projectNarrative(graph, state).choices.find((c) => c.id === 'disabled')?.enabled).toBe(
      false,
    );
    for (const choice of ['disabled', 'unknown'])
      expect(() => choose(graph, state, choice)).toThrow(/Unknown or disabled/);
    expect(() =>
      advanceNarrative(graph, state, { node: 'period', revision: 0, choice: 'help' }),
    ).toThrow(/Stale/);
    expect(() =>
      advanceNarrative(graph, state, { node: state.node, revision: 2, choice: 'help' }),
    ).toThrow(/Stale/);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('bounds automatic cycles and does not publish their staged effects', () => {
    const graph = storyFixture();
    graph.nodes[1]!.automatic = [
      { id: 'cycle', to: 'period', guard: null, effects: ['star-grant'] },
    ];
    const start = createNarrativeState(graph);
    expect(() => choose(graph, start, 'help')).toThrow(/period:cycle.*period:cycle/);
    expect(start.collected.reward).toEqual([]);
    expect(start.flags.helped).toBe(false);
  });

  it('settles finite automatic paths and refuses half-settled restores', () => {
    const graph = storyFixture();
    graph.nodes[1]!.automatic = [
      { id: 'finish-auto', to: 'end', guard: null, effects: ['spend-ticket'] },
    ];
    const end = choose(graph, createNarrativeState(graph), 'help');
    expect(end.ending).toBe('shared-walk');
    expect(end.items.ticket).toBe(0);
    const other = storyFixture();
    const period = choose(other, createNarrativeState(other), 'help');
    expect(() => restoreNarrative(graph, period)).toThrow(/committed narrative boundary/);
  });

  it('preflights consumer dependencies and applies only declared atomic writes', () => {
    const graph = storyFixture();
    graph.data = ['score', 'total'];
    graph.effects.push({
      id: 'consumer-once',
      kind: 'consumer',
      handler: 'double',
      reads: ['score'],
      writes: ['total'],
      payload: { factor: 2 },
    });
    graph.nodes[0]!.choices[1]!.effects = ['helped-once', 'consumer-once'];
    const handlers: ConsumerEffects = {
      double: {
        validate(payload) {
          if (JSON.stringify(payload) !== '{"factor":2}')
            throw new ToolkitError('PAYLOAD', '$.payload', 'Invalid factor.', 'Use 2.');
        },
        apply(_payload, inputs) {
          expect(Object.keys(inputs)).toEqual(['score']);
          if (typeof inputs.score !== 'number')
            throw new ToolkitError('SCORE', '$.score', 'Expected a score.', 'Use a number.');
          return { total: inputs.score * 2 };
        },
      },
    };
    const missing = createNarrativeState(graph, { data: { score: 3 } }, handlers);
    expect(() => choose(graph, missing, 'help', handlers)).toThrow(/dependency is missing/);
    expect(missing.flags.helped).toBe(false);
    const start = createNarrativeState(graph, { data: { score: 3, total: 0 } }, handlers);
    const period = choose(graph, start, 'help', handlers);
    expect(period.data).toEqual({ score: 3, total: 6 });
    expect(start.data.total).toBe(0);
    expect(restoreNarrative(graph, period, handlers).data.total).toBe(6);
    const wrong: ConsumerEffects = {
      double: { validate: () => {}, apply: () => ({ unexpected: 10 }) },
    };
    expect(() => choose(graph, start, 'help', wrong)).toThrow(/declared writes/);
    expect(start.claims).not.toContain('helped-once');
  });

  it('does not leak mutation by an impure consumer into prior state', () => {
    const graph = storyFixture();
    graph.data = ['bag'];
    graph.effects.push({
      id: 'mutate',
      kind: 'consumer',
      handler: 'mutate',
      reads: ['bag'],
      writes: ['bag'],
      payload: null,
    });
    graph.nodes[0]!.choices[1]!.effects = ['mutate'];
    const handlers: ConsumerEffects = {
      mutate: {
        validate() {},
        apply(_payload, inputs) {
          if (Array.isArray(inputs.bag)) inputs.bag.push('new');
          throw new ToolkitError('REJECT', '$', 'Rejected.', 'Try another choice.');
        },
      },
    };
    const state = createNarrativeState(graph, { data: { bag: ['old'] } }, handlers);
    expect(() => choose(graph, state, 'help', handlers)).toThrow(/Rejected/);
    expect(state.data.bag).toEqual(['old']);
  });

  it.each(['node', 'asset', 'effect', 'guard', 'schema'] as const)(
    'diagnoses missing %s references',
    (kind) => {
      const graph = storyFixture();
      if (kind === 'node') graph.nodes[0]!.choices[0]!.to = 'absent';
      if (kind === 'asset') graph.nodes[0]!.narration = 'absent';
      if (kind === 'effect') graph.nodes[0]!.entryEffects.push('absent');
      if (kind === 'guard')
        graph.nodes[0]!.choices[0]!.guard = { kind: 'flag', id: 'absent', value: true };
      const input = kind === 'schema' ? { ...graph, schema: 99 } : graph;
      const result = validateNarrative(input);
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]?.location?.path).toBeTruthy();
      expect(result.diagnostics[0]?.fix).toBeTruthy();
    },
  );

  it('rejects corrupt claims, mismatched content and missing entry records on restore', () => {
    const graph = storyFixture(),
      state = createNarrativeState(graph);
    expect(() => restoreNarrative(graph, { ...state, contentRevision: 'two' })).toThrow(/mismatch/);
    expect(() => restoreNarrative(graph, { ...state, claims: [] })).toThrow(
      /Claims and collection disagree/,
    );
    expect(() =>
      restoreNarrative(graph, {
        ...state,
        claims: state.claims.filter((key) => key !== 'first-ticket'),
      }),
    ).toThrow(/missing entry claims/);
    expect(() => restoreNarrative(graph, { ...state, items: { ticket: -1 } })).toThrow(/integer/);
    expect(() =>
      restoreNarrative(graph, {
        ...state,
        collected: { ...state.collected, reward: ['paper-star'] },
      }),
    ).toThrow(/Claims and collection disagree/);
  });

  it('provides localizable typed command errors and rejects unsafe input', () => {
    const graph = storyFixture(),
      state = createNarrativeState(graph);
    try {
      choose(graph, state, 'missing');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolkitError);
      if (error instanceof ToolkitError) {
        expect(error.code).toBe('AEG-NARRATIVE-CHOICE');
        expect(error.messageKey).toBe('aegis.narrative.choice');
        expect(error.path).toBe('$.command.choice');
      }
    }
    expect(validateNarrative({ ...graph, data: ['constructor'] }).ok).toBe(false);
    expect(validateNarrative({ ...graph, extra: () => 1 }).ok).toBe(false);
    expect(validateNarrative(JSON.parse('{"__proto__":{},"schema":1}')).ok).toBe(false);
  });
});
