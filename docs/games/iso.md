# Isometric PoC — "The Server Vault"

> Isometric / three-quarter tactical. Reference feel: _Fallout 2_, _Dragon Age: Origins_.
> Mode: `iso` (`@aegis/mode-iso`). Runs headless, verified without pixels.

## Concept and fantasy

A one-agent tactical infiltration on a grid. You control a single operative who must slip through a
walled server vault, flip a security switch to unlock the sealed data-room door, and reach the
exit — but a guard walks a fixed patrol across the only corridor connecting the map, and the moment
it sees you it opens fire. You engage it Dragon-Age-style: click the guard, trade shots on a
cooldown, and drop it before it drops you. There is no dice-roll — the guard's route and its firing
cadence are clockwork, the walls are fixed, and success is reading the grid, winning the one
firefight, and threading the door. For its 30–45 seconds it is a compressed Fallout/DA:O tactical
beat: _move, hold, fight, move_.

## Core loop

Look at the grid → **click a destination cell** to path-move, or **click the hostile guard** to
attack it → trade fire on cooldown until the guard dies → flip the switch → cross to the exit. Two
verbs, both expressed as `click`: click empty ground = move; click a hostile = attack-move (path
into weapon range, then fire on cooldown). The engine does the pathfinding, stepping and combat
resolution.

## Mechanics (design intent — implementers may tune)

Grid is integer cells; `tileSize: 1`. Tick rate 60Hz.

**Operative** — `GridPosition` + `IsoActor` + `Health` + `Attacker`, and (on click) `MoveOrder` or
`AttackOrder`:

| Tunable                  | Value                      | Consequence                                                  |
| ------------------------ | -------------------------- | ------------------------------------------------------------ |
| `IsoActor.speed`         | 4 cells/s                  | 15 ticks per cell                                            |
| `IsoActor.moveMode`      | `realtime`                 | smooth sub-cell `progress`, logical position stays integer   |
| pathfinding              | 4-neighbour (no diagonals) | Manhattan grid; deterministic tie-break by (x then y)        |
| `Health`                 | 30 / 30                    | operative HP (`Health` is now shared, from `@aegis/content`) |
| `Attacker.rangeCells`    | 3                          | max attack distance (Chebyshev) with clear line of sight     |
| `Attacker.damage`        | 10                         | per shot                                                     |
| `Attacker.cooldownTicks` | 30                         | 0.5 s between the operative's shots                          |

> **Tuned from design intent (range 4 → 3).** The spec's operative range of 4 exceeds the guard's
> detection/return-fire range of 3, so an attack-move would halt one cell outside the guard's reach
> and snipe it for **zero** return fire — making the golden "exactly two hits / Health 20" outcome
> mechanically unreachable. Dropping the operative's range to 3 forces a genuine close-quarters
> trade (both combatants at Chebyshev 3), which is the firefight the fiction describes. The
> operative still wins the exchange decisively via its faster cooldown (30 < 40).

Two operative shots (10 + 10) kill the guard (HP 20).

**The guard** — `GridPosition` + `IsoActor` + `Health` + `Attacker`, driven by a deterministic
`PatrolSystem` + `CombatSystem` (RNG-free):

| Tunable                  | Value                             | Consequence                                                |
| ------------------------ | --------------------------------- | ---------------------------------------------------------- |
| patrol                   | (1,5) ⇄ (10,5), 1 cell / 20 ticks | clockwork ping-pong along row 5                            |
| detection                | Chebyshev ≤ 3 with line of sight  | seeing the operative flips it hostile                      |
| `Health`                 | 20 / 20                           | dies to two operative shots                                |
| `Attacker.rangeCells`    | 3                                 | return-fire range                                          |
| `Attacker.damage`        | 5                                 | per shot                                                   |
| `Attacker.cooldownTicks` | 40                                | slower than the operative, so the trade favours the player |

- **Patrol** is a pure function of tick, `patrolCell(t)`: `leg = floor((t mod 360) / 20)`; legs 0–9
  place the guard at `x = 1 + leg` (sweeping (1,5)→(10,5) over t0–180) and legs 10–17 at
  `x = 19 - leg` (sweeping back (9,5)→(2,5) over t180–340), then the cycle repeats — a clockwork
  triangle-wave ping-pong along row 5, 1 cell / 20 ticks, period 360. Reproducible tick-for-tick
  until combat begins. **The scripted playthrough deliberately lets it run:** the operative holds
  its spawn (1,1) for the first 40 ticks, where the guard is never closer than Chebyshev 4 and so
  cannot detect it, then descends and _chases the patrol up the corridor_. By the time the guard
  turns hostile at **t178** it stands at **(9,5)** — eight legs from its spawn — and the game test
  asserts `guardCell(t) === patrolCell(t)` on **every** tick before the alert.
- **Detection → fight, not fail.** When the guard sees the operative it emits `guard.alerted` and
  becomes hostile; it stops patrolling, freezes on its current cell, and fires every 40 ticks while
  the operative is in range. The freeze is asserted too (the guard's cell stays (9,5) for the rest
  of the run), so neither half of the `Hostile` latch can regress unnoticed.
- Expected exchange (golden outcome, as implemented): the operative chases the guard to the middle
  of the corridor; the guard detects it at **t178** from (9,5) and opens fire (hits at t178 and
  t218). The operative attack-moves onto the guard at t195 and kills it with two shots by **t225** —
  after the guard has landed **exactly two** 5-damage shots, so the operative ends the fight at
  **Health 20**. The operative's delayed engagement (letting the guard fire first as it closes) is
  what yields two hits rather than one; the outcome is a specific, non-zero, reproducible amount of
  damage taken.

> **How `click` becomes an attack:** clicking a cell occupied by a hostile actor writes an
> `AttackOrder{ target }` instead of a `MoveOrder`. The mode's `CombatSystem` moves the operative
> to within `Attacker.rangeCells` of the target (reusing the pathfinder), then fires on cooldown,
> applying `Attacker.damage` to the target's `Health` and emitting the combat events below. This
> keeps the whole game on the single `click` verb from ADR-0004.

**The sealed door** — a `Blocking` entity at cell (4,6), the sole link between the corridor and the
data-room. A `Trigger` volume (from `@aegis/content`) on the switch cell (9,1) fires when the
operative enters it; a `SwitchSystem` removes the door's `Blocking` tag, emitting `switch.activated`
then `door.opened`. **Clicking the exit before the switch is flipped yields `path.blocked`** (no
route exists) — and the _winning_ playthrough does exactly that, mid-run, so the gate is proven by
the main run rather than only by a side test: the exit is clicked at t300 while the operative is
still climbing the col-9 shaft and the door is still sealed (`path.blocked`, the in-flight order is
dropped), and the **same** target only resolves after `door.opened` at t330. Blocked-then-resolved
on one target is the proof that pathfinding re-resolves against a _mutated_ grid, not a cached one.

**Exit** — a `Trigger` volume on exit cell (4,7): operative enters → `mission.completed`.

**Death** — the operative's `Health` reaching 0 → `player.died` (once), mission failed.

> **Engine scope (per PM ruling):** `Health` and the `Trigger`/volume component are now **shared
> gameplay vocabulary in `@aegis/content`**, and `mode-iso` gains a **real-time-with-cooldown**
> combat surface (an `Attacker` component + `CombatSystem` + `AttackOrder`). Turn-based
> initiative is deferred to v2. This PoC is designed to those decisions; the exact `Attacker`
> shape is owned by the `mode-iso` session — the numbers above are design intent.

## Level layout

Authored as an ADR-0003 tilemap (`levels/server-vault.tilemap.json`), 12×9, `tileSize: 1`. Row 0 is
the top. Operative, guard, switch-trigger, door and exit-trigger are scene entities placed by cell;
walls/floor live in the tilemap's `collision` layer.

Legend:

```
#  wall  (solid tile, impassable)     .  floor (passable)
S  operative spawn cell (entity)      X  exit / objective cell (Trigger volume)
K  security switch cell (Trigger)     D  sealed door  (Blocking entity, removed on switch)
~  guard patrol lane (floor; guard entity patrols row 5)
```

Collision layer (walls only; `S`/`K`/`X`/`D`/`~` are shown for orientation but the tile under each
is plain floor):

```
        col: 0         1
             012345678901
      row 0 |############|
      row 1 |#S..#...#K.#|   S=(1,1)  K=(9,1)
      row 2 |#.#.#.#.#..#|
      row 3 |#.#...#...##|
      row 4 |#.###.#.##.#|
      row 5 |#....~.....#|   guard patrols (1,5)‥(10,5)
      row 6 |####D#######|   D=(4,6)  sole corridor→data-room link
      row 7 |#...X......#|   X=(4,7)
      row 8 |############|
```

Connectivity (why this needs a real pathfinder, not a straight line):

- **S (1,1) → corridor:** the only way down is the winding left column `(1,1)→(1,5)`, threading
  single-tile gaps at rows 2–4. A greedy "move toward target" walk hits a wall; BFS/A* is required.
- **Corridor (row 5) → switch K (9,1):** cross row 5 rightward to the vertical shaft at **col 7**
  `(7,5)→(7,4)→(7,3)`, jog right `(8,3)→(9,3)`, then up col 9 `(9,2)→(9,1)=K`. Every other apparent
  route is blocked — the pathfinder must find the one shaft.
- **The door gate:** the data-room (row 7) connects to the rest of the map through **exactly one**
  cell, the door **D (4,6)**. While `D` is `Blocking`, `X` is unreachable → `path.blocked`. After
  the switch, `(4,5)→(4,6)→(4,7)=X` opens. This is the dynamic-repath proof.
- **The guard** owns row 5, the chokepoint the operative must traverse. The canonical solution is to
  **engage and destroy the guard** here (the firefight beat) so the corridor is safe for the switch
  run and the return to the door.

## Win and lose conditions

- **Win:** exactly one `mission.completed` event AND no `player.died` event.
- **Lose:** any `player.died` event (guard fire drained the operative's `Health` to 0), or the run
  ends without `mission.completed`.

Fully machine-checkable from the event log and final `GridPosition`/`Health`.

**The lose path is shipped as a playthrough**, not just described. `serverVaultDeathTest` (exported
from `src/server-vault.ts`) steps the operative to (1,2) at t2 and then gives it **no further
orders**: the guard spots it at t18 and lands its 5-damage shot every 40 ticks until the operative's
30 HP is gone at **t218**. It asserts `player.died` ×1 with `cause: 'guard'`, `damage.taken` ×6,
final `Health === 0`, and neither `mission.completed` nor `enemy.killed`.

Without it, the winning run's `eventNotEmitted('player.died')` is vacuous — it passes even if the
death emitter is deleted, because nothing in the suite ever emits one.

## Events emitted

| Event               | Payload                         | Emitted by | When                                             |
| ------------------- | ------------------------------- | ---------- | ------------------------------------------------ |
| `move.ordered`      | `{ target: {x,y} }`             | mode       | a `click` on empty ground produces a `MoveOrder` |
| `attack.ordered`    | `{ target }`                    | mode       | a `click` on a hostile produces an `AttackOrder` |
| `path.resolved`     | `{ target, length }`            | mode       | pathfinder finds a route                         |
| `path.blocked`      | `{ target }`                    | mode       | no route exists to the clicked cell              |
| `cell.entered`      | `{ x, y, tick }`                | mode       | operative arrives at a new cell                  |
| `guard.alerted`     | `{ tick }`                      | game       | guard sees the operative and turns hostile       |
| `attack.fired`      | `{ attacker, target, tick }`    | mode       | either combatant fires a shot                    |
| `enemy.damaged`     | `{ name, amount, remaining }`   | mode       | the guard takes a hit                            |
| `enemy.killed`      | `{ name, tick }`                | mode       | the guard's `Health` reaches 0                   |
| `damage.taken`      | `{ amount, source, remaining }` | mode       | the operative is hit by the guard                |
| `switch.activated`  | `{ name }`                      | game       | operative enters the switch trigger              |
| `door.opened`       | `{ name }`                      | game       | the door's `Blocking` tag is removed             |
| `player.died`       | `{ cause, tick }`               | game       | operative `Health` ≤ 0, once                     |
| `mission.completed` | `{ tick }`                      | game       | operative enters the exit trigger, once          |

## The scripted playthrough

`play/server-vault.input` (ADR-0004 DSL, mirroring `SERVER_VAULT_SCRIPT` in `src/server-vault.ts`).
Click-to-move/attack is issued as `click x,y @tick` at grid cells; between clicks the operative
auto-paths, fights or idles. These are the exact tuned frames the acceptance test runs; the golden
outcome (guard dead, operative at Health 20, mission completed at t505) holds against them. Budget
**960 ticks (~16 s sim time)**; the run resolves well inside it.

```text
# The Server Vault — infiltrate, win the firefight, breach the vault. Clicks are grid cells (x,y).

click 1,5 @40     # 1) hold the spawn first. At (1,1) the guard is never closer than Chebyshev 4,
                  #    so it cannot see us and the clockwork patrol really walks. Then descend the
                  #    winding left column — A* around single-tile gaps.
click 7,5 @102    # 2) chase it up the corridor. The patrol has swept (1,5) -> (9,5) — eight legs —
                  #    before it turns and spots us at t178, and freezes on (9,5) when it does.
                  #    -> guard.alerted
click 9,5 @195    # 3) attack-move onto the guard -> AttackOrder: it fires at t178 and t218, we kill
                  #    it at t225 with two shots. -> enemy.killed, damage.taken x2 (Health 20)
click 9,1 @232    # 4) head for the security switch: cross to the col-7 shaft and start climbing.
click 4,7 @300    # 5) try the vault while still climbing the col-9 shaft. The door is still sealed,
                  #    so the pathfinder honestly reports path.blocked and drops the in-flight order.
click 9,1 @308    # 6) resume to the security switch; reaching (9,1) at t330 unseals the vault door.
                  #    -> switch.activated, door.opened
click 4,7 @340    # 7) the SAME target now resolves against the mutated grid, back along row 5 and
                  #    through the open door. -> mission.completed at t505
```

Notes for the implementer:

- **The opening wait is load-bearing, not padding.** Clicking at t2 (as an earlier script did) gets
  the operative spotted at t18 with the guard still standing on its spawn cell — which meant
  `patrolSystem` could be frozen, or its body deleted outright, with the whole suite green and the
  golden hash unchanged. Detection needs Chebyshev ≤ 3 _and_ line of sight, and from the left column
  only a guard at x ≤ 2 has both (the wall run at (2,4)–(4,4) occludes the rest), so the guard must
  either be on its spawn or be met out in the corridor. The script meets it in the corridor.
- **Dynamic-repath proof, in the main run.** Beat 4 clicks the exit _before_ the switch, so the
  winning playthrough itself asserts `path.blocked` ×1 and that its tick precedes `door.opened`,
  which precedes `mission.completed`. The companion cold-start negative test (click `4,7` at tick 5
  and assert `path.blocked` with no `mission.completed`) lives in `games/iso/test/server-vault.test.ts`.
- The attack click at `@195` targets the guard's frozen cell (9,5). The `AttackOrder` targets the
  guard _entity_, not a fixed cell, so it stays correct even if the guard is mid-patrol when clicked.
  Keep the _semantics_ (let the patrol run, engage the guard, let it fire, kill it before it kills
  you, find the vault sealed, flip the switch, breach) even if tuned ticks drift; the assertions
  check the outcome, not the frames.
- Because the game ships a composed `ModePlugin` (the frozen `RunOptions` has no extra-systems
  hook), the test's `plugin` is the game's **`serverVaultPlugin`**, not the mode's bare `isoPlugin`.

## The gameplay assertions

```ts
import { defineGameTest, expectSim } from '@aegis/harness';
import { GridPosition } from '@aegis/mode-iso';
import { Health } from '@aegis/content';
// The game ships a composed ModePlugin (mode systems + its own semantic systems), the wall cells
// derived from the level's collision rows, and the two pinned goldens.
import {
  serverVaultPlugin,
  WALL_CELLS,
  GOLDEN_HASH,
  GOLDEN_TRAJECTORY,
  patrolCell,
  trajectoryDigest,
} from './server-vault';

export default defineGameTest({
  name: 'server vault: win the firefight, open the door, reach the exit',
  scene: 'games/iso/levels/server-vault.scene.json',
  options: { plugin: serverVaultPlugin, captureHistory: true },
  ticks: 960,
  seed: 'poc-iso',
  input: `
    click 1,5 @40
    click 7,5 @102
    click 9,5 @195
    click 9,1 @232
    click 4,7 @300
    click 9,1 @308
    click 4,7 @340
  `,
  expect(result) {
    expectSim(result)
      .eventEmitted('mission.completed', 1) // reached the exit, once
      .eventEmitted('enemy.killed', 1) // the guard was actually defeated (DoD §4.3)
      .eventEmitted('damage.taken', 2) // took exactly two guard hits...
      .eventNotEmitted('player.died') // ...but survived (and see the lose playthrough)
      .eventEmitted('switch.activated', 1) // the switch was actually flipped
      .eventEmitted('door.opened', 1) // which opened the sealed door
      .eventEmitted('path.blocked', 1) // the sealed door really did gate the exit, mid-run
      .entityExists({ has: ['Operative'] })
      .holds('operative ended on the exit cell (4,7)', (r) => …)
      .holds('operative took the correct damage (30 - 2x5 = 20)', (r) => …)
      // The clockwork patrol actually walks: the guard's cell equals patrolCell(t) on EVERY tick
      // before the alert at t178, it had reached (9,5) by then, and it freezes there afterwards.
      .holds('the guard walks patrolCell(t) on every tick before it alerts (t < 178)', (r) => …)
      .holds('the patrol had carried the guard to (9,5) before it opened fire', (r) => …)
      .holds('a hostile guard holds its ground instead of patrolling on', (r) => …)
      // The cooldown clock, pinned behaviourally: the guard's 40-tick cadence and the operative's
      // 30-tick one put the four shots on exactly these ticks.
      .eventEmitted('attack.fired', 4)
      .holds('the firefight ran on its golden cadence (shots on ticks 178, 195, 218, 225)', (r) => …)
      // The route is re-resolved against the mutated grid: blocked, then opened, then traversed.
      .holds('the exit was unreachable while the door was sealed, and reachable only after', (r) => …)
      // The whole trajectory, not just the resting state it converges on.
      .holds('the per-tick hash timeline matches the golden trajectory', (r) =>
        trajectoryDigest(r.tickHashes) === GOLDEN_TRAJECTORY)
      .hashEquals(GOLDEN_HASH); // pin the golden state hash (determinism)

    // Whole-timeline invariant #1 — pathfinding correctness: never stand in a wall.
    result.assertInvariant('operative is always on a passable cell', (w) => {
      const g = w
        .query({ has: ['Operative', 'GridPosition'] })
        .one()
        .get(GridPosition);
      return WALL_CELLS.every((c) => !(c.x === g.cellX && c.y === g.cellY));
    });

    // Whole-timeline invariant #2 — bounded, deterministic incoming damage.
    result.assertInvariant(
      'operative health never dropped below the golden floor',
      (w) =>
        w
          .query({ has: ['Operative', 'Health'] })
          .one()
          .get(Health).current >= 20,
    );
  },
});
```

Invariant #1 fails the instant a pathfinding bug walks the operative through a wall. Invariant #2
pins the guard's firing cadence: if combat resolution or the patrol/AI regresses (wrong phase,
extra shot, non-deterministic ordering) the operative takes more than 10 damage and health dips
below 20 on some tick — failing precisely when the AI drifted.

### Why a trajectory digest and not just `hashEquals`

`GOLDEN_HASH` is a hash of the **final** world, and this run ends at rest — operative parked on the
exit, guard dead, every order resolved. Two runs whose trajectories differ can therefore converge on
a byte-identical final state. Measured on this very level: moving the last click from t340 to t420
delays `mission.completed` from t505 to t585 — an 80-tick difference across the entire back half of
the map — and leaves `GOLDEN_HASH` **byte-identical** at `cb0f07007ad8608a`, while the trajectory
digest moves from `2c6881a477e2d268` to `3d533c9edb70690f`. `GOLDEN_TRAJECTORY` is
`hashString(tickHashes.join('|'))` — core's frozen FNV-1a over the per-tick hashes the harness
already records — so any changed trajectory goes red. (`tickHashes` were previously compared only
run-to-run, which proves determinism but adds no regression detection.)

The digest is the safety net, not the diagnosis. The named assertions above it come first in the
chain on purpose: a cooldown-cadence regression should report "the firefight ran on its golden
cadence" and a frozen patrol should report the guard's cell, because "a hash moved" is the least
actionable diagnostic the engine can produce (CHARTER principle 8).

## What this game proves about the engine

| Game element                      | Engine capability exercised                                                  |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Winding path S → corridor         | Grid pathfinding around single-tile gaps (not a straight line)               |
| The col-7 shaft to the switch     | A*/BFS finding the one valid route among decoys                              |
| `click x,y` on ground             | Pointer/`click` input → `MoveOrder` (ADR-0004 iso path)                      |
| `click` on the guard              | Pointer input → `AttackOrder`: attack-move + fire on cooldown                |
| Cell-by-cell stepping             | `IsoActor` realtime interpolation, integer logical `GridPosition`            |
| The firefight                     | Shared `Health`, `Attacker` cooldown combat, `enemy.killed` + `damage.taken` |
| Guard patrol + detection          | Deterministic, RNG-free AI as a pure function of tick, LOS check             |
| The firefight cadence             | `Attacker.cooldownTicks` clock — the four shots land on their golden ticks   |
| Door blocks, then opens           | `Blocking` tag mutation forcing pathfinding **re-resolution**                |
| `path.blocked` mid-run            | Pathfinder correctly reports "no route" on a gated grid, in the winning run  |
| Switch / exit triggers            | Shared `Trigger`/volume component from `@aegis/content`                      |
| Reaching the exit                 | Event emission + one-shot latching (`mission.completed` once)                |
| `hashEquals` + repeated run       | Byte-identical determinism (ADR-0001)                                        |
| `GOLDEN_TRAJECTORY` digest        | The whole per-tick timeline, not just the resting state it converges on      |
| The lose playthrough              | `player.died{cause:'guard'}` — the guard can actually kill you               |
| Health / passable-cell invariants | Whole-timeline safety properties across a moving fight                       |
