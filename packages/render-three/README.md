# @aegis/render-three

The optional visual adapter. Everything else in this engine is built so an agent can work without
pixels; this package is the one place pixels matter, and it must not compromise any of that.

> **The rule:** the simulation must not know this package exists. Rendering reads world state; it
> never writes to it, never advances it, never influences it. `noninterference.test.ts` proves it
> per tick, for all three modes.

## Play the three PoC games

```
npm install
npm run build
node poc/play.mjs
```

Then open <http://127.0.0.1:5173> and pick a game. Flags: `--port <n>`, `--host <iface>`.

| Game                                | Mode       | How you play it                                                                                                                                                                 |
| ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Coyote Gap** (`/play/platformer`) | platformer | `A`/`D` or `←`/`→` run (axis `MoveX`), `Space`/`W`/`↑` jump. Coyote time and jump buffering apply, so tapping jump while running chains maximum-distance hops.                  |
| **The Server Vault** (`/play/iso`)  | iso        | Left-click a floor cell to path there (A\*); left-click the guard to attack-move.                                                                                               |
| **Sector Breach** (`/play/fps`)     | fps        | `W`/`S` forward/back (axis `Forward`), `A`/`D` strafe (axis `Strafe`), `Space` jump, mouse look (click the canvas to capture the pointer), left click fires the hitscan weapon. |

Every game also takes `P` (pause/resume), `.` (single-step one tick while paused) and `R`
(restart at tick 0).

## Screenshots

`node poc/capture.mjs` plays all three games in a real browser with real key and
mouse events and writes `screenshots/{platformer,iso,fps}.png`. It speaks the Chrome DevTools
Protocol over Node's built-in `WebSocket`, so it needs no extra dependency — just Chrome or Edge.
Add `--headed` to watch it happen.

Two properties it is built around, both learned by getting them wrong first:

**It replays the game's own `.input` script.** Not hand-written key timings — the same file the
game's acceptance test runs, compiled to browser events by `script-input.ts` through the same
binding table a human's keyboard goes through. The earlier version carried canned timings, and
when the platformer's lava ferry was restored they silently began running the player into a gap.
They were never stable anyway: hand-tuned wall-clock sleeps race the browser's frame pacing, and
the same commit died in **two runs out of three**.

> An enumerated fix is only as good as the enumeration. There is now no enumeration to be wrong
> about, because the source of truth is the file the tests already prove.

The replay is exact rather than hopeful: the session is paused and stepped explicitly, and
`aegis.sync()` guarantees each segment's input has reached the server _before_ the ticks it
applies to are simulated. The live input path is untouched — key and mouse events go through the
page's collector, the binding table, an HTTP packet and `LiveInput` exactly as a human's do. Only
the trigger for advancing time differs, and the accumulator that normally provides it has its own
tests (`loop.test.ts`, `session.test.ts`).

**It refuses to ship a failed playthrough.** The previous version counted dead entities and
printed them — and then wrote the PNG anyway, so a screenshot of a corpse falling out of the world
became the committed evidence that the game is playable. Reporting a problem is not the same as
declining to ship it. A capture now fails if the game's win event was never emitted or the player
ended up dead; the PNG is still written, because a failed frame is the most useful thing to look
at, but it no longer passes for success.

The frame kept is the one at a named event's tick — the win, or something more legible if a game
wins somewhere dull (Sector Breach's exit is a dead-end wall, so it photographs the firefight).
Only the event _name_ is a choice; the tick comes out of the run's own event log.

None of this is trusted on the strength of a screenshot: `script-input.test.ts` compiles a script
to browser events, replays them back through the real `LiveInput`, and asserts the resulting
simulation reaches **the same state hash** as the script itself — headlessly, in `npm run verify`.

## How it fits together

```
Node (dev-server process)                    Browser page
  scene JSON ─▶ World                          import map ─▶ three, @aegis/core,
  composed game plugin ─▶ Schedule                           @aegis/content, @aegis/mode-*
  fixed-step accumulator (wall clock)          POST /frame {input} ─▶ {tick, snapshot, events}
  live InputSource fed by the page             createWorld().restore(snapshot)   ← a *copy*
  world.snapshot() per frame                   RenderAdapter.sync(copy) ─▶ THREE.Scene
```

- The simulation runs in Node on a **fixed** timestep. Wall-clock enters in exactly one place —
  `loop.ts`, the accumulator — which converts real time into a whole number of `1 / tickRate`
  steps. The simulation never sees a variable `dt`, so a played session and a scripted headless
  run of the same input produce the same state hash (`session.test.ts`).
- The page renders a `WorldSnapshot` — plain JSON, exactly what CHARTER principle 4 promises — by
  restoring it into a throwaway `World`. The renderer therefore holds a _different_ world from the
  simulation and is structurally unable to write to it.
- Live input is mapped through `bindings.ts` onto the same logical actions, axes, look deltas and
  pointer samples the `.input` DSL compiles to. A human and a script reach the simulation through
  one identical door.
- There is **no bundler**. Every `@aegis/*` package except the harness is free of Node built-ins
  and is emitted as plain ESM with explicit `.js` extensions, so the page resolves them with an
  import map against the built `dist/` folders. three.js remains the only third-party runtime
  dependency (ADR-0005).

## What each adapter draws

All of it is read straight from world state; appearance components (`Sprite`/`Model`/`Light` from
`@aegis/content`) are honoured when authored, and a role palette (`appearance.ts`) fills in when
they are not. Crude on purpose — legibility over beauty (CHARTER §5).

| Mode       | Camera                                                                                                                      | Geometry                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| platformer | orthographic side-on, from the `PlatformerCamera` rig (`viewHeight` is the zoom)                                            | the baked `PlatformerCollision` tilemap as solid blocks and low red hazard blocks; the player sized from its `TileCollider` with a facing pip from `BodyState.facing`; other damageable bodies; `KinematicPlatform` solids; translucent goal/hazard `Trigger` volumes                                                                                             |
| iso        | orthographic at the classic 2:1 isometric elevation, following `IsoCamera.target`                                           | the baked `NavGrid` as floor plates and wall columns; actors on their `GridPosition`, interpolated along the resolved path by `progress`, with camera-facing health bars; the `Blocking` door (which vanishes when the switch removes the tag); switch/exit trigger pads                                                                                          |
| fps        | perspective at `Transform.position + FpsCamera.eyeHeight`, oriented by `LookState` through the mode's own `forwardFromLook` | every solid `FPS_COLLISION` cell extruded from its `floor` to its `ceil` (door cells in orange, and they disappear when the game clears `solid`); a ground slab at each walkable cell's own floor height, which is what makes the coolant pit a hole; a dim ceiling; `HitBox` entities drawn exactly where the hitscan resolves them; translucent trigger volumes |

## Layout

| File                                       | Purpose                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `adapter.ts`                               | the `RenderAdapter` contract, keyed `Object3D` reconciliation, scene/camera helpers |
| `adapters/{platformer,iso,fps}.ts`         | one adapter per mode; `adapters/index.ts` selects by mode                           |
| `appearance.ts`, `primitives.ts`           | role palette + authored appearance, shared geometry/materials                       |
| `loop.ts`                                  | the fixed-timestep accumulator — the only wall-clock read in the package            |
| `live-input.ts`, `bindings.ts`             | browser reports ➜ `InputFrame`s, and the key/mouse binding table                    |
| `script-input.ts`                          | a game's `.input` script ➜ browser events, and back again for the round-trip test   |
| `session.ts`                               | world + schedule + live input, steppable in real time                               |
| `catalog.ts`                               | `GameDefinition` and scene loading — game-agnostic; the caller supplies the entries |
| `dev-server.ts`, `pages.ts`, `protocol.ts` | the `node:http` server, its HTML, and the wire types                                |
| `client/`                                  | the browser entry: render loop, input capture, HUD                                  |
| `play.ts`, `capture.ts`                    | serve a catalogue, and screenshot a catalogue                                       |
| `../../poc/poc-games.mjs`                  | **the composition root**: wires the three PoC games into a catalogue                |

An adapter owns **no GPU state** — it builds a `THREE.Scene` and a `THREE.Camera` and nothing
else — so it constructs and runs headlessly in Node, which is how the non-interference proof runs
it against a live world.

## Why the game wiring lives outside `src/`

`@aegis/render-three` is _engine_. `scripts/check-deps.mjs` forbids anything under `packages/`
from importing anything under `games/` — by package name and by relative path, with a dedicated
message: _"the engine must NEVER depend on a game"_. That is the right rule, and it bites:

```
packages/render-three/src/probe.ts imports "@aegis/game-iso" which is not allowed for @aegis/render-three
packages/render-three/src/probe.ts reaches into games/ ("../../../games/iso/src/index.js")
  — the engine must NEVER depend on a game
```

So nothing under `src/` knows a game exists. `startDevServer({ games })` takes a catalogue,
`play(games)` serves one, `capture(games)` photographs one. `poc/poc-games.mjs` is the composition
root: it imports the three built game packages by ordinary bare specifier and hands the catalogue
over.

That file sits under `packages/render-three/` but outside the compiled output and outside the
package's `exports`/`files`, so it is not part of the shipped artefact. It does resolve
`@aegis/game-*` through workspace hoisting rather than a declared dependency — which check-deps
rightly refuses to let the engine declare. The durable home for this wiring is a project that is
_allowed_ to depend on both sides; an `aegis play` subcommand in `@aegis/cli` would satisfy
CHARTER principle 9. That is a PM call on the DAG.
