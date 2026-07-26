# Platformer PoC — "Coyote Gap"

> 2D side-scroller. Reference feel: _Super Mario World_, _Ori_.
> Mode: `platformer` (`@aegis/mode-platformer`). Runs headless, verified without pixels.

## Concept and fantasy

A tiny run-right-and-jump level. You are a nimble runner crossing a broken ledge: sprint over a
pit, bounce off a patrolling critter, ride a moving platform across a lava gap, then leap onto the
goal flag. For the 20–25 seconds it lasts it should feel _tight_ — a mistimed jump drops you in the
pit, a mistimed landing lands you on the critter's teeth. It is a compressed anthology of the four
things a platformer must get right: gravity, collision, timing windows (coyote/buffer) and moving
geometry.

## Core loop

Run right → time a jump → land → react to a hazard/enemy → repeat → touch the flag. The only verbs
are **move horizontally** and **jump**. Everything else (falling, colliding, being carried, dying)
is a consequence the engine computes.

## Mechanics (design intent — implementers may tune)

World unit = 1 tile. `tileSize: 1`. Tick rate 60Hz, `dt = 1/60`.

**Player** (`PlatformerController` tunables, mostly defaults):

| Tunable           | Value        | Consequence                                               |
| ----------------- | ------------ | --------------------------------------------------------- |
| `moveSpeed`       | 8 u/s        | 0.133 u/tick; ~40-tile level ≈ 300 ticks end-to-end       |
| `jumpSpeed`       | 16 u/s       | apex ≈ 2.1 tiles, reached in ~16 ticks                    |
| `gravity`         | 60 u/s²      | 1 u/s added downward per tick                             |
| `maxFallSpeed`    | 30 u/s       | terminal velocity, caps pit-fall                          |
| `coyoteTicks`     | 6            | jump still fires up to 6 ticks after leaving a ledge      |
| `jumpBufferTicks` | 6            | a jump pressed up to 6 ticks before landing still fires   |
| `TileCollider`    | half 0.4×0.5 | slightly narrower than a tile so corners forgive          |
| `Health`          | 1 / 1        | one-hit death (`Health` is shared, from `@aegis/content`) |

Derived: a running jump stays airborne ~32 ticks and travels ~4.3 tiles horizontally, so a **3-tile
pit is comfortably clearable and a 4-tile pit is at the ragged edge**. The level uses 3-tile gaps.

**Enemy "critter"** — a game-owned `PatrolSystem` (deterministic, no RNG):

- Walks horizontally between two solid walls at 3 u/s, reversing `facing` on contact.
- Position at tick _t_ is a pure function of _t_ → reproducible tick-for-tick.
- **Stomp:** if the player's collider overlaps the critter while the player's `Velocity.dy < 0`
  (descending) and the player's feet are above the critter's centre → `enemy.killed`, and the
  player receives a small bounce (`dy = 10`).
- **Gore:** any other overlap (side/below) → `damage.taken` then `player.died` the same tick.

**Moving platform** — a kinematic solid entity provided and carried by the **mode** (see _Engine
scope_ below):

- A 3-tile-wide solid entity that oscillates horizontally over the lava gap between x=27 and x=32
  at 2 u/s, period reproducible from tick count.
- The player standing on it is **carried** — its horizontal delta is added to the rider by the
  mode's collision resolution.

**Death** — the player carries `Health { current: 1, max: 1 }`; any lethal contact sets it to 0,
emitting `player.died` (once) and ending the run. Lethal contacts are: a `hazard` `Trigger` volume
(spikes/lava tiles), falling below `Transform.position.y < -4`, or being gored by the critter. One
HP is the whole mechanic — a platformer death is instant.

**Goal** — a `Trigger` volume (from `@aegis/content`) on the flag entity: the player's collider
enters it → `level.completed` (once).

> **Engine scope (per PM ruling):** the moving platform is **mode-owned**. `mode-platformer` must
> support **kinematic solids** and carry a rider standing on one — being carried is core platformer
> vocabulary (both reference games have it), so the game does not hand-roll a carry system. Shared
> `Health` and the `Trigger`/volume component live in `@aegis/content`. This design assumes all
> three.

## Level layout

Authored as an ADR-0003 tilemap (`levels/coyote-gap.tilemap.json`), 44×12, `tileSize: 1`. Row 0 is
the top. Entities (player, critter, platform, flag) are placed in the scene file at world
coordinates, not in the tilemap.

Legend:

```
#  solid tile (ground / wall)         .  empty (air)
^  spikes (hazard tile: death)        ~  lava surface (hazard tile: death)
P  player spawn (scene entity)        C  critter patrol lane (scene entity)
M  moving-platform track (scene)      G  goal flag (scene entity)
```

Collision layer (the only layer the sim reads; `^`/`~` carry `data.hazard: true`):

```
row  0 | ............................................
row  1 | ............................................
row  2 | ............................................
row  3 | ...................######...................
row  4 | ..............C....................G........
row  5 | ..........#########.........#####..####.....
row  6 | ..P.......#########...MMM...#####..####.....
row  7 | #####.....#########.........#####..####.....
row  8 | #####...........................############
row  9 | #####.###.......................############
row 10 | #####.###..^^^^^..~~~~~~~~~~~....############
row 11 | ############^^^^^############################
         0         1         2         3         4
         0123456789012345678901234567890123456789012 3
```

Read left-to-right, the level is six beats, each proving one thing:

1. **cols 0–4 — flat start.** Player rests on ground. Proves gravity settles a body to grounded and
   horizontal run works.
2. **cols 5–9 — the spike step.** A `.###` step up with `^^^^^` spikes in the trench below (rows
   10–11). Player must jump the 1-tile step; falling into the trench = death. Proves jump + landing
   on a raised solid + hazard death.
3. **cols 10–17 — the critter plateau.** The critter `C` patrols the long `#########` plateau.
   Player must stomp it (land from above) to pass safely. Proves deterministic AI + stomp-vs-gore
   discrimination (`Velocity.dy` sign + relative position).
4. **cols 18–25 — the lava gap + moving platform.** A pit floored with `~` lava (row 10). The
   `MMM` platform ferries the player across. Proves collision against **non-static geometry** and
   rider carry.
5. **cols 26–33 — the coyote ledge.** Player runs off the right edge of the `#####` block and must
   press Jump _just after_ leaving the ledge; the 6-tick coyote window makes the late press valid.
   Proves coyote time is actually implemented (without it, the jump is eaten and the player dies).
6. **cols 34–43 — the goal.** A final `####` pillar with the flag `G` on top (row 4). Player buffers
   a jump into the landing to mount it. Proves jump-buffering and goal detection.

## Win and lose conditions

- **Win:** exactly one `level.completed` event AND no `player.died` event.
- **Lose:** any `player.died` event (fell in a pit, hit spikes/lava, or gored by the critter), or
  the run ends without `level.completed`.

Both are machine-checkable purely from the event log; no pixel inspection.

## Events emitted

| Event              | Payload                                   | Emitted by | When                                           |
| ------------------ | ----------------------------------------- | ---------- | ---------------------------------------------- |
| `player.jumped`    | `{ tick, fromGround: boolean }`           | mode/game  | a jump actually launches (incl. coyote/buffer) |
| `player.landed`    | `{ tick }`                                | mode/game  | body transitions airborne → grounded           |
| `enemy.killed`     | `{ name, tick }`                          | game       | player stomps the critter                      |
| `damage.taken`     | `{ amount, source: 'critter'\|'hazard' }` | game       | player is gored / touches hazard               |
| `player.died`      | `{ cause, tick }`                         | game       | death, emitted once                            |
| `platform.boarded` | `{ name }`                                | game       | player begins riding the moving platform       |
| `level.completed`  | `{ tick }`                                | game       | player reaches the flag, emitted once          |

## The scripted playthrough

`play/coyote-gap.input` (ADR-0004 DSL). Ticks are design intent; the implementer tunes exact frames
against the real physics. Total ≈ **360 ticks (~6 s sim time)**.

```text
# Coyote Gap — a completing run. Hold Right the whole way; jump on cue.
hold Right 0..360

press Jump @28      # beat 2: clear the spike step onto the raised block
press Jump @96      # beat 3: hop onto the critter from above (stomp) -> enemy.killed
                    #          the stomp bounce carries us onto the plateau
# beat 4: wait on the plateau edge for the platform, then board and ride
press Jump @150     # small hop onto the moving platform when it swings left
# (ride ~40 ticks to the far side; no input needed — the platform carries us)
press Jump @250     # beat 5: coyote jump — pressed 3 ticks AFTER running off the ledge
press Jump @318     # beat 6: buffered jump into the goal pillar landing
```

Notes for the implementer:

- The two "timing proof" presses are deliberate: `@250` fires _after_ the player has left the ledge
  (proves coyote), `@318` is buffered _before_ the landing contact (proves jump buffer). If either
  window regresses, the corresponding jump is eaten and the run ends in `player.died`, so the test
  fails loudly.
- If tuned tick numbers drift, keep the _semantics_ (stomp from above, board on the left swing,
  late-jump the ledge) — those are what the assertions below actually check.

## The gameplay assertions

```ts
import { defineGameTest, expectSim } from '@aegis/harness';
import { platformerPlugin } from '@aegis/mode-platformer';
import { Transform } from '@aegis/core';

export default defineGameTest({
  name: 'coyote gap: stomp, ride, coyote-jump, reach the flag',
  scene: 'games/platformer/levels/coyote-gap.scene.json',
  options: { plugin: platformerPlugin, captureHistory: true },
  ticks: 400,
  seed: 'poc-platformer',
  input: `
    hold Right 0..360
    press Jump @28
    press Jump @96
    press Jump @150
    press Jump @250
    press Jump @318
  `,
  expect(result) {
    expectSim(result)
      .eventEmitted('level.completed', 1) // finished, exactly once
      .eventNotEmitted('player.died') // survived the whole run
      .eventEmitted('enemy.killed', 1) // the critter was actually stomped
      .eventEmitted('platform.boarded', 1) // the moving platform actually carried us
      .entityExists({ has: ['Player'] })
      .holds(
        'player ended on/past the goal pillar',
        (r) =>
          r
            .query({ has: ['Player', 'Transform'] })
            .one()
            .get(Transform).position.x >= 36,
      )
      .hashEquals(result.hash); // pin the golden state hash (determinism)

    // Whole-timeline invariants (require captureHistory):
    result.assertInvariant(
      'never fell out of the world',
      (w) =>
        w
          .query({ has: ['Player', 'Transform'] })
          .one()
          .get(Transform).position.y > -4,
    );
    result.assertInvariant(
      'never tunnelled above the ceiling plane',
      (w) =>
        w
          .query({ has: ['Player', 'Transform'] })
          .one()
          .get(Transform).position.y <= 12,
    );
  },
});
```

The first invariant is the load-bearing one: if collision or gravity regresses so the player clips
through a platform or the pit floor, `position.y` dips below `-4` on some tick and the invariant
fails _at that tick_, pointing the implementer at exactly when the physics broke.

## What this game proves about the engine

| Game element                      | Engine capability exercised                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Flat start settles to grounded    | Gravity integration + resting contact against static tiles                         |
| Jumping the spike step            | Jump launch, upward integration, landing on a raised solid                         |
| Spike / lava trench death         | `hazard` `Trigger` volumes (`@aegis/content`) + positional death (`y < -4`)        |
| Critter patrol                    | Deterministic, RNG-free AI as a pure function of tick                              |
| Stomp vs gore                     | `Velocity.dy` sign + relative position → branching game event                      |
| Moving platform crossing          | **Mode-owned kinematic-solid collision + rider carry**                             |
| Coyote-ledge jump                 | `coyoteTicks` grace window after leaving ground                                    |
| Goal pillar mount                 | `jumpBufferTicks` buffered-press window + `Trigger` goal volume (`@aegis/content`) |
| Reaching the flag                 | Event emission + one-shot latching (`level.completed` exactly once)                |
| `hashEquals` + repeated run       | Byte-identical determinism (ADR-0001)                                              |
| `assertInvariant` on `position.y` | Whole-timeline safety property, not just final state                               |
