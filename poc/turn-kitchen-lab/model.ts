import {
  applyBoundaryTransforms,
  createRuntimeHost,
  failure,
  parseContentJson,
  requireValue,
  schema,
  success,
} from '@aegis/runtime';
import type {
  BoundaryTransform,
  CheckpointWriter,
  ContentPack,
  InferSchema,
  RuntimeAdapter,
  RuntimeRead,
} from '@aegis/runtime';

const count = schema.number({ integer: true, min: 0, max: 100 });
const id = schema.string({ minLength: 1, maxLength: 60 });
const slot = schema.object({ item: schema.union(id, schema.literal(null)), age: count });
const actionSchema = schema.union(
  schema.object({ type: schema.literal('begin') }),
  schema.object({ type: schema.literal('move'), from: count, to: count }),
  schema.object({ type: schema.literal('start'), recipe: id }),
  schema.object({ type: schema.literal('listen'), actor: id }),
  schema.object({ type: schema.literal('wait') }),
  schema.object({ type: schema.literal('hint') }),
  schema.object({ type: schema.literal('purchase') }),
  schema.object({ type: schema.literal('budget'), allowance: count }),
  schema.object({ type: schema.literal('next') }),
  schema.object({ type: schema.literal('finish'), share: schema.boolean }),
);
const stateSchema = schema.object({
  screen: schema.union(schema.literal('setup'), schema.literal('workshop'), schema.literal('rest')),
  slots: schema.array(slot, { min: 6, max: 8 }),
  actors: schema.record(
    schema.union(schema.literal('waiting'), schema.literal('incoming'), schema.literal('gone')),
  ),
  batches: schema.record(schema.union(schema.literal('working'), schema.literal('ready'))),
  events: schema.array(id, { max: 1000 }),
  credit: count,
  produced: count,
  hints: count,
  purchases: count,
  storyTokens: count,
  reward: count,
  terminal: schema.union(schema.literal(null), schema.literal('shared'), schema.literal('kept')),
});
const balanceSchema = schema.object({
  costs: schema.object({
    begin: count,
    move: count,
    start: count,
    listen: count,
    wait: count,
    hint: count,
    purchase: count,
    budget: count,
    next: count,
    finish: count,
  }),
  phaseBudget: count,
  restBudget: count,
  capacity: count,
  capacityVariants: schema.array(count, { min: 2, max: 2 }),
  jobDelay: count,
  noticeDelay: count,
  arrivalDelay: count,
  expirationDelay: count,
  jobYield: count,
  listenYield: count,
  startingCredit: count,
  purchasePrice: count,
  hintLimit: count,
  completionThreshold: count,
  phaseAgeIncrease: count,
  initialStoryTokens: count,
  terminalReward: count,
  actors: schema.array(id, { min: 3, max: 3 }),
  items: schema.array(id, { min: 3, max: 3 }),
  recipes: schema.array(id, { min: 2, max: 2 }),
  neighbors: schema.array(schema.array(count, { min: 2, max: 2 })),
});

export type KitchenAction = InferSchema<typeof actionSchema>;
export type KitchenState = InferSchema<typeof stateSchema>;
export type KitchenBalance = InferSchema<typeof balanceSchema>;
export type KitchenView = {
  state: RuntimeRead<KitchenState, KitchenBalance>['state'];
  turn: number;
  revision: number;
  remaining: number | null;
};

export function boundaryRules(balance: KitchenBalance): BoundaryTransform<KitchenState>[] {
  return Array.from({ length: balance.capacity }, (_, index) => ({
    id: `age-slot-${index}`,
    evaluate: (before) => {
      const current = before.slots[index];
      if (!current?.item) return [];
      const occupiedNeighbor = balance.neighbors.some(
        ([left, right]) =>
          (left === index && right !== undefined && before.slots[right]?.item) ||
          (right === index && left !== undefined && before.slots[left]?.item),
      );
      return [
        {
          path: ['slots', index, 'age'],
          value: current.age + (occupiedNeighbor ? balance.phaseAgeIncrease : 0),
        },
      ];
    },
  }));
}

export const kitchenAdapter: RuntimeAdapter<
  KitchenState,
  KitchenAction,
  KitchenView,
  KitchenBalance
> = {
  id: 'turn-kitchen-lab',
  stateVersion: 1,
  state: stateSchema,
  action: actionSchema,
  content: {
    schemaVersion: 1,
    schema: balanceSchema,
    validate: (data) => {
      const diagnostics = [];
      if (![6, 8].includes(data.capacity) || !data.capacityVariants.includes(data.capacity)) {
        diagnostics.push({
          code: 'capacity',
          message: 'Choose the six- or eight-slot fixture.',
          path: 'capacity',
        });
      }
      for (const field of ['actors', 'items', 'recipes'] as const) {
        if (new Set(data[field]).size !== data[field].length) {
          diagnostics.push({
            code: 'duplicate',
            message: 'Fixture IDs must be unique.',
            path: field,
          });
        }
      }
      if (data.costs.move !== 0 || data.costs.listen !== 1 || data.costs.wait !== 2) {
        diagnostics.push({
          code: 'trace-costs',
          message: 'This fixture demonstrates costs zero, one and two.',
          path: 'costs',
        });
      }
      if (
        data.jobDelay < 1 ||
        data.noticeDelay < 1 ||
        data.arrivalDelay < 1 ||
        data.expirationDelay < 1
      ) {
        diagnostics.push({
          code: 'delay',
          message: 'Delayed fixture events need positive delays.',
          path: 'jobDelay',
        });
      }
      return diagnostics;
    },
  },
  eventPhases: ['notice', 'ready', 'arrival', 'expiration'],
  initialize: ({ content }) => ({
    screen: 'setup',
    slots: Array.from({ length: content.data.capacity }, (_, index) => ({
      item: content.data.items[index] ?? null,
      age: 0,
    })),
    actors: Object.fromEntries(
      content.data.actors.map((actor, index) => [actor, index === 2 ? 'incoming' : 'waiting']),
    ),
    batches: {},
    events: [],
    credit: content.data.startingCredit,
    produced: 0,
    hints: 0,
    purchases: 0,
    storyTokens: content.data.initialStoryTokens,
    reward: 0,
    terminal: null,
  }),
  resolve: (action, read) => {
    const { state, content, phase, turn } = read;
    const reject = (code: string) =>
      failure(code, 'The fixture action is not legal in this state.');
    if (state.terminal && action.type !== 'finish') return reject('terminal');
    if (state.screen === 'setup' && action.type !== 'begin') return reject('not-started');
    if (action.type === 'begin' && state.screen !== 'setup') return reject('already-started');
    if (
      action.type === 'move' &&
      (!state.slots[action.from]?.item || !state.slots[action.to] || state.slots[action.to]?.item)
    ) {
      return reject('occupied-slot');
    }
    if (
      action.type === 'start' &&
      (state.screen !== 'workshop' ||
        !content.data.recipes.includes(action.recipe) ||
        state.batches[action.recipe])
    ) {
      return reject('invalid-recipe');
    }
    if (action.type === 'listen' && state.actors[action.actor] !== 'waiting')
      return reject('actor-unavailable');
    if (action.type === 'hint' && state.hints >= content.data.hintLimit)
      return reject('hints-exhausted');
    if (action.type === 'purchase' && state.credit < content.data.purchasePrice)
      return reject('insufficient-credit');
    if (
      action.type === 'next' &&
      (state.screen !== 'workshop' ||
        Object.values(state.batches).some((batch) => batch === 'working'))
    )
      return reject('jobs-pending');
    if (
      action.type === 'finish' &&
      !state.terminal &&
      (state.screen !== 'rest' ||
        state.produced < content.data.completionThreshold ||
        (action.share && state.storyTokens < 1))
    ) {
      return reject('ending-unavailable');
    }
    if (action.type === 'budget' && phase && action.allowance < turn - phase.enteredTurn)
      return reject('past-budget');
    const turns = content.data.costs[action.type];
    if (phase && turns > phase.allowance - (turn - phase.enteredTurn))
      return reject('budget-exhausted');
    return success({ rule: 'command', payload: action, turns });
  },
  commands: [
    {
      id: 'command',
      payload: actionSchema,
      progress: schema.literal(null),
      start: (context, pending) => {
        const action = requireValue(actionSchema.parse(pending.payload));
        const { state, content } = context;
        const data = content.data;
        switch (action.type) {
          case 'begin': {
            state.screen = 'workshop';
            context.enterPhase('workshop', data.phaseBudget, 'reject');
            const phase = context.phase;
            if (!phase) throw new Error('Workshop phase was not entered');
            context.schedule({
              id: 'workshop-notice',
              rule: 'notice',
              payload: 'workshop',
              anchor: { kind: 'phase-entry', instance: phase.instance, offset: data.noticeDelay },
              phase: 'notice',
              priority: 0,
            });
            context.schedule({
              id: 'visitor-arrival',
              rule: 'arrival',
              payload: data.actors[2]!,
              anchor: { kind: 'phase-entry', instance: phase.instance, offset: data.arrivalDelay },
              phase: 'arrival',
              priority: 0,
            });
            context.schedule({
              id: 'reader-expiration',
              rule: 'expiration',
              payload: data.actors[0]!,
              anchor: {
                kind: 'phase-end',
                instance: phase.instance,
                offset: data.expirationDelay - data.phaseBudget,
              },
              phase: 'expiration',
              priority: 0,
            });
            break;
          }
          case 'move': {
            const item = state.slots[action.from]!;
            state.slots[action.to] = item;
            state.slots[action.from] = { item: null, age: 0 };
            break;
          }
          case 'start':
            state.batches[action.recipe] = 'working';
            context.schedule({
              id: action.recipe,
              rule: 'ready',
              payload: action.recipe,
              anchor: { kind: 'elapsed', turn: context.turn + data.jobDelay },
              phase: 'ready',
              priority: 0,
            });
            break;
          case 'listen':
            state.credit += data.listenYield;
            break;
          case 'wait':
            break;
          case 'hint':
            state.hints++;
            break;
          case 'purchase':
            state.credit -= data.purchasePrice;
            state.purchases++;
            break;
          case 'budget':
            context.adjustAllowance(action.allowance);
            break;
          case 'next': {
            const balance = requireValue(balanceSchema.parse(data));
            context.state = requireValue(applyBoundaryTransforms(state, boundaryRules(balance)));
            context.state.screen = 'rest';
            context.enterPhase('rest', data.restBudget, 'reject');
            break;
          }
          case 'finish':
            if (context.claim('terminal-reward')) {
              if (action.share) state.storyTokens--;
              state.terminal = action.share ? 'shared' : 'kept';
              state.reward += data.terminalReward;
            }
            break;
        }
      },
    },
  ],
  jobs: ['notice', 'ready', 'arrival', 'expiration'].map((kind) => ({
    id: kind,
    payload: id,
    run: (context, job) => {
      const target = requireValue(id.parse(job.payload));
      if (kind === 'ready') {
        context.state.batches[target] = 'ready';
        context.state.produced += context.content.data.jobYield;
      } else if (kind !== 'notice') {
        context.state.actors[target] = kind === 'arrival' ? 'waiting' : 'gone';
      }
      context.state.events.push(`${kind}:${target}`);
    },
  })),
  view: ({ state, turn, revision, phase }) => ({
    state,
    turn,
    revision,
    remaining: phase ? phase.allowance - (turn - phase.enteredTurn) : null,
  }),
  validate: ({ state, content, jobs }) => {
    const items = state.slots.flatMap((slot) => (slot.item === null ? [] : [slot.item]));
    if (
      state.slots.length !== content.data.capacity ||
      new Set(items).size !== items.length ||
      items.some((item) => !content.data.items.includes(item)) ||
      items.length !== content.data.items.length ||
      Object.keys(state.actors).length !== content.data.actors.length ||
      Object.keys(state.actors).some((actor) => !content.data.actors.includes(actor)) ||
      Object.keys(state.batches).some((recipe) => !content.data.recipes.includes(recipe)) ||
      jobs.some(
        (job) =>
          typeof job.payload !== 'string' ||
          !(
            job.rule === 'notice'
              ? ['workshop']
              : job.rule === 'ready'
                ? content.data.recipes
                : content.data.actors
          ).includes(job.payload),
      )
    ) {
      return failure('incompatible-state', 'The state refers to unavailable fixture content.');
    }
    return success(undefined);
  },
  canActivateContent: ({ state }) => state.screen === 'setup',
};

export function loadKitchenContent(json: string): ContentPack<KitchenBalance> {
  return requireValue(parseContentJson(json, kitchenAdapter.content, 'balance.json'));
}

export function createKitchen(content: ContentPack<KitchenBalance>, checkpoint?: CheckpointWriter) {
  return createRuntimeHost({
    adapter: kitchenAdapter,
    content,
    seed: 'turn-kitchen-lab',
    checkpoint,
  });
}

export const kitchenTrace: readonly KitchenAction[] = [
  { type: 'begin' },
  { type: 'move', from: 0, to: 3 },
  { type: 'hint' },
  { type: 'purchase' },
  { type: 'start', recipe: 'batch-b' },
  { type: 'start', recipe: 'batch-a' },
  { type: 'wait' },
  { type: 'listen', actor: 'maker' },
  { type: 'next' },
  { type: 'finish', share: true },
];

export async function runKitchenTrace(content: ContentPack<KitchenBalance>) {
  const host = createKitchen(content);
  const commits: { turn: number; revision: number; hash: string }[] = [];
  host.subscribeCommits(({ turn, revision, hash }) => commits.push({ turn, revision, hash }));
  for (const action of kitchenTrace) {
    const outcome = await host.dispatch(action);
    if (!outcome.ok)
      throw new Error(
        JSON.stringify({
          seed: host.snapshot().seed,
          content: content.revision,
          action,
          turn: host.getStatus().turn,
          error: outcome.error,
        }),
      );
  }
  const result = { commits, view: host.getView(), hash: host.hash() };
  await host.dispose();
  return result;
}
