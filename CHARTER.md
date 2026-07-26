# Aegis — An Agent-First Game Engine

> Project charter. This is the single source of truth for **why** this project exists and
> **what** "done" means. Read this before doing any work. Do not change it without the PM.

## 1. The problem

Every mainstream game engine (Unity, Unreal, Godot) is built around a **GUI editor**. The
canonical workflow is: drag a thing into a viewport, click through inspector panels, wire
references by mouse, hit Play, and *look at the screen* to judge whether it worked.

That workflow is hostile to coding agents:

| GUI-first engine | Consequence for an agent |
| --- | --- |
| Scene state lives in opaque binary/YAML blobs with GUIDs | Agent cannot read or diff a scene meaningfully |
| Authoring requires mouse gestures in a viewport | Agent has no hands |
| Verification requires *looking at pixels* | Agent cannot tell if the jump felt right, or even happened |
| Play mode is wall-clock, non-deterministic | Agent cannot reproduce a bug it just saw |
| Errors surface as red text in a console panel | Agent gets no structured, actionable diagnostics |
| Engine APIs assume a live editor process | Agent cannot run anything in CI |

## 2. The thesis

**A game engine should be a library with a machine-readable world model, not an application
with a viewport.** If the world state, the inputs, and the passage of time are all plain data,
then an agent can author a game, run it, observe it, assert on it, and debug it — using only
text. Humans still get pretty pixels; they are an *output adapter*, not the substrate.

## 3. Non-negotiable design principles

These nine principles are the product. Any design that violates one is wrong.

1. **Text is the substrate.** Scenes, prefabs, tilemaps, animations, materials and level data
   are declarative, human-and-agent readable, diffable files in version control. No binary
   authoring formats. No GUIDs where a stable string id will do.
2. **Headless-first.** The full simulation runs in Node with no GPU, no window, no browser.
   Rendering is an optional adapter attached to a simulation that does not know it exists.
3. **Deterministic by construction.** Fixed timestep, seeded PRNG, no `Date.now()`, no
   `Math.random()`, stable iteration order. The same scene + same input script + same seed
   produces a byte-identical state hash, on any machine, every time.
4. **The world is inspectable as data.** At any tick, the entire world serialises to JSON.
   Agents can query it (`world.query({ has: ['Player'] })`) and diff two ticks.
5. **Input is a script.** Input is a data stream, authorable as text
   (`hold Right 0..40; press Jump @12`). Sessions record to and replay from a file.
   An agent can "play" a game without a human or a keyboard.
6. **Verification without pixels.** A first-class simulation harness lets you express
   *gameplay* assertions: run scene X for N ticks with input script Y, then assert on world
   state, emitted events, and invariants. This is how an agent knows the jump worked.
7. **Agents can "see" without a GPU.** The engine can emit a **semantic frame** — what the
   camera would show, as structured data (visible entities, screen-space positions, layer,
   occlusion) — plus a deterministic ASCII view for 2D modes. Debugging visuals in text.
8. **Diagnostics are structured.** Every error has a stable code, a source location, and a
   suggested fix. Content is validated against schemas before it ever runs.
9. **One CLI surface.** Everything an agent needs is a subcommand. No GUI is ever required
   to build, run, test, inspect or ship a game.

## 4. Scope of v1.0

### 4.1 The engine

A TypeScript monorepo. Deterministic ECS core with zero runtime dependencies, plus adapters.

Three supported **modes**, each a first-class module providing camera rig, movement,
collision and spatial conventions:

- **`platformer`** — 2D side-scroller. Gravity, tile collision, coyote time, jump buffering.
  Reference feel: *Super Mario World*, *Ori*.
- **`iso`** — isometric / 3-quarter view tactical. Grid world, pathfinding, turn or
  real-time-with-pause, click-to-move semantics expressed as data.
  Reference feel: *Fallout 2*, *Dragon Age: Origins*.
- **`fps`** — first-person 3D. Perspective camera, capsule movement, raycasting, hitscan.
  Reference feel: *Half-Life*.

### 4.2 The three proof-of-concept games

Each PoC must be a real, playable, winnable slice — not a tech demo cube.
Each must ship with a scripted playthrough that an agent can run headlessly to prove the game
is completable, and gameplay assertions that would fail if the game broke.

1. A platformer PoC.
2. An isometric PoC.
3. A first-person 3D PoC.

### 4.3 Definition of done

- [ ] `npm install && npm run build && npm test` is green from a clean clone.
- [ ] Every package has meaningful tests. Core sim logic is thoroughly covered.
- [ ] Determinism is *proven by test*: identical state hash across repeated runs.
- [ ] All three PoCs complete their scripted playthrough headlessly in CI, and assert on
      gameplay outcomes (reached the goal, defeated the enemy, took the correct damage).
- [ ] All three PoCs are visually playable by a human in a browser.
- [ ] An agent-facing guide (`AGENTS.md`) documents the full authoring loop end to end.
- [ ] CI runs the whole thing on push.

## 5. Anti-goals

- Not building a GUI editor. A read-only web inspector is acceptable; a mouse-driven
  authoring tool is out of scope.
- Not competing on graphics. Rendering is a thin adapter over a battle-tested library.
  The innovation is the agent-facing layer, not the shaders.
- Not shipping an asset store, a networking stack, or a physics engine with continuous
  collision. Keep the simulation understandable.
- No "temporary" hacks that break determinism. Determinism is the foundation everything
  else rests on.

## 6. Team model

This project is built by a fleet of Copilot sessions. One session per role, per workstream.

| Role | Responsibility |
| --- | --- |
| **PM** | Charter, sequencing, integration, acceptance. Does not write code. |
| **Architect** | System design, package boundaries, public API contracts, ADRs. |
| **Engine dev** | Core simulation, modes, renderers, CLI. |
| **Game dev** | The three PoC games, on top of the shipped engine API. |
| **QA** | Test strategy, determinism proofs, playthrough verification, bug reports. |
| **Ops** | Toolchain, build, CI, release, docs site. |

Every session works on its own branch and hands back a summary. The PM integrates.
