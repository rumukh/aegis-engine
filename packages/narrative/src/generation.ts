import { createPrng } from '@aegis/core';
import type { Diagnostic, Validated } from '@aegis/core';
import { validateChildProfile, validateNarrativeChildProfile } from './child-profile.js';
import type { ChildCase, ContentCatalogs } from './child-profile.js';
import { validateDeduction } from './deduction.js';
import type { DeductionCase } from './deduction.js';
import { validateNarrative } from './narrative.js';
import type { NarrativeGraph, ConsumerEffects } from './narrative.js';
import {
  check,
  diagnostic,
  dictionary,
  id,
  ids,
  integer,
  json,
  list,
  record,
  reference,
  requireValid,
  unique,
  validated,
} from './validation.js';
import type { Json } from './validation.js';

export interface ResolvedCase {
  schema: 1;
  id: string;
  revision: string;
  narrative: NarrativeGraph;
  deduction: DeductionCase;
  child: ChildCase;
  catalogs: ContentCatalogs;
}
export interface GenerationTemplate {
  schema: 1;
  id: string;
  revision: string;
  dimensions: { id: string; options: string[] }[];
  bundles: { id: string; selection: Record<string, string>; content: Json }[];
}
export interface GeneratedCase {
  schema: 1;
  templateId: string;
  templateRevision: string;
  bundleId: string;
  selection: Record<string, string>;
  resolved: ResolvedCase;
}
export type GenerationResult =
  | { ok: true; value: GeneratedCase; attempts: number }
  | { ok: false; attempts: number; diagnostics: readonly Diagnostic[] };
export interface CombinationReport {
  selection: Record<string, string>;
  bundleId: string | null;
  ok: boolean;
  diagnostics: readonly Diagnostic[];
}

export function validateResolvedCase(
  input: unknown,
  handlers: ConsumerEffects = {},
): Validated<ResolvedCase> {
  return validated(() => {
    json(input);
    const o = record(input, '$');
    check(o.schema === 1, 'VERSION', '$.schema', 'Unsupported resolved case.', 'Use schema 1.');
    const catalog = record(o.catalogs, '$.catalogs');
    const catalogs: ContentCatalogs = {
      assets: ids(catalog.assets, '$.catalogs.assets'),
      clues: ids(catalog.clues, '$.catalogs.clues'),
      facts: ids(catalog.facts, '$.catalogs.facts'),
      glossary: ids(catalog.glossary, '$.catalogs.glossary'),
      rewards: ids(catalog.rewards, '$.catalogs.rewards'),
      speakers: ids(catalog.speakers, '$.catalogs.speakers'),
    };
    const child = requireValid(validateChildProfile(o.child, catalogs));
    const deduction = requireValid(validateDeduction(o.deduction));
    const narrative = requireValid(validateNarrative(o.narrative, handlers));
    requireValid(validateNarrativeChildProfile(narrative, child, catalogs, undefined, handlers));
    deduction.clues.forEach((clue) => {
      reference(clue.id, child.clueIds, `deduction.clues.${clue.id}`);
      reference(
        clue.explanationKey,
        child.lines.map((line) => line.id),
        `deduction.clues.${clue.id}.explanationKey`,
      );
    });
    deduction.redHerrings.forEach((h) => {
      reference(
        h.id,
        child.redHerrings.map((r) => r.id),
        `deduction.redHerrings.${h.id}`,
      );
      reference(
        h.explanationKey,
        child.lines.map((line) => line.id),
        `deduction.redHerrings.${h.id}.explanationKey`,
      );
    });
    for (const [keys, available, path] of [
      [narrative.catalogs.clue, catalogs.clues, 'clue'],
      [narrative.catalogs.fact, catalogs.facts, 'fact'],
      [narrative.catalogs.reward, catalogs.rewards, 'reward'],
      [narrative.catalogs.glossary, catalogs.glossary, 'glossary'],
      [narrative.catalogs.asset, catalogs.assets, 'asset'],
      [narrative.catalogs.text, child.lines.map((line) => line.id), 'text'],
    ] as const)
      keys.forEach((key) => reference(key, available, `narrative.catalogs.${path}`));
    return {
      schema: 1,
      id: id(o.id, '$.id'),
      revision: id(o.revision, '$.revision'),
      narrative,
      deduction,
      child,
      catalogs,
    };
  });
}

function parseTemplate(input: unknown): GenerationTemplate {
  json(input);
  const o = record(input, '$');
  check(o.schema === 1, 'VERSION', '$.schema', 'Unsupported generator template.', 'Use schema 1.');
  const dimensions = list(
    o.dimensions,
    '$.dimensions',
    (v, p) => {
      const d = record(v, p),
        options = ids(d.options, `${p}.options`, 128);
      check(
        options.length > 0,
        'GEN-DOMAIN',
        p,
        'Generation dimension is empty.',
        'Supply finite authored option IDs.',
      );
      return { id: id(d.id, `${p}.id`), options };
    },
    8,
  );
  check(
    dimensions.length > 0,
    'GEN-DOMAIN',
    '$.dimensions',
    'No generation dimensions.',
    'Supply 1..8 finite dimensions.',
  );
  unique(
    dimensions.map((d) => d.id),
    '$.dimensions',
  );
  const size = dimensions.reduce((n, d) => n * d.options.length, 1);
  check(
    size <= 4096,
    'GEN-BOUND',
    '$.dimensions',
    `Generation space ${size} exceeds 4096.`,
    'Split the template into smaller finite sets.',
  );
  const bundles = list(
    o.bundles,
    '$.bundles',
    (v, p) => {
      const b = record(v, p),
        selection = dictionary(b.selection, `${p}.selection`, id);
      check(
        Object.keys(selection).length === dimensions.length,
        'GEN-COMPATIBILITY',
        p,
        'Bundle must resolve every dimension.',
        'Provide exactly one declared option per dimension.',
      );
      for (const dimension of dimensions)
        reference(
          selection[dimension.id] ?? '',
          dimension.options,
          `${p}.selection.${dimension.id}`,
        );
      return { id: id(b.id, `${p}.id`), selection, content: json(b.content, `${p}.content`) };
    },
    4096,
  );
  unique(
    bundles.map((b) => b.id),
    '$.bundles',
  );
  unique(
    bundles.map((b) => JSON.stringify(dimensions.map((d) => b.selection[d.id]))),
    '$.bundles.selection',
  );
  return {
    schema: 1,
    id: id(o.id, '$.id'),
    revision: id(o.revision, '$.revision'),
    dimensions,
    bundles,
  };
}

function allSelections(template: GenerationTemplate): Record<string, string>[] {
  let combinations: Record<string, string>[] = [{}];
  for (const dimension of template.dimensions)
    combinations = combinations.flatMap((c) =>
      dimension.options.map((option) => ({ ...c, [dimension.id]: option })),
    );
  return combinations;
}

/** Missing rows are explicitly incompatible, not an invitation to mix content fragments. */
export function enumerateCaseCombinations(
  input: GenerationTemplate,
  handlers: ConsumerEffects = {},
): CombinationReport[] {
  const template = parseTemplate(input);
  return allSelections(template).map((selection) => {
    const bundle = template.bundles.find((b) =>
      template.dimensions.every((d) => b.selection[d.id] === selection[d.id]),
    );
    if (!bundle)
      return {
        selection,
        bundleId: null,
        ok: false,
        diagnostics: [
          diagnostic(
            'GEN-INCOMPATIBLE',
            '$.selection',
            'No explicitly approved resolved bundle for this combination.',
            'Author and validate a compatible bundle or leave the combination unsupported.',
            { selection },
          ),
        ],
      };
    const result = validateResolvedCase(bundle.content, handlers);
    return { selection, bundleId: bundle.id, ok: result.ok, diagnostics: result.diagnostics };
  });
}

export function generateCase(
  input: GenerationTemplate,
  seed: string | number,
  maxAttempts = 64,
  handlers: ConsumerEffects = {},
): GenerationResult {
  const parsed = validated(() => parseTemplate(input));
  if (!parsed.ok || !parsed.value)
    return { ok: false, attempts: 0, diagnostics: parsed.diagnostics };
  const limits = validated(() => {
    integer(maxAttempts, '$.maxAttempts', 1, 4096);
    check(
      (typeof seed === 'string' && seed.length > 0 && seed.length <= 8192) ||
        (typeof seed === 'number' && Number.isFinite(seed)),
      'GEN-SEED',
      '$.seed',
      'Invalid deterministic seed.',
      'Supply a nonempty bounded string or finite number.',
    );
    return maxAttempts;
  });
  if (!limits.ok) return { ok: false, attempts: 0, diagnostics: limits.diagnostics };
  const template = parsed.value,
    random = createPrng(seed);
  const pool = [...template.bundles];
  const diagnostics: Diagnostic[] = [];
  let attempts = 0;
  while (pool.length > 0 && attempts < maxAttempts) {
    const index = random.int(0, pool.length);
    const bundle = pool.splice(index, 1)[0];
    check(
      bundle,
      'GEN-INTERNAL',
      '$.bundles',
      'Generation pool unexpectedly empty.',
      'Report the invalid generation state.',
    );
    attempts++;
    const result = validateResolvedCase(bundle.content, handlers);
    if (result.ok && result.value) {
      return {
        ok: true,
        attempts,
        value: {
          schema: 1,
          templateId: template.id,
          templateRevision: template.revision,
          bundleId: bundle.id,
          selection: { ...bundle.selection },
          resolved: result.value,
        },
      };
    }
    diagnostics.push(
      ...result.diagnostics.map((d) => ({
        ...d,
        location: { ...d.location, path: `bundles.${bundle.id}.${d.location?.path ?? '$'}` },
      })),
    );
  }
  diagnostics.push(
    diagnostic(
      'GEN-EXHAUSTED',
      '$.bundles',
      `No valid case after ${attempts} bounded attempts.`,
      'Fix the reported bundles, add approved compatible content, or explicitly raise the attempt budget.',
    ),
  );
  return { ok: false, attempts, diagnostics };
}

/** Restores the saved resolved definition, never reruns the generator against a new catalog. */
export function restoreGeneratedCase(
  value: unknown,
  handlers: ConsumerEffects = {},
): GeneratedCase {
  json(value);
  const o = record(value, '$');
  check(
    o.schema === 1,
    'VERSION',
    '$.schema',
    'Unsupported generated-case snapshot.',
    'Migrate the saved resolved definition explicitly.',
  );
  return {
    schema: 1,
    templateId: id(o.templateId, '$.templateId'),
    templateRevision: id(o.templateRevision, '$.templateRevision'),
    bundleId: id(o.bundleId, '$.bundleId'),
    selection: dictionary(o.selection, '$.selection', id),
    resolved: requireValid(validateResolvedCase(o.resolved, handlers)),
  };
}
