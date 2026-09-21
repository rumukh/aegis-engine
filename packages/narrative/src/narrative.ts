import type { Validated } from '@aegis/core';
import {
  boolean,
  check,
  dictionary,
  id,
  ids,
  integer,
  json,
  list,
  member,
  record,
  reference,
  unique,
  validated,
} from './validation.js';
import type { Json } from './validation.js';

export type StoryReferenceKind = 'clue' | 'fact' | 'glossary' | 'reward' | 'completion';
export type StoryGuard =
  | { kind: 'flag'; id: string; value: boolean }
  | { kind: 'item'; id: string; atLeast: number }
  | { kind: 'claimed'; id: string }
  | { kind: 'all' | 'any'; guards: StoryGuard[] }
  | { kind: 'not'; guard: StoryGuard };

export type StoryEffect =
  | { id: string; kind: 'flag'; flag: string; value: boolean }
  | { id: string; kind: 'item'; item: string; delta: number }
  | { id: string; kind: 'claim'; catalog: StoryReferenceKind; ref: string }
  | {
      id: string;
      kind: 'consumer';
      handler: string;
      reads: string[];
      writes: string[];
      payload: Json;
    };

export interface StoryEdge {
  id: string;
  to: string;
  guard: StoryGuard | null;
  effects: string[];
}

export interface StoryChoice extends StoryEdge {
  text: string;
}
export interface StoryNode {
  id: string;
  scene: string;
  text: string;
  narration: string | null;
  revisit: 'allow' | 'forbid';
  entryEffects: string[];
  choices: StoryChoice[];
  automatic: StoryEdge[];
  resolveEnding: boolean;
}

export interface NarrativeGraph {
  schema: 1;
  id: string;
  revision: string;
  start: string;
  catalogs: Record<StoryReferenceKind | 'scene' | 'text' | 'asset', string[]>;
  flags: string[];
  items: string[];
  data: string[];
  effects: StoryEffect[];
  nodes: StoryNode[];
  endings: { id: string; guard: StoryGuard | null; effects: string[] }[];
  maxAutomaticSteps: number;
}

export interface NarrativeState {
  schema: 1;
  graphId: string;
  contentRevision: string;
  revision: number;
  node: string;
  visits: Record<string, number>;
  flags: Record<string, boolean>;
  items: Record<string, number>;
  data: Record<string, Json>;
  claims: string[];
  collected: Record<StoryReferenceKind, string[]>;
  ending: string | null;
}

export interface ConsumerEffect {
  validate(payload: Json): void;
  /** Pure function; only declared inputs are supplied. Return exactly the declared writes. */
  apply(payload: Json, inputs: Readonly<Record<string, Json>>): Record<string, Json>;
}
export type ConsumerEffects = Readonly<Record<string, ConsumerEffect>>;
export interface NarrativeCommand {
  node: string;
  revision: number;
  choice: string;
}

const referenceKinds: readonly StoryReferenceKind[] = [
  'clue',
  'fact',
  'glossary',
  'reward',
  'completion',
];

function decodeGuard(input: unknown, path: string): StoryGuard | null {
  let size = 0;
  const decode = (value: unknown, at: string, depth: number): StoryGuard => {
    check(
      ++size <= 256 && depth <= 16,
      'GUARD-BOUND',
      at,
      'Guard exceeds expression limits.',
      'Use at most 256 expressions and 16 levels.',
    );
    const o = record(value, at);
    const kind = member(o.kind, ['flag', 'item', 'claimed', 'all', 'any', 'not'], `${at}.kind`);
    switch (kind) {
      case 'flag':
        return { kind, id: id(o.id, `${at}.id`), value: boolean(o.value, `${at}.value`) };
      case 'item':
        return { kind, id: id(o.id, `${at}.id`), atLeast: integer(o.atLeast, `${at}.atLeast`) };
      case 'claimed':
        return { kind, id: id(o.id, `${at}.id`) };
      case 'not':
        return { kind, guard: decode(o.guard, `${at}.guard`, depth + 1) };
      default: {
        const guards = list(o.guards, `${at}.guards`, (g, p) => decode(g, p, depth + 1), 256);
        check(
          guards.length > 0,
          'GUARD-BOUND',
          at,
          'Empty guard group.',
          'Supply at least one guard.',
        );
        return { kind, guards };
      }
    }
  };
  return input === null ? null : decode(input, path, 0);
}

function decodeEffect(value: unknown, path: string): StoryEffect {
  const o = record(value, path);
  const effectId = id(o.id, `${path}.id`);
  const kind = member(o.kind, ['flag', 'item', 'claim', 'consumer'], `${path}.kind`);
  switch (kind) {
    case 'flag':
      return {
        id: effectId,
        kind,
        flag: id(o.flag, `${path}.flag`),
        value: boolean(o.value, `${path}.value`),
      };
    case 'item':
      return {
        id: effectId,
        kind,
        item: id(o.item, `${path}.item`),
        delta: integer(o.delta, `${path}.delta`, -1_000_000),
      };
    case 'claim':
      return {
        id: effectId,
        kind,
        catalog: member(o.catalog, referenceKinds, `${path}.catalog`),
        ref: id(o.ref, `${path}.ref`),
      };
    case 'consumer':
      return {
        id: effectId,
        kind,
        handler: id(o.handler, `${path}.handler`),
        reads: ids(o.reads, `${path}.reads`),
        writes: ids(o.writes, `${path}.writes`),
        payload: json(o.payload, `${path}.payload`),
      };
  }
}

function decodeEdge(value: unknown, path: string): StoryEdge {
  const o = record(value, path);
  return {
    id: id(o.id, `${path}.id`),
    to: id(o.to, `${path}.to`),
    guard: decodeGuard(o.guard, `${path}.guard`),
    effects: ids(o.effects, `${path}.effects`),
  };
}

function guardReferences(guard: StoryGuard | null, graph: NarrativeGraph, path: string): void {
  if (guard === null) return;
  switch (guard.kind) {
    case 'flag':
      reference(guard.id, graph.flags, path);
      break;
    case 'item':
      reference(guard.id, graph.items, path);
      break;
    case 'claimed':
      reference(
        guard.id,
        graph.effects.map((e) => e.id),
        path,
      );
      break;
    case 'not':
      guardReferences(guard.guard, graph, path);
      break;
    default:
      guard.guards.forEach((g, index) => guardReferences(g, graph, `${path}.guards[${index}]`));
  }
}

function parseGraph(input: unknown, handlers: ConsumerEffects): NarrativeGraph {
  json(input);
  const o = record(input, '$');
  check(
    o.schema === 1,
    'VERSION',
    '$.schema',
    'Unsupported narrative schema.',
    'Use schema 1 or migrate explicitly.',
  );
  const c = record(o.catalogs, '$.catalogs');
  const graph: NarrativeGraph = {
    schema: 1,
    id: id(o.id, '$.id'),
    revision: id(o.revision, '$.revision'),
    start: id(o.start, '$.start'),
    catalogs: {
      clue: ids(c.clue, '$.catalogs.clue'),
      fact: ids(c.fact, '$.catalogs.fact'),
      glossary: ids(c.glossary, '$.catalogs.glossary'),
      reward: ids(c.reward, '$.catalogs.reward'),
      completion: ids(c.completion, '$.catalogs.completion'),
      scene: ids(c.scene, '$.catalogs.scene'),
      text: ids(c.text, '$.catalogs.text'),
      asset: ids(c.asset, '$.catalogs.asset'),
    },
    flags: ids(o.flags, '$.flags'),
    items: ids(o.items, '$.items'),
    data: ids(o.data, '$.data'),
    effects: list(o.effects, '$.effects', decodeEffect),
    nodes: list(o.nodes, '$.nodes', (value, path) => {
      const n = record(value, path);
      return {
        id: id(n.id, `${path}.id`),
        scene: id(n.scene, `${path}.scene`),
        text: id(n.text, `${path}.text`),
        narration: n.narration === null ? null : id(n.narration, `${path}.narration`),
        revisit: member(n.revisit, ['allow', 'forbid'], `${path}.revisit`),
        entryEffects: ids(n.entryEffects, `${path}.entryEffects`),
        choices: list(n.choices, `${path}.choices`, (v, p) => ({
          ...decodeEdge(v, p),
          text: id(record(v, p).text, `${p}.text`),
        })),
        automatic: list(n.automatic, `${path}.automatic`, decodeEdge),
        resolveEnding: boolean(n.resolveEnding, `${path}.resolveEnding`),
      };
    }),
    endings: list(o.endings, '$.endings', (value, path) => {
      const e = record(value, path);
      return {
        id: id(e.id, `${path}.id`),
        guard: decodeGuard(e.guard, `${path}.guard`),
        effects: ids(e.effects, `${path}.effects`),
      };
    }),
    maxAutomaticSteps: integer(o.maxAutomaticSteps, '$.maxAutomaticSteps', 1, 1024),
  };
  const nodeIds = graph.nodes.map((n) => n.id);
  const effectIds = graph.effects.map((e) => e.id);
  unique(nodeIds, '$.nodes');
  unique(effectIds, '$.effects');
  unique(
    graph.endings.map((e) => e.id),
    '$.endings',
  );
  reference(graph.start, nodeIds, '$.start');
  for (const effect of graph.effects) {
    const path = `effects.${effect.id}`;
    switch (effect.kind) {
      case 'flag':
        reference(effect.flag, graph.flags, path);
        break;
      case 'item':
        reference(effect.item, graph.items, path);
        break;
      case 'claim':
        reference(effect.ref, graph.catalogs[effect.catalog], path);
        break;
      case 'consumer': {
        const handler = Object.hasOwn(handlers, effect.handler)
          ? handlers[effect.handler]
          : undefined;
        check(
          handler,
          'EFFECT',
          path,
          `Missing consumer effect "${effect.handler}".`,
          'Register the pure effect handler before activation.',
        );
        [...effect.reads, ...effect.writes].forEach((key) => reference(key, graph.data, path));
        handler.validate(json(effect.payload));
      }
    }
  }
  for (const node of graph.nodes) {
    const path = `nodes.${node.id}`;
    reference(node.scene, graph.catalogs.scene, `${path}.scene`);
    reference(node.text, graph.catalogs.text, `${path}.text`);
    if (node.narration !== null)
      reference(node.narration, graph.catalogs.asset, `${path}.narration`);
    node.entryEffects.forEach((effect) => reference(effect, effectIds, path));
    unique(
      [...node.choices, ...node.automatic].map((e) => e.id),
      path,
    );
    check(
      !(node.resolveEnding && (node.choices.length || node.automatic.length)),
      'ENDING',
      path,
      'Ending node has outgoing edges.',
      'Resolve an ending or author outgoing edges, not both.',
    );
    for (const edge of [...node.choices, ...node.automatic]) {
      reference(edge.to, nodeIds, `${path}.${edge.id}.to`);
      guardReferences(edge.guard, graph, `${path}.${edge.id}.guard`);
      edge.effects.forEach((effect) => reference(effect, effectIds, path));
    }
    for (const choice of node.choices) reference(choice.text, graph.catalogs.text, path);
  }
  for (const ending of graph.endings) {
    guardReferences(ending.guard, graph, `endings.${ending.id}`);
    ending.effects.forEach((effect) => reference(effect, effectIds, `endings.${ending.id}`));
  }
  return graph;
}

export function validateNarrative(
  input: unknown,
  handlers: ConsumerEffects = {},
): Validated<NarrativeGraph> {
  return validated(() => parseGraph(input, handlers));
}

function guardHolds(guard: StoryGuard | null, state: NarrativeState): boolean {
  if (guard === null) return true;
  switch (guard.kind) {
    case 'flag':
      return state.flags[guard.id] === guard.value;
    case 'item':
      return (state.items[guard.id] ?? 0) >= guard.atLeast;
    case 'claimed':
      return state.claims.includes(guard.id);
    case 'all':
      return guard.guards.every((g) => guardHolds(g, state));
    case 'any':
      return guard.guards.some((g) => guardHolds(g, state));
    case 'not':
      return !guardHolds(guard.guard, state);
  }
}

function applyEffects(
  graph: NarrativeGraph,
  state: NarrativeState,
  effectIds: readonly string[],
  handlers: ConsumerEffects,
): void {
  for (const effectId of effectIds) {
    if (state.claims.includes(effectId)) continue;
    const effect = graph.effects.find((e) => e.id === effectId);
    check(effect, 'REFERENCE', `effects.${effectId}`, 'Unknown effect.', 'Declare the effect.');
    switch (effect.kind) {
      case 'flag':
        state.flags[effect.flag] = effect.value;
        break;
      case 'item': {
        const quantity = (state.items[effect.item] ?? 0) + effect.delta;
        integer(quantity, `items.${effect.item}`);
        state.items[effect.item] = quantity;
        break;
      }
      case 'claim': {
        const collection = state.collected[effect.catalog];
        if (!collection.includes(effect.ref)) collection.push(effect.ref);
        break;
      }
      case 'consumer': {
        for (const key of [...effect.reads, ...effect.writes]) {
          check(
            Object.hasOwn(state.data, key),
            'DEPENDENCY',
            `effects.${effect.id}.${key}`,
            'Consumer effect dependency is missing.',
            'Initialize every declared data dependency before advancing.',
          );
        }
        const handler = handlers[effect.handler];
        check(
          handler,
          'EFFECT',
          effect.id,
          'Consumer handler is missing.',
          'Register the declared handler.',
        );
        const inputs = Object.fromEntries(effect.reads.map((key) => [key, json(state.data[key])]));
        const output = dictionary(
          handler.apply(json(effect.payload), inputs),
          `effects.${effect.id}.output`,
          json,
        );
        check(
          Object.keys(output).length === effect.writes.length &&
            effect.writes.every((key) => Object.hasOwn(output, key)),
          'EFFECT-WRITES',
          effect.id,
          'Consumer output differs from declared writes.',
          'Return exactly the declared write keys.',
        );
        for (const key of effect.writes) state.data[key] = json(output[key]);
        break;
      }
    }
    state.claims.push(effect.id);
  }
}

function enter(
  graph: NarrativeGraph,
  state: NarrativeState,
  target: string,
  handlers: ConsumerEffects,
): void {
  const node = graph.nodes.find((n) => n.id === target);
  check(node, 'REFERENCE', target, 'Missing target node.', 'Declare the target.');
  const visits = state.visits[target] ?? 0;
  check(
    visits === 0 || node.revisit === 'allow',
    'REVISIT',
    target,
    'This node cannot be revisited.',
    'Use an allowed route or explicitly mark the node revisitable.',
  );
  state.node = target;
  state.visits[target] = integer(visits + 1, `visits.${target}`, 1);
  applyEffects(graph, state, node.entryEffects, handlers);
}

function settle(graph: NarrativeGraph, state: NarrativeState, handlers: ConsumerEffects): void {
  const trace: string[] = [];
  for (let step = 0; ; step++) {
    const node = graph.nodes.find((n) => n.id === state.node);
    check(
      node,
      'REFERENCE',
      state.node,
      'Missing active node.',
      'Restore against matching content.',
    );
    if (node.resolveEnding) {
      const ending = graph.endings.find((e) => guardHolds(e.guard, state));
      check(
        ending,
        'ENDING',
        node.id,
        'No eligible ending.',
        'Author an eligible ending in consumer precedence order.',
      );
      applyEffects(graph, state, ending.effects, handlers);
      state.ending = ending.id;
      return;
    }
    const edge = node.automatic.find((e) => guardHolds(e.guard, state));
    if (!edge) return;
    trace.push(`${node.id}:${edge.id}`);
    check(
      step < graph.maxAutomaticSteps,
      'AUTO-LIMIT',
      node.id,
      `Automatic transition budget exceeded: ${trace.join(' -> ')}.`,
      'Break the cycle with a manual choice or state-changing guard.',
    );
    applyEffects(graph, state, edge.effects, handlers);
    enter(graph, state, edge.to, handlers);
  }
}

export function createNarrativeState(
  input: NarrativeGraph,
  initial: {
    flags?: Record<string, boolean>;
    items?: Record<string, number>;
    data?: Record<string, Json>;
  } = {},
  handlers: ConsumerEffects = {},
): NarrativeState {
  const graph = parseGraph(input, handlers);
  const flags = dictionary(initial.flags ?? {}, 'initial.flags', boolean);
  const items = dictionary(initial.items ?? {}, 'initial.items', integer);
  const data = dictionary(initial.data ?? {}, 'initial.data', json);
  Object.keys(flags).forEach((key) => reference(key, graph.flags, 'initial.flags'));
  Object.keys(items).forEach((key) => reference(key, graph.items, 'initial.items'));
  Object.keys(data).forEach((key) => reference(key, graph.data, 'initial.data'));
  const state: NarrativeState = {
    schema: 1,
    graphId: graph.id,
    contentRevision: graph.revision,
    revision: 0,
    node: graph.start,
    visits: {},
    flags: Object.fromEntries(graph.flags.map((key) => [key, flags[key] ?? false])),
    items: Object.fromEntries(graph.items.map((key) => [key, items[key] ?? 0])),
    data,
    claims: [],
    collected: { clue: [], fact: [], glossary: [], reward: [], completion: [] },
    ending: null,
  };
  enter(graph, state, graph.start, handlers);
  settle(graph, state, handlers);
  return state;
}

export function restoreNarrative(
  input: NarrativeGraph,
  snapshot: unknown,
  handlers: ConsumerEffects = {},
): NarrativeState {
  const graph = parseGraph(input, handlers);
  json(snapshot);
  const o = record(snapshot, '$');
  check(
    o.schema === 1 && o.graphId === graph.id && o.contentRevision === graph.revision,
    'RESTORE',
    '$',
    'Narrative identity or revision mismatch.',
    'Use matching content or an explicit migration.',
  );
  const c = record(o.collected, '$.collected');
  const state: NarrativeState = {
    schema: 1,
    graphId: graph.id,
    contentRevision: graph.revision,
    revision: integer(o.revision, '$.revision'),
    node: id(o.node, '$.node'),
    visits: dictionary(o.visits, '$.visits', (v, p) => integer(v, p, 1)),
    flags: dictionary(o.flags, '$.flags', boolean),
    items: dictionary(o.items, '$.items', integer),
    data: dictionary(o.data, '$.data', json),
    claims: ids(o.claims, '$.claims'),
    collected: {
      clue: ids(c.clue, '$.collected.clue'),
      fact: ids(c.fact, '$.collected.fact'),
      glossary: ids(c.glossary, '$.collected.glossary'),
      reward: ids(c.reward, '$.collected.reward'),
      completion: ids(c.completion, '$.collected.completion'),
    },
    ending: o.ending === null ? null : id(o.ending, '$.ending'),
  };
  reference(
    state.node,
    graph.nodes.map((n) => n.id),
    '$.node',
  );
  check(
    (state.visits[state.node] ?? 0) > 0,
    'RESTORE',
    '$.visits',
    'Active node was not visited.',
    'Restore a committed snapshot.',
  );
  Object.keys(state.visits).forEach((key) =>
    reference(
      key,
      graph.nodes.map((n) => n.id),
      '$.visits',
    ),
  );
  for (const [values, allowed, path] of [
    [state.flags, graph.flags, 'flags'],
    [state.items, graph.items, 'items'],
  ] as const) {
    check(
      Object.keys(values).length === allowed.length,
      'RESTORE',
      path,
      'State declarations differ from content.',
      'Restore every declared key.',
    );
    Object.keys(values).forEach((key) => reference(key, allowed, path));
  }
  Object.keys(state.data).forEach((key) => reference(key, graph.data, '$.data'));
  state.claims.forEach((key) =>
    reference(
      key,
      graph.effects.map((e) => e.id),
      '$.claims',
    ),
  );
  for (const kind of referenceKinds) {
    state.collected[kind].forEach((key) =>
      reference(key, graph.catalogs[kind], `$.collected.${kind}`),
    );
    const expected = graph.effects
      .filter((e) => e.kind === 'claim' && e.catalog === kind && state.claims.includes(e.id))
      .map((e) => (e.kind === 'claim' ? e.ref : ''));
    check(
      expected.every((key) => state.collected[kind].includes(key)) &&
        state.collected[kind].every((key) => expected.includes(key)),
      'RESTORE',
      `$.collected.${kind}`,
      'Claims and collection disagree.',
      'Restore the complete atomic snapshot.',
    );
  }
  for (const node of graph.nodes.filter((n) => (state.visits[n.id] ?? 0) > 0)) {
    check(
      node.entryEffects.every((key) => state.claims.includes(key)),
      'RESTORE',
      `visits.${node.id}`,
      'Visited node is missing entry claims.',
      'Restore an already committed state; entry effects will not be replayed.',
    );
    check(
      node.revisit === 'allow' || state.visits[node.id] === 1,
      'RESTORE',
      `visits.${node.id}`,
      'Forbidden node was revisited.',
      'Use a consistent snapshot.',
    );
  }
  if (state.ending !== null) {
    const ending = graph.endings.find((e) => e.id === state.ending);
    check(
      ending &&
        ending.effects.every((key) => state.claims.includes(key)) &&
        graph.nodes.some((n) => n.id === state.node && n.resolveEnding),
      'RESTORE',
      '$.ending',
      'Invalid committed ending.',
      'Restore the terminal node and all its effect claims.',
    );
  } else {
    const node = graph.nodes.find((n) => n.id === state.node);
    check(
      node && !node.resolveEnding && !node.automatic.some((e) => guardHolds(e.guard, state)),
      'RESTORE',
      '$.node',
      'Snapshot is not at a committed narrative boundary.',
      'Save after automatic transitions settle.',
    );
  }
  return state;
}

export function advanceNarrative(
  input: NarrativeGraph,
  snapshot: NarrativeState,
  command: NarrativeCommand,
  handlers: ConsumerEffects = {},
): NarrativeState {
  const graph = parseGraph(input, handlers);
  const state = restoreNarrative(graph, snapshot, handlers);
  const action = record(command, '$.command');
  id(action.node, '$.command.node');
  integer(action.revision, '$.command.revision');
  id(action.choice, '$.command.choice');
  check(
    state.ending === null,
    'TERMINAL',
    '$.ending',
    'Narrative already ended.',
    'Keep the committed outcome.',
  );
  check(
    command.node === state.node && command.revision === state.revision,
    'STALE',
    '$.command',
    'Stale narrative command.',
    'Project the current node and revision before choosing.',
  );
  const node = graph.nodes.find((n) => n.id === state.node);
  const choice = node?.choices.find((c) => c.id === command.choice);
  check(
    choice && guardHolds(choice.guard, state),
    'CHOICE',
    '$.command.choice',
    'Unknown or disabled choice.',
    'Choose an enabled option from the current projection.',
  );
  applyEffects(graph, state, choice.effects, handlers);
  enter(graph, state, choice.to, handlers);
  settle(graph, state, handlers);
  state.revision = integer(state.revision + 1, '$.revision');
  return state;
}

export function projectNarrative(
  graph: NarrativeGraph,
  snapshot: NarrativeState,
  handlers: ConsumerEffects = {},
): {
  node: string;
  scene: string;
  text: string;
  narration: string | null;
  revision: number;
  ending: string | null;
  choices: { id: string; text: string; enabled: boolean }[];
} {
  const state = restoreNarrative(graph, snapshot, handlers);
  const node = graph.nodes.find((n) => n.id === state.node);
  check(node, 'REFERENCE', state.node, 'Missing active node.', 'Use matching content.');
  return {
    node: node.id,
    scene: node.scene,
    text: node.text,
    narration: node.narration,
    revision: state.revision,
    ending: state.ending,
    choices:
      state.ending === null
        ? node.choices.map((c) => ({ id: c.id, text: c.text, enabled: guardHolds(c.guard, state) }))
        : [],
  };
}
