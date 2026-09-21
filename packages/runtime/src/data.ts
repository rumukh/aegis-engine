import { canonicalStringify, findUnserialisable, hashString } from '@aegis/core';
import { caughtFailure, failure, fault, requireValue, success } from './outcome.js';
import type { Outcome, RuntimeDiagnostic } from './outcome.js';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type DeepReadonly<T, Depth extends readonly number[] = []> = Depth['length'] extends 12
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K], [...Depth, 0]> }
    : T;

export interface Schema<T> {
  parse(value: unknown, path?: string): Outcome<T>;
}

export type InferSchema<T> = T extends Schema<infer V> ? V : never;

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reject non-JSON descriptors before invoking schemas or copying caller-owned data. */
export function checkJson(value: unknown): Outcome<void> {
  let nodes = 0;
  let characters = 0;
  function descriptors(current: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 64) fault('data-limit', 'JSON exceeds traversal limits.');
    if (typeof current === 'string') characters += current.length;
    if (characters > 2_000_000) fault('data-limit', 'JSON exceeds the character limit.');
    if (current === null || typeof current !== 'object') return;
    if (!Array.isArray(current) && !isRecord(current)) {
      fault('invalid-data', 'Expected a plain JSON object.');
    }
    for (const key of Reflect.ownKeys(current)) {
      if (Array.isArray(current) && key === 'length') continue;
      if (typeof key !== 'string') fault('invalid-data', 'Symbol properties are not JSON.');
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        fault('invalid-data', 'Reserved object keys are not supported.', key);
      }
      characters += key.length;
      if (
        Array.isArray(current) &&
        (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)
      ) {
        fault('invalid-data', 'Arrays cannot contain non-index properties.', key);
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        fault('invalid-data', 'JSON cannot contain accessors or hidden properties.', key);
      }
      descriptors(descriptor.value, depth + 1);
    }
  }
  try {
    descriptors(value, 0);
  } catch (error) {
    return failure('invalid-data', error instanceof Error ? error.message : String(error));
  }
  const problems = findUnserialisable(value, { limit: 8 });
  if (problems.length !== 0) {
    return {
      ok: false,
      error: {
        code: 'invalid-data',
        messageKey: 'aegis.runtime.invalid-data',
        diagnostics: problems.map((problem) => ({
          code: 'invalid-data',
          path: problem.path,
          message: `${problem.reason}: ${problem.detail}`,
        })),
      },
    };
  }
  return success(undefined);
}

export function cloneData<T>(value: T): T {
  requireValue(checkJson(value));
  // The JSON check establishes a lossless plain-data round trip (including normalized -0).
  return JSON.parse(JSON.stringify(value)) as T;
}

export function freezeData<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export function dataHash(value: unknown): string {
  requireValue(checkJson(value));
  return hashString(canonicalStringify(value));
}

function expected(path: string, description: string): Outcome<never> {
  return failure('invalid-data', `Expected ${description}.`, { path });
}

export const schema = {
  string(
    options: { minLength?: number; maxLength?: number; pattern?: RegExp } = {},
  ): Schema<string> {
    return {
      parse(value, path = '') {
        if (
          typeof value !== 'string' ||
          value.length < (options.minLength ?? 0) ||
          value.length > (options.maxLength ?? 16_384)
        )
          return expected(path, 'a bounded string');
        if (options.pattern !== undefined) {
          options.pattern.lastIndex = 0;
          if (!options.pattern.test(value))
            return expected(path, `a string matching ${options.pattern}`);
        }
        return success(value);
      },
    };
  },
  number(options: { min?: number; max?: number; integer?: boolean } = {}): Schema<number> {
    return {
      parse(value, path = '') {
        return typeof value === 'number' &&
          Number.isFinite(value) &&
          (!options.integer || Number.isSafeInteger(value)) &&
          value >= (options.min ?? -Number.MAX_VALUE) &&
          value <= (options.max ?? Number.MAX_VALUE)
          ? success(value)
          : expected(path, 'a finite number within the declared bounds');
      },
    };
  },
  boolean: {
    parse(value: unknown, path = ''): Outcome<boolean> {
      return typeof value === 'boolean' ? success(value) : expected(path, 'a boolean');
    },
  },
  literal<const T extends string | number | boolean | null>(literal: T): Schema<T> {
    return {
      parse: (value, path = '') =>
        value === literal ? success(literal) : expected(path, JSON.stringify(literal)),
    };
  },
  array<T>(item: Schema<T>, options: { min?: number; max?: number } = {}): Schema<T[]> {
    return {
      parse(value, path = '') {
        if (
          !Array.isArray(value) ||
          value.length < (options.min ?? 0) ||
          value.length > (options.max ?? 10_000)
        ) {
          return expected(path, 'an array within the declared bounds');
        }
        const result: T[] = [];
        for (let index = 0; index < value.length; index++) {
          const parsed = item.parse(value[index], `${path}[${index}]`);
          if (!parsed.ok) return parsed;
          result.push(parsed.value);
        }
        return success(result);
      },
    };
  },
  object<const S extends Record<string, Schema<unknown>>>(
    shape: S,
  ): Schema<{ -readonly [K in keyof S]: InferSchema<S[K]> }> {
    return {
      parse(value, path = '') {
        if (!isRecord(value)) return expected(path, 'an object');
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(shape, key)) return expected(`${path}.${key}`, 'a declared field');
        }
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(shape)) {
          const parsed = item.parse(value[key], `${path}.${key}`);
          if (!parsed.ok) return parsed;
          Object.defineProperty(result, key, {
            value: parsed.value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return success(result as { -readonly [K in keyof S]: InferSchema<S[K]> });
      },
    };
  },
  record<T>(item: Schema<T>): Schema<Record<string, T>> {
    return {
      parse(value, path = '') {
        if (!isRecord(value)) return expected(path, 'a record');
        const result: Record<string, T> = {};
        for (const key of Object.keys(value).sort()) {
          const parsed = item.parse(value[key], `${path}.${key}`);
          if (!parsed.ok) return parsed;
          Object.defineProperty(result, key, {
            value: parsed.value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return success(result);
      },
    };
  },
  union<const S extends readonly Schema<unknown>[]>(...items: S): Schema<InferSchema<S[number]>> {
    return {
      parse(value, path = '') {
        for (const item of items) {
          const parsed = item.parse(value, path);
          if (parsed.ok) return parsed as Outcome<InferSchema<S[number]>>;
        }
        return expected(path, 'one of the declared variants');
      },
    };
  },
  json: {
    parse(value: unknown): Outcome<JsonValue> {
      const valid = checkJson(value);
      return valid.ok ? success(cloneData(value) as JsonValue) : valid;
    },
  },
};

export const identifierSchema = schema.string({
  minLength: 1,
  maxLength: 160,
  pattern: /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
});
export const counterSchema = schema.number({ integer: true, min: 0 });

export interface ContentPack<C> {
  readonly id: string;
  readonly revision: string;
  readonly schemaVersion: number;
  readonly data: C;
}

export interface ContentRegistration<C> {
  readonly schemaVersion: number;
  readonly schema: Schema<C>;
  readonly validate?: (data: DeepReadonly<C>) => readonly RuntimeDiagnostic[];
}

export function validateContent<C>(
  candidate: unknown,
  registration: ContentRegistration<C>,
  file = 'content',
): Outcome<ContentPack<C>> {
  try {
    return validateContentData(candidate, registration, file);
  } catch (error) {
    return caughtFailure(error, 'content-validation-failed');
  }
}

function validateContentData<C>(
  candidate: unknown,
  registration: ContentRegistration<C>,
  file: string,
): Outcome<ContentPack<C>> {
  const json = checkJson(candidate);
  if (!json.ok) return json;
  const parsed = schema
    .object({
      id: identifierSchema,
      revision: identifierSchema,
      schemaVersion: schema.literal(registration.schemaVersion),
      data: registration.schema,
    })
    .parse(candidate);
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        ...parsed.error,
        diagnostics: parsed.error.diagnostics.map((entry) => ({ ...entry, file })),
      },
    };
  }
  const pack = cloneData(parsed.value);
  const diagnostics = registration.validate?.(freezeData(pack.data)) ?? [];
  if (diagnostics.length > 0) {
    return {
      ok: false,
      error: {
        code: 'invalid-content',
        messageKey: 'aegis.runtime.invalid-content',
        diagnostics: diagnostics.map((entry) => ({ ...entry, file: entry.file ?? file })),
      },
    };
  }
  return success(pack);
}

export function parseContentJson<C>(
  text: string,
  registration: ContentRegistration<C>,
  file = 'content.json',
  maxCharacters = 2_000_000,
): Outcome<ContentPack<C>> {
  if (text.length > maxCharacters)
    return failure('data-limit', 'Content file exceeds its limit.', { file });
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch (error) {
    return failure('invalid-json', error instanceof Error ? error.message : String(error), {
      file,
    });
  }
  return validateContent(candidate, registration, file);
}

export function validateReferences(
  records: readonly { id: string; references: readonly string[] }[],
  available: readonly string[],
  catalog: string,
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const seen = new Set<string>();
  const ids = new Set(available);
  for (const record of records) {
    if (seen.has(record.id)) {
      diagnostics.push({
        code: 'duplicate-id',
        message: 'Duplicate record ID.',
        file: catalog,
        recordId: record.id,
        path: 'id',
      });
    }
    seen.add(record.id);
    for (const [index, reference] of record.references.entries()) {
      if (!ids.has(reference)) {
        diagnostics.push({
          code: 'missing-reference',
          message: `Unknown reference "${reference}".`,
          file: catalog,
          recordId: record.id,
          path: `references[${index}]`,
        });
      }
    }
  }
  return diagnostics;
}
