import { suggestName } from '@aegis/core';
import type { Diagnostic } from '@aegis/core';
import { ContentCode, diagnostic } from './diagnostics.js';

/** Data-only contracts for authored resources and event payloads. No world/default factory needed. */
export type ValueSchema =
  | 'string'
  | 'number'
  | 'boolean'
  | 'nonnegative-integer'
  | 'positive-number'
  | 'any'
  | { readonly nullable: ValueSchema }
  | { readonly enum: readonly string[] }
  | { readonly array: ValueSchema }
  | { readonly record: ValueSchema }
  | {
      readonly fields: Readonly<Record<string, ValueSchema>>;
      readonly optional?: Readonly<Record<string, ValueSchema>>;
    };

/** Unknown keys may contain punctuation, including literal dots. */
function fieldPath(path: string, key: string): string {
  return /^[A-Za-z_]\w*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** Validate a serialisable value without coercing it, filling defaults, or mutating it. */
export function validateValue(
  value: unknown,
  schema: ValueSchema,
  path: string,
  file?: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  function visit(v: unknown, s: ValueSchema, p: string): void {
    const fail = (message: string, fix: string, suggestion?: string): void => {
      diagnostics.push(
        diagnostic(ContentCode.InvalidDeclaredValue, message, {
          location: { file, path: p },
          fix,
          ...(suggestion === undefined ? {} : { data: { suggestion } }),
        }),
      );
    };
    if (typeof s === 'string') {
      if (s === 'any') return;
      const valid =
        s === 'nonnegative-integer'
          ? typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
          : s === 'positive-number'
            ? typeof v === 'number' && Number.isFinite(v) && v > 0
            : typeof v === s && (s !== 'number' || Number.isFinite(v));
      if (!valid) fail(`Expected ${s} at ${p}.`, `Supply a ${s} value.`);
    } else if ('nullable' in s) {
      if (v !== null) visit(v, s.nullable, p);
    } else if ('enum' in s) {
      if (typeof v === 'string' && s.enum.includes(v)) return;
      const near = typeof v === 'string' ? suggestName(v, s.enum) : undefined;
      fail(
        `Expected one of ${s.enum.join(', ')} at ${p}.`,
        near ? `Use "${near}".` : 'Choose a declared value.',
        near,
      );
    } else if ('array' in s) {
      if (!Array.isArray(v)) fail(`Expected an array at ${p}.`, 'Supply an array.');
      else v.forEach((item, i) => visit(item, s.array, `${p}[${i}]`));
    } else if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      fail(`Expected an object at ${p}.`, 'Supply an object with the declared fields.');
    } else if ('record' in s) {
      for (const [key, item] of Object.entries(v)) visit(item, s.record, fieldPath(p, key));
    } else {
      const fields = { ...s.fields, ...s.optional };
      for (const [key, item] of Object.entries(v)) {
        if (Object.hasOwn(fields, key)) visit(item, fields[key]!, fieldPath(p, key));
        else {
          const near = suggestName(key, Object.keys(fields));
          diagnostics.push(
            diagnostic(ContentCode.UnknownField, `Unknown field "${key}" at ${p}.`, {
              location: { file, path: fieldPath(p, key) },
              fix: near
                ? `Rename "${key}" to "${near}".`
                : `Remove "${key}" or declare it in the schema.`,
              data: { field: key, ...(near ? { suggestion: near } : {}) },
            }),
          );
        }
      }
      for (const key of Object.keys(s.fields)) {
        if (!Object.hasOwn(v, key))
          diagnostics.push(
            diagnostic(ContentCode.MissingField, `Missing required field "${key}" at ${p}.`, {
              location: { file, path: fieldPath(p, key) },
              fix: `Supply "${key}" using its declared schema.`,
            }),
          );
      }
    }
  }
  visit(value, schema, path);
  return diagnostics;
}
