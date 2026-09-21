import type {
  ChildCase,
  ContentCatalogs,
  DeductionCase,
  FamilyDefinition,
  MinigameDefinition,
  NarrativeGraph,
  ResolvedCase,
  RuleTableConfig,
} from '../src/index.js';

export function storyFixture(): NarrativeGraph {
  return {
    schema: 1,
    id: 'lantern-walk',
    revision: 'one',
    start: 'room',
    catalogs: {
      scene: ['workshop'],
      text: ['room', 'help', 'skip', 'look', 'disabled', 'period', 'finish', 'back'],
      asset: ['voice'],
      clue: ['clue-a', 'clue-b', 'clue-c'],
      fact: ['fact-a', 'fact-b', 'fact-c'],
      glossary: ['reflection'],
      reward: ['paper-star'],
      completion: ['walk-complete'],
    },
    flags: ['helped', 'later'],
    items: ['ticket'],
    data: [],
    effects: [
      { id: 'first-ticket', kind: 'item', item: 'ticket', delta: 1 },
      { id: 'first-clue', kind: 'claim', catalog: 'clue', ref: 'clue-a' },
      { id: 'helped-once', kind: 'flag', flag: 'helped', value: true },
      { id: 'next-period', kind: 'flag', flag: 'later', value: true },
      { id: 'spend-ticket', kind: 'item', item: 'ticket', delta: -1 },
      { id: 'star-grant', kind: 'claim', catalog: 'reward', ref: 'paper-star' },
      { id: 'finish-once', kind: 'claim', catalog: 'completion', ref: 'walk-complete' },
    ],
    nodes: [
      {
        id: 'room',
        scene: 'workshop',
        text: 'room',
        narration: 'voice',
        revisit: 'allow',
        entryEffects: ['first-ticket', 'first-clue'],
        resolveEnding: false,
        automatic: [],
        choices: [
          { id: 'look', text: 'look', to: 'room', guard: null, effects: [] },
          { id: 'help', text: 'help', to: 'period', guard: null, effects: ['helped-once'] },
          { id: 'skip', text: 'skip', to: 'period', guard: null, effects: [] },
          {
            id: 'disabled',
            text: 'disabled',
            to: 'period',
            guard: { kind: 'item', id: 'ticket', atLeast: 2 },
            effects: [],
          },
        ],
      },
      {
        id: 'period',
        scene: 'workshop',
        text: 'period',
        narration: null,
        revisit: 'allow',
        entryEffects: ['next-period'],
        resolveEnding: false,
        automatic: [],
        choices: [
          {
            id: 'finish',
            text: 'finish',
            to: 'end',
            guard: {
              kind: 'all',
              guards: [
                { kind: 'flag', id: 'later', value: true },
                { kind: 'item', id: 'ticket', atLeast: 1 },
              ],
            },
            effects: ['spend-ticket', 'star-grant'],
          },
          { id: 'back', text: 'back', to: 'room', guard: null, effects: [] },
        ],
      },
      {
        id: 'end',
        scene: 'workshop',
        text: 'finish',
        narration: null,
        revisit: 'forbid',
        entryEffects: [],
        resolveEnding: true,
        automatic: [],
        choices: [],
      },
    ],
    endings: [
      {
        id: 'shared-walk',
        guard: { kind: 'flag', id: 'helped', value: true },
        effects: ['finish-once'],
      },
      { id: 'quiet-walk', guard: null, effects: ['finish-once'] },
    ],
    maxAutomaticSteps: 8,
  };
}

export function deductionFixture(sizes = [3, 3, 3]): DeductionCase {
  return {
    schema: 1,
    id: 'lost-ribbon',
    maxCandidates: 100,
    axes: sizes.map((count, index) => ({
      id: `axis-${index}`,
      values: Array.from({ length: count }, (_, n) => `value-${n}`),
    })),
    compatibility: null,
    intended: Object.fromEntries(sizes.map((_, index) => [`axis-${index}`, 'value-0'])),
    clues: sizes.map((_, index) => ({
      id: `clue-${String.fromCharCode(97 + index)}`,
      predicate: { op: 'eq', axis: `axis-${index}`, value: 'value-0' },
      requires: index === 0 ? [] : [`clue-${String.fromCharCode(96 + index)}`],
      requiresAnswer: false,
      explanationKey: `explanation-${index}`,
    })),
    redHerrings: [{ id: 'ribbon-color', explanationKey: 'red-explanation' }],
  };
}

export function contentFixture(): { child: ChildCase; catalogs: ContentCatalogs } {
  const lineIds = [
    'room',
    'help',
    'skip',
    'look',
    'disabled',
    'period',
    'finish',
    'back',
    'explanation-0',
    'explanation-1',
    'explanation-2',
    'red-explanation',
  ];
  return {
    catalogs: {
      assets: ['voice'],
      clues: ['clue-a', 'clue-b', 'clue-c'],
      facts: ['fact-a', 'fact-b', 'fact-c'],
      glossary: ['reflection'],
      rewards: ['paper-star'],
      speakers: ['guide'],
    },
    child: {
      schema: 1,
      id: 'workshop-lesson',
      entry: 'welcome',
      lines: lineIds.map((lineId) => ({
        id: lineId,
        speaker: 'guide',
        variants: [
          {
            id: 'default',
            sentences: ['The ribbon reflects the soft light.'],
            placeholders: [],
            narration: [{ selection: [], assetId: 'voice' }],
          },
        ],
      })),
      newTerms: ['reflection'],
      factIds: ['fact-a', 'fact-b', 'fact-c'],
      clueIds: ['clue-a', 'clue-b', 'clue-c'],
      rewardIds: ['paper-star'],
      redHerrings: [{ id: 'ribbon-color', explanationLine: 'red-explanation' }],
      nodes: [
        {
          id: 'welcome',
          lineIds: ['room'],
          termIds: ['reflection'],
          next: ['compare'],
          complete: false,
        },
        {
          id: 'compare',
          lineIds: ['explanation-0', 'explanation-1'],
          termIds: ['reflection'],
          next: ['review'],
          complete: false,
        },
        {
          id: 'review',
          lineIds: ['explanation-2', 'red-explanation', 'finish'],
          termIds: ['reflection'],
          next: [],
          complete: true,
        },
      ],
      decisions: [
        {
          id: 'choose',
          node: 'welcome',
          pageSize: 2,
          choices: [
            { id: 'look', line: 'look', to: 'compare' },
            { id: 'help', line: 'help', to: 'compare' },
          ],
        },
      ],
      routes: [{ id: 'full', nodes: ['welcome', 'compare', 'review'] }],
    },
  };
}

export function resolvedFixture(): ResolvedCase {
  const { child, catalogs } = contentFixture();
  const narrative = storyFixture();
  child.entry = narrative.start;
  child.nodes = narrative.nodes.map((node) => ({
    id: node.id,
    lineIds: node.resolveEnding ? [node.text, 'red-explanation'] : [node.text],
    termIds: ['reflection'],
    next: [...new Set([...node.choices, ...node.automatic].map((edge) => edge.to))],
    complete: node.resolveEnding,
  }));
  child.decisions = narrative.nodes
    .filter((node) => node.choices.length > 0)
    .map((node) => ({
      id: `${node.id}-choices`,
      node: node.id,
      pageSize: 3,
      choices: node.choices.map((choice) => ({ id: choice.id, line: choice.text, to: choice.to })),
    }));
  child.routes = [{ id: 'helped-walk', nodes: ['room', 'period', 'end'] }];
  return {
    schema: 1,
    id: 'workshop-ribbon',
    revision: 'one',
    narrative,
    deduction: deductionFixture(),
    child,
    catalogs,
  };
}

export function selectionFixture(): MinigameDefinition {
  return {
    schema: 1,
    id: 'find-shapes',
    revision: 'one',
    kind: 'scene-selection',
    adapterSchema: 1,
    config: {
      targets: [
        { id: 'circle', labelKey: 'circle', required: true },
        { id: 'triangle', labelKey: 'triangle', required: true },
        { id: 'square', labelKey: 'square', required: false },
      ],
    },
    outputs: [{ kind: 'clue', id: 'shapes-clue' }],
  };
}
export function matchingFixture(): MinigameDefinition {
  return {
    schema: 1,
    id: 'pair-leaves',
    revision: 'one',
    kind: 'matching',
    adapterSchema: 1,
    config: {
      cards: [
        { id: 'a1', pair: 'a', labelKey: 'secret-fern', backLabelKey: 'card-back' },
        { id: 'b1', pair: 'b', labelKey: 'secret-clover', backLabelKey: 'card-back' },
        { id: 'a2', pair: 'a', labelKey: 'secret-fern', backLabelKey: 'card-back' },
        { id: 'b2', pair: 'b', labelKey: 'secret-clover', backLabelKey: 'card-back' },
      ],
    },
    outputs: [{ kind: 'reward', id: 'leaf-sticker' }],
  };
}
export function orderingFixture(): MinigameDefinition {
  return {
    schema: 1,
    id: 'sort-lanterns',
    revision: 'one',
    kind: 'ordering',
    adapterSchema: 1,
    config: {
      items: [
        { id: 'c', labelKey: 'third' },
        { id: 'a', labelKey: 'first' },
        { id: 'b', labelKey: 'second' },
      ],
      solution: ['a', 'b', 'c'],
    },
    outputs: [],
  };
}

/** These are finite rule fixtures, not themed game implementations or an inference engine. */
export function ruleFixture(kind: 'quantity' | 'causal' | 'media' | 'selection'): RuleTableConfig {
  if (kind === 'quantity')
    return {
      initial: 'zero',
      states: [
        { id: 'zero', textKey: 'zero-quarters', complete: false },
        { id: 'two', textKey: 'two-quarters', complete: false },
        { id: 'three', textKey: 'three-quarters', complete: true },
      ],
      moves: [
        {
          id: 'half',
          from: 'zero',
          to: 'two',
          labelKey: 'add-half',
          media: null,
          alternativeKey: 'two-of-four-parts',
        },
        {
          id: 'quarter',
          from: 'two',
          to: 'three',
          labelKey: 'add-quarter',
          media: null,
          alternativeKey: 'one-of-four-parts',
        },
        {
          id: 'reset',
          from: 'two',
          to: 'zero',
          labelKey: 'reset',
          media: null,
          alternativeKey: 'reset',
        },
      ],
    };
  return {
    initial: 'inspect',
    states: [
      { id: 'inspect', textKey: `${kind}-inspect`, complete: false },
      { id: 'done', textKey: `${kind}-done`, complete: true },
    ],
    moves: [
      {
        id: 'try',
        from: 'inspect',
        to: 'inspect',
        labelKey: 'try-again',
        media: kind === 'media' ? 'two-bells' : null,
        alternativeKey: 'two-visible-pulses',
      },
      {
        id: 'solve',
        from: 'inspect',
        to: 'done',
        labelKey: `${kind}-solve`,
        media: kind === 'media' ? 'three-bells' : null,
        alternativeKey: 'three-visible-pulses',
      },
    ],
  };
}

export function familyFixture(): FamilyDefinition {
  return {
    schema: 1,
    id: 'shared-ribbon',
    revision: 'one',
    players: [
      { id: 'p1', labelKey: 'first-player', abilities: ['ask-once'], role: 'player' },
      { id: 'p2', labelKey: 'second-player', abilities: ['hint-once'], role: 'hint-giver' },
    ],
    cards: [
      { id: 'private-a', content: { textKey: 'secret-sun' } },
      { id: 'private-b', content: { textKey: 'secret-moon' } },
      { id: 'unused', content: { textKey: 'secret-star' } },
    ],
    distribution: [
      { player: 'p1', count: 1, capacity: 2 },
      { player: 'p2', count: 1, capacity: 1 },
    ],
    remainder: 'stock',
  };
}
