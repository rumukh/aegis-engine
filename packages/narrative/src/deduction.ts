import type { Diagnostic, Validated } from '@aegis/core';
import {
  boolean,
  check,
  diagnostic,
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

export type Candidate = Record<string, string>;
export type Predicate =
  | { op: 'eq' | 'ne'; axis: string; value: string }
  | { op: 'in'; axis: string; values: string[] }
  | { op: 'and' | 'or'; terms: Predicate[] };
export interface DeductionClue {
  id: string;
  predicate: Predicate;
  requires: string[];
  requiresAnswer: boolean;
  explanationKey: string;
}
export interface DeductionCase {
  schema: 1;
  id: string;
  axes: { id: string; values: string[] }[];
  compatibility: Predicate | null;
  intended: Candidate;
  clues: DeductionClue[];
  redHerrings: { id: string; explanationKey: string }[];
  maxCandidates: number;
}
export interface DeductionReport {
  candidates: Candidate[];
  reachableClues: string[];
  prefixes: { clueIds: string[]; remaining: number }[];
  diagnostics: Diagnostic[];
}

function decodePredicate(input: unknown, path: string, axes: DeductionCase['axes']): Predicate {
  let size = 0;
  const decode = (value: unknown, at: string, depth: number): Predicate => {
    check(
      ++size <= 256 && depth <= 16,
      'LOGIC-BOUND',
      at,
      'Predicate exceeds depth or size limit.',
      'Use at most 256 nodes and 16 levels.',
    );
    const o = record(value, at);
    const op = member(o.op, ['eq', 'ne', 'in', 'and', 'or'], `${at}.op`);
    if (op === 'and' || op === 'or') {
      const terms = list(o.terms, `${at}.terms`, (v, p) => decode(v, p, depth + 1), 256);
      check(
        terms.length > 0,
        'LOGIC-BOUND',
        at,
        'Empty logical group.',
        'Supply one or more predicates.',
      );
      return { op, terms };
    }
    const axis = id(o.axis, `${at}.axis`);
    const domain = axes.find((a) => a.id === axis);
    check(domain, 'REFERENCE', `${at}.axis`, `Unknown axis "${axis}".`, 'Declare the axis.');
    if (op === 'in') {
      const values = ids(o.values, `${at}.values`, 128);
      check(
        values.length > 0,
        'LOGIC-BOUND',
        at,
        'Empty membership domain.',
        'Supply at least one value.',
      );
      values.forEach((v) => reference(v, domain.values, `${at}.values`));
      return { op, axis, values };
    }
    const target = id(o.value, `${at}.value`);
    reference(target, domain.values, `${at}.value`);
    return { op, axis, value: target };
  };
  return decode(input, path, 0);
}

function evaluate(predicate: Predicate, candidate: Candidate): boolean {
  switch (predicate.op) {
    case 'eq':
      return candidate[predicate.axis] === predicate.value;
    case 'ne':
      return candidate[predicate.axis] !== predicate.value;
    case 'in':
      return predicate.values.includes(candidate[predicate.axis] ?? '');
    case 'and':
      return predicate.terms.every((p) => evaluate(p, candidate));
    case 'or':
      return predicate.terms.some((p) => evaluate(p, candidate));
  }
}

function predicateSize(predicate: Predicate): number {
  return predicate.op === 'and' || predicate.op === 'or'
    ? 1 + predicate.terms.reduce((sum, term) => sum + predicateSize(term), 0)
    : 1;
}

export function parseDeduction(input: unknown): DeductionCase {
  json(input);
  const o = record(input, '$');
  check(o.schema === 1, 'VERSION', '$.schema', 'Unsupported deduction schema.', 'Use schema 1.');
  const axes = list(
    o.axes,
    '$.axes',
    (value, path) => {
      const a = record(value, path);
      const values = ids(a.values, `${path}.values`, 128);
      check(
        values.length > 0,
        'LOGIC-DOMAIN',
        path,
        'Axis has no values.',
        'Supply a nonempty finite domain.',
      );
      return { id: id(a.id, `${path}.id`), values };
    },
    8,
  );
  check(axes.length > 0, 'LOGIC-DOMAIN', '$.axes', 'No axes supplied.', 'Declare 1..8 axes.');
  unique(
    axes.map((a) => a.id),
    '$.axes',
  );
  const maxCandidates = integer(o.maxCandidates, '$.maxCandidates', 1, 100_000);
  const product = axes.reduce((count, a) => count * a.values.length, 1);
  check(
    product <= maxCandidates,
    'LOGIC-BOUND',
    '$.axes',
    `Candidate space ${product} exceeds ${maxCandidates}.`,
    'Reduce the finite domains or explicitly raise the limit up to 100000.',
  );
  const intended = dictionary(o.intended, '$.intended', id);
  check(
    Object.keys(intended).length === axes.length,
    'LOGIC-SOLUTION',
    '$.intended',
    'Solution must assign every axis exactly once.',
    'Provide one declared value per axis.',
  );
  for (const axis of axes) reference(intended[axis.id] ?? '', axis.values, `$.intended.${axis.id}`);
  const clues = list(
    o.clues,
    '$.clues',
    (value, path): DeductionClue => {
      const c = record(value, path);
      return {
        id: id(c.id, `${path}.id`),
        predicate: decodePredicate(c.predicate, `${path}.predicate`, axes),
        requires: ids(c.requires, `${path}.requires`, 128),
        requiresAnswer: boolean(c.requiresAnswer, `${path}.requiresAnswer`),
        explanationKey: id(c.explanationKey, `${path}.explanationKey`),
      };
    },
    128,
  );
  unique(
    clues.map((c) => c.id),
    '$.clues',
  );
  for (const clue of clues)
    clue.requires.forEach((r) =>
      reference(
        r,
        clues.map((c) => c.id),
        `clues.${clue.id}.requires`,
      ),
    );
  const redHerrings = list(
    o.redHerrings,
    '$.redHerrings',
    (value, path) => {
      const h = record(value, path);
      return {
        id: id(h.id, `${path}.id`),
        explanationKey: id(h.explanationKey, `${path}.explanationKey`),
      };
    },
    128,
  );
  unique(
    [...clues, ...redHerrings].map((c) => c.id),
    '$.clues/redHerrings',
  );
  const compatibility =
    o.compatibility === null ? null : decodePredicate(o.compatibility, '$.compatibility', axes);
  const work =
    product *
    (clues.reduce((sum, clue) => sum + predicateSize(clue.predicate), 0) +
      (compatibility === null ? 0 : predicateSize(compatibility)));
  check(
    work <= 10_000_000,
    'LOGIC-WORK',
    '$.clues',
    `Candidate-expression product ${work} exceeds 10000000.`,
    'Reduce domains or predicate complexity; separate bounds must not multiply into an impractical search.',
  );
  return {
    schema: 1,
    id: id(o.id, '$.id'),
    axes,
    maxCandidates,
    intended,
    clues,
    redHerrings,
    compatibility,
  };
}

function enumerate(definition: DeductionCase): Candidate[] {
  let candidates: Candidate[] = [{}];
  for (const axis of definition.axes)
    candidates = candidates.flatMap((c) => axis.values.map((v) => ({ ...c, [axis.id]: v })));
  const compatibility = definition.compatibility;
  return compatibility === null ? candidates : candidates.filter((c) => evaluate(compatibility, c));
}

function reachable(definition: DeductionCase, selected: readonly string[]): string[] {
  const reached: string[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const clue of definition.clues) {
      if (
        selected.includes(clue.id) &&
        !reached.includes(clue.id) &&
        !clue.requiresAnswer &&
        clue.requires.every((key) => reached.includes(key))
      ) {
        reached.push(clue.id);
        changed = true;
      }
    }
  }
  return reached;
}

export function inspectDeduction(input: unknown): DeductionReport {
  const definition = parseDeduction(input);
  const allIds = definition.clues.map((c) => c.id);
  const reached = reachable(definition, allIds);
  const diagnostics: Diagnostic[] = [];
  const invalidClues = definition.clues
    .filter((c) => !evaluate(c.predicate, definition.intended))
    .map((c) => c.id);
  if (
    invalidClues.length > 0 ||
    (definition.compatibility && !evaluate(definition.compatibility, definition.intended))
  ) {
    diagnostics.push(
      diagnostic(
        'LOGIC-INTENDED',
        '$.intended',
        'Intended solution violates compatibility or substantive clues.',
        'Correct the intended assignment or responsible predicates.',
        { intended: definition.intended, clueIds: invalidClues },
      ),
    );
  }
  if (reached.length !== allIds.length)
    diagnostics.push(
      diagnostic(
        'LOGIC-REACHABILITY',
        '$.clues',
        'Required clues are circular or locked behind the unknown answer.',
        'Use prerequisites reachable without solving the mystery.',
        { clueIds: allIds.filter((key) => !reached.includes(key)), reachableClues: reached },
      ),
    );
  const prefixes: DeductionReport['prefixes'] = [];
  let candidates = enumerate(definition);
  const prefix: string[] = [];
  for (const key of reached) {
    const clue = definition.clues.find((c) => c.id === key);
    check(clue, 'REFERENCE', key, 'Missing clue.', 'Declare the clue.');
    prefix.push(key);
    candidates = candidates.filter((c) => evaluate(clue.predicate, c));
    prefixes.push({ clueIds: [...prefix], remaining: candidates.length });
    if (candidates.length === 0)
      diagnostics.push(
        diagnostic(
          'LOGIC-PREFIX',
          `clues.${key}`,
          'Reachable clue prefix is contradictory.',
          'Correct the responsible clue predicates.',
          { clueIds: [...prefix], candidates: [] },
        ),
      );
  }
  const complete = enumerate(definition).filter((c) =>
    definition.clues.every((clue) => evaluate(clue.predicate, c)),
  );
  if (complete.length !== 1)
    diagnostics.push(
      diagnostic(
        'LOGIC-UNIQUE',
        '$.clues',
        `Complete clues leave ${complete.length} candidates, expected one.`,
        'Remove contradictory clues or add a discriminating truthful clue.',
        {
          clueIds: allIds,
          count: complete.length,
          candidates: complete.slice(0, 32),
          truncated: complete.length > 32,
        },
      ),
    );
  return { candidates: complete, reachableClues: reached, prefixes, diagnostics };
}

export function validateDeduction(input: unknown): Validated<DeductionCase> {
  const parsed = validated(() => parseDeduction(input));
  if (!parsed.ok || !parsed.value) return parsed;
  const report = inspectDeduction(parsed.value);
  return report.diagnostics.length === 0 ? parsed : { ok: false, diagnostics: report.diagnostics };
}

/** Filters only the supplied revealed clues; it never reads the intended solution. */
export function solveDeduction(
  input: DeductionCase,
  revealedClueIds: readonly string[],
): Candidate[] {
  const definition = parseDeduction(input);
  const revealed = ids(revealedClueIds, '$.revealedClueIds', 128);
  revealed.forEach((key) =>
    reference(
      key,
      definition.clues.map((c) => c.id),
      '$.revealedClueIds',
    ),
  );
  check(
    reachable(definition, revealed).length === revealed.length,
    'LOGIC-REACHABILITY',
    '$.revealedClueIds',
    'Revealed set skips required prerequisites.',
    'Reveal prerequisites before dependent clues.',
  );
  const clues = definition.clues.filter((c) => revealed.includes(c.id));
  return enumerate(definition).filter((c) => clues.every((clue) => evaluate(clue.predicate, c)));
}

export interface NotebookMark {
  axis: string;
  value: string;
  mark: 'unknown' | 'excluded' | 'confirmed';
  source: 'user' | 'evidence';
  clueIds: string[];
}
export interface NotebookState {
  schema: 1;
  caseId: string;
  marks: NotebookMark[];
}

export function createNotebook(definition: DeductionCase): NotebookState {
  const parsed = parseDeduction(definition);
  return { schema: 1, caseId: parsed.id, marks: [] };
}

export function proposeNotebookMarks(
  definition: DeductionCase,
  revealed: readonly string[],
): NotebookMark[] {
  const parsed = parseDeduction(definition);
  const candidates = solveDeduction(parsed, revealed);
  check(
    candidates.length > 0,
    'LOGIC-PREFIX',
    '$.revealed',
    'Revealed clues have no compatible candidate.',
    'Correct the contradictory clues before requesting assistance.',
  );
  if (revealed.length === 0) return [];
  return parsed.axes.flatMap((axis) =>
    axis.values.flatMap((value): NotebookMark[] => {
      const matches = candidates.filter((c) => c[axis.id] === value).length;
      if (matches !== 0 && matches !== candidates.length) return [];
      return [
        {
          axis: axis.id,
          value,
          mark: matches === 0 ? 'excluded' : 'confirmed',
          source: 'evidence',
          clueIds: parsed.clues.filter((c) => revealed.includes(c.id)).map((c) => c.id),
        },
      ];
    }),
  );
}

function decodeMark(value: unknown, path: string, definition: DeductionCase): NotebookMark {
  const m = record(value, path);
  const axis = id(m.axis, `${path}.axis`);
  const domain = definition.axes.find((a) => a.id === axis);
  check(domain, 'REFERENCE', path, 'Unknown notebook axis.', 'Use a declared axis.');
  const target = id(m.value, `${path}.value`);
  reference(target, domain.values, path);
  return {
    axis,
    value: target,
    mark: member(m.mark, ['unknown', 'excluded', 'confirmed'], `${path}.mark`),
    source: member(m.source, ['user', 'evidence'], `${path}.source`),
    clueIds: ids(m.clueIds, `${path}.clueIds`, 128),
  };
}

function notebookMarkKey(mark: NotebookMark): string {
  return JSON.stringify([mark.axis, mark.value, mark.mark]);
}

function notebookMarkValidator(
  parsed: DeductionCase,
  revealed: readonly string[],
): (mark: NotebookMark) => void {
  const supportedByCitations = new Map<string, ReadonlySet<string>>();
  return (mark) => {
    if (mark.source === 'user') {
      check(
        mark.clueIds.length === 0,
        'EVIDENCE',
        '$.marks',
        'User marks cannot claim evidence provenance.',
        'Store user marks without citations.',
      );
    } else {
      check(
        mark.clueIds.length > 0 && mark.clueIds.every((key) => revealed.includes(key)),
        'EVIDENCE',
        '$.marks',
        'Evidence mark cites unrevealed or absent clues.',
        'Cite only revealed clues.',
      );
      const citations = JSON.stringify([...mark.clueIds].sort());
      let support = supportedByCitations.get(citations);
      if (support === undefined) {
        support = new Set(proposeNotebookMarks(parsed, mark.clueIds).map(notebookMarkKey));
        supportedByCitations.set(citations, support);
      }
      check(
        support.has(notebookMarkKey(mark)),
        'EVIDENCE',
        '$.marks',
        'Cited clues do not support the mark.',
        'Use a supported assistance proposal.',
      );
    }
  };
}

function restoreNotebookWithValidator(
  parsed: DeductionCase,
  snapshot: unknown,
  validateMark: (mark: NotebookMark) => void,
): NotebookState {
  const o = record(snapshot, '$');
  check(
    o.schema === 1 && o.caseId === parsed.id,
    'RESTORE',
    '$',
    'Notebook identity mismatch.',
    'Restore matching case data.',
  );
  const marks = list(o.marks, '$.marks', (v, p) => decodeMark(v, p, parsed));
  unique(
    marks.map((m) => JSON.stringify([m.axis, m.value])),
    '$.marks',
  );
  marks.forEach(validateMark);
  return { schema: 1, caseId: parsed.id, marks };
}

export function restoreNotebook(
  definition: DeductionCase,
  snapshot: unknown,
  revealed: readonly string[],
): NotebookState {
  const parsed = parseDeduction(definition);
  return restoreNotebookWithValidator(parsed, snapshot, notebookMarkValidator(parsed, revealed));
}

export function setNotebookMark(
  definition: DeductionCase,
  snapshot: NotebookState,
  revealed: readonly string[],
  input: NotebookMark,
  policy: 'preserve-user' | 'replace-user',
): NotebookState {
  member(policy, ['preserve-user', 'replace-user'], '$.policy');
  const parsed = parseDeduction(definition);
  const validateMark = notebookMarkValidator(parsed, revealed);
  const state = restoreNotebookWithValidator(parsed, snapshot, validateMark);
  const mark = decodeMark(input, '$.mark', parsed);
  validateMark(mark);
  const old = state.marks.find((m) => m.axis === mark.axis && m.value === mark.value);
  if (old?.source === 'user' && mark.source === 'evidence' && policy === 'preserve-user')
    return state;
  const marks = state.marks.filter((m) => m.axis !== mark.axis || m.value !== mark.value);
  marks.push(mark);
  return { ...state, marks };
}

export interface HintTier {
  id: string;
  textKey: string;
  clueIds: string[];
}
export interface HintState {
  schema: 1;
  used: string[];
}
export type HintResult =
  | { status: 'hint'; state: HintState; hint: HintTier }
  | { status: 'exhausted'; reason: 'allowance' | 'review'; state: HintState };

export function nextHint(
  definition: DeductionCase,
  tiers: readonly HintTier[],
  snapshot: unknown,
  revealed: readonly string[],
  allowance = 1024,
): HintResult {
  const parsed = parseDeduction(definition);
  solveDeduction(parsed, revealed);
  integer(allowance, '$.allowance', 0, 1024);
  const hints = list(tiers, '$.tiers', (v, p) => {
    const h = record(v, p);
    const clueIds = ids(h.clueIds, `${p}.clueIds`, 128);
    check(
      clueIds.length > 0,
      'EVIDENCE',
      p,
      'Hint has no evidence citations.',
      'Cite the authored clues supporting this tier.',
    );
    clueIds.forEach((key) =>
      reference(
        key,
        parsed.clues.map((c) => c.id),
        p,
      ),
    );
    return { id: id(h.id, `${p}.id`), textKey: id(h.textKey, `${p}.textKey`), clueIds };
  });
  unique(
    hints.map((h) => h.id),
    '$.tiers',
  );
  const o = record(snapshot, '$.state');
  check(o.schema === 1, 'VERSION', '$.state.schema', 'Unsupported hint state.', 'Use schema 1.');
  const state: HintState = { schema: 1, used: ids(o.used, '$.state.used') };
  state.used.forEach((key) =>
    reference(
      key,
      hints.map((h) => h.id),
      '$.state.used',
    ),
  );
  if (state.used.length >= allowance) return { status: 'exhausted', reason: 'allowance', state };
  const hint = hints.find(
    (h) => !state.used.includes(h.id) && h.clueIds.every((key) => revealed.includes(key)),
  );
  return hint
    ? { status: 'hint', state: { schema: 1, used: [...state.used, hint.id] }, hint }
    : { status: 'exhausted', reason: 'review', state };
}
