/**
 * Stable diagnostic codes for `@aegis/content` (CHARTER principle 8).
 *
 * Codes are permanent: once shipped, a code's meaning never changes and it is never reused.
 * Add new codes for new problems. Agents branch on `code`; the `message`/`fix` are for humans.
 * Range: `AEG-CONTENT-0001`..`AEG-CONTENT-0999`.
 * @packageDocumentation
 */
import type { Diagnostic, Severity, SourceLocation } from '@aegis/core';

/** All content diagnostic codes. */
export const ContentCode = {
  /** The document is not valid JSON. */
  InvalidJson: 'AEG-CONTENT-0001',
  /** The `aegis` discriminator is missing or not a recognised value/version. */
  UnknownFormat: 'AEG-CONTENT-0002',
  /** A required field is missing. */
  MissingField: 'AEG-CONTENT-0003',
  /** A field has the wrong type. */
  TypeMismatch: 'AEG-CONTENT-0004',
  /** An entity references a component id not present in the registry. */
  UnknownComponent: 'AEG-CONTENT-0005',
  /** An entity references a prefab that could not be resolved. */
  UnknownPrefab: 'AEG-CONTENT-0006',
  /** Two entities (or prefabs) share the same id. */
  DuplicateId: 'AEG-CONTENT-0007',
  /** Component data failed the component's own schema validation. */
  InvalidComponentData: 'AEG-CONTENT-0008',
  /** A tilemap row/layer is inconsistent with the declared width/height. */
  TilemapShapeMismatch: 'AEG-CONTENT-0009',
  /** A tilemap cell uses a legend key that is not defined. */
  UnknownTile: 'AEG-CONTENT-0010',
  /** The scene's `mode` is not one of the supported game modes. */
  UnknownMode: 'AEG-CONTENT-0011',
  /**
   * Authored component data carries a field the component's shape does not have — a typo
   * (`curent`) or an invention (`hp`). The value would be stored and never read by any system.
   */
  UnknownField: 'AEG-CONTENT-0012',
  /**
   * An authored **nested** object is missing keys the default has. Component data is merged
   * one level deep, so a nested object replaces the default wholesale and the missing keys
   * become `undefined` at runtime (`{ position: { x: 3 } }` loses `y` and `z`).
   */
  IncompleteNestedObject: 'AEG-CONTENT-0013',
  /** A scene sets a resource id that is not registered (only checked when a registry is given). */
  UnknownResource: 'AEG-CONTENT-0014',
  /** A field's value is outside the closed set of values the component declares for it. */
  InvalidFieldValue: 'AEG-CONTENT-0015',
  /**
   * A registered component has no declared schema, but {@link describeComponent} was called for
   * a *different* component object carrying the same id — so the declaration is almost
   * certainly keyed against another module's copy and is being silently ignored.
   */
  SchemaKeyMismatch: 'AEG-CONTENT-0016',
  /**
   * An authored value cannot be held by world state, so **instantiating this document would
   * throw**: a non-finite number (`1e999` parses to `Infinity`, and `JSON.parse` accepts it), a
   * cycle or runaway nesting, or a value that is not plain JSON.
   *
   * This exists because the three checks above it are shape checks, and shape is not the whole
   * contract: a free-form `optional: { data: 'object' }` field, an array's elements and a
   * scene's `resources` block are all *shapeless* by design, so nothing looked inside them.
   * `aegis validate` reported a clean document and `aegis run` then died with
   * `AEG-CORE-0001` — the worst shape a defect can take in an agent-first engine, because the
   * tool that exists to catch the problem says the problem is not there.
   */
  UnserialisableValue: 'AEG-CONTENT-0017',
} as const;

/** A content diagnostic code value. */
export type ContentCodeValue = (typeof ContentCode)[keyof typeof ContentCode];

/** Build a content {@link Diagnostic}. Thin helper so call sites stay terse and consistent. */
export function diagnostic(
  code: ContentCodeValue,
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
