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

- **`Entity` is a branded integer** (`core/entity.ts`) encoding a slot **index** in its low bits
  and a **generation** counter in its high bits. Despawning a slot bumps its generation, so a
  handle held past a despawn compares unequal to the reused slot — no accidental aliasing.
- **Each component type owns a sparse set**: a dense array of values plus a sparse index array
  keyed by entity index. O(1) add/remove/get, and dense arrays serialise and iterate cleanly.
- **Iteration is always ascending entity index.** Queries resolve by walking the smallest matching
  component's dense set and probing the others, but results are yielded in ascending-index order
  so every system sees entities in the same order on every machine (feeds ADR-0001).
- **The whole world serialises to JSON** (`core/serialize.ts`): entities, their components, and
  resources, in a canonical, key-sorted form. This is both the save format and the hash input.
- **Queries are declarative** (`core/query.ts`): `world.query({ has: [...], any: [...], none: [...] })`,
  returning a `QueryResult` with `.iter()`, `.one()`, `.count()`. Component references may be the
  `ComponentType` (type-safe) or its string id.

## Consequences

- **Good:** deterministic iteration falls out for free; per-component arrays are the natural unit
  for serialisation and for the render adapter to read; generational handles kill a whole class of
  use-after-despawn bugs; the query surface reads fluently for agents.
- **Cost:** entities that carry many rarely-shared components use a little more memory than an
  archetype store; extremely large worlds (100k+ entities) are not the design target (anti-goal:
  keep the simulation understandable), so this is acceptable.
- **Constraint for implementers:** component data must be **plain, JSON-serialisable data** — no
  class instances, functions, or cyclic refs — because it is cloned via structural copy and hashed
  by canonical JSON. Behaviour lives in systems, never on components.
