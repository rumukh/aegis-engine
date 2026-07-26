/**
 * The IO seam the CLI is written against. Every command reads argv and writes through a
 * {@link CliIO} rather than touching `process` directly, so commands are unit-testable and
 * free of hidden non-determinism (no direct `console`, no wall-clock).
 * @packageDocumentation
 */

/** Abstract input/output for a CLI invocation. */
export interface CliIO {
  /** The command-line arguments, excluding the node binary and script path. */
  readonly argv: readonly string[];
  /** The working directory the command resolves paths against. */
  readonly cwd: string;
  /** Write to standard output (no trailing newline is added). */
  out(text: string): void;
  /** Write to standard error (no trailing newline is added). */
  err(text: string): void;
}
