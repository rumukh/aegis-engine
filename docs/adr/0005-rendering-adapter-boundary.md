# ADR-0005: Rendering adapter boundary

- **Status:** Accepted
- **Principle:** CHARTER §3.2 (headless-first), §5 (anti-goals: not competing on graphics).

## Context

Rendering must be genuinely optional: the full simulation runs in Node with no GPU, no window,
no browser, and does not know a renderer exists (principle 2). At the same time we do want pretty
pixels for humans, via a battle-tested library (three.js) rather than bespoke shaders. The risk
is the usual one: rendering concerns leak into the simulation (a `Sprite` grows a `THREE.Mesh`
handle; a system reaches for the canvas), and suddenly core can't run headless.

## Decision

**Rendering is a one-way, read-only adapter that depends inward on the world and is never
depended upon.**

- The dependency arrow points **only inward**: `@aegis/render-three` imports `core`, `content`,
  `harness` and the modes plus `three`. **Nothing imports `render-three` except `@aegis/cli`**,
  and `core` imports nothing. Enforced by [`scripts/check-deps.mjs`](../../scripts/check-deps.mjs)
  — a `core → render-three` import fails the build.
- The adapter (`render-three/adapter.ts`) exposes `mount(world)` then `sync(world)` per displayed
  frame. It **reads** `Transform` and the declarative appearance components
  (`Sprite`/`Model`/`Light` from `@aegis/content`) plus the active mode's camera rig, and mirrors
  them into a `THREE.Scene`. It **never writes to the world**.
- **Appearance is content, not simulation.** Visual components live in `@aegis/content` and are
  ignored by a headless run; they exist purely for the adapter to consume. The simulation's
  output is world state; the renderer is one consumer of it, the semantic frame (ADR-0007) is
  another.
- three.js is confined to this one package. It is the only package allowed a third-party runtime
  dependency (besides node types in the CLI).

## Consequences

- **Good:** core stays a bare-V8 library; two independent "views" (GPU pixels, semantic frame)
  are produced from the same immutable world; swapping renderers (or dropping rendering entirely
  in CI) changes nothing in the simulation; graphics work can't accidentally break determinism.
- **Cost:** the adapter must reconcile three.js object lifetimes against entity spawn/despawn each
  `sync` — real work, but isolated and non-deterministic-safe because it never feeds back.
- **Constraint for implementers:** if the renderer needs data, it is added as a **content**
  component the sim ignores, or read from world state — never by having the sim import or call
  rendering. A DOM/`three` type must never appear in a sim package's public API.
