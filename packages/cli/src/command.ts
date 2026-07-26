/**
 * The command contract. Each of the seven subcommands is a {@link Command}; the dispatcher in
 * `./cli.ts` selects one by name and runs it.
 * @packageDocumentation
 */
import type { CliIO } from './io.js';
import type { ParsedArgs } from './args.js';

/** Everything a command receives when it runs. */
export interface CommandContext {
  /** Parsed arguments (tokens after the subcommand name). */
  readonly args: ParsedArgs;
  /** The IO seam to read/write through. */
  readonly io: CliIO;
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
   * Execute the command. Resolves to a process exit code: `0` for success, non-zero for
   * failure. Must not call `process.exit` itself.
   */
  run(ctx: CommandContext): Promise<number>;
}
