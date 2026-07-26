/**
 * A tiny, dependency-free argument parser shared by every command. Implemented here (it is
 * plumbing, not gameplay) so parallel command implementers agree on flag semantics.
 * @packageDocumentation
 */

/** The result of parsing one command's arguments. */
export interface ParsedArgs {
  /** Non-flag arguments, in order. */
  positionals: readonly string[];
  /**
   * Flags. `--key value` and `--key=value` yield `{ key: "value" }`; a bare `--key` (or
   * `--key` followed by another flag) yields `{ key: true }`. Repeats keep the last value.
   */
  flags: Readonly<Record<string, string | boolean>>;
}

/**
 * Parse `args` (the tokens *after* the subcommand name). Supports `--flag`, `--flag=value`,
 * `--flag value`, and short aliases `-x` treated as `--x`. `--` terminates flag parsing; every
 * token after it is a positional.
 */
export function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  let noMoreFlags = false;
  while (i < args.length) {
    const token = args[i] as string;
    if (noMoreFlags || !token.startsWith('-')) {
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
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      i += 1;
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags[body] = next;
      i += 2;
    } else {
      flags[body] = true;
      i += 1;
    }
  }
  return { positionals, flags };
}
