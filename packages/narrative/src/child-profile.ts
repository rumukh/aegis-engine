import type { Diagnostic, Validated } from '@aegis/core';
import { advanceNarrative, createNarrativeState, validateNarrative } from './narrative.js';
import type { ConsumerEffects, NarrativeGraph } from './narrative.js';
import {
  boolean,
  check,
  id,
  ids,
  integer,
  json,
  list,
  record,
  reference,
  requireValid,
  text,
  unique,
  validated,
} from './validation.js';

export interface ContentCatalogs {
  assets: string[];
  clues: string[];
  facts: string[];
  glossary: string[];
  rewards: string[];
  speakers: string[];
}
export interface TextPlaceholder {
  id: string;
  maxWords: number;
  variants: { id: string; text: string }[];
}
export interface ChildTextVariant {
  id: string;
  sentences: string[];
  placeholders: TextPlaceholder[];
  narration: { selection: string[]; assetId: string }[];
}
export interface ChildLine {
  id: string;
  speaker: string | null;
  variants: ChildTextVariant[];
}
export interface ChildCase {
  schema: 1;
  id: string;
  entry: string;
  lines: ChildLine[];
  newTerms: string[];
  factIds: string[];
  clueIds: string[];
  rewardIds: string[];
  redHerrings: { id: string; explanationLine: string }[];
  nodes: { id: string; lineIds: string[]; termIds: string[]; next: string[]; complete: boolean }[];
  decisions: {
    id: string;
    node: string;
    pageSize: number;
    choices: { id: string; line: string; to: string }[];
  }[];
  routes: { id: string; nodes: string[] }[];
}
export interface ChildProfile {
  maxWordsPerSentence: number;
  maxNewTerms: number;
  factCards: number;
  maxPrimaryChoices: number;
  requireNarration: boolean;
  maxPhraseCombinations: number;
}
export const CHILD_PROFILE: Readonly<ChildProfile> = Object.freeze({
  maxWordsPerSentence: 10,
  maxNewTerms: 3,
  factCards: 3,
  maxPrimaryChoices: 3,
  requireNarration: true,
  maxPhraseCombinations: 128,
});

/** Unicode words, with internal apostrophes/hyphens retained; punctuation is not a word. */
export function tokenizeWords(sentence: string): string[] {
  return sentence.match(/[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu) ?? [];
}

function parseCatalogs(value: ContentCatalogs): ContentCatalogs {
  const o = record(value, '$.catalogs');
  return {
    assets: ids(o.assets, '$.catalogs.assets'),
    clues: ids(o.clues, '$.catalogs.clues'),
    facts: ids(o.facts, '$.catalogs.facts'),
    glossary: ids(o.glossary, '$.catalogs.glossary'),
    rewards: ids(o.rewards, '$.catalogs.rewards'),
    speakers: ids(o.speakers, '$.catalogs.speakers'),
  };
}

function parseProfile(value: ChildProfile): ChildProfile {
  return {
    maxWordsPerSentence: integer(
      value.maxWordsPerSentence,
      '$.profile.maxWordsPerSentence',
      1,
      100,
    ),
    maxNewTerms: integer(value.maxNewTerms, '$.profile.maxNewTerms', 0, 128),
    factCards: integer(value.factCards, '$.profile.factCards', 0, 128),
    maxPrimaryChoices: integer(value.maxPrimaryChoices, '$.profile.maxPrimaryChoices', 1, 64),
    requireNarration: boolean(value.requireNarration, '$.profile.requireNarration'),
    maxPhraseCombinations: integer(
      value.maxPhraseCombinations,
      '$.profile.maxPhraseCombinations',
      1,
      1024,
    ),
  };
}

function parseVariant(
  value: unknown,
  path: string,
  catalogs: ContentCatalogs,
  profile: ChildProfile,
): ChildTextVariant {
  const o = record(value, path);
  const sentences = list(o.sentences, `${path}.sentences`, text, 128);
  check(
    sentences.length > 0,
    'CHILD-TEXT',
    path,
    'Line variant has no authored sentences.',
    'Supply explicit sentence segments.',
  );
  const placeholders = list(
    o.placeholders,
    `${path}.placeholders`,
    (v, p) => {
      const placeholder = record(v, p);
      const maxWords = integer(placeholder.maxWords, `${p}.maxWords`, 1, 100);
      const variants = list(
        placeholder.variants,
        `${p}.variants`,
        (entry, at) => {
          const variant = record(entry, at);
          const rendered = text(variant.text, `${at}.text`);
          check(
            !/[{}]/.test(rendered),
            'CHILD-PLACEHOLDER',
            at,
            'Nested placeholder substitution is not supported.',
            'Use fully resolved authored substitutions.',
          );
          const wordCount = tokenizeWords(rendered).length;
          check(
            wordCount > 0 && wordCount <= maxWords,
            'CHILD-WORDS',
            at,
            'Placeholder variant exceeds its declared word bound or contains no words.',
            'Author a nonempty variant within maxWords.',
          );
          return { id: id(variant.id, `${at}.id`), text: rendered };
        },
        128,
      );
      unique(
        variants.map((entry) => entry.id),
        `${p}.variants`,
      );
      return { id: id(placeholder.id, `${p}.id`), maxWords, variants };
    },
    16,
  );
  unique(
    placeholders.map((p) => p.id),
    `${path}.placeholders`,
  );
  const used: string[] = [];
  for (const [index, sentence] of sentences.entries()) {
    let substitutionWords = 0;
    const without = sentence.replace(/\{([A-Za-z0-9._:/-]+)\}/g, (_, key: string) => {
      const placeholder = placeholders.find((p) => p.id === key);
      check(
        placeholder,
        'CHILD-PLACEHOLDER',
        `${path}.sentences[${index}]`,
        `Undeclared placeholder "${key}".`,
        'Declare its finite variants or maximum word bound.',
      );
      used.push(key);
      substitutionWords += placeholder.maxWords;
      return ' ';
    });
    check(
      !/[{}]/.test(without),
      'CHILD-PLACEHOLDER',
      path,
      'Malformed placeholder syntax.',
      'Use {stable-id} placeholders.',
    );
    const count = tokenizeWords(without).length + substitutionWords;
    check(
      count > 0 && count <= profile.maxWordsPerSentence,
      'CHILD-WORDS',
      `${path}.sentences[${index}]`,
      `Sentence worst-case word count is ${count}; limit is ${profile.maxWordsPerSentence}.`,
      'Shorten the explicit sentence or reduce a truthful placeholder bound.',
    );
  }
  check(
    placeholders.every((p) => used.includes(p.id)),
    'CHILD-PLACEHOLDER',
    path,
    'Unused placeholder declaration.',
    'Remove unused placeholders.',
  );
  const count = placeholders.reduce((total, p) => total * Math.max(1, p.variants.length), 1);
  check(
    count <= profile.maxPhraseCombinations,
    'CHILD-BOUND',
    path,
    'Phrase variant product exceeds the limit.',
    'Reduce variants or split the line.',
  );
  let combinations: string[][] = [[]];
  for (const placeholder of placeholders)
    combinations = combinations.flatMap((combination) =>
      placeholder.variants.map((variant) => [...combination, variant.id]),
    );
  if (profile.requireNarration)
    check(
      placeholders.every((p) => p.variants.length > 0),
      'CHILD-NARRATION',
      path,
      'A bound-only placeholder cannot have complete finite recorded narration.',
      'Supply finite approved phrase variants or explicitly select a non-narrated profile; arbitrary-name speech is not provided.',
    );
  const narration = list(
    o.narration,
    `${path}.narration`,
    (v, p) => {
      const binding = record(v, p);
      const selection = list(binding.selection, `${p}.selection`, id, 16);
      check(
        selection.length === placeholders.length,
        'CHILD-NARRATION',
        p,
        'Narration selection has the wrong arity.',
        'Name one variant for each placeholder, in declaration order.',
      );
      selection.forEach((key, index) =>
        reference(key, placeholders[index]?.variants.map((variant) => variant.id) ?? [], p),
      );
      const assetId = id(binding.assetId, `${p}.assetId`);
      reference(assetId, catalogs.assets, p);
      return { selection, assetId };
    },
    1024,
  );
  unique(
    narration.map((n) => JSON.stringify(n.selection)),
    `${path}.narration`,
  );
  if (profile.requireNarration) {
    check(
      combinations.every((selection) =>
        narration.some((n) => JSON.stringify(n.selection) === JSON.stringify(selection)),
      ),
      'CHILD-NARRATION',
      path,
      'Required narration is missing for a phrase variant.',
      'Bind an approved audio asset to every resolved variant, including [] for a line without placeholders.',
    );
  }
  return { id: id(o.id, `${path}.id`), sentences, placeholders, narration };
}

function parseChild(
  input: unknown,
  catalogInput: ContentCatalogs,
  profileInput: ChildProfile,
): ChildCase {
  json(input);
  const catalogs = parseCatalogs(catalogInput),
    profile = parseProfile(profileInput);
  const o = record(input, '$');
  check(o.schema === 1, 'VERSION', '$.schema', 'Unsupported child case schema.', 'Use schema 1.');
  const lines = list(o.lines, '$.lines', (value, path): ChildLine => {
    const line = record(value, path);
    const speaker = line.speaker === null ? null : id(line.speaker, `${path}.speaker`);
    if (speaker !== null) reference(speaker, catalogs.speakers, `${path}.speaker`);
    const variants = list(
      line.variants,
      `${path}.variants`,
      (v, p) => parseVariant(v, p, catalogs, profile),
      128,
    );
    check(
      variants.length > 0,
      'CHILD-TEXT',
      path,
      'Line has no phrase variants.',
      'Author at least one variant.',
    );
    unique(
      variants.map((v) => v.id),
      `${path}.variants`,
    );
    return { id: id(line.id, `${path}.id`), speaker, variants };
  });
  unique(
    lines.map((line) => line.id),
    '$.lines',
  );
  const newTerms = ids(o.newTerms, '$.newTerms', 128);
  check(
    newTerms.length <= profile.maxNewTerms,
    'CHILD-GLOSSARY',
    '$.newTerms',
    'Too many new terms in this case.',
    `Introduce at most ${profile.maxNewTerms} terms.`,
  );
  newTerms.forEach((key) => reference(key, catalogs.glossary, '$.newTerms'));
  const factIds = ids(o.factIds, '$.factIds', 128);
  check(
    factIds.length === profile.factCards,
    'CHILD-FACTS',
    '$.factIds',
    `Case must have exactly ${profile.factCards} fact cards.`,
    'Supply the required distinct applicable fact IDs.',
  );
  factIds.forEach((key) => reference(key, catalogs.facts, '$.factIds'));
  const clueIds = ids(o.clueIds, '$.clueIds'),
    rewardIds = ids(o.rewardIds, '$.rewardIds');
  clueIds.forEach((key) => reference(key, catalogs.clues, '$.clueIds'));
  rewardIds.forEach((key) => reference(key, catalogs.rewards, '$.rewardIds'));
  const redHerrings = list(
    o.redHerrings,
    '$.redHerrings',
    (value, path) => {
      const h = record(value, path),
        explanationLine = id(h.explanationLine, `${path}.explanationLine`);
      reference(
        explanationLine,
        lines.map((l) => l.id),
        path,
      );
      return { id: id(h.id, `${path}.id`), explanationLine };
    },
    128,
  );
  unique(
    redHerrings.map((h) => h.id),
    '$.redHerrings',
  );
  const nodes = list(o.nodes, '$.nodes', (value, path) => {
    const n = record(value, path),
      lineIds = ids(n.lineIds, `${path}.lineIds`),
      termIds = ids(n.termIds, `${path}.termIds`, 128);
    lineIds.forEach((key) =>
      reference(
        key,
        lines.map((l) => l.id),
        path,
      ),
    );
    termIds.forEach((key) => reference(key, catalogs.glossary, path));
    return {
      id: id(n.id, `${path}.id`),
      lineIds,
      termIds,
      next: ids(n.next, `${path}.next`),
      complete: boolean(n.complete, `${path}.complete`),
    };
  });
  unique(
    nodes.map((n) => n.id),
    '$.nodes',
  );
  nodes.forEach((node) =>
    node.next.forEach((key) =>
      reference(
        key,
        nodes.map((n) => n.id),
        `nodes.${node.id}.next`,
      ),
    ),
  );
  const entry = id(o.entry, '$.entry');
  reference(
    entry,
    nodes.map((n) => n.id),
    '$.entry',
  );
  const decisions = list(o.decisions, '$.decisions', (value, path) => {
    const d = record(value, path),
      node = id(d.node, `${path}.node`);
    reference(
      node,
      nodes.map((n) => n.id),
      `${path}.node`,
    );
    const choices = list(
      d.choices,
      `${path}.choices`,
      (v, p) => {
        const choice = record(v, p),
          line = id(choice.line, `${p}.line`),
          to = id(choice.to, `${p}.to`);
        reference(
          line,
          lines.map((l) => l.id),
          `${p}.line`,
        );
        reference(to, nodes.find((n) => n.id === node)?.next ?? [], `${p}.to`);
        return { id: id(choice.id, `${p}.id`), line, to };
      },
      128,
    );
    check(
      choices.length > 0,
      'CHILD-CHOICES',
      path,
      'Decision has no choices.',
      'Supply at least one choice.',
    );
    unique(
      choices.map((c) => c.id),
      `${path}.choices`,
    );
    return {
      id: id(d.id, `${path}.id`),
      node,
      pageSize: integer(d.pageSize, `${path}.pageSize`, 1, profile.maxPrimaryChoices),
      choices,
    };
  });
  unique(
    decisions.map((d) => d.id),
    '$.decisions',
  );
  unique(
    decisions.map((d) => d.node),
    '$.decisions.node',
  );
  const routes = list(
    o.routes,
    '$.routes',
    (value, path) => {
      const route = record(value, path),
        routeNodes = list(route.nodes, `${path}.nodes`, id, 1024);
      check(
        routeNodes.length > 0 && routeNodes[0] === entry,
        'CHILD-ROUTE',
        path,
        'Route does not start at the case entry.',
        'Provide a playable route from the entry.',
      );
      for (const [index, key] of routeNodes.entries()) {
        reference(
          key,
          nodes.map((n) => n.id),
          path,
        );
        if (index > 0)
          reference(
            key,
            nodes.find((n) => n.id === routeNodes[index - 1])?.next ?? [],
            `${path}.nodes[${index}]`,
          );
      }
      check(
        nodes.some((n) => n.id === routeNodes[routeNodes.length - 1] && n.complete),
        'CHILD-ROUTE',
        path,
        'Route does not reach a completion node.',
        'Include a full playable route, not disconnected appearances.',
      );
      return { id: id(route.id, `${path}.id`), nodes: routeNodes };
    },
    128,
  );
  unique(
    routes.map((r) => r.id),
    '$.routes',
  );
  return {
    schema: 1,
    id: id(o.id, '$.id'),
    entry,
    lines,
    newTerms,
    factIds,
    clueIds,
    rewardIds,
    redHerrings,
    nodes,
    decisions,
    routes,
  };
}

export function validateChildProfile(
  input: unknown,
  catalogs: ContentCatalogs,
  profile: ChildProfile = CHILD_PROFILE,
): Validated<ChildCase> {
  return validated(() => parseChild(input, catalogs, profile));
}

export interface TeachingRouteReport {
  routeId: string;
  terms: { termId: string; encounters: number; distinctNodes: string[] }[];
  missingExplanations: string[];
  editorialReviewRequired: true;
}

export function reportTeachingRoutes(
  input: ChildCase,
  catalogs: ContentCatalogs,
  profile: ChildProfile = CHILD_PROFILE,
): TeachingRouteReport[] {
  const content = parseChild(input, catalogs, profile);
  return content.routes.map((route) => {
    const visited = route.nodes
      .map((key) => content.nodes.find((n) => n.id === key))
      .filter((n) => n !== undefined);
    return {
      routeId: route.id,
      terms: content.newTerms.map((termId) => {
        const encounters = visited.filter((node) => node.termIds.includes(termId));
        return {
          termId,
          encounters: encounters.length,
          distinctNodes: [...new Set(encounters.map((n) => n.id))],
        };
      }),
      missingExplanations: content.redHerrings
        .filter((h) => !visited.some((n) => n.lineIds.includes(h.explanationLine)))
        .map((h) => h.id),
      editorialReviewRequired: true,
    };
  });
}

export function childRouteDiagnostics(
  reports: readonly TeachingRouteReport[],
  minimumDistinctEncounters = 3,
): Diagnostic[] {
  integer(minimumDistinctEncounters, '$.minimumDistinctEncounters', 1, 128);
  return reports.flatMap((report) => [
    ...report.terms
      .filter((term) => term.distinctNodes.length < minimumDistinctEncounters)
      .map((term): Diagnostic => ({
        code: 'AEG-NARRATIVE-CHILD-RECURRENCE',
        severity: 'warning',
        location: { path: `routes.${report.routeId}.${term.termId}` },
        message: `Term is encountered at ${term.distinctNodes.length} distinct nodes on this route.`,
        fix: 'Review repeated teaching along this playable route; global text occurrence counts are not evidence.',
      })),
    ...report.missingExplanations.map((key): Diagnostic => ({
      code: 'AEG-NARRATIVE-CHILD-EXPLANATION',
      severity: 'warning',
      location: { path: `routes.${report.routeId}.${key}` },
      message: 'This route does not present the red-herring explanation.',
      fix: 'Review the authored route and explanation placement.',
    })),
  ]);
}

/** Binds editorial annotations and page sizes to the actual narrative rather than a parallel graph. */
export function validateNarrativeChildProfile(
  graphInput: NarrativeGraph,
  input: ChildCase,
  catalogs: ContentCatalogs,
  profile: ChildProfile = CHILD_PROFILE,
  handlers: ConsumerEffects = {},
): Validated<ChildCase> {
  return validated(() => {
    const graph = requireValid(validateNarrative(graphInput, handlers));
    const child = parseChild(input, catalogs, profile);
    check(
      child.entry === graph.start && child.nodes.length === graph.nodes.length,
      'CHILD-GRAPH',
      '$.nodes',
      'Child annotations do not describe the active narrative graph.',
      'Use the actual entry and annotate every narrative node.',
    );
    for (const node of graph.nodes) {
      const annotation = child.nodes.find((n) => n.id === node.id);
      check(
        annotation,
        'CHILD-GRAPH',
        `nodes.${node.id}`,
        'Narrative node lacks child annotations.',
        'Annotate the actual node ID.',
      );
      reference(node.text, annotation.lineIds, `nodes.${node.id}.text`);
      const targets = [...new Set([...node.choices, ...node.automatic].map((e) => e.to))];
      check(
        targets.length === annotation.next.length &&
          targets.every((key) => annotation.next.includes(key)),
        'CHILD-GRAPH',
        `nodes.${node.id}.next`,
        'Annotated edges differ from the executable narrative.',
        'Use actual choice/automatic targets.',
      );
      check(
        annotation.complete === node.resolveEnding,
        'CHILD-GRAPH',
        `nodes.${node.id}.complete`,
        'Annotated completion differs from the executable narrative.',
        'Mark only ending-resolution nodes complete.',
      );
      const decision = child.decisions.find((d) => d.node === node.id);
      check(
        node.choices.length === 0
          ? !decision
          : decision &&
              decision.choices.length === node.choices.length &&
              node.choices.every((choice) =>
                decision.choices.some(
                  (c) => c.id === choice.id && c.to === choice.to && c.line === choice.text,
                ),
              ),
        'CHILD-GRAPH',
        `nodes.${node.id}.choices`,
        'Decision annotations differ from actual choices.',
        'Annotate every choice with its real ID, text line, target and rendered page size.',
      );
    }
    return child;
  });
}

export interface NarrativeTeachingRoute {
  id: string;
  choices: string[];
  initial?: Parameters<typeof createNarrativeState>[1];
}

/** Executes guards/effects on a private state; invalid or disabled routes cannot earn teaching credit. */
export function reportNarrativeTeachingRoute(
  graph: NarrativeGraph,
  input: ChildCase,
  catalogs: ContentCatalogs,
  route: NarrativeTeachingRoute,
  handlers: ConsumerEffects = {},
): TeachingRouteReport {
  const child = requireValid(
    validateNarrativeChildProfile(graph, input, catalogs, CHILD_PROFILE, handlers),
  );
  const choices = list(route.choices, '$.route.choices', id, 1024);
  let state = createNarrativeState(graph, route.initial, handlers);
  for (const choice of choices)
    state = advanceNarrative(
      graph,
      state,
      { node: state.node, revision: state.revision, choice },
      handlers,
    );
  check(
    state.ending !== null,
    'CHILD-ROUTE',
    '$.route',
    'Executable route did not reach a committed ending.',
    'Supply a complete legal command route.',
  );
  const visited = child.nodes.filter((node) => (state.visits[node.id] ?? 0) > 0);
  return {
    routeId: id(route.id, '$.route.id'),
    terms: child.newTerms.map((termId) => {
      const nodes = visited.filter((node) => node.termIds.includes(termId));
      return {
        termId,
        encounters: nodes.reduce((total, node) => total + (state.visits[node.id] ?? 0), 0),
        distinctNodes: nodes.map((node) => node.id),
      };
    }),
    missingExplanations: child.redHerrings
      .filter((h) => !visited.some((node) => node.lineIds.includes(h.explanationLine)))
      .map((h) => h.id),
    editorialReviewRequired: true,
  };
}
