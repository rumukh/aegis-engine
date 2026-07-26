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
| Unknown resource id, with a did-you-mean (opt-in — see below)   | `AEG-CONTENT-0014` | `platformer.tilemp`                                    |
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
- **Resource _values_.** Resources are applied wholesale with no merge, and some (an fps floorplan
  legend) are legitimately free-form. Ids only.
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

## Resource-id validation is implemented and **not wired up**

`ResourceRegistry` + `ValidateOptions.resources` are implemented and tested: supply a registry and
an unknown resource id is an error with a did-you-mean. **`runScene` does not supply one**, so
`aegis run` / `aegis test` do not report a typo'd resource id today. That is a PM ruling on
proportionality (activating it touches a frozen contract plus three mode packages that other
sessions are actively changing), deferred to v2 — not an oversight, and recorded here because an
unwired capability that says so is fine while one that silently does nothing is not.

Exactly two changes activate it:

1. **`@aegis/harness`** — add an optional `resources?(): readonly ResourceType<unknown>[]` to
   `ModePlugin`, and in `run.ts` pass
   `resources: createResourceRegistry(...plugin.resources?.() ?? [])` into the `instantiateScene`
   options.
2. **each `@aegis/mode-*`** — implement `resources()`, returning what it already declares
   (`PlatformerTilemap`, `IsoGrid`/`NavGrid`, `FPS_FLOORPLAN`/`FPS_COLLISION`).

Until then it is opt-in for any caller that knows the legal ids:

```ts
validateScene(scene, { registry, resources: createResourceRegistry('platformer.tilemap') });
```

Related, also outstanding and owned elsewhere: `aegis validate` does not pass
`ValidateOptions.file`, so CLI diagnostics carry a JSON path but no filename. One line in
`packages/cli/src/commands/validate.ts`.

## Public surface

`scene.ts` (document types) · `registry.ts` (`createRegistry`, `createResourceRegistry`) ·
`schema.ts` (`validateComponentData`, `describeComponent`, `componentFields`, `suggestName`) ·
`load.ts` (`parseScene`/`parsePrefab`/`parseTilemap`, `validateScene`/`validatePrefab`,
`instantiateScene`) · `builder.ts` (`createSceneBuilder`) · `components/` (`Sprite`, `Model`,
`Light`, `Health`, `Trigger`, `Dead`, `Triggered`, `healthSystem`, `pointInTrigger`).

The TSDoc in `src/` is the contract of record; see [`docs/api/README.md`](../../docs/api/README.md).
