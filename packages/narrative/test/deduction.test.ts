import { describe, expect, it } from 'vitest';
import {
  createNotebook,
  inspectDeduction,
  nextHint,
  parseDeduction,
  proposeNotebookMarks,
  restoreNotebook,
  requireValid,
  setNotebookMark,
  solveDeduction,
  validateDeduction,
  ToolkitError,
} from '../src/index.js';
import type { HintTier, NotebookMark, Predicate } from '../src/index.js';
import { deductionFixture } from './fixtures.js';

function countLargeCandidateEnumerations(run: () => void): number {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'flatMap');
  if (!descriptor) throw new Error('Array.flatMap descriptor is unavailable');
  const original = Array.prototype.flatMap;
  let enumerations = 0;
  Object.defineProperty(Array.prototype, 'flatMap', {
    ...descriptor,
    value(this: unknown[], ...args: unknown[]): unknown {
      // The 100/100/10 fixture expands 10,000 partial assignments on its final axis.
      if (this.length === 10_000) enumerations++;
      return Reflect.apply(original, this, args);
    },
  });
  try {
    run();
  } finally {
    Object.defineProperty(Array.prototype, 'flatMap', descriptor);
  }
  return enumerations;
}

describe('bounded finite deduction', () => {
  it.each([
    [3, 3, 3, 27],
    [4, 4, 4, 64],
    [5, 5, 4, 100],
  ])('supports %i/%i/%i domains with %i initial candidates', (a, b, c, total) => {
    const fixture = deductionFixture([a, b, c]);
    expect(solveDeduction(fixture, [])).toHaveLength(total);
    expect(validateDeduction(fixture).ok).toBe(true);
    expect(solveDeduction(fixture, ['clue-a', 'clue-b', 'clue-c'])).toEqual([
      { 'axis-0': 'value-0', 'axis-1': 'value-0', 'axis-2': 'value-0' },
    ]);
    expect(inspectDeduction(fixture).prefixes.map((p) => p.remaining)).toEqual([b * c, c, 1]);
  });

  it('does not hardcode three axes and supports validated equality/inequality/membership/and/or', () => {
    const fixture = deductionFixture([3, 3]);
    fixture.compatibility = {
      op: 'or',
      terms: [
        { op: 'eq', axis: 'axis-0', value: 'value-0' },
        { op: 'ne', axis: 'axis-1', value: 'value-2' },
      ],
    };
    fixture.clues[0]!.predicate = {
      op: 'and',
      terms: [
        { op: 'in', axis: 'axis-0', values: ['value-0', 'value-1'] },
        { op: 'ne', axis: 'axis-0', value: 'value-1' },
      ],
    };
    expect(solveDeduction(fixture, [])).toHaveLength(7);
    expect(validateDeduction(fixture).ok).toBe(true);
    expect(solveDeduction(fixture, ['clue-a', 'clue-b'])).toEqual([
      { 'axis-0': 'value-0', 'axis-1': 'value-0' },
    ]);
  });

  it('reports actual remaining candidates and responsible clues for ambiguity', () => {
    const fixture = deductionFixture();
    fixture.clues.pop();
    const result = validateDeduction(fixture);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.find((d) => d.code.endsWith('LOGIC-UNIQUE'))?.data).toMatchObject({
      clueIds: ['clue-a', 'clue-b'],
      count: 3,
      truncated: false,
    });
    expect(inspectDeduction(fixture).candidates.map((c) => c['axis-2'])).toEqual([
      'value-0',
      'value-1',
      'value-2',
    ]);
    try {
      requireValid(result);
      throw new Error('expected validation rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolkitError);
      if (error instanceof ToolkitError) {
        expect(error.code).toBe('AEG-NARRATIVE-LOGIC-UNIQUE');
        expect(error.messageKey).toBe('aegis.narrative.logic-unique');
        expect(error.diagnostics).toEqual(result.diagnostics);
      }
    }
  });

  it('rejects wrong intended solutions and contradictory reachable prefixes', () => {
    const fixture = deductionFixture();
    fixture.clues[1]!.predicate = { op: 'ne', axis: 'axis-0', value: 'value-0' };
    const result = validateDeduction(fixture);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('AEG-NARRATIVE-LOGIC-INTENDED');
    expect(result.diagnostics.find((d) => d.code.endsWith('LOGIC-PREFIX'))?.data).toEqual({
      clueIds: ['clue-a', 'clue-b'],
      candidates: [],
    });
    expect(result.diagnostics.find((d) => d.code.endsWith('LOGIC-UNIQUE'))?.data?.count).toBe(0);
  });

  it.each(['cycle', 'answer'] as const)('refuses %s-locked required clue access', (lock) => {
    const fixture = deductionFixture();
    if (lock === 'cycle') fixture.clues[0]!.requires = ['clue-c'];
    else fixture.clues[0]!.requiresAnswer = true;
    const result = validateDeduction(fixture);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.find((d) => d.code.endsWith('LOGIC-REACHABILITY'))?.data?.clueIds,
    ).toEqual(['clue-a', 'clue-b', 'clue-c']);
  });

  it('rejects unknown references, skipped prerequisite reveals and malformed predicates', () => {
    const fixture = deductionFixture();
    expect(() => solveDeduction(fixture, ['clue-b'])).toThrow(/prerequisites/);
    expect(() => solveDeduction(fixture, ['missing'])).toThrow(/Unknown reference/);
    const changed = {
      ...fixture,
      clues: [{ ...fixture.clues[0], predicate: { op: 'eval', code: 'true' } }],
    };
    expect(validateDeduction(changed).ok).toBe(false);
    fixture.clues[0]!.predicate = { op: 'eq', axis: 'missing-axis', value: 'value-0' };
    expect(validateDeduction(fixture).ok).toBe(false);
    expect(validateDeduction({ ...deductionFixture(), intended: { 'axis-0': 'missing' } }).ok).toBe(
      false,
    );
  });

  it('bounds candidate products, predicate depth, breadth and JSON cycles', () => {
    expect(validateDeduction(deductionFixture([5, 5, 5])).ok).toBe(false);
    expect(validateDeduction({ ...deductionFixture(), maxCandidates: 100_001 }).ok).toBe(false);
    let predicate: Predicate = { op: 'eq', axis: 'axis-0', value: 'value-0' };
    for (let index = 0; index < 20; index++) predicate = { op: 'and', terms: [predicate] };
    const fixture = deductionFixture();
    fixture.clues[0]!.predicate = predicate;
    expect(validateDeduction(fixture).ok).toBe(false);
    fixture.clues[0]!.predicate = {
      op: 'and',
      terms: Array.from({ length: 257 }, () => ({ op: 'eq', axis: 'axis-0', value: 'value-0' })),
    };
    expect(validateDeduction(fixture).ok).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(validateDeduction(cycle).ok).toBe(false);
  });

  it('bounds the combined candidate/expression work rather than only each factor', () => {
    const fixture = deductionFixture([100, 100]);
    fixture.maxCandidates = 10_000;
    fixture.clues = Array.from({ length: 10 }, (_, index) => ({
      id: `wide-${index}`,
      explanationKey: 'wide-explanation',
      requires: [],
      requiresAnswer: false,
      predicate: {
        op: 'and',
        terms: Array.from({ length: 128 }, () => ({ op: 'ne', axis: 'axis-0', value: 'value-99' })),
      },
    }));
    expect(validateDeduction(fixture).diagnostics[0]?.code).toBe('AEG-NARRATIVE-LOGIC-WORK');
  });

  it('keeps red herrings explanatory rather than treating them as false hard constraints', () => {
    const fixture = deductionFixture();
    expect(validateDeduction(fixture).ok).toBe(true);
    expect(validateDeduction({ ...fixture, redHerrings: [{ id: 'color' }] }).ok).toBe(false);
    expect(() => solveDeduction(fixture, ['ribbon-color'])).toThrow(/Unknown reference/);
  });
});

describe('notebook evidence and non-punitive hint tiers', () => {
  it('solves a canonical citation set once when restoring or editing 210 generated marks', () => {
    const fixture = deductionFixture([100, 100, 10]);
    fixture.maxCandidates = 100_000;
    const revealed = ['clue-a', 'clue-b', 'clue-c'];
    const marks = proposeNotebookMarks(fixture, revealed).map((mark, index) => ({
      ...mark,
      clueIds: index % 2 === 0 ? [...mark.clueIds].reverse() : mark.clueIds,
    }));
    expect(marks).toHaveLength(210);
    const snapshot = { ...createNotebook(fixture), marks };
    const saved = JSON.stringify(snapshot);
    const restoreWork = countLargeCandidateEnumerations(() => {
      expect(restoreNotebook(fixture, JSON.parse(saved), revealed)).toEqual(snapshot);
    });
    expect(restoreWork).toBe(1);
    const editWork = countLargeCandidateEnumerations(() => {
      const updated = setNotebookMark(
        fixture,
        snapshot,
        revealed,
        { ...marks[0]!, clueIds: [...revealed] },
        'replace-user',
      );
      expect(updated.marks).toHaveLength(210);
      expect(updated.marks.at(-1)).toEqual({ ...marks[0], clueIds: revealed });
    });
    expect(editWork).toBe(1);
    expect(JSON.stringify(snapshot)).toBe(saved);
  });

  it('solves distinct citation subsets separately and never reuses stronger evidence', () => {
    const fixture = deductionFixture([100, 100, 10]);
    fixture.maxCandidates = 100_000;
    const revealed = ['clue-a', 'clue-b', 'clue-c'];
    const marks = proposeNotebookMarks(fixture, revealed).map((mark) => ({
      ...mark,
      clueIds: mark.axis === 'axis-0' ? ['clue-a'] : mark.clueIds,
    }));
    const snapshot = { ...createNotebook(fixture), marks };
    const work = countLargeCandidateEnumerations(() => {
      expect(restoreNotebook(fixture, snapshot, revealed).marks).toHaveLength(210);
    });
    expect(work).toBe(2);
    const forged = marks.map((mark) => ({
      ...mark,
      clueIds: mark.axis === 'axis-1' ? ['clue-a'] : mark.clueIds,
    }));
    expect(() => restoreNotebook(fixture, { ...snapshot, marks: forged }, revealed)).toThrow(
      /do not support/,
    );
  });

  it('does not retain cached support across operations with changed content or reveals', () => {
    const fixture = deductionFixture();
    const revealed = ['clue-a', 'clue-b', 'clue-c'];
    const snapshot = {
      ...createNotebook(fixture),
      marks: proposeNotebookMarks(fixture, revealed),
    };
    expect(restoreNotebook(fixture, snapshot, revealed)).toEqual(snapshot);
    expect(() => restoreNotebook(fixture, snapshot, ['clue-a', 'clue-b'])).toThrow(/unrevealed/);
    fixture.clues[0]!.predicate = { op: 'eq', axis: 'axis-0', value: 'value-1' };
    fixture.intended['axis-0'] = 'value-1';
    expect(() => restoreNotebook(fixture, snapshot, revealed)).toThrow(/do not support/);
  });

  it.each([
    { citations: ['clue-b'], revealed: ['clue-a', 'clue-b', 'clue-c'], error: /prerequisites/ },
    {
      citations: ['missing'],
      revealed: ['clue-a', 'clue-b', 'clue-c', 'missing'],
      error: /Unknown reference/,
    },
    {
      citations: ['clue-a', 'clue-a'],
      revealed: ['clue-a', 'clue-b', 'clue-c'],
      error: /Duplicate/,
    },
    { citations: ['clue-c'], revealed: ['clue-a', 'clue-b'], error: /unrevealed/ },
    { citations: [], revealed: ['clue-a', 'clue-b', 'clue-c'], error: /unrevealed or absent/ },
  ])(
    'rejects invalid citations $citations after validating prior evidence',
    ({ citations, revealed, error }) => {
      const fixture = deductionFixture();
      const marks = proposeNotebookMarks(fixture, ['clue-a', 'clue-b']);
      const input = { ...marks[1]!, clueIds: citations };
      const snapshot = { ...createNotebook(fixture), marks: [marks[0]!, input] };
      expect(() => restoreNotebook(fixture, snapshot, revealed)).toThrow(error);
    },
  );

  it('uses only revealed clues, cites support, and ignores hidden clue mutations', () => {
    const fixture = deductionFixture();
    expect(proposeNotebookMarks(fixture, [])).toEqual([]);
    const before = proposeNotebookMarks(fixture, ['clue-a']);
    expect(before).toEqual([
      {
        axis: 'axis-0',
        value: 'value-0',
        mark: 'confirmed',
        source: 'evidence',
        clueIds: ['clue-a'],
      },
      {
        axis: 'axis-0',
        value: 'value-1',
        mark: 'excluded',
        source: 'evidence',
        clueIds: ['clue-a'],
      },
      {
        axis: 'axis-0',
        value: 'value-2',
        mark: 'excluded',
        source: 'evidence',
        clueIds: ['clue-a'],
      },
    ]);
    fixture.clues[1]!.predicate = { op: 'eq', axis: 'axis-1', value: 'value-2' };
    fixture.intended['axis-1'] = 'value-2';
    expect(proposeNotebookMarks(fixture, ['clue-a'])).toEqual(before);
    expect(before.every((m) => m.axis !== 'axis-1')).toBe(true);
  });

  it('honors user mark policy and validates evidence after JSON restore', () => {
    const fixture = deductionFixture(),
      revealed = ['clue-a'];
    const user: NotebookMark = {
      axis: 'axis-0',
      value: 'value-0',
      mark: 'excluded',
      source: 'user',
      clueIds: [],
    };
    const state = setNotebookMark(
      fixture,
      createNotebook(fixture),
      revealed,
      user,
      'preserve-user',
    );
    const suggestion = proposeNotebookMarks(fixture, revealed)[0]!;
    expect(setNotebookMark(fixture, state, revealed, suggestion, 'preserve-user')).toEqual(state);
    const replaced = setNotebookMark(fixture, state, revealed, suggestion, 'replace-user');
    expect(replaced.marks[0]?.mark).toBe('confirmed');
    expect(restoreNotebook(fixture, JSON.parse(JSON.stringify(replaced)), revealed)).toEqual(
      replaced,
    );
    expect(state.marks[0]?.source).toBe('user');
    expect(() => restoreNotebook(fixture, replaced, [])).toThrow(/unrevealed/);
  });

  it('refuses unsupported and forged evidence instead of silently marking a guess', () => {
    const fixture = deductionFixture(),
      state = createNotebook(fixture);
    expect(() =>
      setNotebookMark(
        fixture,
        state,
        ['clue-a'],
        {
          axis: 'axis-1',
          value: 'value-0',
          mark: 'confirmed',
          source: 'evidence',
          clueIds: ['clue-a'],
        },
        'replace-user',
      ),
    ).toThrow(/do not support/);
    expect(() =>
      setNotebookMark(
        fixture,
        state,
        ['clue-a'],
        {
          axis: 'axis-0',
          value: 'value-0',
          mark: 'confirmed',
          source: 'user',
          clueIds: ['clue-a'],
        },
        'replace-user',
      ),
    ).toThrow(/User marks/);
    expect(parseDeduction(fixture).id).toBe('lost-ribbon');
    const user = setNotebookMark(
      fixture,
      state,
      ['clue-a'],
      { axis: 'axis-1', value: 'value-0', mark: 'unknown', source: 'user', clueIds: [] },
      'preserve-user',
    );
    expect(() =>
      setNotebookMark(
        fixture,
        user,
        ['clue-a'],
        {
          axis: 'axis-1',
          value: 'value-0',
          mark: 'confirmed',
          source: 'evidence',
          clueIds: ['clue-b'],
        },
        'preserve-user',
      ),
    ).toThrow(/unrevealed/);
  });

  it('returns ordered revealed-only hints and an explicit resumable exhausted state', () => {
    const fixture = deductionFixture();
    const tiers: HintTier[] = [
      { id: 'review-first', textKey: 'look-at-ribbon', clueIds: ['clue-a'] },
      { id: 'compare-second', textKey: 'compare-position', clueIds: ['clue-a', 'clue-b'] },
    ];
    const initial = { schema: 1, used: [] };
    expect(nextHint(fixture, tiers, initial, [])).toMatchObject({
      status: 'exhausted',
      reason: 'review',
    });
    const first = nextHint(fixture, tiers, initial, ['clue-a']);
    expect(first).toMatchObject({
      status: 'hint',
      hint: { id: 'review-first' },
      state: { used: ['review-first'] },
    });
    const again = nextHint(fixture, tiers, JSON.parse(JSON.stringify(first.state)), ['clue-a']);
    expect(again).toMatchObject({ status: 'exhausted', reason: 'review', state: first.state });
    const second = nextHint(fixture, tiers, again.state, ['clue-a', 'clue-b']);
    expect(second).toMatchObject({ status: 'hint', hint: { id: 'compare-second' } });
    expect(nextHint(fixture, tiers, second.state, ['clue-a', 'clue-b'])).toMatchObject({
      status: 'exhausted',
      reason: 'review',
    });
    expect(nextHint(fixture, tiers, initial, ['clue-a'], 0)).toMatchObject({
      status: 'exhausted',
      reason: 'allowance',
    });
    expect(initial).toEqual({ schema: 1, used: [] });
    expect(() =>
      nextHint(fixture, [{ id: 'bad', textKey: 'bad', clueIds: [] }], initial, []),
    ).toThrow(/no evidence/);
  });
});
