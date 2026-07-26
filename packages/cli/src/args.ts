/**
 * A tiny, dependency-free argument parser shared by every command.
 *
 * Parsing is **declarative, never guessed**: each command declares its flags and their arity
 * ({@link FlagSpec}), so `--json level.scene.json` cannot swallow the positional and a typo like
 * `--asci` cannot be silently ignored. A parser that guesses is worse than no parser — it makes
 * the CLI answer a *different question* than the one the agent asked, and then report success.
 * @packageDocumentation
 */

/** How a declared flag consumes its value. */
export type FlagKind =
  /** `--flag`, `--flag=true`, `--flag=false`. Never consumes the following token. */
  | 'boolean'
  /** `--flag value` or `--flag=value`. Consumes the following token. */
  | 'value';

/** A command's declared flags: flag name (without dashes) → arity. */
export type FlagSpec = Readonly<Record<string, FlagKind>>;

/** Flags every command accepts, declared once so no command can forget them. */
export const GLOBAL_FLAGS: FlagSpec = { json: 'boolean', help: 'boolean', h: 'boolean' };

/** The result of parsing one command's arguments. */
export interface ParsedArgs {
  /** Non-flag arguments, in order. */
  positionals: readonly string[];
  /**
   * Flags. A `value` flag yields its string; a `boolean` flag yields `true`, or the literal
   * string when written as `--flag=value`. Repeats keep the last value.
   */
  flags: Readonly<Record<string, string | boolean>>;
  /** Flags that were not declared by the command, in first-seen order (deduplicated). */
  unknown: readonly string[];
  /** Declared `value` flags that were given no value (e.g. a trailing `--seed`). */
  missingValues: readonly string[];
}

/** Whether a token can serve as a value for a `value` flag. Negative numbers count (`--seed -1`). */
function isValueToken(token: string | undefined): token is string {
  if (token === undefined) return false;
  if (!token.startsWith('-')) return true;
  return /^-\d/.test(token);
}

/**
 * Parse `args` (the tokens *after* the subcommand name) against `spec`.
 *
 * Supports `--flag`, `--flag=value`, `--flag value` (declared `value` flags only), and short
 * aliases `-x` treated as `--x`. `--` terminates flag parsing; every token after it is a
 * positional. Undeclared flags are collected in {@link ParsedArgs.unknown} rather than silently
 * ignored, and never consume the next token — so the positional after a typo survives.
 */
export function parseArgs(args: readonly string[], spec: FlagSpec = {}): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const unknown: string[] = [];
  const missingValues: string[] = [];
  let i = 0;
  let noMoreFlags = false;

  const noteUnknown = (name: string): void => {
    if (spec[name] === undefined && !unknown.includes(name)) unknown.push(name);
  };

  while (i < args.length) {
    const token = args[i];
    if (token === undefined) break;
    if (noMoreFlags || !token.startsWith('-') || token === '-') {
      positionals.push(token);
      i += 1;
      continue;
    }
    if (token === '--') {
      noMoreFlags = true;
      i += 1;
      continue;
    }
    const body = token.replace(/^-+/, '');
    const eq = body.indexOf('=');
    if (eq >= 0) {
      const name = body.slice(0, eq);
      noteUnknown(name);
      flags[name] = body.slice(eq + 1);
      i += 1;
      continue;
    }
    const kind = spec[body];
    if (kind !== 'value') {
      noteUnknown(body);
      flags[body] = true;
      i += 1;
      continue;
    }
    const next = args[i + 1];
    if (isValueToken(next)) {
      flags[body] = next;
      i += 2;
    } else {
      if (!missingValues.includes(body)) missingValues.push(body);
      flags[body] = true;
      i += 1;
    }
  }
  return { positionals, flags, unknown, missingValues };
}

/** Levenshtein distance between two flag names, compared case-insensitively. */
function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const rows: number[][] = [];
  for (let i = 0; i <= s.length; i++) rows.push(new Array<number>(t.length + 1).fill(0));
  for (let i = 0; i <= s.length; i++) rows[i]![0] = i;
  for (let j = 0; j <= t.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      const deletion = rows[i - 1]![j]! + 1;
      const insertion = rows[i]![j - 1]! + 1;
      const substitution = rows[i - 1]![j - 1]! + cost;
      rows[i]![j] = Math.min(deletion, insertion, substitution);
    }
  }
  return rows[s.length]![t.length]!;
}

/**
 * The closest declared flag to `name`, if one is plausibly a typo of it. A shared prefix
 * (`--asci` → `--ascii`) always wins; otherwise an edit distance of at most 2 qualifies.
 */
export function suggestFlag(name: string, spec: FlagSpec): string | undefined {
  const lower = name.toLowerCase();
  let best: { name: string; score: number } | undefined;
  for (const candidate of Object.keys(spec)) {
    if (candidate.length < 2) continue;
    const shared = candidate.startsWith(lower) || lower.startsWith(candidate);
    const score = shared ? 0 : editDistance(name, candidate);
    if (score > 2) continue;
    if (!best || score < best.score || (score === best.score && candidate < best.name)) {
      best = { name: candidate, score };
    }
  }
  return best?.name;
}
