/**
 * The command contract. Each subcommand is a {@link Command}; the dispatcher in
 * `./cli.ts` selects one by name and runs it.
 * @packageDocumentation
 */
import type { CliIO } from './io.js';
import type { FlagSpec, ParsedArgs } from './args.js';
import type { ModeResolver } from './modes.js';

/** Everything a command receives when it runs. */
export interface CommandContext {
  /** Parsed arguments (tokens after the subcommand name). */
  readonly args: ParsedArgs;
  /** The IO seam to read/write through. */
  readonly io: CliIO;
  /** Resolves a mode name to its plugin (injectable, so tests supply a fake mode). */
  readonly modes: ModeResolver;
}

/** A single CLI subcommand. */
export interface Command {
  /** The subcommand name, e.g. `"run"`. */
  readonly name: string;
  /** One-line summary shown in top-level help. */
  readonly summary: string;
  /** Multi-line usage text shown for `aegis <name> --help`. */
  readonly usage: string;
  /**
   * Every flag this command accepts, and whether it takes a value. The dispatcher parses argv
   * against this and rejects anything undeclared — a flag that is not listed here is a typo as
   * far as the CLI is concerned, and is reported rather than ignored. Global flags (`--json`,
   * `--help`) are added automatically.
   */
  readonly flags: FlagSpec;
  /** Enumerated flag values, when the implementation publishes its actual choice arrays. */
  readonly choices?: Readonly<Record<string, readonly string[]>>;
  /**
   * Format support declared at command registration and exposed by `describe`.
   * `reads`/`writes` describe primary file formats; `stdout` names response formats.
   * Unversioned names (e.g. `input-script`) are format labels, not versioned schemas.
   */
  readonly formats?: {
    readonly reads: readonly string[];
    readonly writes: readonly string[];
    readonly stdout: readonly string[];
  };
  /**
   * Execute the command. Resolves to a process exit code: `0` for success, non-zero for
   * failure. Must not call `process.exit` itself.
   */
  run(ctx: CommandContext): Promise<number>;
}
