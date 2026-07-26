# FPS PoC — "Sector Breach"

> First-person 3D. Reference feel: *Half-Life*.
> Mode: `fps` (`@aegis/mode-fps`). Runs headless; verified without pixels via the semantic frame.

## Concept and fantasy

A 30-second Black-Mesa-style facility breach. You spawn in a sealed antechamber, **turn and shoot a
wall panel** to blow the blast door, jog down a service corridor, **hop a toxic-coolant pit**, then
gun down a lone security grunt guarding the exit before it whittles you down. It is the classic
Half-Life micro-loop — *look, shoot, move, jump, shoot* — compressed to its smallest honest form.
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

| Tunable | Value | Consequence |
| --- | --- | --- |
| `FpsController.moveSpeed` | 6 u/s | corridor traversal pace |
| `FpsController.gravity` | 24 u/s² | fall accel |
| `FpsController.jumpSpeed` | 8 u/s | apex ≈ 1.33 u high, ~40 ticks airborne, ~4 u of forward reach |
| `FpsController.maxPitchDeg` | 89 | look clamp |
| `CapsuleBody` | r 0.4, h 1.8 | collision volume |
| `Hitscan.range` | 100 u | ray length |
| `Hitscan.damage` | 25 | per shot |
| `Hitscan.cooldownTicks` | 12 | ≥12 ticks between shots (0.2 s) |
| `Health.current/max` | 100 | player HP (`Health` is shared, from `@aegis/content`) |

Derived: an 8 u/s jump under 24 u/s² gravity clears a **2–3 u pit** with margin; the coolant pit is
2 u across.

**Weapon (hitscan)** — a `WeaponSystem` (mode) casts a ray from the eye along the look direction on a
`Fire` press (respecting `cooldownRemaining`), emitting `weapon.fired`, then `hitscan.hit{target}` or
`hitscan.miss`. A hit on an entity with `Health` subtracts `damage`.

**The blast door** — a `Blocking`-tagged wall segment (game-owned) at the north end of the
antechamber. A game `DoorSystem` listens for `hitscan.hit` whose `target` is the `Button` panel and
removes the wall, emitting `door.opened`. The button is on the **east wall**, so the player must
**yaw right ~90°** to hit it — this is the proof that look direction actually steers the ray.

**The grunt** — a game `GruntAiSystem` (deterministic, RNG-free):
- Stands at the far end of the security room, facing −Z (toward the incoming player), `Health 50`.
- When the player is within 15 u and roughly in front, it fires every 30 ticks, dealing 10 damage →
  `damage.taken` on the player. Cadence is a pure function of tick, so damage totals are
  reproducible.
- Dies at `Health ≤ 0` → `enemy.killed`. Two player hits (25+25) kill it; the player expects to
  take **at most one** grunt shot (−10 → Health 90) if it shoots on cue.

**The coolant pit** — a `hazard` `Trigger` volume (from `@aegis/content`) in the floor gap; entering
it emits `player.died` (the player fell in). Clearing it requires a jump.

**Exit** — a `Trigger` volume behind the grunt: the player enters it → `level.completed`.

> **Engine scope (per PM ruling — confirmed):** 3D level geometry is authored as a **top-down
> tilemap floorplan** (ADR-0003) that `mode-fps` extrudes — `#` cells become full-height solid
> walls, `.` is floor. Hand-placed 3D "brush" entities were rejected (they violate charter
> principle 1 — an agent must author an FPS level by typing ASCII). The floorplan additionally
> supports an **optional per-tile floor and ceiling height** (a numeric `heights` layer keyed by
> the same grid), so the coolant pit — and any verticality — is expressible in the same text
> format: a pit is a tile whose floor height is below 0 (or, for a bottomless gap, a `T` tile with
> no floor). `mode-fps` therefore (a) builds capsule collision from the extruded, per-tile-height
> floorplan and (b) resolves `Hitscan` rays against both that geometry and entities (`Button`,
> grunt). Shared `Health` and the `Trigger`/volume component live in `@aegis/content`.

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
   14 |          # . . . #
      |          # . T . #             corridor B (coolant pit T at z≈9)
      |          # . T . #
      |          # . . . #
   10 |          # . . . #
      |          # . . . #
    8 |  # # # # . = . # # # #      blast door '=' at the Room A ↔ corridor mouth
      |  # . . . . . . . . B #      button 'B' on the EAST wall of Room A
      |  # . . . . . . . . . #
      |  # . . . . P . . . . #      Room A — antechamber, player faces +Z
    0 |  # # # # # # # # # # #
```

The floorplan above is the tilemap's `collision` layer; a parallel **`heights` layer** (same grid)
makes the verticality explicit: every `.`/wall tile has floor 0 / ceiling 3, while the two `T` tiles
carry a floor height of `-3` (a pit the player falls into if unjumped). A `hazard` `Trigger` volume
sits in the pit and a goal `Trigger` sits on `E`.

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

## Events emitted

| Event | Payload | Emitted by | When |
| --- | --- | --- | --- |
| `weapon.fired` | `{ tick }` | mode | a `Fire` press launches a ray (past cooldown) |
| `hitscan.hit` | `{ target, distance, tick }` | mode | a ray hits an entity or wall |
| `hitscan.miss` | `{ tick }` | mode | a ray hits nothing in range |
| `door.opened` | `{ name }` | game | the button is hit and the blast door is removed |
| `enemy.damaged` | `{ name, amount, remaining }` | game | the grunt takes a hit |
| `enemy.killed` | `{ name, tick }` | game | the grunt's `Health` reaches 0 |
| `damage.taken` | `{ amount, source, remaining }` | game | the grunt hits the player |
| `player.died` | `{ cause, tick }` | game | player `Health` ≤ 0 or fell in the pit, once |
| `level.completed` | `{ tick }` | game | player reaches the exit trigger, once |

## The scripted playthrough

`play/sector-breach.input` (ADR-0004 DSL). Uses `aim` (absolute look), `Fire`, the `Forward` axis
and `Jump`. Ticks are design intent; tune exact frames against the real physics/AI. Total ≈ **560
ticks (~9 s sim time)**.

```text
# Sector Breach — a completing run.

aim   90 0   @8           # turn right to face the east-wall button
press Fire   @20          # blast the panel -> hitscan.hit(Button) -> door.opened
aim   0 0    @32          # face forward (+Z) again

axis  Forward 1 40..300   # jog north through the opened door and up the corridor
press Jump   @150         # clear the toxic coolant pit (jump arc carries us over)

# arrive in the security room; the grunt is dead ahead
press Fire   @330         # first shot  -> enemy.damaged (50 -> 25)
press Fire   @346         # second shot -> enemy.damaged (25 -> 0) -> enemy.killed
                          #   (16-tick spacing respects the 12-tick weapon cooldown)

axis  Forward 1 360..520  # advance past the grunt to the exit trigger -> level.completed
```

Notes for the implementer:
- The `aim 90 0` / `aim 0 0` pair is the look-drives-the-ray proof; if yaw fails to steer the
  hitscan, the button shot misses, the door never opens, and the run cannot progress — a loud
  failure.
- Keep the *semantics* (turn→shoot button, jump the pit, two shots on the grunt) even if tuned tick
  numbers drift; the assertions below check those, not the exact frames.

## The gameplay assertions

```ts
import { defineGameTest, expectSim } from '@aegis/harness';
import { fpsPlugin } from '@aegis/mode-fps';
import { Health } from '@aegis/content';
import { Transform } from '@aegis/core';

export default defineGameTest({
  name: 'sector breach: shoot the door, jump the pit, kill the grunt, reach the exit',
  scene: 'games/fps/levels/sector-breach.scene.json',
  options: { plugin: fpsPlugin, captureHistory: true },
  ticks: 600,
  seed: 'poc-fps',
  input: `
    aim 90 0 @8
    press Fire @20
    aim 0 0 @32
    axis Forward 1 40..300
    press Jump @150
    press Fire @330
    press Fire @346
    axis Forward 1 360..520
  `,
  expect(result) {
    expectSim(result)
      .eventEmitted('door.opened', 1)        // the button shot actually opened the door
      .eventEmitted('enemy.killed', 1)       // the grunt actually died
      .eventEmitted('level.completed', 1)    // reached the exit, once
      .eventNotEmitted('player.died')        // survived (pit + firefight)
      .entityExists({ has: ['Player'] })
      .holds(
        'player ended in the security room, past the grunt',
        (r) =>
          r.query({ has: ['Player', 'Transform'] }).one().get(Transform).position.z >= 17,
      )
      .hashEquals(result.hash);              // pin the golden state hash (determinism)

    // Whole-timeline invariant #1 — 3D collision/jump: never fell through the world.
    result.assertInvariant(
      'player feet never dropped into the void',
      (w) => w.query({ has: ['Player', 'Transform'] }).one().get(Transform).position.y > -1,
    );

    // Whole-timeline invariant #2 — bounded, deterministic incoming damage.
    result.assertInvariant(
      'player health stayed above the safe floor',
      (w) => w.query({ has: ['Player', 'Health'] }).one().get(Health).current >= 70,
    );
  },
});
```

Invariant #1 fails at the exact tick a botched pit-jump or capsule-collision bug drops the player
below the floor. Invariant #2 pins the grunt's AI cadence: if the enemy fires more often than
designed (a determinism or timing regression), incoming damage exceeds 30 and health dips below 70
on some tick — failing precisely when the AI drifted.

## What this game proves about the engine

| Game element | Engine capability exercised |
| --- | --- |
| Turn to the east-wall button | Yaw/pitch `LookState` **steering the hitscan ray direction** |
| Shooting the button | `Hitscan` raycast resolving against a specific entity + cooldown |
| Blast door opens on hit | Event-driven world mutation (`Blocking` removal) from a ray hit |
| Walking the corridor | Capsule movement over extruded floorplan geometry, wall sliding |
| Jumping the coolant pit | **3D gravity + jump arc + capsule-vs-floor** over a per-tile floor height; `hazard` `Trigger` pit-fall death |
| The grunt firefight | `Health` damage from hitscan; two-shot kill math |
| Grunt shooting back | Deterministic, RNG-free enemy AI cadence → `damage.taken` |
| Reaching the exit | Goal `Trigger` volume detection in 3D + one-shot latch (`level.completed` once) |
| Semantic frame of the room | `ViewProvider` perspective projection (agent "sees" without a GPU) |
| `hashEquals` + repeated run | Byte-identical determinism across `sin/cos` look math (ADR-0001) |
| Health/`position.y` invariants | Whole-timeline safety properties, not just final state |
