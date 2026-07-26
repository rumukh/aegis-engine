# Aegis proof-of-concept games

Three small, completable games — one per engine mode. Each is both a **playable slice** and, more
importantly, a **stress test of its mode**: it is deliberately built to exercise the parts of the
engine most likely to be subtly broken, so that if the engine regresses, one of these games fails
loudly and specifically (a named invariant at a named tick).

Every game obeys the charter's principles: text-authored (canonical JSON scenes + ASCII-grid
tilemaps, ADR-0003), driven by a text input script (ADR-0004), and **verified without pixels** —
by assertions over emitted events and world state (ADR-0008), never by looking at a screen. All
gameplay is deterministic; the only randomness allowed is the engine's seeded PRNG, and enemy
behaviour is a pure function of the tick.

| Doc                                | Mode         | Game                 | Length             | The hard thing it proves                                                                                                                                                     |
| ---------------------------------- | ------------ | -------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`platformer.md`](./platformer.md) | `platformer` | **Coyote Gap**       | ~360 ticks (~6 s)  | Gravity, tile collision, coyote/buffer timing windows, **moving-platform (non-static) collision**                                                                            |
| [`iso.md`](./iso.md)               | `iso`        | **The Server Vault** | ~900 ticks (~15 s) | Grid **pathfinding**, click-to-move, **dynamic repath** on a mutated grid, deterministic patrol + detection, **real-time cooldown combat** (`enemy.killed` + `damage.taken`) |
| [`fps.md`](./fps.md)               | `fps`        | **Sector Breach**    | ~560 ticks (~9 s)  | Look-**steered raycasting/hitscan**, capsule movement, **3D gravity + jump**, `Health` damage                                                                                |

## Why these three cover the engine's surface

The three modes divide the engine's spatial and simulation surface into three non-overlapping
regions, and each game is chosen to push on the region its mode owns — not on things any mode could
do.

- **Platformer → continuous 2D physics + timing feel.** The unique risks here are _analog_: sub-tick
  gravity integration, AABB-vs-tile resolution, and the grace windows (coyote time, jump buffering)
  that make a platformer feel right and are trivial to get subtly wrong. Coyote Gap forces each one
  with a dedicated beat, plus a moving platform to prove collision against geometry that isn't the
  static tilemap.

- **Iso → discrete grid reasoning + pathfinding + grid tactics.** The unique risks here are
  _combinatorial_: finding a route through a maze, re-finding it when the grid changes (a door
  opens), reporting "no path" honestly, and running a second actor deterministically alongside the
  player. The Server Vault needs a real A*/BFS (a straight-line mover cannot solve it), mutates the
  passability grid mid-mission, and makes success depend on timing against a clockwork guard — which,
  when it spots the operative, becomes a hostile that must be **defeated in real-time cooldown combat**
  (attack range in cells, per-hit damage, return fire against a shared `Health` pool).

- **FPS → 3D orientation + rays.** The unique risks here are _directional and volumetric_: turning
  the camera and having a hitscan ray actually follow the look vector, moving a capsule through
  extruded 3D geometry, gravity/jumping in three dimensions, and applying damage from a ray. Sector
  Breach makes the door depend on a look-steered shot, the progress depend on a 3D jump, and the
  firefight depend on hitscan damage against `Health`.

Between them they exercise: the ECS + fixed-timestep scheduler, seeded determinism (each game pins a
golden `hashEquals` **and** a golden digest of its per-tick hash timeline), the content loader (three
scene + tilemap documents), the input DSL (digital actions, analog axes, `look`/`aim`, and `click`
pointer input — all three input families), the event bus (each game asserts on named events,
including a deliberate loss), the assertion harness (`expectSim` + whole-timeline `assertInvariant`),
and all three `ViewProvider` projections (orthographic, isometric, perspective).

## The shared design rules

1. **Small.** One level / one mission each, completable in 1–2 minutes of _simulated_ time (a few
   hundred to ~900 ticks). We are proving the engine, not shipping a game.
2. **Text-only assets.** Geometry is tiles/grids/extruded floorplans; appearance is a glyph, a
   colour and a primitive. No sprite sheets, models or audio.
3. **Observable outcomes.** Mechanics are designed to emit _assertable_ events (`level.completed`,
   `enemy.killed`, `damage.taken`, `mission.completed`, `door.opened`, `player.died`, …) and to move
   world state that assertions can read — never a purely visual "feel".
4. **Deterministic AI.** Every enemy/guard is a pure function of the tick; no `Math.random`, only
   `@aegis/core`'s seeded PRNG if randomness is ever needed (none of these games needs it).
5. **Each game ships three artifacts that prove it:** a scripted playthrough (`*.input`) that
   completes it headlessly, a `defineGameTest` block whose assertions — including at least one
   whole-timeline invariant and a golden **trajectory** digest — would fail if the game (or the
   engine under it) broke, and at least one **negative playthrough** that deliberately loses, so
   `eventNotEmitted('player.died')` in the winning run is not a vacuous assertion.

## Running a game from the CLI

Each game directory carries an `aegis.json` naming its composed plugin:

```json
{ "plugin": "./dist/server-vault.js#serverVaultPlugin" }
```

This closes a trap. Without it, `aegis run games/iso/levels/server-vault.scene.json` exits **0**
with an empty event log: the scene validates perfectly against the stock `isoPlugin`, and because
`Operative`/`Guard`/`Patrol` are tags, no component check can detect that the game layer never ran.
With the file present the CLI resolves the right plugin by default rather than by the user
remembering a flag. The three declarations are:

| Game               | `aegis.json` `plugin`                      |
| ------------------ | ------------------------------------------ |
| `games/platformer` | `./dist/index.js#coyoteGapPlugin`          |
| `games/iso`        | `./dist/server-vault.js#serverVaultPlugin` |
| `games/fps`        | `./dist/index.js#sectorBreachPlugin`       |

## Five rules learned from the mode-capability audit

An independent audit ran ~60 source mutations and found that 7 of 12 named mode capabilities could
be broken with all three game tests green. The structural causes are worth stating once, here,
because they apply to any future game in this repo:

1. **A final-state hash is nearly blind to dynamics.** All three runs deliberately end _at rest_ —
   actor parked, velocities zero, orders resolved — so a regression whose trajectory differs but
   whose resting state converges is invisible to `hashEquals`. Demonstrated on iso: making both
   combatants' cooldowns tick twice as fast left `damage.taken ×2`, `Health 20` **and** the golden
   hash byte-identical. Each game therefore also pins a digest of the whole per-tick hash timeline
   (`hashString(tickHashes.join('|'))`). Comparing `tickHashes` run-to-run — which the suites
   already did — proves determinism but adds **zero** regression detection.
2. **A negative assertion about an event nothing ever emits proves nothing.** `eventNotEmitted` on
   `player.died` passed in all three games even with the emitter deleted. The fix is a second
   playthrough per game that deliberately loses and asserts the death _with its cause_.
3. **A capability that fails only via hash drift is not covered.** "The golden hash moved" tells an
   agent that the world diverged and nothing about where or why — the least actionable diagnostic
   the engine can produce (CHARTER principle 8). Every capability in the "what this game proves"
   tables must fail through a **named** assertion; the trajectory digest is the safety net beneath
   them, not the diagnosis. Where the winning run does not naturally exercise a mechanism (fps
   never touches a wall, so capsule collision and sliding were invisible), add a small **probe
   playthrough** that does, rather than settling for the hash.
4. **"The dead thing stops participating" has as many facets as there are systems touching it.**
   A check aimed at one facet goes green on every other. A corpse that stops responding to input
   but keeps accumulating gravity is still broken; so is one that stops moving but still completes
   the level. Assert **each** facet, and assert it **over a window of ticks** — a single-tick check
   passes on a body that merely happens to be momentarily stationary. `docs/games/platformer.md`
   carries the worked enumeration, system by system, with the owner of each.
5. **Be as deliberate about what a losing run _reports_ as about what it asserts.** The renderer
   session found the dead-player defect only because its capture reported dead-entity counts
   instead of silently photographing a lost run — the first screenshot showed a corpse standing on
   a plateau looking perfectly healthy. Prefer assertions whose failure message names the thing
   (`entityCount({ has: ['Player', 'Dead'] }, 1)` prints the matched entities; a bare `holds` prints
   only its label), and put the measured numbers in the label.

## Deliberately _not_ covered

These are conscious scope cuts, called out so nobody mistakes them for gaps in the games:

- **No turn-based / initiative combat.** The iso mission is a _real-time-with-cooldown_ fight
  (authentic to Dragon Age: Origins, half our stated iso reference), **not** a turn/action-point
  system. True turn-based initiative (Fallout-style) is **deferred to v2** and will be recorded in a
  PM ADR, so `mode-iso` carries a single movement model in v1.
- **No multi-level / progression.** One level per mode. No save/load of progress, no hub, no menus.
- **No physics beyond the mode's model.** No ragdolls, no continuous collision, no rigid-body
  stacking (charter anti-goal). Platformer collision is AABB-vs-tile (+ one kinematic platform);
  fps is capsule-vs-extruded-floorplan.
- **No networking, no economy, no inventory.** Out of charter scope.
- **No audio, no particles, no shaders.** Appearance is intentionally crude (principle: the
  renderer is a thin adapter).

## Engine capabilities these designs assume — resolved with the PM

Each game doc has a "what it proves" table; collectively they assume the engine can do everything in
those tables. Three assumptions went beyond the originally-shipped component surface and were
escalated to the PM. **All three were accepted and folded into engine scope**, along with two smaller
shared-vocabulary gaps — recorded here as an index (details live in each doc):

1. **Platformer — kinematic moving platforms** → **mode-owned.** `mode-platformer` provides kinematic
   solids that carry a rider (`platformer.md`); the game no longer hand-rolls carry logic. Being
   carried by a moving solid is core platformer vocabulary, so the mode owns it.
2. **Iso — grid combat** → **added.** `mode-iso` gains a real-time-with-cooldown attack contract
   (attack range in cells, per-hit damage, cooldown, return fire) so the Server Vault guard can be
   engaged and defeated (`iso.md`). This satisfies charter §4.3's Definition of Done ("defeated the
   enemy, took the correct damage"). Turn-based initiative is deferred to v2 (see _not covered_).
3. **FPS — 3D geometry authoring + ray/collision against it** → **confirmed + extended.** `mode-fps`
   builds capsule collision **and** resolves hitscan rays against a **top-down tilemap floorplan
   extruded to walls** (plus entities), with an **optional per-tile floor/ceiling height** so pits and
   verticality stay text-authorable (`fps.md`). Hand-placed 3D brushes were rejected (they violate
   principle 1 — text is the substrate).

Two smaller gaps were also accepted into `@aegis/content` as shared vocabulary, so the games stop
copy-pasting per-game systems:

- **Shared `Health`** — moved from `mode-fps` into `@aegis/content` alongside damage/death events, so
  iso and fps (and any future mode) share one HP pool. The platformer expresses one-hit death as
  `Health { current: 1 }` rather than a bespoke mechanic.
- **Shared `Trigger`/volume component** — a generic goal/hazard/switch/exit detection volume in
  `@aegis/content`. All three games route goal, hazard and switch detection through it instead of a
  hand-rolled per-game proximity system.
