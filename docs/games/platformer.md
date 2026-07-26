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
| `moveSpeed`       | 8 u/s        | 0.133 u/tick; 46-tile level ≈ 328 ticks to completion     |
| `jumpSpeed`       | 16 u/s       | apex ≈ 2.3 tiles, reached in ~16 ticks                    |
| `gravity`         | 60 u/s²      | 1 u/s added downward per tick                             |
| `maxFallSpeed`    | 30 u/s       | terminal velocity, caps pit-fall                          |
| `coyoteTicks`     | 6            | jump still fires up to 6 ticks after leaving a ledge      |
| `jumpBufferTicks` | 6            | a jump pressed up to 6 ticks before landing still fires   |
| `TileCollider`    | half 0.4×0.5 | slightly narrower than a tile so corners forgive          |
| `Health`          | 1 / 1        | one-hit death (`Health` is shared, from `@aegis/content`) |

Derived: a running jump stays airborne ~32 ticks and travels ~4.3 tiles horizontally, so a **3-tile
pit is comfortably clearable and a 4-tile pit is at the ragged edge**. The level uses a 3-tile spike
pit, a **7-tile lava gap** (too wide to jump — crossed only by riding the ferry), and a 2-tile
coyote gap.

**Enemy "critter"** — a game-owned `PatrolSystem` (deterministic, no RNG):

- Its position at tick _t_ is a pure function of _t_: `patrolX(t)` is a **triangle wave** between
  `minX = 15` and `maxX = 17` at 3 u/s (0.05 u/tick, period 80 ticks). It is not a physics body and
  there is no contact test — it never collides with a wall and never "reverses on contact"; the
  wave _is_ the turn-around, which is what makes it reproducible tick-for-tick and hashable.
- **Stomp:** if the player's collider overlaps the critter while the player's `Velocity.dy < 0`
  (descending) and the player's feet are above the critter's centre → `enemy.killed`, and the
  player receives a small bounce (`dy = 10`).
- **Gore:** any other overlap (side/below) → `damage.taken` then `player.died` the same tick.
  Proven by the `coyote gap (lose): walk into the critter instead of stomping it` playthrough,
  which is the winning script minus the stomp press: it must emit `player.died{cause:'critter'}`
  and **no** `enemy.killed`.

**Moving platform ("the ferry")** — a kinematic solid entity provided and carried by the **mode**
(see _Engine scope_ below):

- A 3-tile-wide solid entity that shuttles horizontally over a **7-tile lava gap** (cols 20–26) at
  4 u/s. Its centre oscillates between x=21.5 (left dock) and x=26 (right dock); its period is a pure
  function of tick count. **It is deliberately non-bridging:** 3 tiles < 7, so at no instant does it
  span the gap. At the left dock it spans [20, 23] — flush with the plateau edge (x=20); at the right
  dock it spans [24.5, 27.5] — overlapping the ledge edge (x=27). The player therefore **cannot walk
  across**; they must board and be carried.
- The player standing on it is **carried** — its horizontal delta is added to the rider by the mode's
  collision resolution. Standing still while docked-then-crossing is the only way over the lava, which
  is exactly what makes carry load-bearing (if it regressed, the rider would be left over the lava and
  fall).

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

Authored as an ADR-0003 tilemap (`levels/coyote-gap.tilemap.json`), 46×12, `tileSize: 1`. Row 0 is
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
row  0 | .............................................#
row  1 | .............................................#
row  2 | .............................................#
row  3 | .............................................#
row  4 | .............................................#
row  5 | .............................................#
row  6 | ..........................................####
row  7 | #######...##########.......##########..#######
row  8 | #######...##########.......##########..#######
row  9 | #######...##########.......##########..#######
row 10 | #######^^^##########~~~~~~~##########..#######
row 11 | #######^^^##########.......##########..#######
         0         1         2         3         4
         0123456789012345678901234567890123456789012345
```

> This is the collision layer verbatim from `levels/coyote-gap.tilemap.json` (regenerated; the tuned
> geometry replaced the design-intent sketch — see _Implementation notes_). Entities are not in the
> tilemap; they sit in the scene at world coordinates: **player** x≈2.5, **critter** patrols x15–17
> on the plateau, **ferry** shuttles centre x21.5–26 over the 7-tile lava gap, **goal** trigger
> centred at x43.5 on the pillar.

Read left-to-right, the level is six beats, each proving one thing:

1. **cols 0–6 — flat start.** Player rests on ground (top row 7, surface y=5). Proves gravity settles
   a body to grounded and horizontal run works.
2. **cols 7–9 — the spike pit.** A 3-tile gap floored with `^^^` spikes (rows 10–11). Player must
   jump it; falling in = hazard death. Proves jump + landing on a raised solid + hazard death.
3. **cols 10–19 — the critter plateau.** The critter patrols x15–17 on the plateau. Player must
   stomp it (land from above) to pass; the stomp bounce drops back onto the same plateau. Proves
   deterministic AI + stomp-vs-gore discrimination (`Velocity.dy` sign + relative position).
4. **cols 20–26 — the lava gap + ferry.** A 7-tile pit floored with `~~~~~~~` lava (row 10) — too wide
   to jump. The 3-tile kinematic ferry is non-bridging, so the player runs to the plateau lip, **stops
   on solid ground**, waits for the ferry to dock left, steps aboard (`platform.boarded`), then
   **stands still and is carried** across the lava, stepping off at the right dock onto the ledge.
   Proves collision against **non-static geometry** and load-bearing rider carry.
5. **cols 27–36 — the coyote ledge.** Player runs off the right edge of the ledge (x=37) and must
   press Jump _just after_ leaving it; the 6-tick coyote window makes the late press valid. Proves
   coyote time is actually implemented (without it the jump is eaten and the player dies in the gap).
6. **cols 37–45 — the coyote gap + goal.** A 2-tile gap (cols 37–38), a landing platform (cols 39–41,
   surface y=5), then a +1 goal pillar (cols 42–45, surface y=6 — row 6 is solid at 42–45, so the
   pillar top is 4 tiles wide) capped by the wall column at col 45. Player coyote-jumps the gap,
   then buffers a jump before touchdown to mount the pillar and enter the goal trigger (centred at
   x=43.5). Proves jump-buffering and goal detection. The gap has **no hazard volume under it** —
   falling in drops the player out of the world, which is the `fell` death cause.

## Win and lose conditions

- **Win:** exactly one `level.completed` event AND no `player.died` event.
- **Lose:** any `player.died` event (fell in a pit, hit spikes/lava, or gored by the critter), or
  the run ends without `level.completed`.

Both are machine-checkable purely from the event log; no pixel inspection.

**All three lose paths are shipped as playthroughs**, not just described. `src/coyote-gap.gametest.ts`
exports three more `defineGameTest`s alongside the winning one, each of which is the winning script
with exactly one thing removed:

| Playthrough          | Script                           | Asserts                                                         |
| -------------------- | -------------------------------- | --------------------------------------------------------------- |
| `spikePitDeathTest`  | no jump at all                   | `player.died{cause:'hazard'}` ×1 at t43, no win                 |
| `critterGoreTest`    | winning script − `@74`           | `player.died{cause:'critter'}` ×1 at t91, **no** `enemy.killed` |
| `fellOutOfWorldTest` | winning script − both late jumps | `player.died{cause:'fell'}` ×1 at t319, no win                  |

Without them `eventNotEmitted('player.died')` in the winning run is vacuous: it passes even with
the death emitter deleted, because nothing in the suite ever emits one. (Verified by mutation: the
three deaths and the emitter itself are each independently killable, and each kills a test.)

## Events emitted

| Event              | Payload                                   | Emitted by | When                                           |
| ------------------ | ----------------------------------------- | ---------- | ---------------------------------------------- |
| `player.jumped`    | `{ tick, fromGround: boolean }`           | mode       | a jump actually launches (incl. coyote/buffer) |
| `player.landed`    | `{ tick }`                                | mode       | body transitions airborne → grounded           |
| `platform.boarded` | `{ name }`                                | mode       | player begins riding the ferry (carry begins)  |
| `enemy.killed`     | `{ name, tick }`                          | game       | player stomps the critter                      |
| `damage.taken`     | `{ amount, source: 'critter'\|'hazard' }` | game       | player is gored / touches hazard               |
| `player.died`      | `{ cause, tick }`                         | game       | death, emitted once                            |
| `level.completed`  | `{ tick }`                                | game       | player reaches the flag, emitted once          |

`platform.boarded`, `player.jumped` and `player.landed` are **mode**-emitted mechanical facts (the
engine reports what physically happened); the game systems emit the fiction (`enemy.killed`,
`player.died`, `level.completed`). This is the two-altitude event model from the working agreement:
the mode never emits game fiction, and the game never re-emits a mechanical fact.

## The scripted playthrough

`play/coyote-gap.input` (ADR-0004 DSL). These are the **tuned** frames, verified against the real
physics by the acceptance test. Total ≈ **328 ticks to completion (~5.5 s sim time)**, resting on the
goal pillar by ~t349.

```text
press Jump @28          # beat 2: clear the spike pit onto the plateau
press Jump @74          # beat 3: stomp the critter from above -> enemy.killed + bounce

hold Right 0..126       # beats 1-3: run to the lip of the lava gap, then STOP on solid ground
hold Right 138..152     # beat 4a: the ferry has docked left -> step aboard (platform.boarded)
                        # beat 4b: ticks 152..189 Right is UN-HELD -- we stand still and the
                        #          ferry carries us across the lava (x rises with no input)
hold Right 190..400     # beat 4c: ferry reaches the right dock -> walk off onto the ledge, then
                        #          keep running toward the coyote gap
press Jump @288         # beat 5: coyote jump, pressed a few ticks after running off the ledge
press Jump @317         # beat 6: buffered jump, pressed before touchdown to mount the pillar
```

Notes for the implementer:

- **The gap in the Right hold is the whole point of beat 4.** The ferry is non-bridging, so a
  continuous "hold Right" would walk the player off its front edge into the lava (the player moves
  0.133 u/tick _relative to_ the 0.067 u/tick ferry). Instead the player stops on the plateau lip,
  boards when the ferry docks left, then **releases Right (ticks 152–189) and is carried** across
  purely by the moving solid, re-holding only to step off at the right dock. If carry regressed, the
  ferry would slide out from under the stationary player and `player.died` (cause `fell`) would fire.
- The two "timing proof" presses are deliberate: `@288` fires _after_ the player has left the ledge
  (proves coyote — telemetry shows `fromGround:false`), `@317` is buffered _before_ the landing
  contact at t320 and fires on touchdown at t321 (proves jump buffer — telemetry shows the buffer
  latch then a `fromGround:true` jump one tick later). If either window regresses, the corresponding
  jump is eaten and the run ends in `player.died`, so the test fails loudly.
- If tuned tick numbers drift, keep the _semantics_ (stomp from above, board + stand still + ride the
  ferry across, late-jump the ledge, buffer onto the pillar) — those are what the assertions check.

## The gameplay assertions

> **The composed plugin is the pattern.** A game composes the mode plugin into its own plugin —
> `coyoteGapPlugin` = mode systems + `@aegis/content`'s `healthSystem` + the game systems — and runs
> that. This is the blessed engine-wide pattern (PM ruling): `ModePlugin` stays the single seam
> through which systems enter the schedule, so there is exactly one way for a game to add behaviour.
> The bare `platformerPlugin` alone cannot emit the game-semantic events (`enemy.killed`,
> `player.died`, `level.completed`) — those are game systems. The block below is the **actual**
> authoritative test; it lives at `games/platformer/src/coyote-gap.gametest.ts` (which defines it,
> along with the three lose playthroughs) and `games/platformer/test/coyote-gap.test.ts` (which
> drives them under vitest).

```ts
import { defineGameTest, expectSim } from '@aegis/harness';
import { coyoteGapPlugin } from 'games/platformer'; // composed: mode + content + game systems
import { Transform } from '@aegis/core';
import { BodyState } from '@aegis/mode-platformer';

export default defineGameTest({
  name: 'coyote gap: stomp, ferry across the lava, coyote-jump, buffer onto the flag',
  scene: 'games/platformer/levels/coyote-gap.scene.json',
  options: { plugin: coyoteGapPlugin, captureHistory: true },
  ticks: 400,
  seed: 'poc-platformer',
  input: `
    hold Right 0..126
    press Jump @28
    press Jump @74
    hold Right 138..152
    hold Right 190..400
    press Jump @288
    press Jump @317
  `,
  expect(result) {
    expectSim(result)
      .eventEmitted('level.completed', 1) // finished, exactly once
      .eventNotEmitted('player.died') // survived the whole run
      .eventEmitted('enemy.killed', 1) // the critter was actually stomped
      .eventEmitted('platform.boarded', 1) // the ferry actually carried us
      .entityExists({ has: ['Player'] })
      .holds(
        'player ended on/past the goal pillar',
        (r) =>
          r
            .query({ has: ['Player', 'Transform'] })
            .one()
            .get(Transform).position.x >= 36,
      )
      .holds(
        'carried by the ferry while standing still (x advances with Right un-held, ticks 152–189)',
        (r) => {
          const sample = (tick) => {
            const v = r
              .at(tick)
              .query({ has: ['Player', 'Transform'] })
              .one();
            return { x: v.get(Transform).position.x, carriedBy: v.get(BodyState).carriedBy };
          };
          const before = sample(158);
          const after = sample(186);
          // On a moving solid (carriedBy != -1) with no input, only the carry can move x.
          return before.carriedBy !== -1 && after.carriedBy !== -1 && after.x > before.x;
        },
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

The `carried by the ferry` assertion is the load-bearing carry proof: it samples two ticks inside the
un-held window and requires the player's x to advance with no horizontal input, so it can only pass if
the moving solid carried the rider. The first invariant is the load-bearing physics check: if
collision or gravity regresses so the player clips through a platform or the pit floor, `position.y`
dips below `-4` on some tick and the invariant fails _at that tick_, pointing the implementer at
exactly when the physics broke.

### The trajectory pins (added after the mode-capability audit)

Everything above describes where the run **ends**, and this run ends at rest: parked on the goal
pillar, velocity zero, orders resolved. A final-state hash is therefore nearly blind to _dynamics_ —
a regression whose route differs but whose resting state converges sails straight through it. So the
game test also pins the shape of the run:

```ts
expectSim(result)
  // Coyote time is real: the ledge jump launched in mid-air.
  .holds('the coyote jump at t288 launched in mid-air (fromGround:false)', (r) => …)
  // Jump buffering is real: the t317 press produced no jump that tick, the player landed at
  // t320, and the buffered jump fired from the ground at t321.
  .holds('the buffered press at t317 was held and fired on the landing tick', (r) => …)
  // Four mid-run beat waypoints (t60 plateau, t126 lava lip, t186 mid-ferry, t300 airborne
  // over the coyote gap) — these are what a human reads when the digest moves.
  .holds('the run hit its four beat waypoints in order', (r) => …)
  // …and a golden digest of every tick's hash, which nothing can slip past.
  .holds('the per-tick hash timeline matches the golden trajectory', (r) =>
    trajectoryDigest(r.tickHashes) === GOLDEN_TRAJECTORY);
```

`trajectoryDigest` is `hashString(tickHashes.join('|'))` — core's frozen FNV-1a over the per-tick
hashes the harness already records, so the digest is exactly as portable and as deterministic as the
hashes it summarises. `tickHashes` were previously only compared run-to-run, which proves
determinism but adds zero regression detection; pinning them against a stored golden is what turns
them into a trajectory test.

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
| `GOLDEN_TRAJECTORY` digest        | The whole per-tick timeline, not just the resting state it converges on            |
| `assertInvariant` on `position.y` | Whole-timeline safety property, not just final state                               |
| The three lose playthroughs       | Hazard death, positional death, and the gore branch — each proven by a failing run |

Each row is backed by a mutation that turns it red. The ones that were **not** load-bearing before
the audit are: hazard death, fall-out-of-world death, stomp-vs-gore, the `player.died` emitter
itself, the coyote window, the buffer window, and the critter patrol.

## Implementation notes (platformer slice, as built)

The mode and game are implemented and green. These are the reality-vs-design-intent notes the PM
asked for; numbers reflect the merged code, not the original sketch above.

1. **Composed `coyoteGapPlugin` is the pattern (PM-blessed), not a workaround.** A game composes the
   mode plugin into its own plugin — mode systems + `@aegis/content`'s `healthSystem` + the game
   systems — and runs that. `ModePlugin` is the single seam through which systems enter the schedule
   (`RunOptions` deliberately has no separate systems hook, which would create two injection paths
   with ambiguous ordering), so this is the one and only way a game adds behaviour. The doc's original
   `plugin: platformerPlugin` was shorthand from before the pattern existed; the block above is the
   real thing. **No frozen contract was edited.**

2. **`platform.boarded` is emitted by the _mode_.** Rider carry is mode-owned (per ruling), so the
   boarding fact originates where the carry happens — a mechanical fact at the engine altitude. The
   events table lists it under "mode"; the game does not re-emit it (that would collapse the
   two-altitude model).

3. **The lava ferry is a true, non-bridging ferry.** The gap is **7 tiles** (cols 20–26) and the
   3-tile ferry can never span it, so the player cannot walk across — an earlier always-bridging
   shuttle was replaced because a bridge makes carry non-load-bearing (you could just walk over it and
   the PoC would stop testing carry). The script boards at the left dock, **releases Right for ticks
   152–189** so the rider stands still and is carried by the moving solid, and re-holds only to step
   off at the right dock. This uses the input DSL exactly as designed: a half-open `hold Right a..b`
   leaves Right un-held in the gap between two holds. The `carried by the ferry` assertion + the
   `y > -4` invariant + `eventNotEmitted('player.died')` together fail loudly if carry ever regresses:
   a stationary rider would be left over the lava and fall.

4. **`hashEquals(result.hash)` is self-referential** in the game test as shipped (it compares the
   result to its own hash, so it always passes) — a separate session is replacing it with the
   literal golden `d813e4e19db7444d`. Determinism is proven _separately and for real_ in the
   acceptance test: two independent `runScene` calls produce identical `hash` **and** identical
   `tickHashes`, and `result.replay()` reproduces both. Independently of that, `GOLDEN_TRAJECTORY`
   (a digest of the whole per-tick hash timeline) **is** a literal golden and does catch drift —
   including drift a final-state hash cannot see.

5. **`games/*` is wired into root config.** Each game is an npm workspace, a tsconfig project
   reference and part of the root vitest `include`, so `games/platformer/test/coyote-gap.test.ts`
   runs under `npm run verify` and drives the game's own `defineGameTest`s directly. (An earlier
   note here described an interim arrangement where the authoritative run lived in
   `packages/mode-platformer`; that file no longer exists.)

Tuned geometry/timing vs the design sketch: level rebuilt to the column layout in _Level layout_
above (flat 0–6, spike pit 7–9, plateau 10–19, **lava gap 20–26**, ledge 27–36, coyote gap 37–38,
landing 39–41, +1 pillar 42–45); critter patrols x15–17 (so the stomp lands mid-plateau and
the bounce stays on it); the ferry runs at 4 u/s so the rider can board, be carried, and step off
within one crossing; jump apex measured ≈ 2.3 tiles; playthrough presses retuned to @28/@74 (pit,
stomp) and @288/@317 (coyote, buffer), with the ferry expressed as gapped `hold Right` windows.
