import { suggestName } from '@aegis/core';
import type { Diagnostic } from '@aegis/core';
import { validateValue } from '@aegis/content';
import type { ValueSchema } from '@aegis/content';
import type { EventContracts } from '@aegis/harness';
import { renderDiagnostic, RenderCode } from './diagnostics.js';
import type { PresentationManifest } from './schema.js';

/** Check a structurally valid manifest against declarations, not a sample run's event log. */
export function checkEventBindings(
  manifest: PresentationManifest,
  events: EventContracts,
  file?: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  function unknown(kind: string, name: string, known: string[], path: string): void {
    const near = suggestName(name, known);
    const d = renderDiagnostic(
      RenderCode.EventBinding,
      path,
      `Unknown ${kind} "${name}".`,
      near
        ? `Did you mean "${near}"?`
        : `Use a declared ${kind}. Known: ${known.join(', ') || '(none)'}.`,
      file,
    );
    diagnostics.push({ ...d, data: { name, ...(near ? { suggestion: near } : {}) } });
  }
  function payload(name: string, path: string, catalog = events): ValueSchema | undefined {
    if (Object.hasOwn(catalog, name)) return catalog[name] ?? undefined;
    unknown('event', name, Object.keys(catalog), path);
    return undefined;
  }
  manifest.effects?.forEach((e, i) => payload(e.event, `effects[${i}].event`));
  const hud = manifest.hud;
  if (hud !== undefined) {
    payload(hud.winEvent, 'hud.winEvent');
    hud.loseEvents.forEach((name, i) => payload(name, `hud.loseEvents[${i}]`));
    hud.steps?.forEach((s, i) => payload(s.event, `hud.steps[${i}].event`));
  }
  // A cutscene can send audio-only cues with no payload. It cannot win a game or drive an effect.
  const audioEvents = { ...events };
  for (const cue of manifest.ui?.winEnding?.cues ?? []) audioEvents[cue.event] = { fields: {} };
  manifest.audio?.cues?.forEach((cue, i) => {
    const p = `audio.cues[${i}]`;
    let schema = payload(cue.event, `${p}.event`, audioEvents);
    if (cue.when === undefined || schema === undefined) return;
    for (const key of cue.when.field.split('.')) {
      while (typeof schema === 'object' && 'nullable' in schema) schema = schema.nullable;
      if (schema === 'any') return; // The rest of the predicate is undeclared.
      if (typeof schema === 'object' && 'record' in schema) {
        schema = schema.record;
        continue;
      }
      const fields: Readonly<Record<string, ValueSchema>> =
        typeof schema === 'object' && 'fields' in schema
          ? { ...schema.fields, ...schema.optional }
          : {};
      if (!Object.hasOwn(fields, key)) {
        unknown(`payload field of "${cue.event}"`, key, Object.keys(fields), `${p}.when.field`);
        return;
      }
      schema = fields[key]!;
    }
    for (const d of validateValue(cue.when.equals, schema, `${p}.when.equals`, file))
      diagnostics.push({ ...d, code: RenderCode.EventBinding });
  });
  return diagnostics;
}
