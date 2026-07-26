# FPS PoC — "Sector Breach"

> First-person 3D. Reference feel: _Half-Life_.
> Mode: `fps` (`@aegis/mode-fps`). Runs headless; verified without pixels via the semantic frame.

## Concept and fantasy

A 30-second Black-Mesa-style facility breach. You spawn in a sealed antechamber, **turn and shoot a
wall panel** to blow the blast door, jog down a service corridor, **hop a toxic-coolant pit**, then
gun down a lone security grunt guarding the exit before it whittles you down. It is the classic
Half-Life micro-loop — _look, shoot, move, jump, shoot_ — compressed to its smallest honest form.
Its whole reason to exist is to make the hard 3D things (look-driven raycasting, capsule-vs-geometry
movement, gravity in three dimensions, hitscan damage) observable and assertable.

## Core loop

Aim (yaw/pitch) → fire (hitscan ray) → move (WASD as `Forward`/`Strafe` axes) → jump → repeat. Every
verb produces a world-state change or an event: a fired ray hits or misses, a hit deals damage, a
jump clears a pit or drops you into it.

## Coordinate & look convention (binding for authors)

- Right-handed: **+X = east/right, +Y = up, +Z = forward/north.** Floor plane at `y = 0`; player
  eye at `y = 1.6` (`FpsCamera.eyeHeight`).
- **Yaw 0° faces +Z**; increasing yaw turns toward +X (right). Pitch 0° is level; +pitch looks up,
  clamped to `±89°`. Look uses `@aegis/core/math` deterministic trig (ADR-0001) — never `Math.sin`.
- `aim <yaw> <pitch>` sets an absolute look target (compiled to `look` deltas); `look <dyaw>
<dpitch>` is relative.

## Mechanics (design intent — implementers may tune)

Tick rate 60Hz, `dt = 1/60`.

**Player** — `CapsuleBody` + `FpsController` + `LookState` + `FpsCamera` + `Hitscan` + `Health`:

| Tunable                     | Value        | Consequence                                                   |
| --------------------------- | ------------ | ------------------------------------------------------------- |
| `FpsController.moveSpeed`   | 6 u/s        | corridor traversal pace                                       |
| `FpsController.gravity`     | 24 u/s²      | fall accel                                                    |
| `FpsController.jumpSpeed`   | 8 u/s        | apex ≈ 1.33 u high, ~40 ticks airborne, ~4 u of forward reach |
| `FpsController.maxPitchDeg` | 89           | look clamp                                                    |
| `CapsuleBody`               | r 0.4, h 1.8 | collision volume                                              |
| `Hitscan.range`             | 100 u        | ray length                                                    |
| `Hitscan.damage`            | 25           | per shot                                                      |
| `Hitscan.cooldownTicks`     | 12           | ≥12 ticks between shots (0.2 s)                               |
| `Health.current/max`        | 100          | player HP (`Health` is shared, from `@aegis/content`)         |

Derived: an 8 u/s jump under 24 u/s² gravity clears a **2–3 u pit** with margin; the coolant pit is
2 u across.

**Weapon (hitscan)** — a `WeaponSystem` (mode) casts a ray from the eye along the look direction on a
`Fire` press (respecting `cooldownRemaining`), emitting `weapon.fired`, then `hitscan.hit{target}` or
`hitscan.miss`. A hit on an entity with `Health` subtracts `damage`.

**The blast door** — the `=` cell at the corridor mouth (x=0, z=8). It is **not** a `Blocking`-tagged
entity: `mode-fps` has no `Blocking` tag. It is a legend entry `{ solid: true, door: true }`, so the
extruded `fps.collision` grid carries a cell with `door: true`. The game's `DoorSystem` listens for
`hitscan.hit` whose `target` is the `Button` panel and flips `solid` to `false` on every `door` cell,
then emits `door.opened`. Because `fps.collision` is a world **resource** it is part of the
serialised, hashed state, so an open door is deterministic simulation state rather than hidden mode
memory. (See _Level layout_ below for the same mechanism described from the floorplan side.) The
button is on the **east wall**, so the player must **yaw right ~90°** to hit it — this is the proof
that look direction actually steers the ray.

**The grunt** — a game `GruntAiSystem` (deterministic, RNG-free):

- Stands at the far end of the security room, facing −Z (toward the incoming player), `Health 50`.
- When the player is within **6 u** and roughly in front (dot-product gate) and has clear
  line-of-sight (a `raycastGrid` probe — walls block it), it fires every **90 ticks**, dealing 10
  damage → `damage.taken` on the player. Cadence is a pure function of tick, so damage totals are
  reproducible.
- Dies at `Health ≤ 0` → `enemy.killed`. Two player hits (25+25) kill it; the player takes **one**
  grunt shot (−10 → Health 90) crossing into its close-quarters engagement range.

> **Tuning note (reality, not intent):** the design's "within 15 u, every 30 ticks" made the grunt
> open fire the instant the blast door exposed line-of-sight down the whole corridor, landing ~5
> shots and dropping Health to ~50 — below the `≥ 70` invariant. Shrinking the engagement to a
> 6 u close-quarters range on a 90-tick cadence makes it a doorway guard: exactly one shot lands
> before the two-shot kill (Health 90, a 20-point margin under the invariant).

**The coolant pit** — a `hazard` `Trigger` volume (from `@aegis/content`) in the floor gap; entering
it emits `player.died` (the player fell in). Clearing it requires a jump.

**Exit** — a `Trigger` volume behind the grunt: the player enters it → `level.completed`.

> **Engine scope (per PM ruling — confirmed):** 3D level geometry is authored as a **top-down
> tilemap floorplan** (ADR-0003) that `mode-fps` extrudes — `#` cells become full-height solid
> walls, `.` is floor. Hand-placed 3D "brush" entities were rejected (they violate charter
> principle 1 — an agent must author an FPS level by typing ASCII). Per-tile **floor and ceiling
> heights** ride on each legend entry's `data` (`{ floor, ceil, door, hazard }`) rather than a
> separate parallel grid — one glyph carries both its footprint and its verticality, so the coolant
> pit is simply a `T` glyph with `floor: -3`. `mode-fps` therefore (a) builds capsule collision
> from the extruded, per-tile-height floorplan and (b) resolves `Hitscan` rays against both that
> geometry and entities (`Button`, grunt). Shared `Health` and the `Trigger`/volume component live
> in `@aegis/content`.
>
> **Implementation deviation (reality):** the heights are encoded on the legend's `data` object
> (above), not as a second numeric layer keyed to the grid — a `T` tile is `{ floor: -3, ceil: 4,
hazard: true }`, a `#` is `{ solid: true, floor: 0, ceil: 4 }`. Ceilings are **4 u**, not 3: the
> jump apex lifts the capsule's feet to ~1.33 u and the capsule is 1.8 u tall (head at ~3.13 u), so
> a 3 u ceiling would clip the player's head mid-jump.

## Level layout

Two rooms and a corridor. Authored as an extruded floorplan tilemap
(`levels/sector-breach.tilemap.json`), 11×21, `tileSize: 1`, viewed **top-down** (+Z up the page,
+X to the right). Player, button, grunt and exit trigger are scene entities placed in world space.

Legend:

```
#  wall (extruded, solid + ray-blocking)   .  floor
P  player spawn (entity, faces +Z)         B  button panel (entity, east wall of Room A)
=  blast door (Blocking wall, opens on B)  T  toxic pit (floor height < 0: fall = death)
G  grunt (entity, Health 50, faces -Z)     E  exit (Trigger volume)
```

Top-down floorplan (row 0 = z 20 = far/north; bottom row = z 0 = spawn/south):

```
   z                      x:  -5        0        +5
   20 |  # # # # # # # # # # #
      |  # . . . . E . . . . #
      |  # . . . . . . . . . #
      |  # . . . . G . . . . #      Room C — security room + exit
   16 |  # . . . . . . . . . #
      |  # # # # . . . # # # #
   14 |  # # # # . . . # # # #
      |  # # # # T T T # # # #          corridor B (coolant pit T spans z 12–13)
      |  # # # # T T T # # # #
      |  # # # # . . . # # # #
   10 |  # # # # . . . # # # #
      |  # # # # . . . # # # #
    8 |  # # # # # = # # # # #      blast door '=' fully gates the corridor mouth
      |  # # # # # . # # # # #          1-wide neck (z 6–7) below the door
      |  # # # # # . # # # # #
      |  # . . . . . . . . . #
      |  # . . . . . . . . . #
      |  # . . . . . . . . . #
    2 |  # . . . . P . . . B #      Room A — antechamber; player faces +Z, button 'B' east wall
      |  # . . . . . . . . . #
    0 |  # # # # # # # # # # #
```

The floorplan above is the tilemap's `collision` layer; per-tile heights live on each legend
entry's `data` (`{ floor, ceil, door, hazard }`): every `.`/wall tile has floor 0 / ceiling 4, the
`=` door is a solid `{ door: true }` wall until the button is hit, and the six `T` tiles carry
`{ floor: -3, hazard: true }` — a pit the player falls into if unjumped. A `hazard` `Trigger`
volume sits in the pit and a goal `Trigger` sits on `E`.

The breach reads as four beats, each proving one hard thing:

1. **Room A — shoot the panel.** Player must yaw ~+90° to face the east-wall `B`, fire a hitscan
   ray, and hit it → `door.opened`. Proves **look direction steers the raycast** and hitscan
   resolves against a specific entity.
2. **Corridor B — jump the pit.** Walk north into the 3-wide corridor; a 2-u toxic gap `T` must be
   cleared with a jump. Proves **3D gravity + jump arc + capsule-vs-floor collision**, and pit-fall
   death.
3. **Room C — the firefight.** The grunt fires on a deterministic cadence; the player must land two
   hitscan shots (25+25 ≥ 50) to kill it, taking bounded, reproducible damage in return. Proves
   **hitscan damage, `Health`, deterministic enemy AI**, and `damage.taken`.
4. **The exit.** Reaching the trigger behind the grunt → `level.completed`. Proves goal detection in
   3D.

## Win and lose conditions

- **Win:** exactly one `level.completed` event AND no `player.died` event.
- **Lose:** any `player.died` event (grunt drained `Health` to 0, or fell in the coolant pit), or
  the run ends without `level.completed`.

**The pit lose path is shipped as a playthrough.** `sector breach (lose): walk into the coolant pit
without jumping` opens the blast door, jogs north, never jumps, and stops driving Forward at the pit
(as a fallen player's input would). It asserts `player.died` ×1 with `cause: 'coolant'` at t146, a
final `position.y === -3` (resting on the pit floor), and no `level.completed`.

Without it the winning run's `eventNotEmitted('player.died')` is vacuous — it passes even with the
hazard system deleted, because nothing in the suite ever emits a death.

**A third playthrough exists purely as a collision probe.** `sector breach (probe): the capsule is
stopped by walls and slides along them` faces 45° and holds Forward into the antechamber's north-east
corner. The winning run walks straight up the middle of a 3-wide corridor and never touches a wall,
so capsule-vs-wall collision, axis-separated sliding and the capsule radius could previously only
surface as golden-hash drift. The probe pins all three **by name**:

| Assertion                                                            | Fails when                                         |
| -------------------------------------------------------------------- | -------------------------------------------------- |
| stopped by the north wall, one radius short of its face at z=5.5     | wall collision is gone, or the radius is ignored   |
| stopped by the east wall, one radius short of its face at x=4.5      | same, on the other axis                            |
| slid east along the north wall instead of sticking on first contact  | resolution stops both axes on any contact          |
| `player capsule never overlapped a solid wall cell` (whole-timeline) | the capsule clips into or tunnels through geometry |

The last one also runs as an invariant on the **winning** playthrough. It re-derives the overlap test
from the extruded grid's `solid` flags rather than calling the mode's `circleHitsSolid` — a test that
asks the collision solver whether the collision solver was right proves nothing — and reads the grid
from each tick's world snapshot, so the blast door counts as solid before it opens and passable
after.

## Events emitted

| Event             | Payload                         | Emitted by | When                                            |
| ----------------- | ------------------------------- | ---------- | ----------------------------------------------- |
| `weapon.fired`    | `{ tick }`                      | mode       | a `Fire` press launches a ray (past cooldown)   |
| `hitscan.hit`     | `{ target, distance, tick }`    | mode       | a ray hits an entity or wall                    |
| `hitscan.miss`    | `{ tick }`                      | mode       | a ray hits nothing in range                     |
| `door.opened`     | `{ name }`                      | game       | the button is hit and the blast door is removed |
| `enemy.damaged`   | `{ name, amount, remaining }`   | game       | the grunt takes a hit                           |
| `enemy.killed`    | `{ name, tick }`                | game       | the grunt's `Health` reaches 0                  |
| `damage.taken`    | `{ amount, source, remaining }` | game       | the grunt hits the player                       |
| `player.died`     | `{ cause, tick }`               | game       | player `Health` ≤ 0 or fell in the pit, once    |
| `level.completed` | `{ tick }`                      | game       | player reaches the exit trigger, once           |

## The scripted playthrough

`play/sector-breach.input` (ADR-0004 DSL). Uses `aim` (absolute look), `Fire`, the `Forward` axis
and `Jump`. The frames below are the **tuned, real** script (the test reads this exact file, so the
script and the assertions can never drift apart). The run resolves `level.completed` at ~tick 240;
the test runs **600 ticks** to leave a wide post-completion tail for the whole-timeline invariants.

```text
# Sector Breach — scripted playthrough (deterministic, tick-addressed).

# 0. Wall-occlusion proof. We spawn facing +Z with the grunt dead ahead at z=17 and nothing but
#    the sealed blast door between us. The ray must stop at that door (hitscan.hit target "wall",
#    distance 5.5), never reach the grunt.
press Fire @4

# 1. Face the east wall panel and shoot it to open the blast door.
aim 90 0 @8
press Fire @20

# 2. Face north (into the facility) and advance out of the start room.
aim 0 0 @32
axis Forward 1 40..124

# 2b. Vertical-aim proof: nose down 40 degrees and fire straight up the corridor. Level, this shot
#     would hit the grunt; pitched down it passes under its hitbox and misses.
aim 0 -40 @96
press Fire @100
aim 0 0 @108

# 3. Leap the coolant pit — take off just before its south lip.
press Jump @124
axis Forward 1 124..170

# 4. Hold at the mouth of the north room and put two rounds into the grunt.
press Fire @176
press Fire @192

# 5. Advance to the extraction door.
axis Forward 1 210..320
```

Notes for the implementer:

- The `aim 90 0` / `aim 0 0` pair is the look-drives-the-ray proof; if yaw fails to steer the
  hitscan, the button shot misses, the door never opens, and the run cannot progress — a loud
  failure.
- **Beats 0 and 2b exist to make `raycastGrid` load-bearing.** Before they were added, the entire
  DDA could `return undefined` unconditionally and Sector Breach still passed: the winning run never
  once fired through geometry, and the grunt's LOS probe never had a wall to find. The opening shot
  does fire through geometry, so a dead DDA sends it 14.5 u into the grunt instead of stopping 5.5 u
  away at the door — which shows up as a third `enemy.damaged` and a failed target assertion. The
  2b shot closes the matching gap for **pitch**, which the script otherwise pinned at 0 for all 600
  ticks: level, that ray hits the grunt; at −40° it passes beneath its hitbox.
- Both extra shots respect the 12-tick weapon cooldown and neither perturbs movement (pitch does not
  steer the capsule), so the pit jump and the firefight are untouched. **The final state hash is
  unchanged** by them — which is exactly why the trajectory digest below exists.
- Keep the _semantics_ (prove the wall stops a ray, turn→shoot button, prove pitch steers a ray,
  jump the pit, two shots on the grunt) even if tuned tick numbers drift; the assertions below check
  those, not the exact frames.

## The gameplay assertions

```ts
import { defineGameTest, expectSim } from '@aegis/harness';
import { sectorBreachPlugin } from '@aegis/game-fps';
import { Health } from '@aegis/content';
import { Transform } from '@aegis/core';

export default defineGameTest({
  name: 'sector breach: shoot the door, jump the pit, kill the grunt, reach the exit',
  scene: 'games/fps/levels/sector-breach.scene.json',
  options: { plugin: sectorBreachPlugin, captureHistory: true },
  ticks: 600,
  seed: 'poc-fps',
  input: `
    press Fire @4
    aim 90 0 @8
    press Fire @20
    aim 0 0 @32
    axis Forward 1 40..124
    aim 0 -40 @96
    press Fire @100
    aim 0 0 @108
    press Jump @124
    axis Forward 1 124..170
    press Fire @176
    press Fire @192
    axis Forward 1 210..320
  `,
  expect(result) {
    expectSim(result)
      .eventEmitted('door.opened', 1) // the button shot actually opened the door
      .eventEmitted('enemy.killed', 1) // the grunt actually died
      .eventEmitted('level.completed', 1) // reached the exit, once
      .eventEmitted('damage.taken', 1) // the grunt landed exactly one shot (not zero, not many)
      .eventNotEmitted('player.died') // survived (pit + firefight; and see the lose playthrough)
      .entityExists({ has: ['Player'] })
      // Five shots leave the barrel; exactly two reach the grunt. The other three are the button
      // and the two occlusion proofs — so a ray that stops being blocked by geometry shows up here
      // as a third `enemy.damaged`.
      .eventEmitted('weapon.fired', 5)
      .eventEmitted('enemy.damaged', 2)
      .holds('the opening shot stopped at the sealed blast door', (r) => …) // target 'wall', d≈5.5
      .holds('the 40°-down shot at t100 passed under the grunt rather than through it', (r) => …)
      .holds(
        'player ended in the security room, past the grunt',
        (r) =>
          r
            .query({ has: ['Player', 'Transform'] })
            .one()
            .get(Transform).position.z >= 17,
      )
      .holds(
        'player took exactly one grunt hit — final Health is 90',
        (r) =>
          r
            .query({ has: ['Player', 'Health'] })
            .one()
            .get(Health).current === 90, // exact: 0 hits leaves 100, 2 leaves 80 — both fail
      )
      .holds(
        'the per-tick hash timeline matches the golden trajectory',
        (r) => trajectoryDigest(r.tickHashes) === '1ce5508ff97c0b75',
      )
      .hashEquals('f86540b793f071a3'); // literal golden master, not result.hash (self-referential)

    // Whole-timeline invariant #1 — 3D collision/jump: never fell through the world.
    result.assertInvariant(
      'player feet never dropped into the void',
      (w) =>
        w
          .query({ has: ['Player', 'Transform'] })
          .one()
          .get(Transform).position.y > -1,
    );

    // Whole-timeline invariant #2 — a safety property: health never dips below the floor on *any*
    // tick. Kept as a bound because it guards the whole timeline; the exact damage exchange is
    // pinned by the `damage.taken ×1` + `Health === 90` assertions above.
    result.assertInvariant(
      'player health stayed above the safe floor',
      (w) =>
        w
          .query({ has: ['Player', 'Health'] })
          .one()
          .get(Health).current >= 70,
    );
  },
});
```

> **Two deviations from the block as originally drafted (both real, both required):**
>
> 1. **The plugin is `sectorBreachPlugin` from `@aegis/game-fps`, not `fpsPlugin` from
>    `@aegis/mode-fps`.** The harness builds a run's schedule solely from `plugin.systems()`, so the
>    game's own systems (grunt AI, door, damage→event mapping, hazard/goal triggers) must ride in
>    the plugin. `sectorBreachPlugin` composes `fpsPlugin`'s systems + `@aegis/content`'s
>    `healthSystem` + the game systems, and merges the FPS and game component sets. A bare
>    `fpsPlugin` would run the physics but none of the game rules.
> 2. **The frames match the tuned `play/sector-breach.input`.** The shipped test reads that file
>    verbatim (`readFileSync`) rather than inlining the script, so the playthrough has a single
>    source of truth. The block above mirrors it for readability.

The assertions pin the design intent; the two deviations are in _how the run is wired_, not
_what is asserted_ — plus the damage exchange is now pinned **exactly** (see below).

Invariant #1 fails at the exact tick a botched pit-jump or capsule-collision bug drops the player
below the floor. The **`damage.taken ×1` + `Health === 90`** pair pins the firefight exchange
per CHARTER §4.3 ("defeated the enemy, took the correct damage"): if the grunt's targeting, LOS
probe, cooldown, or damage application regresses such that it fires **zero** times the player ends
at Health 100 (both assertions fail); if it fires for the wrong amount or more than once the health
equality fails; if it sprays, the count fails too. Invariant #2 (`Health >= 70` on every tick) is
kept as a whole-timeline **safety** property — necessary but, on its own, _not sufficient_ (zero
damage also satisfies it), which is exactly why the exact pins above were added.

### Why a trajectory digest and not just `hashEquals`

`f86540b793f071a3` is a hash of the **final** world, and this run ends at rest: the player parked in
the exit trigger, the grunt dead, the weapon cooled down. Runs whose trajectories differ can
therefore converge on a byte-identical final state — measured here, adding the two occlusion shots
above changes four ticks' worth of weapon-cooldown and look state and leaves the final hash
untouched. `trajectoryDigest` is `hashString(tickHashes.join('|'))` — core's frozen FNV-1a over the
per-tick hashes the harness already records — so any changed trajectory goes red. (`tickHashes` were
previously compared only run-to-run, which proves determinism but adds no regression detection.)

## What this game proves about the engine

| Game element                    | Engine capability exercised                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Turn to the east-wall button    | Yaw `LookState` **steering the hitscan ray direction**                                                       |
| The 40°-down shot at t100       | Pitch **steering the ray vertically** (the script otherwise never leaves pitch 0)                            |
| Shooting the button             | `Hitscan` raycast resolving against a specific entity + cooldown                                             |
| Shooting _at_ the sealed door   | `raycastGrid` DDA wall occlusion — the ray stops at geometry instead of hitting what is behind it            |
| Blast door opens on hit         | Event-driven world mutation (`door` cells' `solid` flipped in the hashed grid) from a ray hit                |
| Walking the corridor            | Capsule movement over extruded floorplan geometry                                                            |
| Running into the corner (probe) | **Capsule-vs-wall collision, axis-separated wall sliding, and the capsule radius** — each by name            |
| Jumping the coolant pit         | **3D gravity + jump arc + capsule-vs-floor** over a per-tile floor height; `hazard` `Trigger` pit-fall death |
| The grunt firefight             | `Health` damage from hitscan; two-shot kill math                                                             |
| Grunt shooting back             | Deterministic, RNG-free enemy AI cadence → `damage.taken`                                                    |
| Reaching the exit               | Goal `Trigger` volume detection in 3D + one-shot latch (`level.completed` once)                              |
| Falling in the pit (lose run)   | `hazard` `Trigger` pit-fall death — `player.died{cause:'coolant'}`, proven by a failing playthrough          |
| Semantic frame of the room      | `ViewProvider` perspective projection (agent "sees" without a GPU)                                           |
| `hashEquals` + repeated run     | Byte-identical determinism across `sin/cos` look math (ADR-0001)                                             |
| Trajectory digest               | The whole per-tick timeline, not just the resting state it converges on                                      |
| Health/`position.y` invariants  | Whole-timeline safety properties, not just final state                                                       |

Each row is backed by a mutation that turns it red **through a named gameplay assertion**, not
through hash drift. The ones that were not load-bearing before the mode-capability audit are:
`raycastGrid` wall occlusion (the whole DDA could `return undefined`), pitch (the script never left
0), the coolant-pit death, capsule-vs-wall collision, axis-separated sliding, and the capsule radius.

> **Known gap (reported to the PM, not fixed here):** the grunt's own `raycastGrid` line-of-sight
> probe in `gruntAiSystem` is still not independently pinned. Its two lines can be deleted with the
> suite green, because the corridor is straight and open for the whole final 6 u of the approach, so
> the probe never has a wall to find. Closing it needs level geometry (a pillar the player has to
> strafe around), which changes the tilemap, the scene, the floorplan diagram and the golden hashes.
> The `raycastGrid` _function_ is load-bearing via the shot at t4; only that one call site is not.
>
> **Second known gap:** `player.died` is not terminal in this game, and for two independent reasons.
> `fps.intake` has no `none: [Dead]` guard (the same defect as `platformer.intake`), and
> `hazardSystem` emits `player.died` _without_ zeroing `Health`, so `Dead` never latches at all for
> a pit death — meaning even the mode-level guard would not catch this one. On top of that
> `goalSystem` has no dead check. A run that keeps driving `Forward` after the pit death therefore
> climbs back out (the capsule snaps up to the next cell's floor) and reaches the exit at t200. The
> lose playthrough stops input at the pit, as a fallen player's would, which is honest but sidesteps
> the issue. Fixing it properly is a game-semantics change (zero `Health` on the hazard, then avoid
> the double `player.died` that `deathMappingSystem` would emit) and moves the golden hash, so it is
> reported rather than done here.
