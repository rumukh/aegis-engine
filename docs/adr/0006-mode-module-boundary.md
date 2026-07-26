# ADR-0006: Mode module boundary

- **Status:** Accepted
- **Principle:** CHARTER §4.1 (three first-class modes), §6 (parallel session team model).

## Context

Aegis ships three modes — `platformer`, `iso`, `fps` — each a first-class module contributing a
camera rig, movement, collision and spatial conventions (§4.1). Three constraints shape the
boundary:

1. The harness must run _any_ mode without knowing its internals, or the dependency graph gets a
   cycle (`harness → mode → harness`).
2. Modes must not depend on each other.
3. Five sessions build these packages **in parallel** (§6), so the contract between a mode and the
   harness must be complete and stable up front — they cannot renegotiate mid-flight.

## Decision

**Every mode implements a single `ModePlugin` interface; the harness depends only on that
interface, never on a concrete mode.**

`ModePlugin` (`harness/plugin.ts`) is the entire seam:

```ts
interface ModePlugin {
  readonly mode: GameMode;
  components(): readonly ComponentType<unknown>[]; // mode's component set, registered before load
  systems(): Schedule; // the ordered per-tick pipeline
  view(): ViewProvider; // projection → semantic frame + ASCII (ADR-0007)
}
```

- A mode package exports a plugin value (`platformerPlugin`, `isoPlugin`, `fpsPlugin`) plus its
  components and its documented system pipeline (`PLATFORMER_SYSTEMS`, etc. — names + phases +
  ordering constraints, so cross-package ordering is stable).
- **The harness imports the interface, not the mode.** `runScene({ plugin, ... })` receives the
  plugin from the caller. So `harness → mode` never exists; only `mode → harness` (to implement
  the interface) and `cli/render → mode` (to select one).
- Modes are **siblings**: `mode-platformer`, `mode-iso`, `mode-fps` share nothing but their common
  dependencies (`core`, `content`, `harness`). Common gameplay pieces, if any emerge, move _down_
  into core/harness, never sideways between modes.

## Consequences

- **Good:** the graph stays an acyclic DAG; the three mode sessions are fully independent; adding
  a fourth mode later is purely additive (implement `ModePlugin`, register it in the CLI); the
  harness's test/replay/view machinery is written once and works for all modes.
- **Cost:** anything a mode wants the harness to do must fit through `ModePlugin`; genuinely new
  needs (per-run resources, custom input bindings) require growing the interface — a deliberate,
  reviewed change, not an ad-hoc import.
- **Flagged:** `ModePlugin` and `ViewProvider` are the contracts most likely to need a v2 once
  real mode behaviour exists (see architecture.md §8). They are versioned by being small and
  central.
