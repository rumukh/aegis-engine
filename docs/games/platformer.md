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
| `jumpSpeed`       | 16 u/s       | apex ≈ 2.3 tiles, reached in ~16 ticks                    |
| `gravity`         | 60 u/s²      | 1 u/s added downward per tick                             |
| `maxFallSpeed`    | 30 u/s       | terminal velocity, caps pit-fall                          |
| `coyoteTicks`     | 6            | jump still fires up to 6 ticks after leaving a ledge      |
| `jumpBufferTicks` | 6            | a jump pressed up to 6 ticks before landing still fires   |
| `TileCollider`    | half 0.4×0.5 | slightly narrower than a tile so corners forgive          |
| `Health`          | 1 / 1        | one-hit death (`Health` is shared, from `@aegis/content`) |

Derived: a running jump stays airborne ~32 ticks and travels ~4.3 tiles horizontally, so a **3-tile
pit is comfortably clearable and a 4-tile pit is at the ragged edge**. The level uses a 3-tile spike
pit and two 2-tile gaps (lava, coyote).

**Enemy "critter"** — a game-owned `PatrolSystem` (deterministic, no RNG):

- Walks horizontally between two solid walls at 3 u/s, reversing `facing` on contact.
- Position at tick _t_ is a pure function of _t_ → reproducible tick-for-tick.
- **Stomp:** if the player's collider overlaps the critter while the player's `Velocity.dy < 0`
  (descending) and the player's feet are above the critter's centre → `enemy.killed`, and the
  player receives a small bounce (`dy = 10`).
- **Gore:** any other overlap (side/below) → `damage.taken` then `player.died` the same tick.

**Moving platform** — a kinematic solid entity provided and carried by the **mode** (see _Engine
scope_ below):

- A 3-tile-wide solid entity that shuttles horizontally over a 2-tile lava gap between x=21.5 and
  x=22.5 at 2 u/s, period reproducible from tick count. It always bridges the gap (see _Deviations
  & tuning_ for why the ferry became a bridge).
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
row  0 | ...........................................#
row  1 | ...........................................#
row  2 | ...........................................#
row  3 | ...........................................#
row  4 | ...........................................#
row  5 | ...........................................#
row  6 | ........................................####
row  7 | #######...###########..###########..########
row  8 | #######...###########..###########..########
row  9 | #######...###########..###########..########
row 10 | #######^^^###########~~###########..########
row 11 | #######^^^###########..###########..########
         0         1         2         3         4
         01234567890123456789012345678901234567890123
```

> This is the collision layer verbatim from `levels/coyote-gap.tilemap.json` (regenerated; the tuned
> geometry replaced the design-intent sketch — see _Deviations & tuning_). Entities are not in the
> tilemap; they sit in the scene at world coordinates: **player** x≈2.5, **critter** patrols x15–17
> on the plateau, **platform** shuttles x21.5–22.5 over the lava, **goal** trigger centred at x41 on
> the pillar.

Read left-to-right, the level is six beats, each proving one thing:

1. **cols 0–6 — flat start.** Player rests on ground (top row 7, surface y=5). Proves gravity settles
   a body to grounded and horizontal run works.
2. **cols 7–9 — the spike pit.** A 3-tile gap floored with `^^^` spikes (rows 10–11). Player must
   jump it; falling in = hazard death. Proves jump + landing on a raised solid + hazard death.
3. **cols 10–20 — the critter plateau.** The critter patrols x15–17 on the long plateau. Player must
   stomp it (land from above) to pass; the stomp bounce drops back onto the same plateau. Proves
   deterministic AI + stomp-vs-gore discrimination (`Velocity.dy` sign + relative position).
4. **cols 21–22 — the lava gap + shuttle platform.** A 2-tile pit floored with `~~` lava (row 10).
   The 3-tile kinematic platform bridges it and **carries** the rider across. Proves collision
   against **non-static geometry** and rider carry (`platform.boarded`).
5. **cols 23–33 — the coyote ledge.** Player runs off the right edge of the long ledge and must press
   Jump _just after_ leaving it; the 6-tick coyote window makes the late press valid. Proves coyote
   time is actually implemented (without it the jump is eaten and the player dies in the gap).
6. **cols 34–43 — the coyote gap + goal.** A 2-tile gap (cols 34–35), a landing platform (cols
   36–39, surface y=5), then a +1 goal pillar (cols 40–42, surface y=6) capped by a wall (col 43).
   Player coyote-jumps the gap, then buffers a jump before touchdown to mount the pillar and enter
   the goal trigger. Proves jump-buffering and goal detection.

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

`play/coyote-gap.input` (ADR-0004 DSL). These are the **tuned** frames, verified against the real
physics by the acceptance test. Total ≈ **300 ticks to completion (~5 s sim time)**.

```text
# Coyote Gap — a completing run. Hold Right the whole way; jump on cue.
hold Right 0..360

press Jump @28      # beat 2: clear the spike pit onto the plateau
press Jump @74      # beat 3: stomp the critter from above -> enemy.killed + bounce
                    # beat 4: no input -- the shuttle platform bridges the lava and
                    #         carries us across (platform.boarded)
press Jump @238     # beat 5: coyote jump, pressed ~1 tick after running off the ledge
press Jump @266     # beat 6: buffered jump, pressed before touchdown to mount the pillar
```

Notes for the implementer:

- The two "timing proof" presses are deliberate: `@238` fires _after_ the player has left the ledge
  (proves coyote — telemetry shows `fromGround:false`), `@266` is buffered _before_ the landing
  contact at ~t270 and fires on touchdown at t271 (proves jump buffer — telemetry shows the buffer
  latch then a `fromGround:true` jump one tick later). If either window regresses, the corresponding
  jump is eaten and the run ends in `player.died`, so the test fails loudly.
- If tuned tick numbers drift, keep the _semantics_ (stomp from above, ride the shuttle across,
  late-jump the ledge, buffer onto the pillar) — those are what the assertions below actually check.

## The gameplay assertions

> **Deviation (verified):** the block below is the spec as authored, using the bare `platformerPlugin`
> and the design-intent tick numbers. The **actual** authoritative test lives at
> `packages/mode-platformer/src/coyote-gap.acceptance.test.ts` and the game's own copy at
> `games/platformer/src/coyote-gap.gametest.ts`; both use the composed **`coyoteGapPlugin`** and the
> tuned input above. `platformerPlugin` alone cannot emit the game-semantic events (`enemy.killed`,
> `player.died`, `level.completed`) because `executeRun` builds the schedule solely from
> `plugin.systems()` — see _Deviations & tuning_. The assertions themselves are unchanged.

```ts
import { defineGameTest, expectSim } from '@aegis/harness';
import { coyoteGapPlugin } from 'games/platformer'; // composed: mode + content + game systems
import { Transform } from '@aegis/core';

export default defineGameTest({
  name: 'coyote gap: stomp, ride, coyote-jump, reach the flag',
  scene: 'games/platformer/levels/coyote-gap.scene.json',
  options: { plugin: coyoteGapPlugin, captureHistory: true },
  ticks: 400,
  seed: 'poc-platformer',
  input: `
    hold Right 0..360
    press Jump @28
    press Jump @74
    press Jump @238
    press Jump @266
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

## Deviations & tuning (platformer slice, as built)

The mode and game are implemented and green; these are the reality-vs-design-intent notes the PM
asked for. Numbers here reflect the merged code, not the original sketch above.

1. **Composed `coyoteGapPlugin`, not bare `platformerPlugin`.** `executeRun` builds the tick schedule
   solely from `plugin.systems()` (`RunOptions` has no separate systems hook), so a plugin that omits
   the game systems cannot emit `enemy.killed` / `player.died` / `level.completed`. The game therefore
   exports a composed plugin — mode systems + `@aegis/content`'s `healthSystem` + the game systems —
   and the acceptance test/gametest use it. The spec's assertion block is otherwise unchanged. **No
   frozen contract was edited.**

2. **`platform.boarded` is emitted by the _mode_, not the game.** Rider carry is mode-owned (per your
   ruling), so the boarding fact originates where the carry happens. The events table still lists it
   under "game" for reader convenience; treat the mode as the true source. If you'd rather the game
   re-emit it at the semantic altitude, say so and I'll add a game-layer re-emit.

3. **The lava ferry became an always-bridging shuttle.** With "hold Right the whole way," the player
   walks at 0.133 u/tick _relative to_ any platform, so on a platform that doesn't fully span the gap
   the player gains on its front edge and walks off into the lava regardless of phase. To keep the
   run robust and phase-independent while still exercising kinematic carry + boarding, the gap is
   2 tiles (cols 21–22) and the 3-tile platform shuttles x21.5–22.5, always covering it. `platform.
boarded` still fires and the `y > -4` invariant proves the platform held the rider over the lava.
   If you want a "true ferry" (ride a platform that starts docked, detaches, crosses a wide gap, and
   re-docks) the script must _stop_ holding Right while aboard — flag me and I'll add a `release`
   window to the input DSL script.

4. **`hashEquals(result.hash)` is self-referential** in the spec block (it compares the result to its
   own hash, so it always passes). Determinism is proven _separately and for real_ in the acceptance
   test: two independent `runScene` calls produce identical `hash` **and** identical `tickHashes`,
   and `result.replay()` reproduces both. Consider pinning a literal golden hash centrally if you
   want the assertion to catch drift.

5. **`games/*` is not wired into root config** (workspaces, vitest `include`, tsconfig references).
   The authoritative run therefore lives in the owned package
   `packages/mode-platformer/src/coyote-gap.acceptance.test.ts` and imports the game by relative path;
   the game's own `games/platformer/src/coyote-gap.gametest.ts` is not auto-discovered until you wire
   `games/*` in centrally. Nothing outside `packages/mode-platformer/**` and `games/platformer/**`
   was touched.

Tuned geometry/timing vs the design sketch: level rebuilt to the column layout in _Level layout_
above (flat 0–6, spike pit 7–9, plateau 10–20, lava 21–22, ledge 23–33, coyote gap 34–35, landing
36–39, +1 pillar 40–42, wall 43); critter patrols x15–17 (so the stomp lands mid-plateau and the
bounce stays on it); jump apex measured ≈ 2.3 tiles; playthrough presses retuned to @28/@74/@238/@266.
