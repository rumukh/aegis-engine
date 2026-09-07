# Agent workbench

Discover a game's vocabulary, validate authored documents, then request explicit projections of
its world. These commands run headlessly. Their implementation lives in
[`packages/cli/src`](../../packages/cli/src).

## Discover a selected plugin

```text
aegis describe --mode platformer --json
aegis describe --mode iso --json
aegis describe --mode fps --json
aegis describe --plugin @aegis/game-platformer#coyoteGapPlugin --json
aegis describe --plugin @aegis/game-iso#serverVaultPlugin --json
aegis describe --plugin @aegis/game-fps#sectorBreachPlugin --json
aegis describe games\iso\levels\server-vault.scene.json --json
```

`describe [scene]` uses the existing plugin selection rules: explicit `--plugin`, then the
nearest `aegis.json`, then the scene's mode or `--mode`. Without a scene, config discovery starts
at the working directory; absent a config, pass `--plugin` or `--mode`. No selection is an error.
Explicit plugin paths resolve against the working directory; config-relative paths resolve
against that config. `--mode` must agree with a selected plugin.

JSON has discriminator **`"aegis": "capabilities/1"`**. Keys and inventories are deterministic;
execution/child order is preserved. Config provenance includes an absolute path, so that path
naturally differs across checkouts. Without `--json`, the command prints a readable inventory.

| Field                    | Meaning                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plugin`                 | Selected `spec`, `source` (`flag`, `config`, `mode`), `mode`, and `configFile` when applicable.                                                                                                  |
| `components`             | The shared scene context's registered IDs, complete default values, accepted fields, and identity-keyed schema declarations.                                                                     |
| `resources.ids`          | Sorted IDs accepted for authored resources by this plugin. Never inferred from scene keys.                                                                                                       |
| `resources.valueSchemas` | `null`: resource registration does not declare value schemas.                                                                                                                                    |
| `prefabs.catalog`        | Plugin-provided prefab documents, sorted by name. `expanded: false`; these are declarations, not validated instances.                                                                            |
| `systems`                | Fixed phases, actual resolved execution order, original before/after constraints, and unresolved constraints that were not applied.                                                              |
| `operations`             | Available modes and the live CLI command registry: help, flag arities, published choice arrays, and file/response formats. Missing choice metadata is `null`, not an open-ended-value guarantee. |
| `limits`                 | Explicit limits of discovery, including unavailable input-action/event inventories.                                                                                                              |

The registry comes from `createSceneContext`, and accepted field names and optional/enumerated
facts come from `componentFields`/`componentSchema`. In each component field:

- `required: false` means a top-level field can be omitted. `source` distinguishes defaults
  from optional declarations. `value` describes accepted kinds and nested keys.
- `finite: true` is a real numeric validation rule, not an inferred range. `stringEnum` applies
  to authored strings only. Undeclared unions and gameplay-specific restrictions are not guessed.
- Nonempty nested default objects require every `requiredKeys` entry and reject extra keys.
  Empty nested objects and declared optional objects are free-form.
- Array elements have no shape schema beyond serialisability. A **null default** yields
  `kind: "any"`; an **optional null declaration** yields `kind: "null"`.
- `schemaStatus: "identity-mismatch"` warns that a declaration exists for another component
  object sharing this ID. That declaration is not borrowed.

**Defaults are authoring hints, not proof of correct gameplay.** Discovery imports plugin code
and calls declaration/default factories and schedule resolution. It does not create a world,
call `init`, run systems, or call a view provider. A supplied scene is parsed for selection but
is not semantically validated. Use `aegis validate` before running authored content.

## Validate presentation structure

```text
aegis validate look.presentation.json --json
aegis validate "*.presentation.json" --strict
```

The existing `validate` command accepts **`presentation/1`** alongside `scene/1`, `prefab/1`
and `tilemap/1`. Selection uses the document's `aegis` discriminator, not its filename.
It calls the published `@aegis/render-three/presentation/validate` `validatePresentation`
function; its types come from `@aegis/render-three/presentation/schema`. The CLI does not
maintain a second presentation schema.

**This is structural validation only.** It checks manifest fields, declared intra-manifest
references, asset path syntax and the pure validator's limits. It does not read asset files,
decode textures/models/audio, verify provenance, compute inventories or digests, initialize
a scene, or resolve identifiers against a world. A valid manifest can still refer to a
missing local file, a nonexistent model clip, or an entity name that no world provides.
Even `--strict` does not turn these unchecked properties into checks.

Every presentation result identifies this scope. In JSON, its `files` entry includes:

```json
{
  "validation": {
    "format": "presentation/1",
    "scope": "structural",
    "notChecked": ["asset-files", "asset-decoding", "initialized-world-bindings"]
  }
}
```

This is an excerpt, not the whole report. Human output prints the same qualification before
the usual diagnostics. Presentation problems retain the validator's `AEG-RENDER-####` codes,
source file and field path; malformed JSON and unknown versions use the existing content
diagnostics. Exit codes remain `0` for no reported problems, `2` for content/presentation
errors (or warnings under `--strict`), and `1` for CLI/IO errors.

`--plugin`, `--mode` and nearby `aegis.json` selection remain relevant to scenes/prefabs only.
Presentation validation never imports a plugin or validates world bindings, including when
files of multiple formats are validated in one command. Undeclared flags requesting asset
preparation or a world-validation operation are rejected, not silently honored.

`describe` reports `presentation/1` in the registered `validate` command's `formats.reads`,
with the structural-only guarantee in its usage text. This is validation support, not a
presentation-schema inventory, a new simulation resource, or a claim of asset readiness.

## Bound world output explicitly

```text
aegis inspect games\iso\levels\server-vault.scene.json --limit 2 --offset 1 --resources summary --json
aegis inspect games\iso\levels\server-vault.scene.json --query "has:Guard" --resources none --json
aegis inspect games\iso\levels\server-vault.scene.json --limit 0 --resource NavGrid --json
```

All new controls are **world-only**; combining one with `--view frame` or `--view ascii` is an
error, not a silently ignored request. Existing query and offscreen behavior is unchanged.
With no new flags, human and JSON output keep the existing shape and full resource values.

| Flag                  | Behavior                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--limit <n>`         | Return at most `n` matching entities; omitted means all. `0` is counts/resources only.                               |
| `--offset <n>`        | Skip `n` query matches in ascending entity-index order, including recycled slots; default `0`.                       |
| `--resources all`     | Full values, the existing default.                                                                                   |
| `--resources summary` | ID/kind and object key count or array/string length, without full values. String length is UTF-16 code units.        |
| `--resources none`    | Omit resource values and summary rows while reporting how many values were omitted.                                  |
| `--resource <id>`     | Select one exact runtime resource ID for full output or summary. Unknown IDs and combination with `none` are errors. |

Limits/offsets must be safe integers from `0` through `9007199254740991`. Negative, fractional,
nonfinite, empty and unsafe values fail with structured CLI diagnostics before loading a scene.
An offset at or beyond the match count is valid and returns an explicitly empty page.

In paginated JSON, **`total` remains the world entity count and `matched` remains the full query
match count**. `entities` contains only the page. For the first example above at tick 0:

```json
{
  "matched": 6,
  "total": 6,
  "page": {
    "order": "entity-index",
    "offset": 1,
    "limit": 2,
    "returned": 2,
    "truncated": true,
    "hasMore": true,
    "nextOffset": 3
  }
}
```

This is an excerpt; the response also contains scene/plugin provenance, tick, seed, full-world
hash and the selected entities. `truncated` includes matches skipped by the offset, so it can
remain true on the last page. `nextOffset` is `null` when no advancing page exists, including
`--limit 0`. An omitted limit is reported as `null`, not a hidden ceiling.

Opt-in resource projections add `resourceSelection`: `mode`, `total`, `matched`, `returned`,
`valuesReturned`, `omittedValues`, `truncated`. Here `truncated` means **full values were omitted**:
a summary may return every resource's summary while still omitting every full value. Summary
rows live in `resourceSummary`; the `resources` value map is absent in summary/none mode.
Runtime-created IDs can differ from the authoring IDs exposed by `describe`.

**These controls bound returned rows, not simulation time, snapshot memory, or byte size.**
The command still runs every requested tick and hashes/snapshots the complete world. Selected
component/resource values are never silently shortened; a single value can be large.
Entity limits do not limit resource output. Use resource selection/summary/none deliberately.
