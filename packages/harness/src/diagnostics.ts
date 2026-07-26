/**
 * Stable diagnostic codes for `@aegis/harness` (CHARTER principle 8).
 *
 * The harness's only source of recoverable, user-authored input is the input-script DSL
 * (CHARTER principle 5). An agent authoring a script by hand is the primary user, so parse
 * problems are reported as structured {@link Diagnostic}s — stable code, line/column location,
 * and a concrete suggested fix — never as a thrown `Error` with a stack trace. Agents branch
 * on `code`; humans read `message`/`fix`.
 *
 * Codes are permanent: once shipped, a code's meaning never changes and it is never reused.
 * Range: `AEG-HARNESS-0001`..`AEG-HARNESS-0999`.
 * @packageDocumentation
 */
import type { Diagnostic, Severity, SourceLocation } from '@aegis/core';

/** All harness diagnostic codes. */
export const HarnessCode = {
  /** A line could not be tokenised into a known command shape. */
  InvalidSyntax: 'AEG-HARNESS-0001',
  /** The first token of a line is not a recognised command verb. */
  UnknownCommand: 'AEG-HARNESS-0002',
  /** A command is missing a required argument. */
  MissingArgument: 'AEG-HARNESS-0003',
  /** A tick range `a..b` is malformed or empty (`b <= a`). */
  InvalidRange: 'AEG-HARNESS-0004',
  /** A tick value is negative or not an integer. */
  InvalidTick: 'AEG-HARNESS-0005',
  /** A numeric argument could not be parsed. */
  InvalidNumber: 'AEG-HARNESS-0006',
  /** A pointer coordinate `x,y` is malformed. */
  InvalidPointer: 'AEG-HARNESS-0007',
  /** A command has more arguments than its grammar allows. */
  UnexpectedArgument: 'AEG-HARNESS-0008',
  /**
   * A statement lies entirely outside the compiled tick window `[0, ticks)` and therefore had
   * **no effect at all** — the run behaves exactly as if the line were deleted.
   */
  StatementOutOfRange: 'AEG-HARNESS-0009',
  /** A statement's span only partly overlaps `[0, ticks)`; the rest of it was dropped. */
  StatementClipped: 'AEG-HARNESS-0010',
  /**
   * A `look` span was clipped, so only the in-range *fraction* of its delta was applied — the
   * camera turns less far than the script says, silently.
   */
  LookDeltaClipped: 'AEG-HARNESS-0011',
  /**
   * Two statements write the same channel on the same tick, so which one wins depends on their
   * **order in the file**. Re-ordering the script would change the compiled input.
   */
  OrderSensitiveOverlap: 'AEG-HARNESS-0012',
} as const;

/** A harness diagnostic code value. */
export type HarnessCodeValue = (typeof HarnessCode)[keyof typeof HarnessCode];

/** Build a harness {@link Diagnostic}. Thin helper so call sites stay terse and consistent. */
export function diagnostic(
  code: HarnessCodeValue,
  message: string,
  options: {
    severity?: Severity;
    location?: SourceLocation;
    fix?: string;
    data?: Readonly<Record<string, unknown>>;
  } = {},
): Diagnostic {
  return {
    code,
    severity: options.severity ?? 'error',
    message,
    ...(options.location ? { location: options.location } : {}),
    ...(options.fix ? { fix: options.fix } : {}),
    ...(options.data ? { data: options.data } : {}),
  };
}
