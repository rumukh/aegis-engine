/**
 * Stable diagnostic codes raised by `@aegis/core` (CHARTER principle 8).
 *
 * Agents match on the `code`; humans read the `message` and `fix`. Codes are **append-only** —
 * never reword or renumber one, only add new ones. `@aegis/content` owns the `AEG-CONTENT-*`
 * range; this module owns `AEG-CORE-*`.
 * @packageDocumentation
 */

/** Diagnostic codes raised by the core simulation substrate. */
export const CoreDiagnosticCode = {
  /**
   * A component or resource value holds `NaN` or `±Infinity`, so the world cannot be
   * serialised or hashed. Almost always a divide-by-zero, a `sqrt` of a negative, or an
   * uninitialised accumulator in a system.
   */
  NonFiniteState: 'AEG-CORE-0001',
  /** A {@link "./serialize".WorldSnapshot} handed to `World.restore` is structurally invalid. */
  InvalidSnapshot: 'AEG-CORE-0002',
  /**
   * A component value, resource value or event payload cannot be held by world state for a
   * reason other than being non-finite: an explicit `undefined` (which JSON deletes on a save
   * round trip and the state hash cannot see), a cycle or runaway nesting, a class instance
   * (which canonicalises to `{}`), or a function/symbol/bigint. See `serialisable.ts` for the
   * single statement of the rule and why each one matters.
   */
  UnserialisableState: 'AEG-CORE-0003',
} as const;

/** One of the {@link CoreDiagnosticCode} values. */
export type CoreDiagnosticCode = (typeof CoreDiagnosticCode)[keyof typeof CoreDiagnosticCode];
