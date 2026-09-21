import {
  check,
  id,
  ids,
  integer,
  json,
  list,
  member,
  record,
  reference,
  text,
  unique,
} from './validation.js';
import type { Json } from './validation.js';

export interface MinigameAdapter<Config, State, Action, View> {
  kind: string;
  schema: number;
  config(value: unknown): Config;
  state(value: unknown, config: Config): State;
  action(value: unknown, config: Config): Action;
  initial(config: Config): State;
  reduce(config: Config, state: State, action: Action): State;
  project(config: Config, state: State): View;
  completed(config: Config, state: State): boolean;
}

interface RegisteredAdapter {
  kind: string;
  schema: number;
  config(value: unknown): Json;
  initial(config: Json): Json;
  state(value: unknown, config: Json): Json;
  reduce(config: Json, state: Json, action: unknown): Json;
  project(config: Json, state: Json): Json;
  completed(config: Json, state: Json): boolean;
}

export class MinigameRegistry {
  private readonly adapters = new Map<string, RegisteredAdapter>();

  register<C, S, A, V>(adapter: MinigameAdapter<C, S, A, V>): this {
    const kind = id(adapter.kind, '$.adapter.kind');
    integer(adapter.schema, '$.adapter.schema', 1, 1024);
    check(
      !this.adapters.has(kind),
      'MINI-REGISTRY',
      kind,
      'Minigame kind already registered.',
      'Use a unique kind; do not replace active rules.',
    );
    this.adapters.set(kind, {
      kind,
      schema: adapter.schema,
      config: (v) => json(adapter.config(json(v))),
      initial: (c) => json(adapter.initial(adapter.config(c))),
      state: (s, c) => json(adapter.state(s, adapter.config(c))),
      reduce: (c, s, a) => {
        const config = adapter.config(c);
        return json(adapter.reduce(config, adapter.state(s, config), adapter.action(a, config)));
      },
      project: (c, s) => {
        const config = adapter.config(c);
        return json(adapter.project(config, adapter.state(s, config)));
      },
      completed: (c, s) => {
        const config = adapter.config(c);
        const result = adapter.completed(config, adapter.state(s, config));
        check(
          typeof result === 'boolean',
          'MINI-RESULT',
          kind,
          'Completion must be a boolean.',
          'Return a deterministic completion predicate.',
        );
        return result;
      },
    });
    return this;
  }

  get(kind: string): RegisteredAdapter {
    const adapter = this.adapters.get(kind);
    check(
      adapter,
      'MINI-REGISTRY',
      kind,
      'Unregistered minigame kind.',
      'Register the adapter before loading content.',
    );
    return adapter;
  }
}

export interface MinigameDefinition {
  schema: 1;
  id: string;
  revision: string;
  kind: string;
  adapterSchema: number;
  config: Json;
  outputs: { kind: 'clue' | 'reward'; id: string }[];
}
export interface MinigameResult {
  id: string;
  definitionId: string;
  outputs: MinigameDefinition['outputs'];
}
export interface MinigameState {
  schema: 1;
  definitionId: string;
  contentRevision: string;
  instanceId: string;
  revision: number;
  status: 'active' | 'suspended' | 'cancelled' | 'completed';
  progress: Json;
  result: MinigameResult | null;
}
export type MinigameAction =
  | { type: 'move'; revision: number; value: Json }
  | { type: 'suspend' | 'resume' | 'cancel'; revision: number };

export function validateMinigame(input: unknown, registry: MinigameRegistry): MinigameDefinition {
  json(input);
  const o = record(input, '$');
  check(o.schema === 1, 'VERSION', '$.schema', 'Unsupported minigame definition.', 'Use schema 1.');
  const kind = id(o.kind, '$.kind');
  const adapter = registry.get(kind);
  check(
    o.adapterSchema === adapter.schema,
    'VERSION',
    '$.adapterSchema',
    'Minigame adapter version mismatch.',
    'Use the registered adapter schema or migrate explicitly.',
  );
  const outputs = list(o.outputs, '$.outputs', (v, p) => {
    const out = record(v, p);
    return { kind: member(out.kind, ['clue', 'reward'], `${p}.kind`), id: id(out.id, `${p}.id`) };
  });
  unique(
    outputs.map((out) => `${out.kind}:${out.id}`),
    '$.outputs',
  );
  return {
    schema: 1,
    id: id(o.id, '$.id'),
    revision: id(o.revision, '$.revision'),
    kind,
    adapterSchema: adapter.schema,
    config: adapter.config(o.config),
    outputs,
  };
}

function resultFor(definition: MinigameDefinition, instanceId: string): MinigameResult {
  return {
    id: `${instanceId}:complete`,
    definitionId: definition.id,
    outputs: definition.outputs.map((o) => ({ ...o })),
  };
}

export function createMinigame(
  input: MinigameDefinition,
  instanceId: string,
  registry: MinigameRegistry,
): MinigameState {
  const definition = validateMinigame(input, registry);
  id(instanceId, '$.instanceId');
  const adapter = registry.get(definition.kind);
  const progress = adapter.state(adapter.initial(definition.config), definition.config);
  const completed = adapter.completed(definition.config, progress);
  return {
    schema: 1,
    definitionId: definition.id,
    contentRevision: definition.revision,
    instanceId,
    revision: 0,
    status: completed ? 'completed' : 'active',
    progress,
    result: completed ? resultFor(definition, instanceId) : null,
  };
}

export function restoreMinigame(
  input: MinigameDefinition,
  snapshot: unknown,
  registry: MinigameRegistry,
): MinigameState {
  const definition = validateMinigame(input, registry);
  json(snapshot);
  const o = record(snapshot, '$');
  check(
    o.schema === 1 && o.definitionId === definition.id && o.contentRevision === definition.revision,
    'RESTORE',
    '$',
    'Minigame identity or revision mismatch.',
    'Use matching resolved content.',
  );
  const adapter = registry.get(definition.kind);
  const instanceId = id(o.instanceId, '$.instanceId');
  const progress = adapter.state(o.progress, definition.config);
  const status = member(o.status, ['active', 'suspended', 'cancelled', 'completed'], '$.status');
  const completed = adapter.completed(definition.config, progress);
  check(
    (status === 'completed') === completed,
    'RESTORE',
    '$.status',
    'Completion disagrees with committed progress.',
    'Restore a consistent minigame state.',
  );
  const expected = completed ? resultFor(definition, instanceId) : null;
  if (expected === null) {
    check(
      o.result === null,
      'RESTORE',
      '$.result',
      'Unfinished minigame has a result.',
      'Only commit completion after the rules succeed.',
    );
  } else {
    const actual = record(o.result, '$.result');
    const outputs = list(actual.outputs, '$.result.outputs', (v, p) => {
      const out = record(v, p);
      return { kind: member(out.kind, ['clue', 'reward'], `${p}.kind`), id: id(out.id, `${p}.id`) };
    });
    check(
      actual.id === expected.id &&
        actual.definitionId === expected.definitionId &&
        JSON.stringify(outputs) === JSON.stringify(expected.outputs),
      'RESTORE',
      '$.result',
      'Minigame result was altered.',
      'Restore the result derived from the matching definition.',
    );
  }
  return {
    schema: 1,
    definitionId: definition.id,
    contentRevision: definition.revision,
    instanceId,
    revision: integer(o.revision, '$.revision'),
    status,
    progress,
    result: expected,
  };
}

export function reduceMinigame(
  input: MinigameDefinition,
  snapshot: MinigameState,
  action: MinigameAction,
  registry: MinigameRegistry,
): MinigameState {
  const definition = validateMinigame(input, registry);
  const state = restoreMinigame(definition, snapshot, registry);
  const command = record(action, '$.action');
  integer(command.revision, '$.action.revision');
  check(
    action.revision === state.revision,
    'STALE',
    '$.action.revision',
    'Stale minigame command.',
    'Use the current revision.',
  );
  const type = member(action.type, ['move', 'suspend', 'resume', 'cancel'], '$.action.type');
  check(
    state.status !== 'completed' && state.status !== 'cancelled',
    'MINI-CLOSED',
    '$.status',
    'Minigame is already closed.',
    'Consume its logical result once in the parent; create a new instance to replay.',
  );
  if (type === 'move') {
    check(
      state.status === 'active' && action.type === 'move',
      'MINI-SUSPENDED',
      '$.status',
      'Minigame is suspended.',
      'Resume before making a move.',
    );
    const adapter = registry.get(definition.kind);
    state.progress = adapter.state(
      adapter.reduce(definition.config, state.progress, json(action.value)),
      definition.config,
    );
    if (adapter.completed(definition.config, state.progress)) {
      state.status = 'completed';
      state.result = resultFor(definition, state.instanceId);
    }
  } else if (type === 'resume') {
    check(
      state.status === 'suspended',
      'MINI-LIFECYCLE',
      '$.status',
      'Only suspended games can resume.',
      'Use a legal lifecycle command.',
    );
    state.status = 'active';
  } else if (type === 'suspend') {
    check(
      state.status === 'active',
      'MINI-LIFECYCLE',
      '$.status',
      'Only active games can suspend.',
      'Use a legal lifecycle command.',
    );
    state.status = 'suspended';
  } else state.status = 'cancelled';
  state.revision = integer(state.revision + 1, '$.revision');
  return state;
}

export function projectMinigame(
  definition: MinigameDefinition,
  snapshot: MinigameState,
  registry: MinigameRegistry,
): {
  status: MinigameState['status'];
  revision: number;
  view: Json;
  result: MinigameResult | null;
} {
  const parsed = validateMinigame(definition, registry);
  const state = restoreMinigame(parsed, snapshot, registry);
  return {
    status: state.status,
    revision: state.revision,
    view: registry.get(parsed.kind).project(parsed.config, state.progress),
    result: state.result,
  };
}

interface SelectionConfig {
  targets: { id: string; labelKey: string; required: boolean }[];
}
interface SelectionState {
  found: string[];
  last: string | null;
}
const selection: MinigameAdapter<SelectionConfig, SelectionState, string, Json> = {
  kind: 'scene-selection',
  schema: 1,
  config(value) {
    const o = record(value, '$.config');
    const targets = list(
      o.targets,
      '$.config.targets',
      (v, p) => {
        const t = record(v, p);
        check(
          typeof t.required === 'boolean',
          'SHAPE',
          p,
          'Target requires a required flag.',
          'Supply true or false.',
        );
        return {
          id: id(t.id, `${p}.id`),
          labelKey: id(t.labelKey, `${p}.labelKey`),
          required: t.required,
        };
      },
      128,
    );
    unique(
      targets.map((t) => t.id),
      '$.config.targets',
    );
    check(
      targets.some((t) => t.required),
      'MINI-CONFIG',
      '$.config.targets',
      'No required targets.',
      'Include at least one required target.',
    );
    return { targets };
  },
  state(value, config) {
    const o = record(value, '$.progress');
    const found = ids(o.found, '$.progress.found', 128);
    found.forEach((key) =>
      reference(
        key,
        config.targets.filter((t) => t.required).map((t) => t.id),
        '$.progress.found',
      ),
    );
    const last = o.last === null ? null : id(o.last, '$.progress.last');
    if (last !== null)
      reference(
        last,
        config.targets.map((t) => t.id),
        '$.progress.last',
      );
    return { found, last };
  },
  action(value, config) {
    const target = id(record(value, '$.move').target, '$.move.target');
    reference(
      target,
      config.targets.map((t) => t.id),
      '$.move.target',
    );
    return target;
  },
  initial: () => ({ found: [], last: null }),
  reduce(config, state, target) {
    const required = config.targets.some((t) => t.id === target && t.required);
    return {
      found: required && !state.found.includes(target) ? [...state.found, target] : state.found,
      last: target,
    };
  },
  project: (config, state) => ({
    interaction: 'activate-target',
    targets: config.targets.map((t) => ({
      id: t.id,
      labelKey: t.labelKey,
      found: state.found.includes(t.id),
    })),
    last: state.last,
    lastCorrect: state.last === null ? null : state.found.includes(state.last),
  }),
  completed: (config, state) =>
    config.targets.filter((t) => t.required).every((t) => state.found.includes(t.id)),
};

interface MatchingConfig {
  cards: { id: string; pair: string; labelKey: string; backLabelKey: string }[];
}
interface MatchingState {
  open: string[];
  matched: string[];
  attempts: number;
}
type MatchingAction = { type: 'select'; card: string } | { type: 'clear' };
const matching: MinigameAdapter<MatchingConfig, MatchingState, MatchingAction, Json> = {
  kind: 'matching',
  schema: 1,
  config(value) {
    const cards = list(
      record(value, '$.config').cards,
      '$.config.cards',
      (v, p) => {
        const c = record(v, p);
        return {
          id: id(c.id, `${p}.id`),
          pair: id(c.pair, `${p}.pair`),
          labelKey: id(c.labelKey, `${p}.labelKey`),
          backLabelKey: id(c.backLabelKey, `${p}.backLabelKey`),
        };
      },
      128,
    );
    unique(
      cards.map((c) => c.id),
      '$.config.cards',
    );
    check(
      cards.length >= 2 &&
        cards.every((c) => cards.filter((other) => other.pair === c.pair).length === 2),
      'MINI-CONFIG',
      '$.config.cards',
      'Every pair must have exactly two cards.',
      'Supply a nonempty paired deck.',
    );
    return { cards };
  },
  state(value, config) {
    const o = record(value, '$.progress');
    const open = ids(o.open, '$.progress.open', 2);
    const matched = ids(o.matched, '$.progress.matched', 128);
    [...open, ...matched].forEach((key) =>
      reference(
        key,
        config.cards.map((c) => c.id),
        '$.progress',
      ),
    );
    check(
      !open.some((key) => matched.includes(key)),
      'RESTORE',
      '$.progress',
      'A card is both matched and open.',
      'Restore disjoint selections.',
    );
    check(
      config.cards.every(
        (c) =>
          !matched.includes(c.id) ||
          config.cards
            .filter((other) => other.pair === c.pair)
            .every((other) => matched.includes(other.id)),
      ),
      'RESTORE',
      '$.progress.matched',
      'Incomplete matched pair.',
      'Store both cards of each committed pair.',
    );
    if (open.length === 2)
      check(
        config.cards.find((c) => c.id === open[0])?.pair !==
          config.cards.find((c) => c.id === open[1])?.pair,
        'RESTORE',
        '$.progress.open',
        'Matching pair was not committed.',
        'Commit matching cards together.',
      );
    return { open, matched, attempts: integer(o.attempts, '$.progress.attempts') };
  },
  action(value, config) {
    const o = record(value, '$.move');
    const type = member(o.type, ['select', 'clear'], '$.move.type');
    if (type === 'clear') return { type };
    const card = id(o.card, '$.move.card');
    reference(
      card,
      config.cards.map((c) => c.id),
      '$.move.card',
    );
    return { type, card };
  },
  initial: () => ({ open: [], matched: [], attempts: 0 }),
  reduce(config, state, action) {
    if (action.type === 'clear') {
      check(
        state.open.length === 2,
        'MINI-MOVE',
        '$.move',
        'Only a mismatched pair can be cleared.',
        'Select two cards first.',
      );
      return { ...state, open: [] };
    }
    check(
      state.open.length < 2 &&
        !state.open.includes(action.card) &&
        !state.matched.includes(action.card),
      'MINI-MOVE',
      '$.move.card',
      'Card cannot be selected now.',
      'Clear a mismatched pair or select an unmatched hidden card.',
    );
    const open = [...state.open, action.card];
    if (open.length === 1) return { ...state, open };
    const pair = config.cards.find((c) => c.id === open[0])?.pair;
    const matches = pair === config.cards.find((c) => c.id === open[1])?.pair;
    return {
      open: matches ? [] : open,
      matched: matches ? [...state.matched, ...open] : state.matched,
      attempts: integer(state.attempts + 1, '$.attempts'),
    };
  },
  project: (config, state) => ({
    interaction: 'select-card-then-card',
    clearAvailable: state.open.length === 2,
    cards: config.cards.map((c) => ({
      id: c.id,
      labelKey:
        state.open.includes(c.id) || state.matched.includes(c.id) ? c.labelKey : c.backLabelKey,
      faceUp: state.open.includes(c.id) || state.matched.includes(c.id),
      matched: state.matched.includes(c.id),
    })),
  }),
  completed: (config, state) => state.matched.length === config.cards.length,
};

interface OrderingConfig {
  items: { id: string; labelKey: string }[];
  solution: string[];
}
interface OrderingState {
  order: string[];
  submitted: boolean;
  attempts: number;
}
type OrderingAction = { type: 'place'; item: string; index: number } | { type: 'submit' };
const ordering: MinigameAdapter<OrderingConfig, OrderingState, OrderingAction, Json> = {
  kind: 'ordering',
  schema: 1,
  config(value) {
    const o = record(value, '$.config');
    const items = list(
      o.items,
      '$.config.items',
      (v, p) => {
        const item = record(v, p);
        return { id: id(item.id, `${p}.id`), labelKey: id(item.labelKey, `${p}.labelKey`) };
      },
      128,
    );
    unique(
      items.map((i) => i.id),
      '$.config.items',
    );
    check(
      items.length > 0,
      'MINI-CONFIG',
      '$.config.items',
      'Ordering has no items.',
      'Supply a nonempty authored order.',
    );
    const solution = ids(o.solution, '$.config.solution', 128);
    check(
      solution.length === items.length,
      'MINI-CONFIG',
      '$.config.solution',
      'Solution is not a permutation.',
      'Include each item exactly once.',
    );
    solution.forEach((key) =>
      reference(
        key,
        items.map((i) => i.id),
        '$.config.solution',
      ),
    );
    return { items, solution };
  },
  state(value, config) {
    const o = record(value, '$.progress');
    const order = ids(o.order, '$.progress.order', 128);
    check(
      order.length === config.items.length,
      'RESTORE',
      '$.progress.order',
      'Order is missing items.',
      'Restore a complete permutation.',
    );
    order.forEach((key) => reference(key, config.solution, '$.progress.order'));
    check(
      typeof o.submitted === 'boolean',
      'SHAPE',
      '$.progress.submitted',
      'Missing submission flag.',
      'Supply true or false.',
    );
    return { order, submitted: o.submitted, attempts: integer(o.attempts, '$.progress.attempts') };
  },
  action(value, config) {
    const o = record(value, '$.move');
    const type = member(o.type, ['place', 'submit'], '$.move.type');
    if (type === 'submit') return { type };
    const item = id(o.item, '$.move.item');
    reference(item, config.solution, '$.move.item');
    return { type, item, index: integer(o.index, '$.move.index', 0, config.items.length - 1) };
  },
  initial: (config) => ({ order: config.items.map((i) => i.id), submitted: false, attempts: 0 }),
  reduce(config, state, action) {
    if (action.type === 'submit')
      return { ...state, submitted: true, attempts: integer(state.attempts + 1, '$.attempts') };
    const order = state.order.filter((key) => key !== action.item);
    order.splice(action.index, 0, action.item);
    return { ...state, order, submitted: false };
  },
  project: (config, state) => ({
    interaction: 'select-item-then-position',
    items: state.order.map((key) => {
      const item = config.items.find((i) => i.id === key);
      check(
        item,
        'REFERENCE',
        key,
        'Ordering item is missing from its definition.',
        'Use matching validated content.',
      );
      return { id: key, labelKey: item.labelKey };
    }),
    submitted: state.submitted,
  }),
  completed: (config, state) =>
    state.submitted && state.order.every((key, index) => config.solution[index] === key),
};

export interface RuleTableConfig {
  initial: string;
  states: { id: string; textKey: string; complete: boolean }[];
  moves: {
    id: string;
    from: string;
    to: string;
    labelKey: string;
    media: string | null;
    alternativeKey: string;
  }[];
}
const ruleTable: MinigameAdapter<RuleTableConfig, { at: string }, string, Json> = {
  kind: 'rule-table',
  schema: 1,
  config(value) {
    const o = record(value, '$.config');
    const states = list(
      o.states,
      '$.config.states',
      (v, p) => {
        const s = record(v, p);
        check(
          typeof s.complete === 'boolean',
          'SHAPE',
          p,
          'Missing completion flag.',
          'Supply a boolean.',
        );
        return {
          id: id(s.id, `${p}.id`),
          textKey: id(s.textKey, `${p}.textKey`),
          complete: s.complete,
        };
      },
      256,
    );
    unique(
      states.map((s) => s.id),
      '$.config.states',
    );
    check(
      states.some((s) => s.complete),
      'MINI-CONFIG',
      '$.config.states',
      'No complete state.',
      'Author a successful reachable state.',
    );
    const initial = id(o.initial, '$.config.initial');
    reference(
      initial,
      states.map((s) => s.id),
      '$.config.initial',
    );
    const moves = list(o.moves, '$.config.moves', (v, p) => {
      const m = record(v, p);
      const from = id(m.from, `${p}.from`),
        to = id(m.to, `${p}.to`);
      reference(
        from,
        states.filter((s) => !s.complete).map((s) => s.id),
        `${p}.from`,
      );
      reference(
        to,
        states.map((s) => s.id),
        `${p}.to`,
      );
      return {
        id: id(m.id, `${p}.id`),
        from,
        to,
        labelKey: id(m.labelKey, `${p}.labelKey`),
        media: m.media === null ? null : id(m.media, `${p}.media`),
        alternativeKey: id(m.alternativeKey, `${p}.alternativeKey`),
      };
    });
    unique(
      moves.map((m) => JSON.stringify([m.from, m.id])),
      '$.config.moves',
    );
    const winning = new Set(states.filter((s) => s.complete).map((s) => s.id));
    for (let changed = true; changed;) {
      changed = false;
      for (const move of moves)
        if (winning.has(move.to) && !winning.has(move.from)) {
          winning.add(move.from);
          changed = true;
        }
    }
    check(
      states.every((s) => winning.has(s.id)),
      'MINI-CONFIG',
      '$.config.states',
      'Some states cannot reach completion.',
      'Add a non-punitive route from every state to completion.',
    );
    return { initial, states, moves };
  },
  state(value, config) {
    const at = id(record(value, '$.progress').at, '$.progress.at');
    reference(
      at,
      config.states.map((s) => s.id),
      '$.progress.at',
    );
    return { at };
  },
  action: (value) => id(record(value, '$.move').move, '$.move.move'),
  initial: (config) => ({ at: config.initial }),
  reduce(config, state, action) {
    const move = config.moves.find((m) => m.from === state.at && m.id === action);
    check(
      move,
      'MINI-MOVE',
      '$.move',
      'Rule-table move is not legal here.',
      'Use a projected move.',
    );
    return { at: move.to };
  },
  project(config, state) {
    const current = config.states.find((s) => s.id === state.at);
    check(current, 'REFERENCE', state.at, 'Missing state.', 'Use matching content.');
    return {
      interaction: 'activate-choice',
      textKey: current.textKey,
      moves: config.moves
        .filter((m) => m.from === state.at)
        .map((m) => ({
          id: m.id,
          labelKey: m.labelKey,
          media: m.media,
          alternativeKey: m.alternativeKey,
        })),
    };
  },
  completed: (config, state) => config.states.some((s) => s.id === state.at && s.complete),
};

export function createMinigameRegistry(): MinigameRegistry {
  return new MinigameRegistry()
    .register(selection)
    .register(matching)
    .register(ordering)
    .register(ruleTable);
}

/** Exact bounded units for authored halves/quarters; no floating-point answer comparisons. */
export function exactQuantity(
  numerator: number,
  denominator: number,
  unitsPerWhole: number,
): number {
  integer(numerator, '$.numerator');
  integer(denominator, '$.denominator', 1, 1024);
  integer(unitsPerWhole, '$.unitsPerWhole', 1, 1024);
  check(
    unitsPerWhole % denominator === 0,
    'QUANTITY',
    '$.denominator',
    'Quantity cannot be expressed in the chosen integer units.',
    'Choose a units-per-whole value divisible by every denominator.',
  );
  return integer(numerator * (unitsPerWhole / denominator), '$.units');
}

export function minigameResultId(value: unknown): string {
  return text(record(value, '$.result').id, '$.result.id');
}
