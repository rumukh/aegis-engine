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
