import { describe, expect, it } from 'vitest';
import {
  childRouteDiagnostics,
  CHILD_PROFILE,
  enumerateCaseCombinations,
  generateCase,
  reportNarrativeTeachingRoute,
  reportTeachingRoutes,
  restoreGeneratedCase,
  tokenizeWords,
  validateChildProfile,
  validateNarrativeChildProfile,
  validateResolvedCase,
} from '../src/index.js';
import type { GenerationTemplate } from '../src/index.js';
import { contentFixture, resolvedFixture } from './fixtures.js';

describe('opt-in child content checks', () => {
  it('validates original finite content and reports recurrence along a full route', () => {
    const { child, catalogs } = contentFixture();
    expect(validateChildProfile(child, catalogs).ok).toBe(true);
    const report = reportTeachingRoutes(child, catalogs);
    expect(report).toEqual([
      {
        routeId: 'full',
        terms: [
          { termId: 'reflection', encounters: 3, distinctNodes: ['welcome', 'compare', 'review'] },
        ],
        missingExplanations: [],
        editorialReviewRequired: true,
      },
    ]);
    expect(childRouteDiagnostics(report)).toEqual([]);
  });

  it('counts Cyrillic/yo, numbers, apostrophes and hyphenated words deterministically', () => {
    expect(tokenizeWords('Ёжик нёс ёлку. Это 3 ярко-синих шара!')).toEqual([
      'Ёжик',
      'нёс',
      'ёлку',
      'Это',
      '3',
      'ярко-синих',
      'шара',
    ]);
    expect(tokenizeWords("A child's well-lit room.")).toEqual(['A', "child's", 'well-lit', 'room']);
    const { child, catalogs } = contentFixture();
    child.lines[0]!.variants[0]!.sentences = ['Ёжик нашёл яркую ленту.', 'Она отражает свет.'];
    expect(validateChildProfile(child, catalogs).ok).toBe(true);
    child.lines[0]!.variants[0]!.sentences = [
      'one two three four five six seven eight nine ten eleven',
    ];
    expect(validateChildProfile(child, catalogs).diagnostics[0]?.code).toBe(
      'AEG-NARRATIVE-CHILD-WORDS',
    );
  });

  it('checks worst-case placeholder bounds and every finite narration combination', () => {
    const { child, catalogs } = contentFixture(),
      variant = child.lines[0]!.variants[0]!;
    variant.sentences = ['Hello {name}.'];
    variant.placeholders = [
      {
        id: 'name',
        maxWords: 2,
        variants: [
          { id: 'short', text: 'Mira' },
          { id: 'long', text: 'Mira Moon' },
        ],
      },
    ];
    variant.narration = [
      { selection: ['short'], assetId: 'voice' },
      { selection: ['long'], assetId: 'voice' },
    ];
    expect(validateChildProfile(child, catalogs).ok).toBe(true);
    variant.narration.pop();
    expect(validateChildProfile(child, catalogs).diagnostics[0]?.code).toBe(
      'AEG-NARRATIVE-CHILD-NARRATION',
    );
    variant.placeholders[0]!.maxWords = 10;
    expect(validateChildProfile(child, catalogs).diagnostics[0]?.code).toBe(
      'AEG-NARRATIVE-CHILD-WORDS',
    );
  });

  it('does not certify arbitrary-name narration from a mere placeholder bound', () => {
    const { child, catalogs } = contentFixture(),
      variant = child.lines[0]!.variants[0]!;
    variant.sentences = ['Hello {name}.'];
    variant.placeholders = [{ id: 'name', maxWords: 2, variants: [] }];
    variant.narration = [];
    expect(validateChildProfile(child, catalogs).diagnostics[0]?.code).toBe(
      'AEG-NARRATIVE-CHILD-NARRATION',
    );
    expect(
      validateChildProfile(child, catalogs, { ...CHILD_PROFILE, requireNarration: false }).ok,
    ).toBe(true);
    variant.sentences = ['Hello {undeclared}.'];
    expect(validateChildProfile(child, catalogs).diagnostics[0]?.code).toBe(
      'AEG-NARRATIVE-CHILD-PLACEHOLDER',
    );
  });

  it.each([
    'facts',
    'terms',
    'voice',
    'red-herring',
    'choices',
    'speaker',
    'clue',
    'reward',
  ] as const)('rejects %s profile violations with locations', (mutation) => {
    const { child, catalogs } = contentFixture();
    if (mutation === 'facts') child.factIds.pop();
    if (mutation === 'terms') {
      child.newTerms = ['a', 'b', 'c', 'd'];
      catalogs.glossary.push(...child.newTerms);
    }
    if (mutation === 'voice') child.lines[0]!.variants[0]!.narration = [];
    if (mutation === 'red-herring') child.redHerrings[0]!.explanationLine = 'missing';
    if (mutation === 'choices') child.decisions[0]!.pageSize = 4;
    if (mutation === 'speaker') child.lines[0]!.speaker = 'missing';
    if (mutation === 'clue') child.clueIds.push('missing');
    if (mutation === 'reward') child.rewardIds.push('missing');
    const result = validateChildProfile(child, catalogs);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.location?.path).toBeTruthy();
    expect(result.diagnostics[0]?.fix).toBeTruthy();
  });

  it('distinguishes actual rendered groups from total paged choices', () => {
    const { child, catalogs } = contentFixture();
    child.decisions[0]!.choices = Array.from({ length: 8 }, (_, index) => ({
      id: `option-${index}`,
      line: 'look',
      to: 'compare',
    }));
    child.decisions[0]!.pageSize = 3;
    expect(validateChildProfile(child, catalogs).ok).toBe(true);
  });

  it('cannot count disconnected global term appearances as a playable route', () => {
    const { child, catalogs } = contentFixture();
    child.nodes.push({
      id: 'unreachable',
      lineIds: ['room'],
      termIds: ['reflection'],
      next: [],
      complete: true,
    });
    child.nodes[1]!.termIds = [];
    child.nodes[2]!.termIds = [];
    const reports = reportTeachingRoutes(child, catalogs);
    expect(reports[0]?.terms[0]?.encounters).toBe(1);
    expect(childRouteDiagnostics(reports)[0]?.code).toBe('AEG-NARRATIVE-CHILD-RECURRENCE');
    child.routes[0]!.nodes = ['welcome', 'unreachable'];
    expect(validateChildProfile(child, catalogs).ok).toBe(false);
  });

  it('reports an explanation that exists in the catalog but is absent on the chosen route', () => {
    const { child, catalogs } = contentFixture();
    child.nodes[2]!.lineIds = ['finish'];
    const reports = reportTeachingRoutes(child, catalogs);
    expect(reports[0]?.missingExplanations).toEqual(['ribbon-color']);
    expect(childRouteDiagnostics(reports)[0]?.code).toBe('AEG-NARRATIVE-CHILD-EXPLANATION');
  });

  it('executes real narrative guards for teaching credit instead of trusting a parallel graph', () => {
    const resolved = resolvedFixture();
    const report = reportNarrativeTeachingRoute(
      resolved.narrative,
      resolved.child,
      resolved.catalogs,
      { id: 'actual-route', choices: ['look', 'help', 'finish'] },
    );
    expect(report.terms).toEqual([
      { termId: 'reflection', encounters: 4, distinctNodes: ['room', 'period', 'end'] },
    ]);
    expect(report.missingExplanations).toEqual([]);
    expect(() =>
      reportNarrativeTeachingRoute(resolved.narrative, resolved.child, resolved.catalogs, {
        id: 'blocked',
        choices: ['disabled', 'finish'],
      }),
    ).toThrow(/disabled/);
    expect(() =>
      reportNarrativeTeachingRoute(resolved.narrative, resolved.child, resolved.catalogs, {
        id: 'partial',
        choices: ['help'],
      }),
    ).toThrow(/did not reach/);
    const unrelated = contentFixture();
    expect(
      validateNarrativeChildProfile(resolved.narrative, unrelated.child, unrelated.catalogs).ok,
    ).toBe(false);
    resolved.child.decisions[0]!.choices.pop();
    expect(
      validateNarrativeChildProfile(resolved.narrative, resolved.child, resolved.catalogs).ok,
    ).toBe(false);
  });
});

describe('bounded fully validated authored generation', () => {
  const template = (): GenerationTemplate => ({
    schema: 1,
    id: 'finite-lab',
    revision: 'one',
    dimensions: [
      { id: 'room', options: ['workshop', 'garden'] },
      { id: 'ribbon', options: ['blue', 'gold'] },
    ],
    bundles: [
      {
        id: 'workshop-blue',
        selection: { room: 'workshop', ribbon: 'blue' },
        content: JSON.parse(JSON.stringify(resolvedFixture())),
      },
      {
        id: 'garden-gold',
        selection: { room: 'garden', ribbon: 'gold' },
        content: JSON.parse(JSON.stringify({ ...resolvedFixture(), id: 'garden-ribbon' })),
      },
    ],
  });

  it('validates structure, content and logic for each fully resolved output', () => {
    const t = template();
    expect(validateResolvedCase(resolvedFixture()).ok).toBe(true);
    const one = generateCase(t, 'pinned-seed', 2),
      two = generateCase(t, 'pinned-seed', 2);
    expect(one).toEqual(two);
    expect(one.ok).toBe(true);
    if (!one.ok) throw new Error('expected generated case');
    expect(one.value.bundleId).toBe('workshop-blue');
    expect(one.value.resolved.child.factIds).toEqual(['fact-a', 'fact-b', 'fact-c']);
    expect(validateResolvedCase(one.value.resolved).ok).toBe(true);
    expect(one.value.resolved.deduction.clues).toHaveLength(3);
  });

  it('enumerates the whole small product and reports unsupported combinations explicitly', () => {
    const reports = enumerateCaseCombinations(template());
    expect(reports).toHaveLength(4);
    expect(reports.map((r) => [r.selection.room, r.selection.ribbon, r.ok])).toEqual([
      ['workshop', 'blue', true],
      ['workshop', 'gold', false],
      ['garden', 'blue', false],
      ['garden', 'gold', true],
    ]);
    expect(
      reports
        .filter((r) => !r.ok)
        .every((r) => r.diagnostics[0]?.code === 'AEG-NARRATIVE-GEN-INCOMPATIBLE'),
    ).toBe(true);
  });

  it('returns bounded failure for invalid logic/content and never an invalid fallback', () => {
    const t = template(),
      invalid = resolvedFixture();
    invalid.deduction.clues.pop();
    t.bundles = [
      {
        id: 'invalid',
        selection: { room: 'workshop', ribbon: 'blue' },
        content: JSON.parse(JSON.stringify(invalid)),
      },
    ];
    const result = generateCase(t, 'fail', 1);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    if (result.ok) throw new Error('expected failure');
    expect(result.diagnostics.map((d) => d.code)).toContain('AEG-NARRATIVE-LOGIC-UNIQUE');
    expect(result.diagnostics.at(-1)?.code).toBe('AEG-NARRATIVE-GEN-EXHAUSTED');
    expect(generateCase(t, 'fail', 0)).toMatchObject({ ok: false, attempts: 0 });
    invalid.child.factIds.pop();
    expect(validateResolvedCase(invalid).ok).toBe(false);
  });

  it('retains the actual selected case after a generator/catalog update', () => {
    const t = template(),
      result = generateCase(t, 'resume');
    if (!result.ok) throw new Error('expected generated case');
    const saved = JSON.stringify(result.value);
    t.revision = 'two';
    t.bundles = [];
    const restored = restoreGeneratedCase(JSON.parse(saved));
    expect(restored).toEqual(result.value);
    expect(restored.templateRevision).toBe('one');
    expect(generateCase(t, 'resume')).toMatchObject({ ok: false, attempts: 0 });
    expect(() =>
      restoreGeneratedCase({
        ...restored,
        resolved: { ...restored.resolved, catalogs: { ...restored.resolved.catalogs, assets: [] } },
      }),
    ).toThrow(/Unknown reference/);
  });

  it('checks explicit compatibility rows and cross-module references', () => {
    const t = template();
    t.bundles[0]!.selection.room = 'not-authored';
    expect(generateCase(t, 'seed')).toMatchObject({ ok: false, attempts: 0 });
    const bad = resolvedFixture();
    bad.narrative.catalogs.clue.push('ghost');
    expect(validateResolvedCase(bad).ok).toBe(false);
    const duplicate = template();
    duplicate.bundles.push({ ...duplicate.bundles[0]!, id: 'duplicate' });
    expect(generateCase(duplicate, 'seed')).toMatchObject({ ok: false, attempts: 0 });
  });
});
