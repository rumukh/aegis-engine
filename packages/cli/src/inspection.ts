/**
 * Opt-in output projections for world inspection. These bound returned data, not the cost of
 * simulation, hashing or snapshot creation. Unrequested projections leave legacy output intact.
 * @packageDocumentation
 */
import { canonicalStringify } from '@aegis/core';
import type { EntitySnapshot } from '@aegis/core';
import type { ParsedArgs } from './args.js';
import { AegisCliError, CliCode } from './errors.js';
import { flagChoice, flagInt, flagString } from './commands/shared.js';

export const RESOURCE_MODES = ['all', 'summary', 'none'] as const;

export interface InspectionOptions {
  offset: number;
  limit?: number;
  paginate: boolean;
  resources: (typeof RESOURCE_MODES)[number];
  resource?: string;
  projectResources: boolean;
}

function readBound(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const value = flagInt(args, name, { min: 0 });
  if (raw.trim() === '' || value === undefined || !Number.isSafeInteger(value)) {
    throw new AegisCliError(
      CliCode.InvalidFlagValue,
      `Flag --${name} must be a safe integer between 0 and ${Number.MAX_SAFE_INTEGER}.`,
      {
        fix: `Pass --${name} <nonnegative safe integer>.`,
        data: { flag: name, received: raw, min: 0, max: Number.MAX_SAFE_INTEGER },
      },
    );
  }
  return value;
}

/** Validate output controls before loading a scene or running any plugin code. */
export function inspectionOptions(args: ParsedArgs, view: string): InspectionOptions {
  for (const flag of ['limit', 'offset', 'resources', 'resource']) {
    if (args.flags[flag] !== undefined && view !== 'world') {
      throw new AegisCliError(
        CliCode.InvalidFlagValue,
        `Flag --${flag} is only supported with --view world, not --view ${view}.`,
        {
          fix: 'Use --view world, or remove the world-only output control.',
          data: { flag, view, allowedViews: ['world'] },
        },
      );
    }
  }
  const limit = readBound(args, 'limit');
  const offset = readBound(args, 'offset');
  const resources = flagChoice(args, 'resources', RESOURCE_MODES, 'all');
  const resource = flagString(args, 'resource');
  if (resource !== undefined && (resource.length === 0 || resources === 'none')) {
    throw new AegisCliError(
      CliCode.InvalidFlagValue,
      resource.length === 0
        ? 'Flag --resource needs a nonempty resource ID.'
        : '--resource cannot be combined with --resources none.',
      { fix: 'Select an ID with --resource <id> and --resources all|summary.' },
    );
  }
  return {
    offset: offset ?? 0,
    ...(limit !== undefined ? { limit } : {}),
    paginate: limit !== undefined || offset !== undefined,
    resources,
    ...(resource !== undefined ? { resource } : {}),
    projectResources: args.flags['resources'] !== undefined || resource !== undefined,
  };
}

export interface EntityPage {
  order: 'entity-index';
  offset: number;
  limit: number | null;
  returned: number;
  truncated: boolean;
  hasMore: boolean;
  nextOffset: number | null;
}

/** Preserve the snapshot's ascending entity-index order, including reused generations. */
export function pageEntities(
  matches: readonly EntitySnapshot[],
  options: InspectionOptions,
): { entities: readonly EntitySnapshot[]; page?: EntityPage } {
  if (!options.paginate) return { entities: matches };
  const start = Math.min(options.offset, matches.length);
  const count = Math.min(options.limit ?? matches.length, matches.length - start);
  const entities = matches.slice(start, start + count);
  const hasMore =
    options.offset < matches.length && entities.length < matches.length - options.offset;
  return {
    entities,
    page: {
      order: 'entity-index',
      offset: options.offset,
      limit: options.limit ?? null,
      returned: entities.length,
      truncated: entities.length < matches.length,
      hasMore,
      nextOffset: hasMore && entities.length > 0 ? options.offset + entities.length : null,
    },
  };
}

export interface ResourceSummary {
  id: string;
  kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  keyCount?: number;
  length?: number;
}

export interface ResourceProjection {
  values?: Readonly<Record<string, unknown>>;
  summary?: readonly ResourceSummary[];
  selection?: {
    mode: InspectionOptions['resources'];
    total: number;
    matched: number;
    returned: number;
    valuesReturned: number;
    omittedValues: number;
    /** Whether any full resource values, not just summary rows, were omitted. */
    truncated: boolean;
  };
}

function summariseResource(id: string, value: unknown): ResourceSummary {
  if (value === null) return { id, kind: 'null' };
  if (Array.isArray(value)) return { id, kind: 'array', length: value.length };
  if (typeof value === 'string') return { id, kind: 'string', length: value.length };
  if (typeof value === 'object') return { id, kind: 'object', keyCount: Object.keys(value).length };
  const kind = typeof value;
  if (kind === 'number' || kind === 'boolean') return { id, kind };
  throw new AegisCliError(CliCode.InvalidFlagValue, `Resource "${id}" is not serialisable data.`);
}

/** Summaries never impersonate resource values; omitted values remain explicitly counted. */
export function projectResources(
  resources: Readonly<Record<string, unknown>>,
  options: InspectionOptions,
): ResourceProjection {
  if (!options.projectResources) return { values: resources };
  const ids = Object.keys(resources).sort();
  if (options.resource !== undefined && !ids.includes(options.resource)) {
    throw new AegisCliError(
      CliCode.InvalidChoice,
      `Resource "${options.resource}" does not exist at this tick.`,
      {
        fix: 'Use --resources summary to discover resource IDs in this world.',
        data: { resource: options.resource, known: ids },
      },
    );
  }
  const selected = options.resource === undefined ? ids : [options.resource];
  const valuesReturned = options.resources === 'all' ? selected.length : 0;
  const omittedValues = ids.length - valuesReturned;
  return {
    ...(options.resources === 'all'
      ? { values: Object.fromEntries(selected.map((id) => [id, resources[id]])) }
      : {}),
    ...(options.resources === 'summary'
      ? { summary: selected.map((id) => summariseResource(id, resources[id])) }
      : {}),
    selection: {
      mode: options.resources,
      total: ids.length,
      matched: selected.length,
      returned: options.resources === 'none' ? 0 : selected.length,
      valuesReturned,
      omittedValues,
      truncated: omittedValues > 0,
    },
  };
}

/** Legacy text stays byte-identical when no resource projection was requested. */
export function formatResources(projection: ResourceProjection): readonly string[] {
  const ids = Object.keys(projection.values ?? {}).sort();
  const selection = projection.selection;
  const lines: string[] = [];
  if (selection !== undefined) {
    lines.push(
      `resources: ${selection.mode}; ${selection.returned} returned of ${selection.matched} matched ` +
        `(${selection.total} total); ${selection.omittedValues} value(s) omitted; ` +
        `truncated=${selection.truncated ? 'yes' : 'no'}`,
    );
  } else if (ids.length > 0) {
    lines.push('resources:');
  }
  for (const id of ids) {
    lines.push(`  ${id} = ${canonicalStringify(projection.values?.[id])}`);
  }
  for (const summary of projection.summary ?? []) {
    lines.push(
      `  ${summary.id}: ${summary.kind}` +
        (summary.keyCount === undefined ? '' : ` keys=${summary.keyCount}`) +
        (summary.length === undefined ? '' : ` length=${summary.length}`),
    );
  }
  return lines;
}
