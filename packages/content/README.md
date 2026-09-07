# @aegis/content

The declarative content layer: the scene / prefab / tilemap format, the component registry, the
scene loader, the typed builder — and the **schema validation** that stands between an authored
document and the world.

> **The promise:** CHARTER principle 8 — _"every error has a stable code, a source location, and a
> suggested fix. Content is validated against schemas before it ever runs."_ ADR-0003 makes it a
> constraint on implementers: _"validation must run before instantiation — a scene that fails
> validation never reaches the world."_

## The pipeline

```
text ──parseScene──> SceneFile ──validateScene──> Validated<SceneFile> ──instantiateScene──> World
       (structure)                (registry + schema)                    (spawns entities)
```

Parsing and validation never throw for content problems; they return a `Validated<T>` carrying
`Diagnostic`s. `instantiateScene` validates first by default and spawns **nothing** if validation
fails.

## What is validated

A component's schema is **its own default value**. `type.create()` returns a complete, canonical
instance, so its key set _is_ the field list and each default's JSON type _is_ that field's type.
There is no second source of truth to fall out of sync with the runtime shape.

| Check                                                           | Code               | Example                                                |
| --------------------------------------------------------------- | ------------------ | ------------------------------------------------------ |
| Unknown field, with a did-you-mean                              | `AEG-CONTENT-0012` | `Health: { curent: 50 }` → _did you mean "current"?_   |
| Wrong JSON type (incl. `NaN`/`Infinity` where a number belongs) | `AEG-CONTENT-0004` | `Health: { current: "lots" }`                          |
| Incomplete **nested** object (the merge is one level deep)      | `AEG-CONTENT-0013` | `Trigger: { half: { x: 2 } }` — loses `y`/`z`          |
| Value outside a declared closed set                             | `AEG-CONTENT-0015` | `Trigger: { shape: "spere" }`                          |
| Unknown component id, with a did-you-mean                       | `AEG-CONTENT-0005` | `Helth` → _did you mean "Health"?_                     |
| Unknown resource id, with a did-you-mean                        | `AEG-CONTENT-0014` | `platformer.tilemp`                                    |
| A schema declaration keyed against the wrong component object   | `AEG-CONTENT-0016` | warning; see [Declaring a schema](#declaring-a-schema) |

Every diagnostic carries the JSON path of the offending field (and the file, when the caller
supplies `ValidateOptions.file`). The `IncompleteNestedObject` fix quotes the **complete object to
write**, authored values preserved, so it can be pasted back verbatim:

```
AEG-CONTENT-0013  entities[1].components.Trigger.half
  Component "Trigger" field "half" is missing "y", "z". Nested objects are merged one level deep
  only, so this replaces the default {"x":0.5,"y":0.5,"z":0.5} wholesale and leaves "y", "z"
  undefined at runtime, where every comparison against them silently fails.
  fix: Write the complete object: {"x":2,"y":0.5,"z":0.5} - or drop "half" entirely to keep the
       default.
```

### Why nested objects must be complete

`defineComponent().create()` merges authored data over the defaults **one level deep**: a nested
object replaces the default wholesale rather than merging into it. `{ position: { x: 3 } }` stores
exactly that — `position.y` is `undefined`, and `undefined * 2` is `NaN`. Deep-merging was
considered and rejected: it would silently change the meaning of every scene already authored and
remove the author's ability to say "replace this whole object", with no syntax to get it back.
Rejecting with a pasteable fix is the honest answer, and the typed builder is already type-safe
against the same mistake.

## What is deliberately **not** validated

Each of these is a boundary, not an oversight — if you hit one, it is not a bug in validation:

- **Array element shapes.** Every array default in the tree is `[]`, which carries no element
  schema to check against.
- **Open string fields.** `TriggerKind` is extensible by design, so `kind: "teleporter"` passes.
  Only fields explicitly declared as closed sets are checked.
- **Free-form maps.** A field declared `optional: { x: 'object' }`, or one whose default is an
  empty object (`{ bag: {} }`), declares no keys — its contents are not key-checked.
- **Resource value schemas.** Resources are applied wholesale with no merge, and some (an fps
  floorplan legend) are legitimately free-form. Values are always checked for JSON storability;
  their application-specific shape is not inferred.
- **Components this package does not own.** Validation works for every registered component, but
  `describeComponent` declarations are made by each component's owner.

## Declaring a schema

A default cannot express an optional field (it is absent) or a string-union field (it looks like
any other string). `describeComponent` declares both, **directly below the definition**:

```ts
export const Trigger = defineComponent<TriggerData>({ id: 'Trigger', defaults: () => ({ ... }) });

describeComponent(Trigger, {
  optional: { data: 'object' },        // declared optional -> absent from defaults()
  enums: { shape: ['box', 'sphere'] }, // a bare string default cannot express a closed set
});
```

Declarations are keyed by **`ComponentType` identity, not by id** — component ids are scoped to a
run, not to the workspace (`docs/working-agreement.md` §1), so `Velocity` exists in three modules
and `Player`/`Patrol` in two games each. Identity keying stops those from crosstalking, but it can
also _miss_: declare against one module's copy, register another's, and the lookup silently falls
through to the undeclared path where optional fields become hard errors. `validateScene` reports
that as `AEG-CONTENT-0016` (warning) rather than letting it be discovered as a mysterious false
positive. Keep the declaration beside the definition and it cannot happen.

## Resource IDs and shared initialization

`ResourceRegistry` + `ValidateOptions.resources` are implemented and tested: supply a registry and
an unknown resource id is an error with a did-you-mean. The harness exports
`createSceneContext(plugin, options)` and `bootstrapScene(scene, options)`; headless runs, CLI
validation and live sessions use the same declarations before `plugin.init`.

`ModePlugin.resources?()` returns resource types or string IDs. Compose the mode's exported
`PLATFORMER_RESOURCES`, `ISO_RESOURCES` or `FPS_RESOURCES` with game-owned declarations.
An omitted method means no authored resources, not unchecked resources. Legacy plugins must
declare their accepted IDs, or their host must supply an explicit extra `ResourceRegistry`
through the run/live `resources` option. Resources created by systems remain unrestricted.

Low-level callers using content without a plugin can still supply the registry directly:

```ts
validateScene(scene, { registry, resources: createResourceRegistry('platformer.tilemap') });
```

CLI validation supplies `ValidateOptions.file`, so diagnostics include filename and JSON path.
`ModePlugin.prefabs?()` supplies a named prefab catalog on every run path; an explicit caller
`prefabs: PrefabResolver` takes precedence. `createPrefabResolver(...documents)` rejects
duplicate catalog names with `AEG-CONTENT-0007`.

## Prefab inheritance and identity

`expandScene(scene, options)` returns a validated explicit tree without writing a world.
`validateScene` and `instantiateScene` share the same expansion and resolve each referenced
prefab once per operation. Component overrides stay shallow per component; tags are a
prefab-first union. Omitted `EntityDecl.children` inherits the prefab defaults; an explicit
list (including `[]`) replaces them completely.

Scene-authored IDs remain global and unchanged, even on nested children. Inherited prefab
children use `<instance-id>/<local-id>` recursively, escaping `~` to `~0` and `/` to `~1`
within local segments. `left` and `right` instances therefore have distinct `left/child`
and `right/child` descendants. Expansion is depth-first in document order. Local child
positions are translated by their parent's world position; rotation/scale are not composed.

Expanded IDs own `Name`. A conflicting authored `Name.value` is `AEG-CONTENT-0019`, with a
migration fix to remove it and use the derived identity. Arbitrary component string references
are not rewritten; author fully qualified target IDs. Duplicate expanded IDs are
`AEG-CONTENT-0007`, unresolved prefabs are `0006`, and cyclic inherited child lists are `0018`.
An explicit finite child-list override may terminate a recursive reference. These failures
occur before any world writes, even when optional component/resource data validation is disabled.

## Public surface

`scene.ts` (document types) · `registry.ts` (`createRegistry`, `createResourceRegistry`) ·
`schema.ts` (`validateComponentData`, `describeComponent`, `componentFields`, `suggestName`) ·
`load.ts` (`parseScene`/`parsePrefab`/`parseTilemap`, `validateScene`/`validatePrefab`,
`createPrefabResolver`, `expandScene`, `instantiateScene`) · `builder.ts` (`createSceneBuilder`) · `components/` (`Sprite`, `Model`,
`Light`, `Health`, `Trigger`, `Dead`, `Triggered`, `healthSystem`, `pointInTrigger`).

The TSDoc in `src/` is the contract of record; see [`docs/api/README.md`](../../docs/api/README.md).
