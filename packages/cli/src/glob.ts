/**
 * A tiny, dependency-free, deterministic file globber.
 *
 * We avoid an external glob dependency (ENVIRONMENT.md: keep the toolchain minimal and
 * proxy-safe) and we need stable, sorted results so command output is reproducible. Supports
 * `**` (spans path separators, and a leading globstar segment matches zero or more directories), `*` (within a
 * segment), `?` (one non-separator char) and single-level `{a,b}` alternation. Matching is done
 * on forward-slash paths on every OS; results are returned as absolute native paths, sorted.
 * @packageDocumentation
 */
import { readdirSync, statSync } from 'node:fs';
import { sep } from 'node:path';

const WILDCARD = /[*?{]/;
/** Directories never descended into during a walk. */
const PRUNE = new Set(['node_modules', '.git']);

/** Convert a native path to a forward-slash path. */
function toPosix(p: string): string {
  return p.split(sep).join('/').split('\\').join('/');
}

/** Convert a forward-slash path back to the native representation. */
function toNative(p: string): string {
  return p.split('/').join(sep);
}

/** Whether a forward-slash path is absolute (POSIX root or Windows drive). */
function isAbsolutePosix(p: string): boolean {
  return /^([a-zA-Z]:\/|\/)/.test(p);
}

/** Expand a single level of `{a,b,c}` alternation into concrete patterns. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open < 0) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close < 0) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const options = pattern.slice(open + 1, close).split(',');
  const out: string[] = [];
  for (const option of options) {
    for (const rest of expandBraces(head + option + tail)) out.push(rest);
  }
  return out;
}

/** Compile a brace-free glob (with `**`, `*`, `?`) to an anchored RegExp over posix paths. */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      out += '.*';
      i += 2;
    } else {
      const ch = pattern[i]!;
      if (ch === '*') out += '[^/]*';
      else if (ch === '?') out += '[^/]';
      else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Split a pattern into its literal leading directory (the walk root) and the wildcard remainder. */
function splitRoot(pattern: string): { root: string; rest: string } {
  const segments = pattern.split('/');
  const literal: string[] = [];
  while (segments.length > 0 && !WILDCARD.test(segments[0]!)) {
    literal.push(segments.shift()!);
  }
  // Keep at least a root so a bare relative pattern walks from '.'.
  const root = literal.join('/') || '.';
  const rest = segments.join('/');
  return { root, rest };
}

/** Recursively collect every file under `dir` (posix paths), pruning `node_modules`/`.git`. */
function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (PRUNE.has(entry)) continue;
    const full = `${dir}/${entry}`;
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

/**
 * Return every file matching `pattern`, as absolute native paths, sorted. `pattern` may be
 * absolute or relative; relative patterns resolve against `cwd`.
 */
export function globFiles(pattern: string, cwd: string): string[] {
  const posixPattern = toPosix(pattern);
  if (posixPattern.includes('{')) {
    const all = new Set<string>();
    for (const expanded of expandBraces(posixPattern)) {
      for (const f of globFiles(expanded, cwd)) all.add(f);
    }
    return [...all].sort();
  }
  const cwdPosix = toPosix(cwd);
  const absPattern = isAbsolutePosix(posixPattern)
    ? posixPattern
    : `${cwdPosix.replace(/\/$/, '')}/${posixPattern}`;

  const { root, rest } = splitRoot(absPattern);
  const walkRoot = isAbsolutePosix(root) ? root : `${cwdPosix.replace(/\/$/, '')}/${root}`;

  const files: string[] = [];
  walk(walkRoot, files);

  const rootPrefix = walkRoot.replace(/\/$/, '') + '/';
  const regex = globToRegExp(rest);
  const matched = files
    .filter((f) => f.startsWith(rootPrefix) && regex.test(f.slice(rootPrefix.length)))
    .map(toNative)
    .sort();
  return [...new Set(matched)];
}

/** Glob multiple patterns, returning the sorted, de-duplicated union of matches. */
export function globAll(patterns: readonly string[], cwd: string): string[] {
  const all = new Set<string>();
  for (const pattern of patterns) for (const f of globFiles(pattern, cwd)) all.add(f);
  return [...all].sort();
}
