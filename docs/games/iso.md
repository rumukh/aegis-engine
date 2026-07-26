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
| `Attacker.rangeCells`    | 4                          | max attack distance (Chebyshev) with clear line of sight     |
| `Attacker.damage`        | 10                         | per shot                                                     |
| `Attacker.cooldownTicks` | 30                         | 0.5 s between the operative's shots                          |

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

- **Patrol** is a pure function of tick: `phase = t mod 360`; sweeps 1→10 over the first 180 ticks,
  10→1 over the next 180. Reproducible tick-for-tick until combat begins.
- **Detection → fight, not fail.** When the guard sees the operative it emits `guard.alerted` and
  becomes hostile; it stops patrolling and fires every 40 ticks while the operative is in range.
- Expected exchange (design-intent golden outcome): the guard lands **exactly two** 5-damage shots
  before it dies, so the operative ends the fight at **Health 20** — a specific, non-zero,
  reproducible amount of damage taken.

> **How `click` becomes an attack:** clicking a cell occupied by a hostile actor writes an
> `AttackOrder{ target }` instead of a `MoveOrder`. The mode's `CombatSystem` moves the operative
> to within `Attacker.rangeCells` of the target (reusing the pathfinder), then fires on cooldown,
> applying `Attacker.damage` to the target's `Health` and emitting the combat events below. This
> keeps the whole game on the single `click` verb from ADR-0004.

**The sealed door** — a `Blocking` entity at cell (4,6), the sole link between the corridor and the
data-room. A `Trigger` volume (from `@aegis/content`) on the switch cell (9,1) fires when the
operative enters it; a `SwitchSystem` removes the door's `Blocking` tag, emitting `switch.activated`
then `door.opened`. **Clicking the exit before the switch is flipped must yield `path.blocked`** (no
route exists) — the proof that pathfinding re-resolves against a _mutated_ grid, not a cached one.

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

`play/server-vault.input` (ADR-0004 DSL). Click-to-move/attack is issued as `click x,y @tick` at
grid cells; between clicks the operative auto-paths, fights or idles. Ticks are design intent; the
implementer tunes exact frames so the golden outcome (guard dead, operative at Health 20) holds.
Total ≈ **900 ticks (~15 s sim time)**.

```text
# The Server Vault — infiltrate, win the firefight, breach the vault. Clicks are grid cells (x,y).

click 1,5   @2      # 1) path down the winding left column to the corridor mouth
                    #    (proves A* around single-tile gaps; ~60 ticks to arrive)
click 6,5   @120    # 2) click the GUARD's cell -> AttackOrder: close to range and open fire.
                    #    Trade shots on cooldown: 2 hits kill it (guard lands 2x5=10 first).
                    #    -> guard.alerted, attack.fired..., enemy.killed, damage.taken x2
click 9,1   @320    # 3) corridor now safe: climb the shaft to the switch
                    #    -> switch.activated, door.opened
click 4,7   @560    # 4) route back and through the now-open door to the exit
                    #    -> mission.completed
```

Notes for the implementer:

- **Dynamic-repath proof:** author a companion _negative_ test that clicks `4,7` at tick 5 (before
  the switch) and asserts `path.blocked` is emitted and `mission.completed` is not — the test that
  fails loudly if pathfinding ever ignores the door mutation.
- The guard's cell at `@120` is wherever its clockwork patrol places it then; the `AttackOrder`
  targets the guard _entity_, not a fixed cell, so it stays correct as the guard moves. Keep the
  _semantics_ (engage the guard, kill it before it kills you) even if tuned ticks drift; the
  assertions check the outcome, not the frames.

## The gameplay assertions

```ts
import { defineGameTest, expectSim } from '@aegis/harness';
import { isoPlugin, GridPosition } from '@aegis/mode-iso';
import { Health } from '@aegis/content';

const WALL_CELLS = /* exported from the tilemap's '#' tiles, alongside the scene */ [] as {
  x: number;
  y: number;
}[];

export default defineGameTest({
  name: 'server vault: win the firefight, open the door, reach the exit',
  scene: 'games/iso/levels/server-vault.scene.json',
  options: { plugin: isoPlugin, captureHistory: true },
  ticks: 960,
  seed: 'poc-iso',
  input: `
    click 1,5 @2
    click 6,5 @120
    click 9,1 @320
    click 4,7 @560
  `,
  expect(result) {
    expectSim(result)
      .eventEmitted('mission.completed', 1) // reached the exit, once
      .eventEmitted('enemy.killed', 1) // the guard was actually defeated (DoD §4.3)
      .eventEmitted('damage.taken', 2) // took exactly two guard hits...
      .eventNotEmitted('player.died') // ...but survived
      .eventEmitted('switch.activated', 1) // the switch was actually flipped
      .eventEmitted('door.opened', 1) // which opened the sealed door
      .entityExists({ has: ['Operative'] })
      .holds('operative ended on the exit cell (4,7)', (r) => {
        const g = r
          .query({ has: ['Operative', 'GridPosition'] })
          .one()
          .get(GridPosition);
        return g.cellX === 4 && g.cellY === 7;
      })
      .holds(
        'operative took the correct damage (30 - 2x5 = 20)',
        (r) =>
          r
            .query({ has: ['Operative', 'Health'] })
            .one()
            .get(Health).current === 20,
      )
      .hashEquals(result.hash); // pin the golden state hash (determinism)

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
| Door blocks, then opens           | `Blocking` tag mutation forcing pathfinding **re-resolution**                |
| `path.blocked` before switch      | Pathfinder correctly reports "no route" on a gated grid                      |
| Switch / exit triggers            | Shared `Trigger`/volume component from `@aegis/content`                      |
| Reaching the exit                 | Event emission + one-shot latching (`mission.completed` once)                |
| `hashEquals` + repeated run       | Byte-identical determinism (ADR-0001)                                        |
| Health / passable-cell invariants | Whole-timeline safety properties across a moving fight                       |
