export interface RuntimeDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly file?: string;
  readonly recordId?: string;
  readonly ruleId?: string;
}

export interface RuntimeError<Code extends string = string> {
  readonly code: Code;
  readonly messageKey: string;
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

export type Outcome<T, Code extends string = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RuntimeError<Code> };

export function success<T>(value: T): Outcome<T, never> {
  return { ok: true, value };
}

export function failure<Code extends string>(
  code: Code,
  message: string,
  location: Omit<RuntimeDiagnostic, 'code' | 'message'> = {},
): { readonly ok: false; readonly error: RuntimeError<Code> } {
  return {
    ok: false,
    error: {
      code,
      messageKey: `aegis.runtime.${code}`,
      diagnostics: [{ code, message, ...location }],
    },
  };
}

export class RuntimeFault extends Error {
  constructor(readonly error: RuntimeError) {
    super(error.diagnostics.map((entry) => entry.message).join('; '));
    this.name = 'RuntimeFault';
  }
}

export function requireValue<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new RuntimeFault(outcome.error);
  return outcome.value;
}

export function fault(code: string, message: string, path?: string): never {
  return requireValue(failure(code, message, path === undefined ? {} : { path }));
}

export function caughtFailure(error: unknown, code: string): Outcome<never> {
  if (error instanceof RuntimeFault) return { ok: false, error: error.error };
  return failure(code, error instanceof Error ? error.message : String(error));
}
