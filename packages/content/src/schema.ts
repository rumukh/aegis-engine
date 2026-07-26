/**
 * Schema validation for authored **component data** (CHARTER principle 8: "content is
 * validated against schemas before it ever runs").
 *
 * A component's schema is its own default value: `type.create()` returns a complete, canonical
 * instance, so its key set *is* the field list and each default's JSON type *is* that field's
 * type. That gives real validation with no extra declaration burden on component authors, and
 * it cannot drift from the runtime shape the way a hand-written schema would.
 *
 * Three classes of defect are caught, every one of which used to load silently:
 *
 * | Authored                      | Was                                 | Now                                            |
 * | ----------------------------- | ----------------------------------- | ---------------------------------------------- |
 * | `Health: { curent: 50 }`      | stored; the entity keeps 1 HP       | {@link ContentCode.UnknownField} + did-you-mean |
 * | `Health: { current: "lots" }` | stored; `"lots" <= 0` is `false`    | {@link ContentCode.TypeMismatch}                |
 * | `Trigger: { half: { x: 2 } }` | `half.y` / `half.z` are `undefined` | {@link ContentCode.IncompleteNestedObject}      |
 *
 * ## Why nested objects must be complete
 *
 * `defineComponent().create()` merges authored data over the defaults **one level deep**: a
 * nested object replaces the default wholesale rather than merging into it. So
 * `{ position: { x: 3 } }` stores exactly that — `position.y` is `undefined`, and
 * `undefined * 2` is `NaN`. Rather than silently deep-merging (which would change
 * `@aegis/core` semantics and the meaning of every scene already authored), this layer
 * *rejects* an incomplete nested object and quotes the complete object to write instead.
 *
 * ## What a default cannot describe
 *
 * A declared-but-optional field (`TriggerData.data`) is absent from `defaults()` and so is
 * invisible here, and a string-union field (`shape: 'box' | 'sphere'`) looks like any other
 * string. {@link describeComponent} lets a component declare both, beside its definition,
 * without changing its runtime shape.
 * @packageDocumentation
 */
import type { ComponentType, Diagnostic } from '@aegis/core';
import { ContentCode, diagnostic } from './diagnostics.js';

/** The JSON type of a value, as reported in diagnostics and declared in {@link ComponentSchema}. */
export type FieldKind = 'number' | 'string' | 'boolean' | 'object' | 'array' | 'null';

/**
 * Schema facts a component's defaults cannot express. Declared beside the component with
 * {@link describeComponent}, and entirely optional — a component without one is still
 * validated against its defaults.
 */
export interface ComponentSchema {
  /**
   * Fields that are valid but absent from `create()` because they are optional (e.g.
   * `TriggerData.data`), mapped to the JSON kind accepted. `object` and `array` fields
   * declared this way are free-form: their contents are not key-checked, because there is no
   * shape to check them against.
   */
  optional?: Readonly<Record<string, FieldKind>>;
  /**
   * Closed value sets for fields whose TypeScript type is a string union (`shape: 'box' |
   * 'sphere'`). A runtime default only reveals `string`, so `"spere"` would otherwise pass
   * validation and then silently behave as a box.
   */
  enums?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Schemas are keyed by component **identity**, not by id: two packages may legitimately define
 * different components sharing an id (several test modes define their own `Velocity`), and a
 * WeakMap keeps those from colliding — and lets an entry die with its type.
 */
const schemas = new WeakMap<ComponentType<unknown>, ComponentSchema>();

/**
 * Declare the schema facts `type.create()` cannot express. Call it directly below the
 * component's definition; calling it twice for one type replaces the earlier declaration.
 */
export function describeComponent<T>(type: ComponentType<T>, schema: ComponentSchema): void {
  schemas.set(type as ComponentType<unknown>, schema);
}

/** The {@link ComponentSchema} declared for `type`, if any. */
export function componentSchema(type: ComponentType<unknown>): ComponentSchema | undefined {
  return schemas.get(type);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** The JSON kind of a value, as it appears in a diagnostic's `expected` / `received`. */
function kindOf(value: unknown): FieldKind | 'undefined' {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number' || t === 'string' || t === 'boolean') return t;
  return 'object';
}

/** Short, safe rendering of a value for a human-readable message. */
function show(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (value === undefined) return 'undefined';
  const text = json(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Full, untruncated JSON — for text the author is meant to *copy*, where {@link show}'s
 * ellipsis would hand them syntactically invalid JSON.
 */
function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Restricted Damerau-Levenshtein distance: an adjacent transposition counts as one edit, so
 * `nmae` -> `name` scores 1. Field and component names are short, so the matrix stays tiny.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    rows.push(row);
  }
  const first = rows[0] as number[];
  for (let j = 0; j <= b.length; j++) first[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const prev = rows[i - 1] as number[];
    const cur = rows[i] as number[];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = (prev[j] as number) + 1; // deletion
      const insertion = (cur[j - 1] as number) + 1;
      if (insertion < best) best = insertion;
      const substitution = (prev[j - 1] as number) + cost;
      if (substitution < best) best = substitution;
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        const transposition = ((rows[i - 2] as number[])[j - 2] as number) + 1;
        if (transposition < best) best = transposition;
      }
      cur[j] = best;
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

/** How far apart two names may be before a suggestion is more confusing than helpful. */
function tolerance(length: number): number {
  if (length <= 2) return 0; // one-letter fields (x/y/z) would otherwise suggest each other
  if (length <= 4) return 1;
  if (length <= 8) return 2;
  return 3;
}

/**
 * The closest of `candidates` to `name`, or `undefined` when nothing is close enough — the
 * shared "did you mean ...?" engine behind field, component and resource diagnostics.
 *
 * A case-only difference always wins. Ties break on the lexicographically smaller candidate,
 * so the suggestion is deterministic whatever order the candidates arrive in.
 */
export function suggestName(name: string, candidates: Iterable<string>): string | undefined {
  const sorted = [...candidates].sort();
  const lower = name.toLowerCase();
  for (const candidate of sorted) if (candidate.toLowerCase() === lower) return candidate;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of sorted) {
    const longest = candidate.length > name.length ? candidate.length : name.length;
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance <= tolerance(longest) && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Where a component's data sits, for diagnostic locations. */
export interface DataLocation {
  /** JSON path of the component data object, e.g. `entities[3].components.Health`. */
  path: string;
  /** Source file, when the document came from one. */
  file?: string;
}

/** `type.create()` as a plain object, or `undefined` when the component is not object-shaped. */
function defaultShape(type: ComponentType<unknown>): Record<string, unknown> | undefined {
  const value = type.create();
  return isPlainObject(value) ? value : undefined;
}

/**
 * Every field name a component accepts — the keys of its defaults plus any declared optional
 * fields, sorted. This is the list an agent is shown when it authors a field that does not
 * exist, and the list a completion surface would offer.
 */
export function componentFields(type: ComponentType<unknown>): readonly string[] {
  const shape = defaultShape(type);
  if (shape === undefined) return [];
  const schema = componentSchema(type);
  const names = new Set(Object.keys(shape));
  if (schema?.optional) for (const key of Object.keys(schema.optional)) names.add(key);
  return [...names].sort();
}

/** State threaded through one component's validation. */
interface Check {
  readonly componentId: string;
  readonly file: string | undefined;
  /** Accepted top-level field names, sorted. */
  readonly fields: readonly string[];
  readonly diagnostics: Diagnostic[];
}

function article(kind: FieldKind): string {
  return kind === 'array' || kind === 'object' ? 'an' : 'a';
}

function unknownField(
  check: Check,
  key: string,
  fieldPath: string,
  jsonPath: string,
  candidates: readonly string[],
): void {
  const dot = fieldPath.lastIndexOf('.');
  const nested = dot >= 0;
  const subject = nested
    ? `field "${fieldPath.slice(0, dot)}" has no key "${key}"`
    : `has no field "${key}"`;
  const suggestion = suggestName(key, candidates);
  const hint = suggestion === undefined ? '.' : ` - did you mean "${suggestion}"?`;
  const none = nested ? '(none: that object declares no keys)' : '(none: it is a marker component)';
  const list = candidates.length > 0 ? candidates.join(', ') : none;
  check.diagnostics.push(
    diagnostic(
      ContentCode.UnknownField,
      `Component "${check.componentId}" ${subject}${hint} Unknown fields are stored verbatim and never read by any system.`,
      {
        location: { file: check.file, path: jsonPath },
        fix:
          suggestion === undefined
            ? `Remove "${key}", or replace it with one of: ${list}.`
            : `Rename "${key}" to "${suggestion}".`,
        data: {
          component: check.componentId,
          field: fieldPath,
          ...(suggestion === undefined ? {} : { suggestion }),
          known: candidates,
        },
      },
    ),
  );
}

function typeMismatch(
  check: Check,
  fieldPath: string,
  jsonPath: string,
  expected: FieldKind,
  fallback: unknown,
  actual: unknown,
): void {
  const wanted = expected === 'number' ? 'a finite number' : `${article(expected)} ${expected}`;
  const received = kindOf(actual);
  const rendered = show(actual);
  const authored = rendered === received ? rendered : `${rendered} (${received})`;
  check.diagnostics.push(
    diagnostic(
      ContentCode.TypeMismatch,
      `Component "${check.componentId}" field "${fieldPath}" must be ${wanted}, but ${authored} was authored.`,
      {
        location: { file: check.file, path: jsonPath },
        fix:
          fallback === undefined
            ? `Author "${fieldPath}" as ${wanted}.`
            : `Author "${fieldPath}" as ${wanted}, e.g. ${show(fallback)} (the default).`,
        data: {
          component: check.componentId,
          field: fieldPath,
          expected,
          received,
          // The default is the value the fix text suggests; carrying it as data too means a
          // caller can repair the document mechanically instead of parsing English.
          ...(fallback === undefined ? {} : { default: fallback }),
        },
      },
    ),
  );
}

/**
 * Report a nested object that is missing keys, quoting the complete object to write. The fix
 * keeps whatever the author did write and fills the rest from the default, so it can be pasted
 * straight back into the document.
 */
function incompleteNested(
  check: Check,
  fieldPath: string,
  jsonPath: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  missing: readonly string[],
): void {
  const complete: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) {
    complete[key] = hasOwn(actual, key) ? actual[key] : expected[key];
  }
  const names = missing.map((k) => `"${k}"`).join(', ');
  check.diagnostics.push(
    diagnostic(
      ContentCode.IncompleteNestedObject,
      `Component "${check.componentId}" field "${fieldPath}" is missing ${names}. Nested objects are merged one level deep only, so this replaces the default ${show(expected)} wholesale and leaves ${names} undefined at runtime, where every comparison against them silently fails.`,
      {
        location: { file: check.file, path: jsonPath },
        fix: `Write the complete object: ${json(complete)} - or drop "${fieldPath}" entirely to keep the default.`,
        data: {
          component: check.componentId,
          field: fieldPath,
          missing,
          expected,
          complete,
        },
      },
    ),
  );
}

function invalidEnum(
  check: Check,
  fieldPath: string,
  jsonPath: string,
  allowed: readonly string[],
  actual: string,
): void {
  const suggestion = suggestName(actual, allowed);
  const hint = suggestion === undefined ? '' : ` - did you mean "${suggestion}"?`;
  check.diagnostics.push(
    diagnostic(
      ContentCode.InvalidFieldValue,
      `Component "${check.componentId}" field "${fieldPath}" does not accept ${show(actual)}.${hint}`,
      {
        location: { file: check.file, path: jsonPath },
        fix: `Use one of: ${allowed.map((v) => JSON.stringify(v)).join(', ')}.`,
        data: {
          component: check.componentId,
          field: fieldPath,
          ...(suggestion === undefined ? {} : { suggestion }),
          allowed,
        },
      },
    ),
  );
}

/**
 * Check a nested object: it must be **key-complete**, because the merge is only one deep.
 *
 * An *empty* default object is the one exception: it declares no keys, so it carries no schema
 * to check against and is treated as a free-form map (the same reading as an
 * `optional: { x: 'object' }` declaration). Reporting every key of a blackboard as unknown
 * against zero candidates would be noise, not a diagnostic.
 */
function checkNested(
  check: Check,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  fieldPath: string,
  jsonPath: string,
): void {
  const expectedKeys = Object.keys(expected);
  if (expectedKeys.length === 0) return;
  const missing = expectedKeys.filter((key) => !hasOwn(actual, key));
  if (missing.length > 0) {
    incompleteNested(check, fieldPath, jsonPath, expected, actual, missing);
  }
  const candidates = [...expectedKeys].sort();
  for (const key of Object.keys(actual)) {
    const childField = `${fieldPath}.${key}`;
    const childPath = `${jsonPath}.${key}`;
    if (!hasOwn(expected, key)) {
      unknownField(check, key, childField, childPath, candidates);
      continue;
    }
    checkValue(check, expected[key], actual[key], childField, childPath);
  }
}

/** Check one authored value against the default that describes its type. */
function checkValue(
  check: Check,
  expected: unknown,
  actual: unknown,
  fieldPath: string,
  jsonPath: string,
): void {
  switch (kindOf(expected)) {
    case 'number':
      if (typeof actual !== 'number' || !Number.isFinite(actual)) {
        typeMismatch(check, fieldPath, jsonPath, 'number', expected, actual);
      }
      return;
    case 'string':
      if (typeof actual !== 'string') {
        typeMismatch(check, fieldPath, jsonPath, 'string', expected, actual);
      }
      return;
    case 'boolean':
      if (typeof actual !== 'boolean') {
        typeMismatch(check, fieldPath, jsonPath, 'boolean', expected, actual);
      }
      return;
    case 'array':
      // Element shapes are deliberately not checked: an empty default array (the only kind in
      // practice) carries no element schema to check them against.
      if (!Array.isArray(actual)) {
        typeMismatch(check, fieldPath, jsonPath, 'array', expected, actual);
      }
      return;
    case 'object':
      if (!isPlainObject(actual)) {
        typeMismatch(check, fieldPath, jsonPath, 'object', expected, actual);
        return;
      }
      checkNested(check, expected as Record<string, unknown>, actual, fieldPath, jsonPath);
      return;
    default:
      // A `null` (or absent) default carries no type information, so anything is accepted.
      return;
  }
}

/** Check a value declared through {@link ComponentSchema.optional}, which has no default. */
function checkDeclaredKind(
  check: Check,
  kind: FieldKind,
  actual: unknown,
  fieldPath: string,
  jsonPath: string,
): void {
  const ok =
    kind === 'number'
      ? typeof actual === 'number' && Number.isFinite(actual)
      : kind === kindOf(actual);
  if (!ok) typeMismatch(check, fieldPath, jsonPath, kind, undefined, actual);
}

/**
 * Validate one component's authored data against the component's own shape.
 *
 * Top-level fields may be omitted — those merge from the defaults, which is the whole point of
 * authoring a partial — but every field that *is* authored must exist, must carry the right
 * JSON type, and, when it is an object, must be complete (see the module docs).
 *
 * @param type - The registered component the data is authored for.
 * @param data - The authored value, exactly as it appears in the document.
 * @param where - JSON path (and optional file) of the data, used in diagnostic locations.
 * @returns Diagnostics in document order; empty when the data is sound.
 */
export function validateComponentData(
  type: ComponentType<unknown>,
  data: unknown,
  where: DataLocation,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isPlainObject(data)) {
    diagnostics.push(
      diagnostic(
        ContentCode.InvalidComponentData,
        `Component "${type.id}" data must be a JSON object, but ${show(data)} (${kindOf(data)}) was authored.`,
        {
          location: { file: where.file, path: where.path },
          fix: `Author "${type.id}" as an object of its fields, or {} to accept every default.`,
          data: { component: type.id, received: kindOf(data) },
        },
      ),
    );
    return diagnostics;
  }
  const shape = defaultShape(type);
  if (shape === undefined) return diagnostics; // not object-shaped: nothing to check against
  const schema = componentSchema(type);
  const check: Check = {
    componentId: type.id,
    file: where.file,
    fields: componentFields(type),
    diagnostics,
  };

  for (const key of Object.keys(data)) {
    const jsonPath = `${where.path}.${key}`;
    const value = data[key];
    if (hasOwn(shape, key)) {
      checkValue(check, shape[key], value, key, jsonPath);
    } else if (schema?.optional !== undefined && hasOwn(schema.optional, key)) {
      checkDeclaredKind(check, schema.optional[key] as FieldKind, value, key, jsonPath);
    } else {
      unknownField(check, key, key, jsonPath, check.fields);
      continue;
    }
    // `key` comes from authored JSON, so an object-literal default can legitimately own a key
    // like `constructor`. Index the enum table only through hasOwn, or the inherited
    // `Object.prototype` member comes back and `allowed.includes` throws — turning a content
    // typo into a crash, which this layer must never do.
    const enums = schema?.enums;
    const allowed = enums !== undefined && hasOwn(enums, key) ? enums[key] : undefined;
    if (allowed !== undefined && typeof value === 'string' && !allowed.includes(value)) {
      invalidEnum(check, key, jsonPath, allowed, value);
    }
  }
  return diagnostics;
}
