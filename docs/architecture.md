# Aegis Architecture

> How the engine is put together, why the boundaries are where they are, and what happens on a
> single tick. This document is binding on all implementation sessions. Every decision here is
> backed by an ADR in [`docs/adr/`](./adr); this file is the map, the ADRs are the rationale.

Aegis inverts the mainstream engine. Instead of a GUI application with an optional scripting
layer, Aegis is a **library with a machine-readable world model** and an _optional_ renderer.
The simulation is pure, deterministic computation over plain data; pixels are an output adapter
bolted on afterwards. Everything below serves the nine principles in [`CHARTER.md`](../CHARTER.md).

## 1. Package graph

Eight packages in an npm-workspaces monorepo, wired with TypeScript project references. The
dependency graph is a strict DAG — enforced mechanically by
[`scripts/check-deps.mjs`](../scripts/check-deps.mjs) (at both the `package.json` and the
`import`-statement level) and by determinism lint rules in
[`eslint.config.js`](../eslint.config.js).

```mermaid
graph TD
  core["@aegis/core<br/>ECS · scheduler · PRNG · hash · serialise<br/>ZERO runtime deps · no DOM"]
  content["@aegis/content<br/>scene/prefab/tilemap · schema · diagnostics"]
  harness["@aegis/harness<br/>runScene · assertions · replay · semantic frame · ASCII"]
  platformer["@aegis/mode-platformer"]
  iso["@aegis/mode-iso"]
  fps["@aegis/mode-fps"]
  render["@aegis/render-three<br/>three.js adapter · browser dev server"]
  cli["@aegis/cli<br/>run · test · inspect · validate · record · replay · scaffold"]

  content --> core
  harness --> core
  harness --> content
  platformer --> core
  platformer --> content
  platformer --> harness
  iso --> core
  iso --> content
  iso --> harness
  fps --> core
  fps --> content
  fps --> harness
  render --> core
  render --> content
  render --> harness
  render --> platformer
  render --> iso
  render --> fps
  cli --> render
  cli --> platformer
  cli --> iso
  cli --> fps
  cli --> harness
  cli --> content
  cli --> core
```

| Package                  | Depends on                               | Responsibility                                                                                            |
| ------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@aegis/core`            | **nothing**                              | Deterministic ECS, fixed-timestep scheduler, seeded PRNG, event bus, world serialisation, query, hashing. |
| `@aegis/content`         | core                                     | Declarative scene/prefab/tilemap format, schema validation, structured diagnostics with stable codes.     |
| `@aegis/harness`         | core, content                            | Run a scene N ticks under an input script; gameplay assertions; replay; semantic frame + ASCII view.      |
| `@aegis/mode-platformer` | core, content, harness                   | 2D side-scroller: gravity, tile collision, coyote time, jump buffer, follow camera.                       |
| `@aegis/mode-iso`        | core, content, harness                   | Isometric grid world: pathfinding, click-to-move, turn/real-time movement.                                |
| `@aegis/mode-fps`        | core, content, harness                   | First-person 3D: capsule movement, mouse-look, hitscan.                                                   |
| `@aegis/render-three`    | core, content, harness, mode-\*, `three` | three.js render adapters for all modes; browser dev server. **Read-only consumer of the world.**          |
| `@aegis/cli`             | everything                               | The single command-line surface. No GUI is ever required.                                                 |

### The three load-bearing rules

1. **`core` depends on nothing.** No runtime dependencies, no DOM, no Node built-ins in its
   public path. It must run in a bare V8. This is what makes the whole engine headless and
   embeddable. (ADR-0002.)
2. **Rendering points inward, never outward.** `render-three` reads the world; the world never
   imports rendering. `core` importing `render-three` is a build-breaking violation. (ADR-0005.)
3. **Modes never depend on each other, and the harness never depends on a concrete mode.** Modes
   plug into the harness through the `ModePlugin` interface (ADR-0006), which keeps the graph
   acyclic and lets the five implementation sessions work in parallel without colliding.

## 2. Anatomy of one tick

Time is discrete and fixed. `Simulation.step()` advances the world by exactly `dt = 1 / tickRate`
seconds regardless of wall-clock (ADR-0001). Systems run once per tick, grouped into the fixed
phases in [`scheduler.ts`](../packages/core/src/scheduler.ts) — always in this order:

```
input → preUpdate → update → physics → postUpdate → events → cleanup
```

Within a phase, systems are ordered topologically by their `before`/`after` constraints, ties
broken by a stable insertion index — so ordering is total and deterministic.

```mermaid
sequenceDiagram
  participant H as Harness
  participant IS as InputSource (script)
  participant Sim as Simulation
  participant W as World
  participant Sys as Systems (by phase)

  H->>Sim: step()
  Sim->>IS: frameFor(tick)
  IS-->>Sim: InputFrame { actions, axes, look, pointer }
  Sim->>Sim: build TickContext { world, tick, dt, input }
  loop phases in fixed order
    Sim->>Sys: run(ctx)
    Sys->>W: spawn / mutate components / emit events
  end
  Sim->>W: tick += 1, swap event buffers
  Note over Sim,W: state is now fully determined by (scene, script, seed, tick)
```

Key invariants of the loop:

- **The only inputs to a tick are the world, the tick number, `dt`, and the `InputFrame`.** No
  system may read a clock or an unseeded RNG. Randomness comes from the world's seeded PRNG
  (`core/prng.ts`); "time" is the integer tick and the fixed `dt`. Enforced by lint.
- **Iteration order is deterministic.** Component storage is a sparse set iterated in ascending
  entity-index order (ADR-0002), so every system visits entities in the same order every run.
- **Events are double-buffered.** Systems emit into a write buffer during the tick; the
  `events` phase reads the buffer filled earlier this tick; `cleanup` swaps. No event ordering
  depends on listener registration time.

## 3. Simulation ⇄ rendering decoupling

The simulation produces two completely different "views", and neither is required for it to run:

- **The semantic frame** (`harness/view.ts`) — a structured description of what the camera would
  show: every visible entity with its world position, projected screen position, depth, layer,
  occlusion and a glyph. Plus the **ASCII view** for 2D modes. This is how an agent "sees" the
  game with no GPU (principle 7). It is derived purely from world state, so it is deterministic
  and diffable.
- **The three.js render** (`render-three`) — the human's pretty pixels. The adapter reads
  `Transform` + appearance components (`Sprite`/`Model`/`Light`) and the active mode's camera
  rig, and mirrors them into a three.js scene once per displayed frame. It **never writes back**.

Both are _projections_ produced by a mode's `ViewProvider`; the difference is only the target
(structured data / character grid vs. GPU). Because the projection is mode-specific
(orthographic side-on, isometric, perspective) it lives in the mode package, while the shared
frame types live in the harness that orchestrates them.

```mermaid
graph LR
  W[World state<br/>Transform, Sprite, Model, Light, camera rig] --> VP{ViewProvider<br/>per mode}
  VP -->|semanticFrame| SF[SemanticFrame<br/>structured JSON]
  VP -->|asciiView| AV[AsciiView<br/>character grid]
  W --> RA[RenderAdapter<br/>render-three]
  RA --> GPU[three.js scene → canvas]
  SF -.read by.-> Agent[agent / assertions / CLI]
  AV -.read by.-> Agent
  GPU -.watched by.-> Human
```

## 4. Content: loading and validation

Scenes, prefabs and tilemaps are **canonical JSON** documents (ADR-0003) tagged with a schema
discriminator (`"aegis": "scene/1"`). The flow from file to running world:

```mermaid
graph LR
  file[".scene.json / .prefab.json / .tilemap.json"] --> parse[parse JSON]
  parse --> validate["validate against ComponentRegistry<br/>(structured diagnostics, stable codes)"]
  validate -->|ok| build[instantiate entities + components into World]
  validate -->|errors| diag["Diagnostic[] { code, severity, path, message, fix }"]
  build --> world[(World)]
```

- **Authoring** uses either raw JSON (diffable, tool-agnostic) or the typed `createSceneBuilder`
  builder (`content/builder.ts`) for type-safety and autocompletion — both emit the same document.
- **Validation is schema-driven and happens before anything runs** (principle 8):
  `parseScene` → `validateScene` → `instantiateScene` (`content/load.ts`). Every diagnostic
  diagnostic carries a stable `code` (e.g. `AEGIS_SCENE_UNKNOWN_COMPONENT`), a source `path`, a
  human message, and where possible a suggested `fix`. `Validated<T>` (`core/diagnostics.ts`) is
  the `{ value?, diagnostics }` envelope every validating API returns.
- **Component identity is a stable string** (`"Transform"`, `"Velocity"`), never a GUID
  (principle 1). The `ComponentRegistry` maps ids → `ComponentType`; core, content-visual and the
  active mode contribute their component sets before a scene loads.
- **Tilemaps store their grid as ASCII rows** with a glyph legend, so a level is human-readable
  and diffs line-by-line.

## 5. Threading and timing model

**Single-threaded and synchronous, by design.** The tick loop contains no `async`, no
`await`, no timers, no worker messages — introducing any of them would make tick order depend on
the event loop and destroy determinism (ADR-0001, principle 3).

- **Fixed timestep only.** `dt` is a constant `1 / tickRate` for the whole run. There is no
  variable-delta update and no wall-clock accumulator inside the simulation. Wall-clock pacing
  (running at 60 fps for a human) is the concern of the _outer_ loop — the dev server or a future
  real-time host — and is strictly a presentation detail layered on top of `step()`.
- **Async lives only at the edges.** `runScene(path, …)` is `async` solely because it may read a
  scene file from disk; once loaded, stepping is synchronous. The dev server is async because it
  binds a socket. The core simulation is a pure function of `(scene, script, seed, ticks)`.
- **No shared mutable global state.** All state lives in the `World`. Two simulations can run in
  the same process (or the same test file) without interfering, which is what lets Vitest run
  package suites in parallel.

## 6. How an agent uses all of this

The end-to-end authoring loop, entirely in text, via `@aegis/cli` (principle 9):

```
aegis scaffold scene level-1 --mode platformer   # generate a starting document
aegis validate levels/level-1.scene.json         # schema-check before running
aegis run levels/level-1.scene.json --ticks 240 --input play.input --ascii
aegis inspect levels/level-1.scene.json --tick 90 --view frame --query "has:Player"
aegis test                                        # run headless gameplay tests
aegis record … --out run.replay && aegis replay run.replay --verify   # prove determinism
```

The **input script** (`play.input`, ADR-0004) is the agent's hands; the **semantic frame / ASCII
view** are its eyes; the **assertion API** (§7) is how it knows it succeeded.

## 7. The assertion API — designed backwards from the ideal test

Principle 6 says gameplay is verified by assertions, not eyeballs. We designed the whole harness
by first writing the test we wanted to read, then building the contracts to make it real. This is
that test:

```ts
import { defineGameTest, expectSim } from '@aegis/harness';
import { platformerPlugin } from '@aegis/mode-platformer';
import { Transform } from '@aegis/core';

export default defineGameTest({
  name: 'player clears the gap and reaches the goal',
  scene: 'games/platformer/levels/1-1.scene.json',
  options: { plugin: platformerPlugin },
  ticks: 240,
  seed: 'poc-1',
  input: `
    hold Right 0..240      # run right the whole time
    press Jump @88         # jump the first gap
    press Jump @150        # jump onto the goal platform
  `,
  expect(result) {
    expectSim(result)
      .eventEmitted('level.completed', 1) // it actually finished, exactly once
      .eventNotEmitted('player.died') // and didn't die on the way
      .entityExists({ has: ['Player'] })
      .holds(
        'player ended past the goal line',
        (r) =>
          r
            .query({ has: ['Player', 'Transform'] })
            .one()
            .get(Transform).position.x >= 128,
      )
      .hashEquals(result.hash); // pin the golden state hash

    // A property that must hold on *every* tick, not just the last:
    result.assertInvariant(
      'never fell out of the world',
      (w) =>
        w
          .query({ has: ['Player', 'Transform'] })
          .one()
          .get(Transform).position.y > -5,
    );
  },
});
```

Why it reads well, and what each piece buys the agent:

- **`defineGameTest`** is a plain data literal — discoverable by `aegis test` _and_ runnable
  under Vitest, with no runner lock-in (`harness/assert.ts`). The scene, the ticks, the seed and
  the input script are all right there, diffable.
- **The input is the DSL** (ADR-0004): the test says, in words an agent wrote, exactly what was
  "played". Change a number, re-run, watch the assertion flip.
- **`expectSim(result)`** is a fluent chain of _gameplay_ assertions over the final world and the
  recorded event log — "did the level complete?", "is the player alive?", "where did it end up?".
- **`assertInvariant`** expresses safety properties across the whole timeline (requires
  `captureHistory`), while `Invariant`s passed to `runScene` fail _live_ at the first offending
  tick with an `InvariantError` naming the tick — so a broken jump points at _when_ it broke.
- **`hashEquals`** turns determinism into a one-line regression test: the golden hash is a byte
  for the entire final world state (ADR-0001).

The object all of this reads from is `SimResult` (`harness/run.ts`): `world`, `hash`,
per-tick `tickHashes`, the `events` reader, `query(...)`, `frame(tick)`, `ascii(tick)`,
`at(tick)`, and `recording()`/`replay()`.

## 8. Contracts most likely to be renegotiated

Flagged here and to the PM because five sessions build against them in parallel:

- **`ModePlugin`** (`harness/plugin.ts`) — the mode ⇄ harness seam. If a mode needs to contribute
  something beyond `components() / systems() / view()` (e.g. per-run resources or a custom input
  binding), this interface grows first.
- **`ViewProvider` / `SemanticFrame`** (`harness/view.ts`) — the fps semantic frame is the least
  certain: `bounds`, `visibleFraction` and `occluded` may need refinement once real perspective
  projection exists.
- **`SimResult`** (`harness/run.ts`) — the surface every test reads. Additions are cheap;
  renames are expensive. Confirm shape before the game-dev sessions start.

## 9. Where the ADRs live

| ADR                                                 | Decision                                              |
| --------------------------------------------------- | ----------------------------------------------------- |
| [0001](./adr/0001-determinism-strategy.md)          | float64 + controlled op order + owned transcendentals |
| [0002](./adr/0002-ecs-storage.md)                   | Sparse-set ECS, entity = index + generation           |
| [0003](./adr/0003-scene-format.md)                  | Canonical JSON scenes + typed builder                 |
| [0004](./adr/0004-input-scripting-format.md)        | Line-oriented input DSL → per-tick frames             |
| [0005](./adr/0005-rendering-adapter-boundary.md)    | Rendering is an inward-pointing read-only adapter     |
| [0006](./adr/0006-mode-module-boundary.md)          | Modes plug in via `ModePlugin`                        |
| [0007](./adr/0007-semantic-frame-and-ascii-view.md) | The two text views of the world                       |
| [0008](./adr/0008-assertion-api.md)                 | Gameplay assertions designed from the ideal test      |
