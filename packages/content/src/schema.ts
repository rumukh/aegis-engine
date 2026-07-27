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
import { explainUnserialisable, findUnserialisable, suggestName } from '@aegis/core';
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
 * different components sharing an id (`Velocity` exists in three modules, `Player` and `Patrol`
 * in two games each — see docs/working-agreement.md §1, "component ids are scoped to a run"),
 * and a WeakMap keeps those from colliding — and lets an entry die with its type.
 *
 * Identity keying is stricter than id keying, which means it can also *miss*: declare against
 * one module's `Velocity`, register another's, and the lookup falls through to the undeclared
 * path — where unknown keys are a hard error — reproducing the very defect this layer exists
 * to prevent, on a different component. {@link isDescribedId} exists to make that miss loud;
 * `validateScene` turns it into a warning.
 */
const schemas = new WeakMap<ComponentType<unknown>, ComponentSchema>();

/**
 * Ids that *some* component object has declared a schema for. Deliberately keyed by id and
 * never pruned: it holds no component references (so it cannot pin a type in memory) and is
 * only ever used to answer "was a declaration made under this name?" — the question that turns
 * a mis-keyed declaration from a silent fall-through into a diagnostic.
 */
const describedIds = new Map<string, number>();

/**
 * Declare the schema facts `type.create()` cannot express. Call it directly below the
 * component's definition — that placement is what makes the identity keying reliable — and
 * never from another module against an imported copy. Calling it twice for one type replaces
 * the earlier declaration.
 */
export function describeComponent<T>(type: ComponentType<T>, schema: ComponentSchema): void {
  const key = type as ComponentType<unknown>;
  if (!schemas.has(key)) describedIds.set(type.id, (describedIds.get(type.id) ?? 0) + 1);
  schemas.set(key, schema);
}

/**
 * Whether any component object has declared a schema under `id`. A registered component that
 * has *no* schema of its own while its id is described elsewhere is the signature of a
 * mis-keyed {@link describeComponent} call.
 */
export function isDescribedId(id: string): boolean {
  return describedIds.has(id);
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
 * Restricted Damerau-Levenshtein distance and the length-scaled tolerance that decides whether
 * a name is a typo of another live in `@aegis/core`'s `suggest.ts`, because the scheduler needs
 * the identical rule for `before`/`after` entries and a second copy is how the two drifted:
 * core's flat "within two edits" *threw* on `after: ['aim']` in a schedule containing `ai`.
 *
 * Re-exported here so `suggestName` stays part of this package's public surface.
 */
export { suggestName };

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
 * Report every value inside `value` that the world's write boundary would reject, as
 * {@link ContentCode.UnserialisableValue} diagnostics.
 *
 * The rule is not restated here: {@link findUnserialisable} is `@aegis/core`'s single
 * statement of what world state may hold, and this is the *validation* presentation of the same
 * traversal that `spawn`/`add`/`setResource` throw from. That is the whole point — a document
 * that validates clean and then throws on load is the defect this closes, and a second,
 * hand-maintained rule list here is how the two would come apart again.
 *
 * @param value - The authored value: a component's data, or one scene resource.
 * @param jsonPath - JSON path of `value` in the document, prefixed onto each report.
 * @param subject - Names the owner in the message, e.g. `Component "Trigger"`.
 * @param file - Source file, when the document came from one.
 * @param out - Diagnostics are appended here, in traversal order.
 */
export function reportUnserialisable(
  value: unknown,
  jsonPath: string,
  subject: string,
  file: string | undefined,
  out: Diagnostic[],
): void {
  for (const problem of findUnserialisable(value)) {
    const path = problem.path === '' ? jsonPath : `${jsonPath}.${problem.path}`;
    const field = problem.path === '' ? '(the whole value)' : problem.path;
    const explained = explainUnserialisable(problem.reason, problem.detail);
    out.push(
      diagnostic(
        ContentCode.UnserialisableValue,
        `${subject} field "${field}" is ${explained.what}, which the world cannot store, so ` +
          `loading this document would fail. ${explained.why}`,
        {
          location: { file, path },
          fix: explained.fix,
          data: { field, path, reason: problem.reason, value: problem.detail },
        },
      ),
    );
  }
}

/**
 * Validate one component's authored data against the component's own shape.
 *
 * Top-level fields may be omitted — those merge from the defaults, which is the whole point of
 * authoring a partial — but every field that *is* authored must exist, must carry the right
 * JSON type, and, when it is an object, must be complete (see the module docs).
 *
 * Shape is checked first, then **storability**: the shape pass can only look at fields the
 * defaults describe, and a free-form `optional: { data: 'object' }` field or an array's
 * elements have no shape to check against, so they used to reach `world.add` unexamined.
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
  if (shape === undefined) {
    // Not object-shaped: no field list to check against, but the data still has to be storable.
    reportUnserialisable(data, where.path, `Component "${type.id}"`, where.file, diagnostics);
    return diagnostics;
  }
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

  // Storability, after shape. A typed number field that holds `1e999` is already reported above
  // as a type mismatch ("must be a finite number"), so drop any storability report landing on a
  // path the shape pass already covered — one defect, one diagnostic.
  const covered = new Set(diagnostics.map((d) => d.location?.path));
  const storability: Diagnostic[] = [];
  reportUnserialisable(data, where.path, `Component "${type.id}"`, where.file, storability);
  diagnostics.push(...storability.filter((d) => !covered.has(d.location?.path)));
  return diagnostics;
}
