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

**The production goal is a new agent-first engine that can eventually support AAA games.**
The current TypeScript implementation is the reference foundation, not a permanent ceiling on
runtime scale, visual quality or production tooling. That goal is not achieved today. We advance
through measured, integrated milestones on the existing games, rather than adding speculative
native stubs or treating a prototype as a production engine. See
[`docs/production-roadmap.md`](./docs/production-roadmap.md).

## 3. Non-negotiable design principles

These nine principles are the product. Any design that violates one is wrong.

1. **Text is the authoring substrate.** Scene graphs, gameplay definitions, asset manifests and
   cooking recipes are declarative, readable and diffable. Opaque editor-owned state is not the
   source of truth. Original media and cooked runtime assets may be binary; they need provenance,
   stable IDs, inspectable metadata and reproducible processing. No GUIDs where a stable string
   id will do. Text authoring does not require a text-only runtime representation.
2. **Headless-first.** The authoritative simulation runs without a GPU, window or browser.
   Node is the current reference host; future runtime hosts must preserve headless operation.
   Rendering is an optional adapter attached to a simulation that does not know it exists.
3. **Deterministic by construction.** Fixed timestep, seeded PRNG, no `Date.now()`, no
   `Math.random()`, stable authoritative iteration order. The same scene, input, seed, tick rate
   and engine/content revision produce identical state hashes across supported machines.
   Presentation and asset IO may be asynchronous; their completion timing must never silently
   determine gameplay. Any authoritative effect enters through an explicit deterministic boundary.
4. **The world is inspectable as data.** At any tick, authoritative state has a canonical
   machine-readable snapshot and JSON observation surface. Agents can query it
   (`world.query({ has: ['Player'] })`) and diff two ticks. This does not require rebuilding or
   transmitting the entire JSON world every frame; compact storage and incremental observation
   must retain the same meaning.
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

## 4. Reference foundation and first production milestone

### 4.1 The engine

A TypeScript monorepo today: deterministic ECS core with zero runtime dependencies, plus adapters.
It is the executable reference for the engine's data and simulation contracts. Native hot paths
or a different storage backend are future, measurement-driven choices, not prerequisites for
finishing the first milestone or reasons to weaken the contracts.

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

1. **Coyote Gap**, the platformer: preserve the stomp, ferry, coyote and jump-buffer beats.
2. **Server Vault**, the isometric infiltration: preserve patrol, detection, blocked-door,
   firefight and extraction beats.
3. **Sector Breach**, the first-person slice: preserve the door shot, coolant jump, combat
   and exit/lose routes.

These existing games are the production milestone's showcases and acceptance workloads.
Upgrade their presentation, feedback and usability substantially; do not replace them with
unrelated demos. Headless gameplay assertions and actual browser presentation review are
complementary requirements, not substitutes.

### 4.3 Definition of done

- [ ] The existing complete `npm run verify` gate is green from a clean checkout with locked dependencies.
- [ ] Every package has meaningful tests. Core sim logic is thoroughly covered.
- [ ] Determinism is *proven by test*: identical state hash across repeated runs.
- [ ] All three PoCs complete their scripted playthrough headlessly in CI, and assert on
      gameplay outcomes (reached the goal, defeated the enemy, took the correct damage).
- [ ] All three PoCs are visually playable by a human in a browser.
- [ ] Snapshot restoration, prefab hierarchies, resource declarations and replay timing have
      complete, validated contracts on headless, CLI and live paths.
- [ ] A shared declarative presentation/asset layer serves all three games in dev and static
      builds, with visible failures, bounded resource use and no simulation interference.
- [ ] Agent-facing capability discovery and bounded inspection expose actual registered
      contracts rather than requiring an agent to guess or deliberately submit invalid content.
- [ ] Runtime improvements have comparable measurements and preserve existing deterministic
      outputs; deliberate gameplay changes carry independent expectations and explained pins.
- [ ] An agent-facing guide (`AGENTS.md`) documents the full authoring loop end to end.
- [ ] CI runs the whole thing on push.

## 5. Boundaries and non-goals for the first milestone

- Not building a GUI editor. A read-only web inspector is acceptable; a mouse-driven
  authoring tool is out of scope.
- Not writing a speculative renderer or native backend merely to claim production scope.
  High-quality visuals are a real requirement; the first milestone builds them through shared
  adapters and authored assets. Later backend decisions require representative measurements.
- Not claiming networking, large-world streaming, production skeletal animation, advanced physics
  or console/platform integrations are complete. They are separately scoped later milestones,
  not permanent exclusions from the AAA-capable goal. Replay alone is not a networking contract.
- Not shipping an asset store or replacing the existing PoCs to avoid their acceptance criteria.
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

## 7. Production roadmap

| Milestone | Outcome | Advancement requires |
| --- | --- | --- |
| **M1: integrated vertical slice** | Correct shared contracts, faster reference runtime, shared presentation, agent capability tools, and substantially upgraded existing PoCs. | Integrated gate, headless win/lose routes, browser/static acceptance and measured budgets. |
| **M2: scalable runtime and content** | Versioned host boundaries, compact storage, incremental observation, cooking and streaming; native hot paths only where justified. | Representative workloads, reproducible builds and equivalence against the reference runtime. |
| **M3: production characters and worlds** | Animation, richer physics/navigation, persistence migrations, streamed worlds and VFX/audio authoring. | Agent-facing diagnostics and measurable gameplay/presentation acceptance for each subsystem. |
| **M4: production operations and platforms** | Large-project content workflows, packaging, platform integration and continuous performance/crash diagnostics. | Sustained production-scale workloads and explicit platform readiness, not feature-count claims. |

M1 is the current execution scope, not proof of AAA completeness. Its sequencing and acceptance
are specified in [`docs/production-roadmap.md`](./docs/production-roadmap.md).
