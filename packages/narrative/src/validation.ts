import { DiagnosticError } from '@aegis/core';
import type { Diagnostic, Validated } from '@aegis/core';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Decoder<T> = (value: unknown, path: string) => T;

export class ToolkitError extends DiagnosticError {
  readonly code: string;
  readonly messageKey: string;
  readonly path: string;
  constructor(
    code: string,
    path: string,
    message: string,
    fix: string,
    data?: Record<string, unknown>,
    diagnostics?: readonly Diagnostic[],
  ) {
    super(
      diagnostics ?? [
        {
          code: `AEG-NARRATIVE-${code}`,
          severity: 'error',
          location: { path },
          message,
          fix,
          data,
        },
      ],
    );
    this.name = 'ToolkitError';
    this.code = `AEG-NARRATIVE-${code}`;
    this.messageKey = `aegis.narrative.${code.toLowerCase()}`;
    this.path = path;
  }
}

export function fail(
  code: string,
  path: string,
  message: string,
  fix: string,
  data?: Record<string, unknown>,
): never {
  throw new ToolkitError(code, path, message, fix, data);
}

export function check(
  condition: unknown,
  code: string,
  path: string,
  message: string,
  fix: string,
): asserts condition {
  if (!condition) fail(code, path, message, fix);
}

export function record(value: unknown, path: string): Record<string, unknown> {
  check(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'SHAPE',
    path,
    'Expected an object.',
    'Supply a plain JSON object.',
  );
  check(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'SHAPE',
    path,
    'Expected a plain object.',
    'Remove class instances.',
  );
  return Object.fromEntries(Object.entries(value));
}

export function text(value: unknown, path: string): string {
  check(
    typeof value === 'string' && value.length > 0 && value.length <= 8192,
    'SHAPE',
    path,
    'Expected a nonempty bounded string.',
    'Use 1..8192 characters.',
  );
  return value;
}

export function id(value: unknown, path: string): string {
  const result = text(value, path);
  check(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(result),
    'ID',
    path,
    'Invalid stable identifier.',
    'Use 1..128 ASCII letters, digits, dot, underscore, colon, slash or hyphen, starting with a letter or digit.',
  );
  check(
    !['__proto__', 'constructor', 'prototype'].includes(result),
    'ID',
    path,
    'Reserved identifier.',
    'Choose a non-reserved identifier.',
  );
  return result;
}

export function integer(value: unknown, path: string, min = 0, max = 1_000_000): number {
  check(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max,
    'BOUND',
    path,
    `Expected an integer in ${min}..${max}.`,
    'Supply a bounded safe integer.',
  );
  return value;
}

export function boolean(value: unknown, path: string): boolean {
  check(typeof value === 'boolean', 'SHAPE', path, 'Expected a boolean.', 'Use true or false.');
  return value;
}

export function list<T>(value: unknown, path: string, decoder: Decoder<T>, max = 1024): T[] {
  check(
    Array.isArray(value) && value.length <= max,
    'BOUND',
    path,
    `Expected an array of at most ${max} entries.`,
    'Supply a bounded array.',
  );
  return value.map((entry, index) => decoder(entry, `${path}[${index}]`));
}

export function ids(value: unknown, path: string, max = 1024): string[] {
  const result = list(value, path, id, max);
  unique(result, path);
  return result;
}

export function unique(values: readonly string[], path: string): void {
  check(
    new Set(values).size === values.length,
    'DUPLICATE',
    path,
    'Duplicate stable identifiers.',
    'Give each entry a unique identifier.',
  );
}

export function member<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  const result = choices.find((choice) => choice === value);
  check(
    result !== undefined,
    'VARIANT',
    path,
    `Unknown variant: ${String(value)}.`,
    `Use one of: ${choices.join(', ')}.`,
  );
  return result;
}

export function reference(value: string, allowed: readonly string[], path: string): void {
  check(
    allowed.includes(value),
    'REFERENCE',
    path,
    `Unknown reference "${value}".`,
    `Declare it first. Available: ${allowed.join(', ') || '(none)'}.`,
  );
}

export function dictionary<T>(
  value: unknown,
  path: string,
  decoder: Decoder<T>,
): Record<string, T> {
  const input = record(value, path);
  check(
    Object.keys(input).length <= 4096,
    'BOUND',
    path,
    'Too many dictionary entries.',
    'Use at most 4096 entries.',
  );
  return Object.fromEntries(
    Object.entries(input).map(([key, entry]) => [
      id(key, `${path}.${key}`),
      decoder(entry, `${path}.${key}`),
    ]),
  );
}

export function json(value: unknown, path = '$'): Json {
  let nodes = 0;
  const visit = (input: unknown, at: string, depth: number): Json => {
    check(
      ++nodes <= 100_000 && depth <= 32,
      'BOUND',
      at,
      'JSON data exceeds depth/size limits.',
      'Use at most 100000 values and 32 levels.',
    );
    if (input === null || typeof input === 'boolean' || typeof input === 'string') {
      check(
        typeof input !== 'string' || input.length <= 1_000_000,
        'BOUND',
        at,
        'String is too large.',
        'Use at most 1000000 characters.',
      );
      return input;
    }
    if (typeof input === 'number') {
      check(Number.isFinite(input), 'SHAPE', at, 'Non-finite JSON number.', 'Use a finite number.');
      return input;
    }
    if (Array.isArray(input))
      return input.map((item, index) => visit(item, `${at}[${index}]`, depth + 1));
    const source = record(input, at);
    return Object.fromEntries(
      Object.entries(source).map(([key, entry]) => {
        check(
          !['__proto__', 'constructor', 'prototype'].includes(key),
          'SHAPE',
          `${at}.${key}`,
          'Unsafe JSON key.',
          'Rename the key.',
        );
        return [key, visit(entry, `${at}.${key}`, depth + 1)];
      }),
    );
  };
  return visit(value, path, 0);
}

export function validated<T>(run: () => T): Validated<T> {
  try {
    return { ok: true, value: run(), diagnostics: [] };
  } catch (error) {
    if (error instanceof DiagnosticError) return { ok: false, diagnostics: error.diagnostics };
    throw error;
  }
}

export function requireValid<T>(result: Validated<T>): T {
  if (!result.ok || result.value === undefined) {
    const first = result.diagnostics[0];
    if (!first)
      fail(
        'VALIDATION',
        '$',
        'Validation returned no usable value.',
        'Supply a successful validated value.',
      );
    const code = first.code.startsWith('AEG-NARRATIVE-')
      ? first.code.slice('AEG-NARRATIVE-'.length)
      : 'VALIDATION';
    throw new ToolkitError(
      code,
      first.location?.path ?? '$',
      first.message,
      first.fix ?? 'Correct the reported validation diagnostics.',
      undefined,
      result.diagnostics,
    );
  }
  return result.value;
}

export function diagnostic(
  code: string,
  path: string,
  message: string,
  fix: string,
  data?: Record<string, unknown>,
): Diagnostic {
  return {
    code: `AEG-NARRATIVE-${code}`,
    severity: 'error',
    location: { path },
    message,
    fix,
    data,
  };
}
