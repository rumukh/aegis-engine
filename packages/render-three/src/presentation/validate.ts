import type { Validated } from '@aegis/core';
import type { EventContracts } from '@aegis/harness';
import type { PresentationManifest } from './schema.js';
import { checkEventBindings } from './event-bindings.js';
import { validatePresentationShape } from './validate-shape.js';

/** Add game vocabulary checks when the caller has a plugin context. */
export function validatePresentation(
  input: unknown,
  sourceFile?: string,
  events?: EventContracts,
): Validated<PresentationManifest> {
  const checked = validatePresentationShape(input, sourceFile);
  if (!checked.ok || !checked.value || events === undefined) return checked;
  const diagnostics = checkEventBindings(checked.value, events, sourceFile);
  return diagnostics.length === 0 ? checked : { ok: false, diagnostics };
}
