import {
  enumerateCaseCombinations,
  generateCase,
  layoutPrint,
  renderPrintHtml,
  restoreGeneratedCase,
} from '@aegis/narrative';
import type { GeneratedCase, GenerationTemplate, ResolvedCase } from '@aegis/narrative';
import { requireValue, schema } from '@aegis/runtime';

/** Two finite authored combinations, not a story/voice synthesis system. */
export function generatedTemplate(): GenerationTemplate {
  const lines = [
    {
      id: 'lab.welcome',
      sentences: ['Добро пожаловать.', 'Здесь можно спокойно попробовать разные задания.'],
    },
    { id: 'lab.clue', sentences: ['Посмотри на подсказку.', 'Она поможет найти следующий шаг.'] },
    {
      id: 'lab.complete',
      sentences: ['Отлично!', 'Все задания готовы.', 'Ты можешь попробовать снова.'],
    },
  ];
  const facts = ['triangle-fact', 'square-fact', 'circle-fact'];
  const bundle = (shape: string): ResolvedCase => ({
    schema: 1,
    id: 'generated-room-' + shape,
    revision: 'lab-1',
    catalogs: {
      assets: lines.map((line) => line.id),
      clues: ['shape', 'place', 'time'],
      facts,
      glossary: [],
      rewards: ['paper-sun'],
      speakers: [],
    },
    narrative: {
      schema: 1,
      id: 'generated-story',
      revision: 'lab-1',
      start: 'welcome',
      catalogs: {
        clue: ['shape', 'place', 'time'],
        fact: facts,
        glossary: [],
        reward: ['paper-sun'],
        completion: ['finished'],
        scene: ['room'],
        text: lines.map((line) => line.id),
        asset: lines.map((line) => line.id),
      },
      flags: [],
      items: [],
      data: [],
      effects: [{ id: 'sun-reward', kind: 'claim', catalog: 'reward', ref: 'paper-sun' }],
      nodes: ['welcome', 'clue', 'complete'].map((id, index) => ({
        id,
        scene: 'room',
        text: lines[index]!.id,
        narration: lines[index]!.id,
        revisit: 'allow',
        entryEffects: [],
        automatic: [],
        resolveEnding: index === 2,
        choices:
          index === 2
            ? []
            : [
                {
                  id: 'next',
                  to: index === 0 ? 'clue' : 'complete',
                  guard: null,
                  text: lines[index + 1]!.id,
                  effects: [],
                },
              ],
      })),
      endings: [{ id: 'done', guard: null, effects: ['sun-reward'] }],
      maxAutomaticSteps: 8,
    },
    deduction: {
      schema: 1,
      id: 'generated-logic',
      maxCandidates: 8,
      axes: [
        { id: 'shape', values: ['sun', 'leaf'] },
        { id: 'place', values: ['table', 'shelf'] },
        { id: 'time', values: ['morning', 'evening'] },
      ],
      intended: { shape, place: 'table', time: 'morning' },
      compatibility: null,
      redHerrings: [],
      clues: [
        {
          id: 'shape',
          predicate: { op: 'eq', axis: 'shape', value: shape },
          requires: [],
          requiresAnswer: false,
          explanationKey: 'lab.clue',
        },
        {
          id: 'place',
          predicate: { op: 'eq', axis: 'place', value: 'table' },
          requires: [],
          requiresAnswer: false,
          explanationKey: 'lab.clue',
        },
        {
          id: 'time',
          predicate: { op: 'eq', axis: 'time', value: 'morning' },
          requires: [],
          requiresAnswer: false,
          explanationKey: 'lab.clue',
        },
      ],
    },
    child: {
      schema: 1,
      id: 'generated-child',
      entry: 'welcome',
      lines: lines.map((line) => ({
        id: line.id,
        speaker: null,
        variants: [
          {
            id: 'default',
            sentences: line.sentences,
            placeholders: [],
            narration: [{ selection: [], assetId: line.id }],
          },
        ],
      })),
      newTerms: [],
      factIds: facts,
      clueIds: ['shape', 'place', 'time'],
      rewardIds: ['paper-sun'],
      redHerrings: [],
      nodes: [
        { id: 'welcome', lineIds: ['lab.welcome'], termIds: [], next: ['clue'], complete: false },
        { id: 'clue', lineIds: ['lab.clue'], termIds: [], next: ['complete'], complete: false },
        { id: 'complete', lineIds: ['lab.complete'], termIds: [], next: [], complete: true },
      ],
      decisions: [
        {
          id: 'welcome-next',
          node: 'welcome',
          pageSize: 1,
          choices: [{ id: 'next', line: 'lab.clue', to: 'clue' }],
        },
        {
          id: 'clue-next',
          node: 'clue',
          pageSize: 1,
          choices: [{ id: 'next', line: 'lab.complete', to: 'complete' }],
        },
      ],
      routes: [{ id: 'complete', nodes: ['welcome', 'clue', 'complete'] }],
    },
  });
  return {
    schema: 1,
    id: 'two-room-fixtures',
    revision: 'lab-1',
    dimensions: [{ id: 'shape', options: ['sun', 'leaf'] }],
    bundles: ['sun', 'leaf'].map((shape) => ({
      id: shape,
      selection: { shape },
      content: requireValue(schema.json.parse(bundle(shape))),
    })),
  };
}

export function generateReference(seed: number | string): GeneratedCase {
  const result = generateCase(generatedTemplate(), seed, 2);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}

export { enumerateCaseCombinations, restoreGeneratedCase };

export function printReference(paper: 'A4' | 'Letter'): string {
  const items = [
    {
      id: 'card',
      contentId: 'place',
      kind: 'card' as const,
      front: ['Записка лежала на столе.'],
      back: ['Комната историй'],
    },
    { id: 'token', contentId: 'sun', kind: 'token' as const, front: ['Солнце'], back: ['Жетон'] },
    { id: 'map', contentId: 'room', kind: 'map' as const, front: ['Комната — сад'], back: null },
    {
      id: 'notebook',
      contentId: 'notebook',
      kind: 'notebook' as const,
      front: ['Что известно?', 'Что пока неизвестно?'],
      back: null,
    },
    {
      id: 'rules',
      contentId: 'rules',
      kind: 'rules' as const,
      front: ['Выбирай предмет, затем место.', 'Можно остановиться в любой момент.'],
      back: null,
    },
  ];
  const layout = layoutPrint(
    { title: 'Комната историй', items },
    { paper, columns: 2, rows: 3, marginMm: 12, gutterMm: 4, fontPt: 14, duplex: 'long-edge' },
    ['place', 'sun', 'room', 'notebook', 'rules'],
  );
  layout.guidance =
    'Печатай в масштабе 100%, без колонтитулов. Переворот по длинному краю. Сначала проверь один лист: подача и совмещение зависят от принтера.';
  return renderPrintHtml(layout).replace('<html>', '<html lang="ru">');
}
