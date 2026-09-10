# ADR-0011: Standalone asset preview

- **Status:** Accepted; implementation and acceptance tracked separately.
- **Principles:** CHARTER headless-first, inspectable data, structured diagnostics and one CLI.

## Context

An agent editing a model, texture, material or animation needs a short feedback loop with its
operator. Starting a game, loading a level and replaying input to reach a useful camera angle
is unnecessary work for an asset review. A private contact-sheet script is useful evidence
but is not a supported engine workflow.

## Decision

Provide an asset-only studio and capture API alongside, not inside, the game host.

1. **No game bootstrap.** A local asset or presentation descriptor is sufficient. Preview
   must not create a World, initialize a ModePlugin, run game systems or load the PoC catalog.
   Studio animation playback is presentation time, not simulated gameplay.
2. **Use production loading.** Reuse the presentation validator, prepared local dependency
   closure, model/texture/material loaders and resource ownership. Do not introduce a second
   importer or a silent primitive fallback. A material preview uses an explicitly selected
   studio shape; it must not pretend that shape is the imported model.
3. **Keep a warm iteration path.** A persistent studio supports explicit reload and watched
   asset changes without rebuilding the workspace. Reload invalidates changed dependencies,
   preserves useful camera and clip settings, and releases replaced resources. The CLI also
   offers one-shot capture through the same implementation.
4. **Identify the rendered revision.** Captures record source/dependency fingerprints,
   selection, camera, lighting, animation sample, dimensions and timings. An old successful
   image must not be returned as success for a newly failed or still-loading revision. Late
   responses cannot replace a newer accepted revision.
5. **Present the result.** Operators can use an interactive orbit/animation view or saved
   images. Agents receive structured results and actionable errors rather than scraping a
   game HUD. Direct user-supplied files with unknown provenance are labeled honestly; preview
   does not infer a license or upload source assets to an external service.

## Acceptance and limits

Use the existing PoC asset kits rather than a separate easy-to-render demo. Exercise actual
decoded pixels and animation, changed dependency reload, failure/recovery and disposal, with
an independent guard against game initialization. Measure cold startup and warm reload/capture
separately on a stated host. A passing parser or a cached previous image is not render evidence.

Fixed studio inputs make comparisons useful, but do not promise byte-identical GPU pixels
across machines. Studio quality does not establish in-game collision alignment, performance,
lighting or gameplay correctness; the PoC game acceptance paths remain necessary. This is a
preview and observation surface, not an opaque GUI asset-authoring format or a new game editor.
