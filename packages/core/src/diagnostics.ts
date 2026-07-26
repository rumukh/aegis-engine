/**
 * Structured diagnostics (CHARTER principle 8).
 *
 * Every recoverable problem — a bad scene file, an unknown component, a malformed input
 * script — is reported as a {@link Diagnostic} with a **stable code**, a source location,
 * and a suggested fix, never as an ad-hoc thrown `Error` with a prose message. Agents match
 * on the `code`, humans read the `message` and `fix`.
 *
 * This module defines the neutral shape. Each package owns its own code ranges and enum
 * (see `@aegis/content` for content codes); `@aegis/core` stays domain-agnostic so harness
 * and cli can render diagnostics from any source uniformly.
 * @packageDocumentation
 */

/** Severity of a diagnostic. */
export type Severity = 'error' | 'warning' | 'info';

/** Where a diagnostic originates. All fields optional — not every diagnostic has a file. */
export interface SourceLocation {
  /** File path, if the diagnostic came from a file. */
  file?: string;
  /** Dotted/bracketed data path within the file, e.g. `entities[3].components.Transform.x`. */
  path?: string;
  /** 1-based line number. */
  line?: number;
  /** 1-based column number. */
  column?: number;
}

/** A single structured diagnostic. */
export interface Diagnostic {
  /** Stable machine code, e.g. `"AEG-CONTENT-0007"`. Never reword; only add new codes. */
  code: string;
  /** Severity. */
  severity: Severity;
  /** Human-readable, present-tense description of the problem. */
  message: string;
  /** Where it happened. */
  location?: SourceLocation;
  /** Concrete, actionable suggested fix. */
  fix?: string;
  /** Optional related values for machine consumers (expected/received, candidates, …). */
  data?: Readonly<Record<string, unknown>>;
}

/** The outcome of a validation: the value (if it validated) plus any diagnostics. */
export interface Validated<T> {
  /** `true` when there are no `error`-severity diagnostics. */
  ok: boolean;
  /** The validated value, present iff `ok`. */
  value?: T;
  /** All diagnostics produced, in source order. */
  diagnostics: readonly Diagnostic[];
}

/** An error carrying one or more diagnostics, thrown when a caller opts into throwing. */
export class DiagnosticError extends Error {
  readonly diagnostics: readonly Diagnostic[];
  constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n'));
    this.name = 'DiagnosticError';
    this.diagnostics = diagnostics;
  }
}
