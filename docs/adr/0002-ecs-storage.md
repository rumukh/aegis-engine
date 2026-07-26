# ADR-0002: ECS storage and entity identity

- **Status:** Accepted
- **Principle:** CHARTER §3.3 (determinism), §3.4 (world is inspectable as data).

## Context

The core is an Entity-Component-System. We need component storage that is (a) deterministic to
iterate, (b) cheap to query by component set, (c) trivially serialisable to JSON, and (d) safe
against stale entity references after despawn/respawn. Storage choice drives the feel of the
whole query API that every downstream package uses.

Options considered: an archetype/table store (fast for huge entity counts, complex, iteration
order tied to archetype churn), a map-of-maps (`Map<Entity, Map<ComponentId, data>>`, simple but
iteration order and hashing get subtle), and a **sparse set per component**.

## Decision

**One sparse set per component type; entity id packs an index and a generation.**

- **`Entity` is a branded integer** (`core/entity.ts`) encoding a slot **index** in its low 32 bits
  and a **generation** counter above them. Despawning a slot bumps its generation, so a handle
  held past a despawn compares unequal to the reused slot — no accidental aliasing.
- **Each component type owns a sparse set**: a dense array of values plus a sparse index array
  keyed by entity index. O(1) add/remove/get, and dense arrays serialise and iterate cleanly.
- **Iteration is always ascending entity index.** Queries resolve by walking the smallest matching
  component's dense set and probing the others, but results are yielded in ascending-index order
  so every system sees entities in the same order on every machine (feeds ADR-0001).
- **A query result holds handles, not slots.** `query()` packs each match into an `Entity` at
  query time, and every row is generation-checked again before it is yielded. This is the part
  that makes the generational handle actually load-bearing: the free list is LIFO, so a despawn
  and respawn inside a system loop reuses the slot immediately, and a result that stored bare
  slot indices would hand the _next_ entity's data to a pending row — a use-after-despawn wearing
  the costume of a safety feature. Instead a despawned entity disappears from the result, and an
  `EntityView` kept past its entity's despawn reports the component absent (`tryGet` →
  `undefined`, `has` → `false`) or throws (`get`). The trade is that `count()`/`entities()`
  describe the world _now_, not at query time.
- **The whole world serialises to JSON** (`core/serialize.ts`): entities, their components, and
  resources, in a canonical, key-sorted form. This is both the save format and the hash input.
  Component values are copied **structurally**, not through `JSON.parse(JSON.stringify(...))`:
  the JSON round-trip maps `NaN`/`±Infinity` to `null`, which made both the save and the state
  hash silently lossy exactly where they most needed to be exact (ADR-0001). Because JSON has no
  representation for a non-finite number, such a value is **rejected at the write boundary**
  (`spawn`, `add`, `setResource`, `ComponentType.create`) rather than stored and then discovered
  later; the structural clone still preserves them so that a value written in place by a system,
  which touches no boundary, is caught at `snapshot()`.
- **Queries are declarative** (`core/query.ts`): `world.query({ has: [...], any: [...], none: [...] })`,
  returning a `QueryResult` that is directly **iterable** (`for (const view of result)`) and also
  offers `.views()`, `.entities()`, `.first()`, `.one()`, `.count()` and `.forEach()`. Component
  references may be the `ComponentType` (type-safe) or its string id.

## Consequences

- **Good:** deterministic iteration falls out for free; per-component arrays are the natural unit
  for serialisation and for the render adapter to read; generational handles kill a whole class of
  use-after-despawn bugs; the query surface reads fluently for agents.
- **Cost:** entities that carry many rarely-shared components use a little more memory than an
  archetype store; extremely large worlds (100k+ entities) are not the design target (anti-goal:
  keep the simulation understandable), so this is acceptable.
- **Constraint for implementers:** component data must be **plain, JSON-serialisable data** — no
  class instances, functions, cyclic refs, or non-finite numbers — because it is cloned via
  structural copy and hashed by canonical JSON. Behaviour lives in systems, never on components.
  Non-plain data is now _rejected_ at the point it enters the world rather than silently
  canonicalised (a `Date` has no enumerable own keys and used to hash as `{}`), and
  `NaN`/`±Infinity` are rejected with `AEG-CORE-0001` naming the component and JSON path.
- **Constraint for implementers:** a slot can be recycled at most `MAX_ENTITY_GENERATION`
  (`2^21 - 1`) times. A handle is a float64 with 53 exact integer bits; 32 go to the index, which
  leaves 21 for the generation. Past that, `generation * 2^32 + index` rounds and two distinct
  entities on an odd slot pack to the _same_ handle — an entity that is alive but unaddressable.
  `despawn` throws rather than crossing it. At 60 Hz a pool that despawns and respawns one entity
  every tick reaches the ceiling in roughly ten hours, so pool and reuse entities in long-running
  scenes instead of churning them.
- **Revisit if:** the generation ceiling is hit in practice. The fix is a different bit split
  (e.g. 20 index / 32 generation), which changes every serialised entity id and therefore every
  stored snapshot and pinned hash — a breaking change that needs its own decision.
