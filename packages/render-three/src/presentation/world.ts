import { DiagnosticError, Name } from '@aegis/core';
import type { Diagnostic, Validated, World } from '@aegis/core';
import { renderDiagnostic, RenderCode } from './diagnostics.js';
import type { PresentationManifest } from './schema.js';
import { validatePresentation } from './validate.js';
import { PresentationState } from './state.js';

/** Check names against initialized state, including expanded prefabs and plugin-init spawns. */
export function validatePresentationWorld(
  manifest: PresentationManifest,
  world: World,
): Validated<PresentationManifest> {
  const shape = validatePresentation(manifest);
  if (!shape.ok) return shape;
  const names = new Set(
    [...world.query({ has: [Name] }).views()].map((entity) => entity.get(Name).value),
  );
  const diagnostics: Diagnostic[] = [];
  const requireName = (name: string, path: string): void => {
    if (names.has(name)) return;
    diagnostics.push(
      renderDiagnostic(
        RenderCode.Reference,
        path,
        `Presentation target "${name}" is absent from the initialized world.`,
        'Use the effective Name after prefab expansion and plugin initialization, or create that entity before presentation mounts.',
      ),
    );
  };
  manifest.entities?.forEach((binding, index) => {
    if ('name' in binding.target)
      requireName(binding.target.name, `entities[${index}].target.name`);
  });
  manifest.objects?.forEach((object, index) => {
    if (typeof object.anchor === 'object')
      requireName(object.anchor.entity, `objects[${index}].anchor.entity`);
  });
  manifest.effects?.forEach((effect, index) => {
    if ('entity' in effect.target)
      requireName(effect.target.entity, `effects[${index}].target.entity`);
  });
  if (manifest.hud !== undefined) requireName(manifest.hud.playerName, 'hud.playerName');
  const state = new PresentationState('fps');
  state.sync(world);
  try {
    state.validate(manifest);
  } catch (error) {
    if (!(error instanceof DiagnosticError)) throw error;
    diagnostics.push(...error.diagnostics);
  }
  return diagnostics.length === 0
    ? { ok: true, value: manifest, diagnostics }
    : { ok: false, diagnostics };
}
