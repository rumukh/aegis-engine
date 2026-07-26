# ADR-0008: Assertion API

- **Status:** Accepted
- **Principle:** CHARTER §3.6 — "Verification without pixels."

## Context

The headline feature is proving a game works _without looking at it_ (principle 6): run scene X
for N ticks with input script Y, then assert on world state, emitted events and invariants. The
Definition of Done requires each PoC to complete a scripted playthrough headlessly in CI and
assert on gameplay outcomes. The API an agent writes these tests in is therefore a product
surface, not an internal helper — it has to read beautifully and run both under a test runner and
under `aegis test` with no runner at all.

## Decision

**Design backwards from the ideal test** (written out in full in
[architecture.md §7](../architecture.md)). Working back from it yields these contracts:

- **`GameTest` + `defineGameTest`** (`harness/assert.ts`) — a plain declarative literal: `name`,
  `scene`, `plugin`, `ticks`, `seed`, `input` (DSL text), and an `expect(result)` callback. Being
  data, it is discoverable by `aegis test` and equally runnable inside a Vitest `it(...)`. No
  runner lock-in.
- **`runScene(scene, options): Promise<SimResult>`** (`harness/run.ts`) — steps the simulation
  deterministically and returns the single object tests read. `SimResult` exposes `world`, `hash`,
  per-tick `tickHashes`, an `events` reader, `query(...)`, `frame(tick)`, `ascii(tick)`,
  `at(tick)`, and `recording()`/`replay()`.
- **`expectSim(result)`** — a fluent chain of _gameplay_ assertions that throw
  `GameAssertionError` on failure (runner-agnostic): `entityExists`, `entityCount`,
  `eventEmitted(type, times?)`, `eventNotEmitted`, `hashEquals`, and an escape-hatch
  `holds(label, predicate)`.
- **Two tiers of invariants:**
  - **Live** — `Invariant`s passed to `runScene` are checked _every tick_ and throw
    `InvariantError` naming the failing tick, so a broken jump points at _when_ it broke.
  - **Post-hoc** — `SimResult.assertInvariant(name, check)` asserts a property held on every
    captured tick (requires `captureHistory`).
- **Determinism as a one-liner:** `hashEquals(goldenHash)` turns the byte-identical state hash
  (ADR-0001) into a regression test; `SimResult.replay()` re-runs identical inputs and must match.

## Consequences

- **Good:** tests read like a description of play ("hold Right, jump at 88, assert level
  completed"); the same literal powers CI (`aegis test`) and local Vitest; failures are specific
  (which invariant, which tick, expected vs actual hash); event- and state-based assertions cover
  the "did the jump actually happen" question pixels can't.
- **Cost:** the harness must record the event log and (optionally) per-tick snapshots/hashes —
  memory vs. fidelity is a per-run option (`recordEvents`, `captureHistory`, `captureTickHashes`).
- **Flagged:** `SimResult` is the surface every game-dev session reads; additions are cheap but
  renames are expensive, so its shape is pinned now (architecture.md §8).
