/**
 * Parse the `--query` mini-language into a {@link QueryDescriptor}.
 *
 * Grammar (whitespace-separated clauses):
 *   `has:Player,Health  any:Sword,Bow  none:Dead`
 * A bare, prefix-less token list is treated as `has:` (the common case), so `--query Player`
 * means "entities that have the `Player` component/tag". Component ids are used verbatim as the
 * string {@link ComponentRef}s the engine's query accepts.
 * @packageDocumentation
 */
import type { QueryDescriptor } from '@aegis/core';
import { AegisCliError, CliCode } from './errors.js';

const CLAUSES = ['has', 'any', 'none'] as const;
type Clause = (typeof CLAUSES)[number];

/** Parse a `--query` expression. Empty/whitespace input yields `{ has: [] }` (matches all). */
export function parseQuery(expr: string): QueryDescriptor {
  const has: string[] = [];
  const any: string[] = [];
  const none: string[] = [];
  const bucket: Record<Clause, string[]> = { has, any, none };

  for (const token of expr.split(/\s+/).filter((t) => t.length > 0)) {
    const colon = token.indexOf(':');
    let clause: Clause = 'has';
    let list = token;
    if (colon >= 0) {
      const prefix = token.slice(0, colon);
      if (!(CLAUSES as readonly string[]).includes(prefix)) {
        throw new AegisCliError(
          CliCode.InvalidFlagValue,
          `Unknown query clause "${prefix}" in --query.`,
          {
            fix: `Use one of: ${CLAUSES.join(', ')} — e.g. --query "has:Player none:Dead".`,
            data: { clause: prefix },
          },
        );
      }
      clause = prefix as Clause;
      list = token.slice(colon + 1);
    }
    for (const id of list.split(',').map((s) => s.trim())) {
      if (id.length > 0) bucket[clause].push(id);
    }
  }

  const descriptor: QueryDescriptor = { has };
  if (any.length > 0) descriptor.any = any;
  if (none.length > 0) descriptor.none = none;
  return descriptor;
}

/** Render a {@link QueryDescriptor} compactly, e.g. `has:[Player] none:[Dead]`. */
export function describeQuery(query: QueryDescriptor): string {
  const part = (label: string, refs?: readonly (string | { id: string })[]): string | undefined =>
    refs && refs.length > 0
      ? `${label}:[${refs.map((r) => (typeof r === 'string' ? r : r.id)).join(',')}]`
      : undefined;
  const parts = [part('has', query.has), part('any', query.any), part('none', query.none)].filter(
    (p): p is string => p !== undefined,
  );
  return parts.length > 0 ? parts.join(' ') : '{any entity}';
}
