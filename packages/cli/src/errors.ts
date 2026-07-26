/**
 * CLI error handling with stable, greppable diagnostic codes (CHARTER principle 8).
 *
 * Every actionable CLI failure is an {@link AegisCliError}: it carries a stable machine code
 * (`AEG-CLI-####`), a human message, an optional suggested `fix`, and the process `exitCode`
 * to return. The dispatcher renders it uniformly — so a wrong flag or a missing file *teaches*
 * the user how to fix it instead of dumping a stack trace.
 * @packageDocumentation
 */

/** Stable CLI diagnostic codes. Permanent: never reword a code's meaning, only add new ones. */
export const CliCode = {
  /** A required positional argument or flag was not supplied. */
  MissingArgument: 'AEG-CLI-0001',
  /** A flag was given a value the command cannot use (wrong type/shape). */
  InvalidFlagValue: 'AEG-CLI-0002',
  /** A `--mode` (or scene `mode`) is not one of platformer | iso | fps. */
  UnknownMode: 'AEG-CLI-0003',
  /** A file that had to be read does not exist. */
  FileNotFound: 'AEG-CLI-0004',
  /** A document's `aegis` discriminator is missing or not a content kind we can handle. */
  UnknownContentKind: 'AEG-CLI-0005',
  /** An output path already exists and `--force` was not given. */
  OutputExists: 'AEG-CLI-0006',
  /** A replay's re-run produced a different state hash than the recording pinned. */
  ReplayMismatch: 'AEG-CLI-0007',
  /** No game tests matched the discovery glob. */
  NoTestsFound: 'AEG-CLI-0008',
  /** The selected mode does not provide the requested view (e.g. no ASCII / not implemented). */
  ViewUnavailable: 'AEG-CLI-0009',
  /** One or more discovered game tests failed. */
  TestFailed: 'AEG-CLI-0010',
  /** An unknown `--view`/`--reporter`/`kind` enum value was given. */
  InvalidChoice: 'AEG-CLI-0011',
  /** A flag the command does not declare was passed (typo, or wrong command). */
  UnknownFlag: 'AEG-CLI-0012',
  /** The first argument is not a subcommand. */
  UnknownCommand: 'AEG-CLI-0013',
  /**
   * A discovered module exports something that is *almost* a `GameTest` — it would have been
   * silently skipped, hiding a red test. A broken test is a failure, never an absence.
   */
  InvalidGameTest: 'AEG-CLI-0014',
  /** A `--plugin <module>#<export>` module could not be imported. */
  PluginLoadFailed: 'AEG-CLI-0015',
  /** A resolved plugin export is missing or is not a `ModePlugin`. */
  PluginInvalid: 'AEG-CLI-0016',
  /** A plugin's `mode` disagrees with the scene's mode or an explicit `--mode`. */
  PluginModeMismatch: 'AEG-CLI-0017',
  /**
   * The scene cannot run under the resolved plugin — it uses components no registered plugin
   * provides. Refusing beats simulating a world whose systems were never installed.
   */
  SceneNotRunnable: 'AEG-CLI-0018',
  /** A tick count so large the run cannot complete in bounded memory/time. */
  TickLimitExceeded: 'AEG-CLI-0019',
} as const;

/** A CLI diagnostic code value. */
export type CliCodeValue = (typeof CliCode)[keyof typeof CliCode];

/** Standard process exit codes used across the CLI. */
export const Exit = {
  /** Success. */
  Ok: 0,
  /** A general failure: usage error, IO error, a failed run, a test failure. */
  Error: 1,
  /** Content failed schema validation (structured diagnostics were printed). */
  Validation: 2,
} as const;

/** Options for constructing an {@link AegisCliError}. */
export interface AegisCliErrorOptions {
  /** Suggested, concrete fix shown to the user. */
  fix?: string;
  /** Process exit code to return. Defaults to {@link Exit.Error}. */
  exitCode?: number;
  /** The underlying error, if this wraps one. */
  cause?: unknown;
  /** Extra machine-readable data (candidates, received value, …). */
  data?: Readonly<Record<string, unknown>>;
}

/** An actionable CLI error: stable code + message + fix + exit code. */
export class AegisCliError extends Error {
  /** Stable machine code, e.g. `"AEG-CLI-0004"`. */
  readonly code: CliCodeValue;
  /** A concrete, actionable suggested fix. */
  readonly fix?: string;
  /** The process exit code this error maps to. */
  readonly exitCode: number;
  /** Extra machine-readable data for `--json` consumers. */
  readonly data?: Readonly<Record<string, unknown>>;

  constructor(code: CliCodeValue, message: string, options: AegisCliErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AegisCliError';
    this.code = code;
    if (options.fix !== undefined) this.fix = options.fix;
    this.exitCode = options.exitCode ?? Exit.Error;
    if (options.data !== undefined) this.data = options.data;
  }
}

/** Render an {@link AegisCliError} to a stable, greppable multi-line string (no trailing newline). */
export function formatCliError(error: AegisCliError): string {
  const lines = [`error [${error.code}]: ${error.message}`];
  if (error.fix) lines.push(`  fix: ${error.fix}`);
  return lines.join('\n');
}

/**
 * The message of a caught value, whatever it is.
 *
 * `catch` binds `unknown`, and `(err as Error).message` is a lie the compiler cannot check: a
 * thrown string or object yields `undefined` inside a diagnostic that is supposed to explain the
 * failure. Narrowing instead of asserting keeps every message truthful.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The `errno` code of a caught filesystem error, when it has one. */
export function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
