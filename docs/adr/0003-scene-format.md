# ADR-0003: Scene / content format

- **Status:** Accepted
- **Principle:** CHARTER §3.1 (text is the substrate), §3.8 (structured diagnostics).

## Context

Scenes, prefabs and tilemaps are the primary things an agent authors. Principle 1 forbids binary
formats and GUIDs and demands diffable, human-and-agent-readable files. We weighed three
substrates:

- **TypeScript-as-data** (`export default defineScene(...)`): great type-safety and
  autocompletion, but a `.ts` scene is code — it can import, branch, and run arbitrary logic,
  which breaks "the world is data", complicates loading (needs a TS/JS runtime to evaluate), and
  makes diffs semantically ambiguous.
- **A bespoke DSL**: maximally terse but needs a parser, an editor story, and a spec; high cost
  for little gain over JSON.
- **JSON**: universally diffable, tool-agnostic, trivially parseable in any host, no code
  execution. Verbose and untyped on its own.

## Decision

**Canonical JSON is the on-disk format; a typed builder is the ergonomic authoring path.** They
emit the same document.

- Documents are JSON tagged with a schema discriminator: `"aegis": "scene/1"` (and
  `prefab/1`, `tilemap/1`), with file suffixes `.scene.json` / `.prefab.json` / `.tilemap.json`.
- Entities are declared as data: a `name`, a list of components addressed by **stable string id**,
  and their plain-data values. Prefabs are reusable entity templates a scene can instantiate and
  override.
- **Tilemaps store their grid as ASCII rows** plus a glyph→tile legend, so a level diffs
  line-by-line and is readable at a glance — the same spirit as the ASCII view (ADR-0007).
- `@aegis/content/builder.ts` offers `createSceneBuilder(name, mode)`: a typed, in-code
  builder that produces the canonical JSON object, giving agents autocompletion and compile-time
  checks when they want them, without making the _format_ be code.
- **Validation is schema-driven and mandatory before running** (`content/load.ts` —
  `parseScene` → `validateScene` → `instantiateScene`; `content/diagnostics.ts`): documents are
  checked against the `ComponentRegistry`; every problem is a
  `Diagnostic { code, severity, path, message, fix? }` with a **stable error code**
  (`ContentCode`). APIs return the `Validated<T>` envelope from `@aegis/core`.

## Consequences

- **Good:** scenes are pure data — no code execution on load, safe to accept from anywhere,
  perfectly diffable; the builder recovers type-safety for authors who want it; the CLI can
  `validate` and `scaffold` documents without a compiler.
- **Cost:** raw JSON is verbose and lacks comments; we mitigate with the builder and with the
  ASCII-grid tilemap representation. Schema evolution needs the versioned discriminator.
- **Constraint for implementers:** the builder must never emit anything the schema can't validate,
  and validation must run before instantiation — a scene that fails validation never reaches the
  world.
