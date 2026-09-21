import {
  advanceNarrative,
  beginHandoff,
  confirmHandoff,
  createFamilyState,
  createMinigame,
  createMinigameRegistry,
  createNarrativeState,
  createNotebook,
  nextHint,
  parseFamilyState,
  projectFamily,
  projectNarrative,
  proposeNotebookMarks,
  reduceMinigame,
  restoreMinigame,
  restoreNarrative,
  restoreNotebook,
  setNotebookMark,
  solveDeduction,
  validateDeduction,
  validateFamily,
  validateMinigame,
  validateNarrative,
} from '@aegis/narrative';
import type {
  FamilyState,
  FamilyView,
  HintState,
  MinigameState,
  NarrativeState,
  NotebookState,
  GeneratedCase,
} from '@aegis/narrative';
import {
  createRuntimeHost,
  failure,
  isRecord,
  parseContentJson,
  requireValue,
  schema,
  success,
} from '@aegis/runtime';
import { generateReference, restoreGeneratedCase } from './extras.js';
import type {
  CheckpointWriter,
  ContentPack,
  InferSchema,
  RuntimeAdapter,
  Schema,
} from '@aegis/runtime';

const registry = createMinigameRegistry();
function toolkitSchema<T>(parse: (value: unknown) => T): Schema<T> {
  return {
    parse(value) {
      try {
        return success(parse(value));
      } catch (error) {
        return failure(
          'invalid-story-data',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
const storyContentSchema = schema.object({
  graph: toolkitSchema((value) => {
    const result = validateNarrative(value);
    if (!result.ok || !result.value) throw new Error(JSON.stringify(result.diagnostics));
    return result.value;
  }),
  deduction: toolkitSchema((value) => {
    const result = validateDeduction(value);
    if (!result.ok || !result.value) throw new Error(JSON.stringify(result.diagnostics));
    return result.value;
  }),
  minigames: schema.array(
    toolkitSchema((value) => validateMinigame(value, registry)),
    { min: 3, max: 3 },
  ),
  family: toolkitSchema(validateFamily),
});
export type StoryContent = InferSchema<typeof storyContentSchema>;
export interface StoryState {
  name: string;
  scarf: boolean;
  scene: 'room' | 'map';
  story: NarrativeState;
  puzzles: MinigameState[];
  revealed: string[];
  notebook: NotebookState;
  hints: HintState;
  family: FamilyState;
  generated: GeneratedCase | null;
}
const actionSchema = schema.union(
  schema.object({
    type: schema.literal('choice'),
    choice: schema.string(),
    node: schema.string(),
    revision: schema.number({ integer: true, min: 0 }),
  }),
  schema.object({
    type: schema.literal('puzzle'),
    id: schema.string(),
    value: schema.json,
    revision: schema.number({ integer: true, min: 0 }),
  }),
  schema.object({ type: schema.literal('hint') }),
  schema.object({ type: schema.literal('mark'), axis: schema.string(), value: schema.string() }),
  schema.object({ type: schema.literal('name'), value: schema.string({ maxLength: 40 }) }),
  schema.object({ type: schema.literal('scarf'), value: schema.boolean }),
  schema.object({
    type: schema.literal('scene'),
    value: schema.union(schema.literal('room'), schema.literal('map')),
  }),
  schema.object({ type: schema.literal('handoff'), player: schema.string() }),
  schema.object({ type: schema.literal('confirm'), player: schema.string() }),
  schema.object({ type: schema.literal('generate') }),
);
export type StoryAction = InferSchema<typeof actionSchema>;
export interface StoryView {
  name: string;
  scarf: boolean;
  scene: string;
  story: ReturnType<typeof projectNarrative>;
  puzzles: { id: string; status: string; revision: number; progress: MinigameState['progress'] }[];
  clues: string[];
  marks: NotebookState['marks'];
  hints: number;
  reward: boolean;
  family: FamilyView;
  candidates: number;
  generated: string | null;
}

export const storyRegistration = { schemaVersion: 1, schema: storyContentSchema };
export function loadStoryContent(text: string): ContentPack<StoryContent> {
  return requireValue(parseContentJson(text, storyRegistration, 'content.json'));
}

export function createStoryAdapter(
  content: ContentPack<StoryContent>,
): RuntimeAdapter<StoryState, StoryAction, StoryView, StoryContent> {
  const data = content.data;
  const hintTiers = [{ id: 'place-help', textKey: 'hint.explained', clueIds: ['place'] }];
  const definition = (id: string) => {
    const found = data.minigames.find((item) => item.id === id);
    if (!found) throw new Error(`Unknown lab minigame: ${id}`);
    return found;
  };
  const stateSchema: Schema<StoryState> = toolkitSchema((value) => {
    const raw = requireValue(
      schema
        .object({
          name: schema.string({ maxLength: 40 }),
          scarf: schema.boolean,
          scene: schema.union(schema.literal('room'), schema.literal('map')),
          story: schema.json,
          puzzles: schema.array(schema.json, { min: 3, max: 3 }),
          revealed: schema.array(schema.string(), { max: 3 }),
          notebook: schema.json,
          hints: schema.object({
            schema: schema.literal(1),
            used: schema.array(schema.string(), { max: 1 }),
          }),
          family: schema.json,
          generated: schema.union(schema.literal(null), toolkitSchema(restoreGeneratedCase)),
        })
        .parse(value),
    );
    if (
      new Set(raw.revealed).size !== raw.revealed.length ||
      raw.hints.used.some((hint) => !hintTiers.some((tier) => tier.id === hint))
    ) {
      throw new Error('Unknown or duplicate saved clue/hint');
    }
    const puzzles = raw.puzzles.map((puzzle) => {
      if (!isRecord(puzzle) || typeof puzzle.definitionId !== 'string')
        throw new Error('Missing puzzle identity');
      return restoreMinigame(definition(puzzle.definitionId), puzzle, registry);
    });
    if (new Set(puzzles.map((item) => item.definitionId)).size !== data.minigames.length)
      throw new Error('Missing puzzle state');
    solveDeduction(data.deduction, raw.revealed);
    return {
      ...raw,
      story: restoreNarrative(data.graph, raw.story),
      puzzles,
      notebook: restoreNotebook(data.deduction, raw.notebook, raw.revealed),
      family: parseFamilyState(data.family, raw.family),
    };
  });
  return {
    id: 'storybook-lab',
    stateVersion: 1,
    state: stateSchema,
    action: actionSchema,
    content: storyRegistration,
    eventPhases: ['story'],
    initialize: () => ({
      name: '',
      scarf: false,
      scene: 'room',
      story: createNarrativeState(data.graph),
      puzzles: data.minigames.map((item) => createMinigame(item, `lab-${item.id}`, registry)),
      revealed: [],
      notebook: createNotebook(data.deduction),
      hints: { schema: 1, used: [] },
      family: createFamilyState(data.family),
      generated: null,
    }),
    resolve: (action) => success({ rule: 'story-action', payload: action, turns: 0 }),
    commands: [
      {
        id: 'story-action',
        payload: actionSchema,
        progress: schema.literal(null),
        start: (context, pending) => {
          const action = requireValue(actionSchema.parse(pending.payload));
          const state = context.state;
          switch (action.type) {
            case 'choice':
              state.story = advanceNarrative(data.graph, state.story, {
                node: action.node,
                revision: action.revision,
                choice: action.choice,
              });
              break;
            case 'puzzle': {
              const index = state.puzzles.findIndex((puzzle) => puzzle.definitionId === action.id);
              const current = state.puzzles[index];
              if (!current) throw new Error('Missing active puzzle');
              const next = reduceMinigame(
                definition(action.id),
                current,
                {
                  type: 'move',
                  revision: action.revision,
                  value: action.value,
                },
                registry,
              );
              state.puzzles[index] = next;
              if (next.result && context.claim(next.result.id)) {
                for (const output of next.result.outputs) {
                  if (output.kind === 'clue' && !state.revealed.includes(output.id))
                    state.revealed.push(output.id);
                }
              }
              state.story.flags.ready = state.puzzles.every((item) => item.status === 'completed');
              break;
            }
            case 'hint': {
              const result = nextHint(data.deduction, hintTiers, state.hints, state.revealed, 1);
              if (result.status === 'exhausted')
                requireValue(failure('hints-exhausted', 'Review the already revealed clue.'));
              state.hints = result.state;
              for (const mark of proposeNotebookMarks(data.deduction, state.revealed)) {
                state.notebook = setNotebookMark(
                  data.deduction,
                  state.notebook,
                  state.revealed,
                  mark,
                  'preserve-user',
                );
              }
              break;
            }
            case 'mark':
              state.notebook = setNotebookMark(
                data.deduction,
                state.notebook,
                state.revealed,
                {
                  axis: action.axis,
                  value: action.value,
                  mark: 'confirmed',
                  source: 'user',
                  clueIds: [],
                },
                'replace-user',
              );
              break;
            case 'name':
              state.name = action.value;
              break;
            case 'scarf':
              state.scarf = action.value;
              break;
            case 'scene':
              state.scene = action.value;
              break;
            case 'handoff':
              state.family = beginHandoff(
                data.family,
                state.family,
                action.player,
                state.family.revision,
              );
              break;
            case 'confirm':
              state.family = confirmHandoff(
                data.family,
                state.family,
                action.player,
                state.family.revision,
              );
              break;
            case 'generate':
              if (context.claim('generated-fixture'))
                state.generated = generateReference(context.random().nextUint32());
              break;
          }
        },
      },
    ],
    view: ({ state }) => {
      // The runtime read is immutable; toolkit reducers/projectors accept detached validated data.
      const current = requireValue(stateSchema.parse(state));
      return {
        name: current.name,
        scarf: current.scarf,
        scene: current.scene,
        story: projectNarrative(data.graph, current.story),
        puzzles: current.puzzles.map((item) => ({
          revision: item.revision,
          id: item.definitionId,
          status: item.status,
          progress: item.progress,
        })),
        clues: current.revealed,
        marks: current.notebook.marks,
        hints: current.hints.used.length,
        reward: current.story.collected.reward.includes('scarf'),
        family: projectFamily(data.family, current.family),
        candidates: solveDeduction(data.deduction, current.revealed).length,
        generated: current.generated?.bundleId ?? null,
      };
    },
  };
}

export function createStory(content: ContentPack<StoryContent>, checkpoint?: CheckpointWriter) {
  return createRuntimeHost({
    adapter: createStoryAdapter(content),
    content,
    seed: 'storybook-lab',
    checkpoint,
  });
}

export const storyTrace: readonly StoryAction[] = [
  { type: 'choice', choice: 'look', node: 'welcome', revision: 0 },
  { type: 'puzzle', id: 'scene', value: { target: 'note' }, revision: 0 },
  { type: 'hint' },
  { type: 'puzzle', id: 'matching', value: { type: 'select', card: 'round' }, revision: 0 },
  { type: 'puzzle', id: 'matching', value: { type: 'select', card: 'sun' }, revision: 1 },
  {
    type: 'puzzle',
    id: 'ordering',
    value: { type: 'place', item: 'morning', index: 0 },
    revision: 0,
  },
  { type: 'puzzle', id: 'ordering', value: { type: 'place', item: 'day', index: 1 }, revision: 1 },
  {
    type: 'puzzle',
    id: 'ordering',
    value: { type: 'place', item: 'evening', index: 2 },
    revision: 2,
  },
  { type: 'puzzle', id: 'ordering', value: { type: 'submit' }, revision: 3 },
  { type: 'choice', choice: 'finish', node: 'room', revision: 1 },
];

export async function runStoryTrace(content: ContentPack<StoryContent>) {
  const host = createStory(content);
  for (const action of storyTrace) requireValue(await host.dispatch(action));
  const result = { hash: host.hash(), view: host.getView() };
  await host.dispose();
  return result;
}
