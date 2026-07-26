# Isometric PoC — "The Server Vault"

> Isometric / three-quarter tactical. Reference feel: *Fallout 2*, *Dragon Age: Origins*.
> Mode: `iso` (`@aegis/mode-iso`). Runs headless, verified without pixels.

## Concept and fantasy

A one-agent stealth-infiltration puzzle on a grid. You control a single operative who must slip
through a walled server vault, flip a security switch to unlock the sealed data-room door, and
reach the exit — all while a guard walks a fixed patrol across the only corridor connecting the
map. There is no dice-roll: the guard's route is clockwork, the walls are fixed, and success is a
matter of **reading the grid and timing the crossings**. For its 30–45 seconds it is a
Fallout-style "move, hold, move" tactical beat, minus the combat — see *Deliberate scope cut*.

## Core loop

Look at the grid → **click a destination cell** → watch the operative path around walls to it →
wait for the guard to pass → click the next waypoint → flip the switch → cross again → reach the
exit. The only verb is **click-to-move** (`click x,y`); the engine does the pathfinding and the
stepping.

## Mechanics (design intent — implementers may tune)

Grid is integer cells; `tileSize: 1`. Tick rate 60Hz.

**Operative** — `GridPosition` + `IsoActor` + (on click) `MoveOrder`:

| Tunable | Value | Consequence |
| --- | --- | --- |
| `IsoActor.speed` | 4 cells/s | 15 ticks per cell |
| `IsoActor.moveMode` | `realtime` | smooth sub-cell `progress`, logical position stays integer |
| pathfinding | 4-neighbour (no diagonals) | Manhattan grid; deterministic tie-break by (x then y) |

A `click x,y` writes a `MoveOrder{ target }`. A `PathfindSystem` resolves `path` (A* / BFS over
passable cells) and sets `resolved: true`; a `GridMoveSystem` consumes the path front-to-back, one
cell per `1/speed` seconds, emitting `cell.entered` on each arrival and removing the `MoveOrder` at
the destination. **Passable = a floor cell that is neither a solid tilemap tile nor occupied by a
`Blocking` entity.**

**The sealed door** — a `Blocking` entity at cell (4,6), the sole link between the corridor and the
data-room. A game-owned `SwitchSystem` removes its `Blocking` tag when the operative enters the
switch cell (9,1), emitting `switch.activated` then `door.opened`. **Clicking the exit before the
switch is flipped must yield `path.blocked`** (no route exists) — this is the proof that
pathfinding re-resolves against a *mutated* grid, not a cached one.

**The guard** — a game-owned `PatrolSystem` (deterministic, RNG-free):
- Ping-pongs along row 5 between cell (1,5) and (10,5), one cell every 20 ticks.
- Its cell at tick *t* is a pure function of *t*: `phase = t mod 360`; sweeps 1→10 over the first
  180 ticks, 10→1 over the next 180. Reproducible tick-for-tick.
- **Detection:** if the Chebyshev distance between guard and operative ≤ 1 (adjacent or same cell)
  → `guard.alerted` then `player.caught`, and the mission fails.

**Exit** — a game-owned `GoalSystem`: operative enters exit cell (4,7) → `mission.completed`.

> **Engine insufficiency flagged to PM:** `mode-iso` ships `GridPosition`, `IsoActor`, `MoveOrder`,
> `Blocking`, `IsoCamera` — everything for movement and pathfinding, but **no `Health`, no attack,
> and no turn-order/initiative surface** (`Health`/`Hitscan` live only in `mode-fps`). A true
> *Fallout/DA:O tactical* slice wants HP, attacks and initiative. This PoC is therefore designed as
> a **stealth/pathing** mission (detection = fail) rather than a firefight, which stays honestly
> within the shipped iso surface. If the PM wants genuine grid *combat* in v1, the engine needs a
> shared `Health` + a per-cell attack/action-point contract in `mode-iso`. See README §"Not
> covered".

## Level layout

Authored as an ADR-0003 tilemap (`levels/server-vault.tilemap.json`), 12×9, `tileSize: 1`. Row 0 is
the top. Operative, guard, switch and door are scene entities placed by cell; walls/floor live in
the tilemap's `collision` layer.

Legend:

```
#  wall  (solid tile, impassable)     .  floor (passable)
S  operative spawn cell (entity)      X  exit / objective cell (entity)
K  security switch cell (entity)      D  sealed door  (Blocking entity, removed on switch)
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
- **The guard** owns row 5, which the operative must traverse **twice** (out to the switch, back to
  the door). Both crossings must be timed against the clockwork patrol.

## Win and lose conditions

- **Win:** exactly one `mission.completed` event AND no `player.caught` event.
- **Lose:** any `player.caught` event (guard detection), or the run ends without
  `mission.completed`.

Fully machine-checkable from the event log and final `GridPosition`.

## Events emitted

| Event | Payload | Emitted by | When |
| --- | --- | --- | --- |
| `move.ordered` | `{ target: {x,y} }` | mode | a `click` produces a `MoveOrder` |
| `path.resolved` | `{ target, length }` | mode | pathfinder finds a route |
| `path.blocked` | `{ target }` | mode | no route exists to the clicked cell |
| `cell.entered` | `{ x, y, tick }` | mode | operative arrives at a new cell |
| `switch.activated` | `{ name }` | game | operative enters the switch cell |
| `door.opened` | `{ name }` | game | the door's `Blocking` tag is removed |
| `guard.alerted` | `{ tick }` | game | guard is within detection range |
| `player.caught` | `{ tick }` | game | detection → mission fail, once |
| `mission.completed` | `{ tick }` | game | operative reaches the exit, once |

## The scripted playthrough

`play/server-vault.input` (ADR-0004 DSL). Click-to-move is issued as `click x,y @tick` at grid
cells; between clicks the operative auto-paths and then idles, so the waits are how we dodge the
guard. Ticks are design intent; the implementer tunes exact frames so the detection invariant holds.
Total ≈ **900 ticks (~15 s sim time)**.

```text
# The Server Vault — a clean infiltration. Clicks are grid cells (x,y).

click 1,5   @2      # 1) path down the winding left column to the corridor mouth
                    #    (proves A* around single-tile gaps; ~60 ticks to arrive)
# hold at (1,5) until the guard sweeps past to the right end
click 7,5   @250    # 2) cross the corridor rightward to the col-7 shaft (guard now near col 10)
click 9,1   @340    # 3) climb the shaft and jog to the switch  -> switch.activated, door.opened
# now return to the corridor and time the second crossing back to the door column
click 4,5   @620    # 4) drop back to the corridor at col 4 (guard sweeping the far side)
click 4,7   @720    # 5) step through the open door into the data-room -> mission.completed
```

Notes for the implementer:
- **Dynamic-repath proof:** author a companion *negative* test that clicks `4,7` at tick 5 (before
  the switch) and asserts `path.blocked` is emitted and `mission.completed` is not — that is the
  test that fails loudly if pathfinding ever ignores the door mutation.
- The two corridor crossings (`@250`, `@620`) are the timing-critical beats. Keep the *semantics*
  (cross while the guard is at the far end) even if exact ticks drift; the detection invariant is
  what actually enforces safety.

## The gameplay assertions

```ts
import { defineGameTest, expectSim } from '@aegis/harness';
import { isoPlugin, GridPosition } from '@aegis/mode-iso';

function chebyshev(a: { cellX: number; cellY: number }, b: { cellX: number; cellY: number }) {
  return Math.max(Math.abs(a.cellX - b.cellX), Math.abs(a.cellY - b.cellY));
}

export default defineGameTest({
  name: 'server vault: path to switch, open door, reach exit uncaught',
  scene: 'games/iso/levels/server-vault.scene.json',
  options: { plugin: isoPlugin, captureHistory: true },
  ticks: 960,
  seed: 'poc-iso',
  input: `
    click 1,5 @2
    click 7,5 @250
    click 9,1 @340
    click 4,5 @620
    click 4,7 @720
  `,
  expect(result) {
    expectSim(result)
      .eventEmitted('mission.completed', 1)  // reached the exit, once
      .eventNotEmitted('player.caught')      // never detected by the guard
      .eventEmitted('switch.activated', 1)   // the switch was actually flipped
      .eventEmitted('door.opened', 1)        // which opened the sealed door
      .entityExists({ has: ['Operative'] })
      .holds(
        'operative ended on the exit cell (4,7)',
        (r) => {
          const g = r.query({ has: ['Operative', 'GridPosition'] }).one().get(GridPosition);
          return g.cellX === 4 && g.cellY === 7;
        },
      )
      .hashEquals(result.hash);              // pin the golden state hash (determinism)

    // Whole-timeline invariant #1 — stealth safety: never enter the guard's 1-ring.
    result.assertInvariant('stayed out of the guard\'s detection ring', (w) => {
      const op = w.query({ has: ['Operative', 'GridPosition'] }).one().get(GridPosition);
      const gd = w.query({ has: ['Guard', 'GridPosition'] }).one().get(GridPosition);
      return chebyshev(op, gd) >= 2;
    });

    // Whole-timeline invariant #2 — pathfinding correctness: never stand in a wall.
    result.assertInvariant('operative is always on a passable cell', (w) => {
      const g = w.query({ has: ['Operative', 'GridPosition'] }).one().get(GridPosition);
      return WALL_CELLS.every((c) => !(c.x === g.cellX && c.y === g.cellY));
    });
  },
});
```

`WALL_CELLS` is derived from the tilemap's `#` tiles (the game exports it next to the scene).
Invariant #1 is the heart of the game: if the guard patrol regresses (wrong phase, off-by-one, or
non-deterministic) the operative ends up in the 1-ring on some tick and the invariant fails *at that
tick*. Invariant #2 fails the instant a pathfinding bug walks the operative through a wall.

## What this game proves about the engine

| Game element | Engine capability exercised |
| --- | --- |
| Winding path S → corridor | Grid pathfinding around single-tile gaps (not a straight line) |
| The col-7 shaft to the switch | A*/BFS finding the one valid route among decoys |
| `click x,y` issuing moves | Pointer/`click` input → `MoveOrder` (ADR-0004 iso path) |
| Cell-by-cell stepping | `IsoActor` realtime interpolation, integer logical `GridPosition` |
| Door blocks, then opens | `Blocking` tag mutation forcing pathfinding **re-resolution** |
| `path.blocked` before switch | Pathfinder correctly reports "no route" on a gated grid |
| Guard patrol | Deterministic, RNG-free AI as a pure function of tick |
| Timed corridor crossings | Reproducible spatial relationship between two actors over time |
| Detection = catch | Grid distance query driving a branching game event |
| Reaching the exit | Event emission + one-shot latching (`mission.completed` once) |
| `hashEquals` + repeated run | Byte-identical determinism (ADR-0001) |
| Stealth-ring invariant | Whole-timeline safety property across two moving actors |
