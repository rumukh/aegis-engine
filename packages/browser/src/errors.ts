export type BrowserErrorCode =
  | 'invalid-data'
  | 'incompatible'
  | 'limit'
  | 'unavailable'
  | 'conflict'
  | 'storage'
  | 'confirmation'
  | 'blocked'
  | 'disposed'
  | 'audio'
  | 'asset'
  | 'cancelled';

/** Developer diagnostics are deliberately separate from localizable presentation keys. */
export class BrowserServiceError extends Error {
  readonly messageKey: string;

  constructor(
    readonly code: BrowserErrorCode,
    diagnostic: string,
    options?: ErrorOptions,
  ) {
    super(diagnostic, options);
    this.name = 'BrowserServiceError';
    this.messageKey = `aegis.browser.${code}`;
  }
}

export function browserError(cause: unknown, code: BrowserErrorCode): BrowserServiceError {
  return cause instanceof BrowserServiceError
    ? cause
    : new BrowserServiceError(code, `Browser service ${code}.`, { cause });
}

export function requireId(value: unknown, field = 'id'): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    throw new BrowserServiceError('invalid-data', `${field} must be a bounded stable identifier.`);
}

export function requireInteger(
  value: unknown,
  min: number,
  field: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new BrowserServiceError('invalid-data', `${field} must be a safe integer >= ${min}.`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
