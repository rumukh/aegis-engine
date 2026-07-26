/**
 * "The Server Vault" — the isometric PoC game, and `@aegis/mode-iso`'s acceptance test.
 *
 * A one-operative tactical infiltration on a 12x9 grid: path down the left column, engage a
 * clockwork guard patrolling the only corridor, flip a switch that unseals the data-room door,
 * then breach to the exit. Everything is deterministic and verified headlessly — see the
 * exported {@link default} `defineGameTest`.
 *
 * This module is the *game layer* (ADR-0006/0007, two altitudes): it composes the mode's
 * generic pipeline ({@link isoSystems}/{@link isoInit}) with its own semantic systems that read
 * the mode's generic events (`trigger.entered`, `entity.died`) and re-emit game vocabulary
 * (`guard.alerted`, `switch.activated`, `door.opened`, `mission.completed`, `player.died`).
 *
 * The frozen `RunOptions` has no extra-systems hook, so the game ships a composed
 * {@link ModePlugin} ({@link serverVaultPlugin}) rather than layering systems onto `isoPlugin`.
 * @packageDocumentation
 */
import { createSchedule, defineTag, hashString, Name } from '@aegis/core';
import type {
  ComponentType,
  Entity,
  Schedule,
  StateHash,
  System,
  Tag,
  TickContext,
  World,
} from '@aegis/core';
import { Health } from '@aegis/content';
import type { EntityDiedEvent } from '@aegis/content';
import { defineGameTest, expectSim } from '@aegis/harness';
import type { ModePlugin, SimResult, ViewProvider } from '@aegis/harness';
import {
  AttackOrder,
  Blocking,
  chebyshev,
  Controlled,
  GridPosition,
  ISO_COMPONENTS,
  IsoViewProvider,
  isoInit,
  isoSystems,
  lineOfSight,
  NavGrid,
  TRIGGER_ENTERED_EVENT,
} from '@aegis/mode-iso';
import type { NavGridData, TriggerEnteredEvent } from '@aegis/mode-iso';

// ---------------------------------------------------------------------------
// Level geometry — single source of truth for the collision layer.
// ---------------------------------------------------------------------------

/**
 * The vault's collision rows (walls only), identical to the tilemap's `collision` layer and the
 * scene's `IsoGrid.walls`. `#` = wall, everything else = floor. Kept here in code so the
 * whole-timeline "never stand in a wall" invariant derives its {@link WALL_CELLS} from the same
 * bytes the sim navigates. The companion test asserts these rows match the scene on disk.
 */
export const WALL_ROWS: readonly string[] = [
  '############',
  '#...#...#..#',
  '#.#.#.#.#..#',
  '#.#...#...##',
  '#.###.#.##.#',
  '#..........#',
  '####.#######',
  '#..........#',
  '############',
];

/** Every wall cell of the level, derived from {@link WALL_ROWS} — used by invariant #1. */
export const WALL_CELLS: readonly { x: number; y: number }[] = WALL_ROWS.flatMap((row, y) =>
  [...row].flatMap((ch, x) => (ch === '#' ? [{ x, y }] : [])),
);

// ---------------------------------------------------------------------------
// Marker components (scene tags queried by the game's own systems).
// ---------------------------------------------------------------------------

/** The single controlled operative (also carries the mode's `Controlled`). */
export const Operative: ComponentType<Tag> = defineTag('Operative');
/** The patrolling guard. */
export const Guard: ComponentType<Tag> = defineTag('Guard');
/** Marks an actor driven by {@link patrolSystem} (removed when it turns hostile). */
export const Patrol: ComponentType<Tag> = defineTag('Patrol');
/** Latch marking the guard as hostile: it stops patrolling and returns fire. */
export const Hostile: ComponentType<Tag> = defineTag('Hostile');

/** Marker components this game contributes on top of the mode's. */
export const GAME_COMPONENTS: readonly ComponentType<unknown>[] = [
  Operative,
  Guard,
  Patrol,
  Hostile,
] as readonly ComponentType<unknown>[];

// ---------------------------------------------------------------------------
// Semantic events (the game's altitude; the mode emits the generic combat/path ones).
// ---------------------------------------------------------------------------

/** The guard saw the operative and turned hostile. */
export const GUARD_ALERTED = 'guard.alerted';
/** The operative entered the switch trigger. */
export const SWITCH_ACTIVATED = 'switch.activated';
/** The sealed door's `Blocking` tag was removed. */
export const DOOR_OPENED = 'door.opened';
/** The operative reached the exit trigger (once). */
export const MISSION_COMPLETED = 'mission.completed';
/** The operative's `Health` reached zero (once). */
export const PLAYER_DIED = 'player.died';

/** Payload of {@link GUARD_ALERTED}. */
export interface GuardAlertedEvent {
  /** The tick the guard turned hostile. */
  tick: number;
}
/** Payload of {@link SWITCH_ACTIVATED} / {@link DOOR_OPENED}. */
export interface NamedEvent {
  /** The `Name` of the switch / door entity. */
  name: string | null;
}
/** Payload of {@link MISSION_COMPLETED}. */
export interface MissionCompletedEvent {
  /** The tick the operative reached the exit. */
  tick: number;
}
/** Payload of {@link PLAYER_DIED}. */
export interface PlayerDiedEvent {
  /** What felled the operative. */
  cause: string;
  /** The tick of death. */
  tick: number;
}

// ---------------------------------------------------------------------------
// Deterministic guard patrol — a pure function of tick.
// ---------------------------------------------------------------------------

/**
 * The guard's patrol cell at `tick`: a clockwork triangle-wave ping-pong along row 5 between
 * x=1 and x=10 at 1 cell / 20 ticks, period 360. Reproducible tick-for-tick until combat begins.
 * `leg = floor((tick mod 360)/20)`: legs 0..9 sweep x 1→10, legs 10..17 sweep x 9→2.
 */
export function patrolCell(tick: number): { x: number; y: number } {
  const period = 360;
  const s = ((tick % period) + period) % period;
  const leg = Math.floor(s / 20);
  const x = leg <= 9 ? 1 + leg : 19 - leg;
  return { x, y: 5 };
}

// ---------------------------------------------------------------------------
// Small world helpers.
// ---------------------------------------------------------------------------

/** The controlled operative entity, or `undefined`. */
function operativeOf(world: World): Entity | undefined {
  return world.query({ has: [Controlled, GridPosition] }).first()?.entity;
}

/** The patrolling (not-yet-hostile) guard entity, or `undefined`. */
function activeGuardOf(world: World): Entity | undefined {
  return world.query({ has: [Guard, GridPosition], none: [Hostile] }).first()?.entity;
}

/** Read the baked nav grid (for line-of-sight in detection). */
function navOf(world: World): NavGridData | undefined {
  const nav = world.getResource(NavGrid);
  return nav !== undefined && nav.width > 0 ? nav : undefined;
}

// ---------------------------------------------------------------------------
// Game systems.
// ---------------------------------------------------------------------------

/**
 * Drive the guard along its clockwork patrol (pure function of tick). Skips a hostile guard —
 * once it sees the operative it holds position and fights. Runs before pathfinding so the
 * guard's cell for this tick is settled when detection and the pathfinder read it.
 */
export const patrolSystem: System = {
  name: 'game.patrol',
  phase: 'preUpdate',
  before: ['iso.pathfind'],
  run({ world, tick }: TickContext): void {
    const guard = activeGuardOf(world);
    if (guard === undefined) return;
    const gp = world.getOrThrow(guard, GridPosition);
    const cell = patrolCell(tick);
    gp.cellX = cell.x;
    gp.cellY = cell.y;
    gp.progress = 0;
  },
};

/**
 * Detection: the moment a patrolling guard has the operative within Chebyshev 3 **and** clear
 * line of sight, it turns hostile — emits `guard.alerted`, latches {@link Hostile} (so
 * {@link patrolSystem} lets go), and takes an {@link AttackOrder} on the operative entity so the
 * mode's combat system returns fire on cooldown. Runs after patrol, before pathfinding.
 */
export const detectSystem: System = {
  name: 'game.detect',
  phase: 'preUpdate',
  after: ['game.patrol'],
  before: ['iso.pathfind'],
  run({ world, tick }: TickContext): void {
    const guard = activeGuardOf(world);
    if (guard === undefined) return;
    const op = operativeOf(world);
    if (op === undefined) return;
    const nav = navOf(world);
    if (nav === undefined) return;

    const g = world.getOrThrow(guard, GridPosition);
    const o = world.getOrThrow(op, GridPosition);
    const from = { x: g.cellX, y: g.cellY };
    const to = { x: o.cellX, y: o.cellY };
    if (chebyshev(from, to) > 3) return;
    if (!lineOfSight(nav, from, to)) return;

    world.add(guard, Hostile);
    world.add(guard, AttackOrder, { target: op, path: [], resolved: false });
    const payload: GuardAlertedEvent = { tick };
    world.events.emit(GUARD_ALERTED, payload);
  },
};

/**
 * Map the mode's generic `trigger.entered` onto the game's objectives. A `switch` trigger removes
 * the sealed door's {@link Blocking} tag (emitting `switch.activated` then `door.opened`) —
 * mutating the grid so the pathfinder re-resolves a route to the data-room next tick. An `exit`
 * trigger emits `mission.completed`. Runs in the `events` phase, after the mode's trigger system
 * has emitted for this tick.
 */
export const objectiveSystem: System = {
  name: 'game.objectives',
  phase: 'events',
  run({ world, tick }: TickContext): void {
    for (const ev of world.events.ofType<TriggerEnteredEvent>(TRIGGER_ENTERED_EVENT)) {
      const kind = ev.data.kind;
      if (kind === 'switch') {
        const switched: NamedEvent = { name: ev.data.name };
        world.events.emit(SWITCH_ACTIVATED, switched);
        for (const view of world.query({ has: [Blocking] }).views()) {
          world.remove(view.entity, Blocking);
          const opened: NamedEvent = { name: nameOf(world, view.entity) };
          world.events.emit(DOOR_OPENED, opened);
        }
      } else if (kind === 'exit') {
        const done: MissionCompletedEvent = { tick };
        world.events.emit(MISSION_COMPLETED, done);
      }
    }
  },
};

/**
 * Map the generic `entity.died` onto `player.died` when the dead entity is the operative. The
 * guard's death stays generic here (the mode already emits `enemy.killed` for it). Runs in the
 * `events` phase, after `content.health.death` has reported deaths for this tick.
 */
export const deathSystem: System = {
  name: 'game.death',
  phase: 'events',
  run({ world, tick }: TickContext): void {
    for (const ev of world.events.ofType<EntityDiedEvent>('entity.died')) {
      const e = ev.data.entity;
      if (world.isAlive(e) && world.has(e, Controlled)) {
        const payload: PlayerDiedEvent = { cause: 'guard', tick };
        world.events.emit(PLAYER_DIED, payload);
      }
    }
  },
};

/** An entity's `Name`, or `null`. */
function nameOf(world: World, entity: Entity): string | null {
  const n = world.get(entity, Name);
  return n && typeof (n as { value?: unknown }).value === 'string'
    ? (n as { value: string }).value
    : null;
}

/** The game's systems (semantic layer) in stable registration order. */
export const SERVER_VAULT_SYSTEMS: readonly System[] = [
  patrolSystem,
  detectSystem,
  objectiveSystem,
  deathSystem,
];

// ---------------------------------------------------------------------------
// The composed plugin the harness runs.
// ---------------------------------------------------------------------------

/**
 * The game's {@link ModePlugin}: the iso mode's components + the game's markers; the iso mode's
 * systems + the game's semantic systems; the mode's nav-grid bake as `init`; the mode's iso view.
 * (The frozen `RunOptions` has no systems hook — a game ships a composed plugin, not `isoPlugin`.)
 */
export const serverVaultPlugin: ModePlugin = {
  mode: 'iso',
  components: (): readonly ComponentType<unknown>[] => [...ISO_COMPONENTS, ...GAME_COMPONENTS],
  systems: (): Schedule => createSchedule().addAll([...isoSystems(), ...SERVER_VAULT_SYSTEMS]),
  init: (world: World): void => isoInit(world),
  view: (): ViewProvider => new IsoViewProvider(),
};

// ---------------------------------------------------------------------------
// The scripted playthrough (ADR-0004 DSL). Tuned so the golden outcome holds.
// ---------------------------------------------------------------------------

/**
 * The tuned click script. `click x,y @tick` at grid cells: click empty ground = move,
 * click the guard's cell = attack-move. See {@link patrolCell} for where the guard is when clicked.
 *
 * ## Why the opening beat is a *wait*
 * The operative holds its spawn (1,1) for 40 ticks. From (1,1) the guard is never closer than
 * Chebyshev 4, so it cannot be detected there — which lets the clockwork patrol actually *run*.
 * By the time the guard turns hostile at **t178** it is standing at **(9,5)**, eight cells from
 * its spawn: the patrol has walked eight legs and the operative has chased it up the corridor.
 * (The previous script clicked at t2 and was spotted at t18 with the guard still on its spawn
 * cell, so `patrolSystem` could be deleted outright without any test noticing.)
 *
 * ## Why the exit is clicked twice
 * The click at **t300** happens while the operative is still climbing the col-9 shaft and the
 * vault door is still `Blocking`: the pathfinder must honestly report `path.blocked` and drop the
 * in-flight order (the operative stops mid-route). The re-click at t308 resumes to the switch,
 * which opens the door at t330; the *same* target then resolves at t340. Blocked-then-resolved on
 * one target is what proves the route is computed against the **current, mutated** grid rather
 * than a cached one — the old script clicked the exit three ticks *after* the door had already
 * opened, so it never touched the gate at all.
 */
export const SERVER_VAULT_SCRIPT = `
  click 1,5 @40
  click 7,5 @102
  click 9,5 @195
  click 9,1 @232
  click 4,7 @300
  click 9,1 @308
  click 4,7 @340
`;

// ---------------------------------------------------------------------------
// The acceptance test.
// ---------------------------------------------------------------------------

/** The golden state hash, pinned after the first green run (determinism proof). */
export const GOLDEN_HASH = 'cb0f07007ad8608a';

/**
 * Golden digest of the **whole per-tick hash timeline**, not just the resting state.
 *
 * A final-state hash is nearly blind to dynamics, because this run — like all three PoCs — ends
 * at rest: the operative parked on the exit, the guard dead, every order resolved. Two runs whose
 * trajectories differ can converge on the identical final state, so {@link GOLDEN_HASH} alone
 * cannot see them. (Measured: moving the last click from t340 to t420 changes when the operative
 * walks the whole back half of the level and leaves `GOLDEN_HASH` *byte-identical*.) Digesting
 * every tick's hash makes any changed trajectory go red.
 */
export const GOLDEN_TRAJECTORY = '2c6881a477e2d268';

/**
 * Digest a run's per-tick hash timeline into one comparable value, using core's frozen
 * {@link hashString} (the same FNV-1a the world hash uses), so the digest is as portable and as
 * deterministic as the hashes it summarises.
 */
export function trajectoryDigest(tickHashes: readonly StateHash[]): StateHash {
  return hashString(tickHashes.join('|'));
}

/**
 * Six literal points of the guard's patrol, as sampled cells rather than as a call back into
 * {@link patrolCell}. The every-tick loop below compares the world against `patrolCell(t)`, which
 * catches a frozen or deleted patrol system exactly — but moves with the formula if the formula
 * itself changes. These literals are the independent pin: they are what the *level design* says
 * the guard's sweep looks like (1 cell per 20 ticks, east along row 5 from its spawn).
 */
const PATROL_WAYPOINTS: readonly (readonly [number, number])[] = [
  [0, 1],
  [20, 2],
  [60, 4],
  [100, 6],
  [140, 8],
  [177, 9],
];

/** The tick the guard turned hostile in the golden run; before it the patrol is clockwork. */
const ALERT_TICK = 178;
/** The cell the guard had patrolled to by the time it alerted (8 legs from its spawn). */
const ALERT_CELL = { x: 9, y: 5 } as const;
/**
 * Every `attack.fired` tick of the golden firefight: guard (40-tick cadence) at t178 and t218,
 * operative (30-tick cadence) at t195 and t225. Pinning the ticks — not just the hit counts —
 * is what makes the cooldown clock load-bearing.
 */
const FIREFIGHT_TICKS: readonly number[] = [178, 195, 218, 225];

/** The guard's logical cell in the world captured at `tick`. */
function guardCellAt(result: SimResult, tick: number): { x: number; y: number } {
  const g = result
    .at(tick)
    .query({ has: ['Guard', 'GridPosition'] })
    .one()
    .get(GridPosition);
  return { x: g.cellX, y: g.cellY };
}

/** The ascending ticks on which `type` was emitted. */
function ticksOf(result: SimResult, type: string): number[] {
  return result.events
    .history()
    .filter((e) => e.type === type)
    .map((e) => e.tick);
}

export default defineGameTest({
  name: 'server vault: win the firefight, open the door, reach the exit',
  scene: 'games/iso/levels/server-vault.scene.json',
  options: { plugin: serverVaultPlugin, captureHistory: true },
  ticks: 960,
  seed: 'poc-iso',
  input: SERVER_VAULT_SCRIPT,
  expect(result) {
    // Order matters: the *mechanism* assertions come first so a broken capability names itself
    // ("the guard stopped walking its patrol") instead of surfacing as a downstream symptom
    // ("damage.taken was 1"), let alone as a hash mismatch (CHARTER principle 8).
    expectSim(result)
      // --- the clockwork patrol actually walks -------------------------------------------
      .holds(
        'the guard swept row 5 eastward at 1 cell / 20 ticks (x = 1 @t0, 2 @t20, 4 @t60, 6 @t100, 8 @t140, 9 @t177)',
        (r) =>
          PATROL_WAYPOINTS.every(([tick, x]) => {
            const at = guardCellAt(r, tick);
            return at.x === x && at.y === 5;
          }),
      )
      .holds(
        `the guard walks patrolCell(t) on every tick before it alerts (t < ${ALERT_TICK})`,
        (r) => {
          for (let t = 0; t < ALERT_TICK; t++) {
            const want = patrolCell(t);
            const got = guardCellAt(r, t);
            if (got.x !== want.x || got.y !== want.y) return false;
          }
          return true;
        },
      )
      .holds(
        `the patrol had carried the guard to (${ALERT_CELL.x},${ALERT_CELL.y}) — 8 cells from its spawn — before it opened fire`,
        (r) => {
          const at = guardCellAt(r, ALERT_TICK);
          return at.x === ALERT_CELL.x && at.y === ALERT_CELL.y;
        },
      )
      .holds('a hostile guard holds its ground instead of patrolling on', (r) => {
        for (const t of [ALERT_TICK, 200, 224, 400, 700, 959]) {
          const at = guardCellAt(r, t);
          if (at.x !== ALERT_CELL.x || at.y !== ALERT_CELL.y) return false;
        }
        return true;
      })
      // --- the firefight runs on its golden cadence ---------------------------------------
      // Named, behavioural pin for the cooldown clock. The guard fires on a 40-tick cadence and
      // the operative on a 30-tick one, so the four shots land on exactly these ticks. A cadence
      // regression (cooldowns ticking at the wrong rate, the wrong phase, an extra decrement)
      // moves them — even when the exchange still nets two hits and the resting state converges,
      // which is precisely the case a final-state hash cannot see.
      .eventEmitted('attack.fired', 4)
      .holds(
        `the firefight ran on its golden cadence (shots on ticks ${FIREFIGHT_TICKS.join(', ')})`,
        (r) => {
          const fired = ticksOf(r, 'attack.fired');
          return (
            fired.length === FIREFIGHT_TICKS.length &&
            fired.every((t, i) => t === FIREFIGHT_TICKS[i])
          );
        },
      )
      // --- the route is re-resolved against the mutated grid ------------------------------
      .holds(
        'the exit was unreachable while the door was sealed, and reachable only after it opened',
        (r) => {
          const blocked = ticksOf(r, 'path.blocked')[0];
          const opened = ticksOf(r, 'door.opened')[0];
          const completed = ticksOf(r, 'mission.completed')[0];
          const resolvedAfterOpen = ticksOf(r, 'path.resolved').filter(
            (t) => opened !== undefined && t > opened,
          );
          return (
            blocked !== undefined &&
            opened !== undefined &&
            completed !== undefined &&
            blocked < opened &&
            opened < completed &&
            resolvedAfterOpen.length >= 1
          );
        },
      )
      // --- the mission outcome -------------------------------------------------------------
      .eventEmitted('mission.completed', 1)
      .eventEmitted('enemy.killed', 1)
      .eventEmitted('damage.taken', 2)
      .eventNotEmitted('player.died')
      .eventEmitted('switch.activated', 1)
      .eventEmitted('door.opened', 1)
      // The sealed door is genuinely load-bearing in the *winning* run: the exit is clicked
      // while it is still Blocking, so the pathfinder must report no route exactly once.
      .eventEmitted('path.blocked', 1)
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
      // --- the whole trajectory, not just the resting state -------------------------------
      // Last on purpose: this is the safety net under the named assertions above, not the
      // diagnosis. If it is the only thing that fails, something changed that no beat describes.
      .holds(
        'the per-tick hash timeline matches the golden trajectory (see GOLDEN_TRAJECTORY)',
        (r) => trajectoryDigest(r.tickHashes) === GOLDEN_TRAJECTORY,
      )
      .hashEquals(GOLDEN_HASH);

    result.assertInvariant('operative is always on a passable cell', (w) => {
      const g = w
        .query({ has: ['Operative', 'GridPosition'] })
        .one()
        .get(GridPosition);
      return WALL_CELLS.every((c) => !(c.x === g.cellX && c.y === g.cellY));
    });

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

// ---------------------------------------------------------------------------
// The negative playthrough — the lose path, proven.
// ---------------------------------------------------------------------------

/**
 * Walk into the guard's field of fire and never shoot back.
 *
 * The operative steps to (1,2) at t2 — three cells straight up the column from the guard's spawn,
 * so it is detected at t18 — and is then given no further orders. The guard lands its 5-damage
 * shot every 40 ticks (t18, 58, 98, 138, 178, 218) until the operative's 30 HP is gone.
 *
 * This exists because `eventNotEmitted('player.died')` in the winning run proves *nothing* on its
 * own: an event that is never emitted anywhere passes that assertion even if the emitter is
 * deleted. Pinning the death here — once, with the right `cause` — is what gives the winning
 * run's negative assertion its meaning, and it is the only test of the lose path the charter
 * promises ("Lose: any `player.died` event").
 */
export const SERVER_VAULT_DEATH_SCRIPT = `
  click 1,2 @2
`;

export const serverVaultDeathTest = defineGameTest({
  name: 'server vault (lose): stand in the guard\u2019s fire and die',
  scene: 'games/iso/levels/server-vault.scene.json',
  options: { plugin: serverVaultPlugin, captureHistory: false },
  ticks: 300,
  seed: 'poc-iso',
  input: SERVER_VAULT_DEATH_SCRIPT,
  expect(result) {
    expectSim(result)
      .eventEmitted('guard.alerted', 1)
      // Six 5-damage shots drain 30 HP; the cadence is clockwork, so the count is exact.
      .eventEmitted('damage.taken', 6)
      .eventEmitted('player.died', 1)
      // The mission is not completed, and we never fired back, so nothing died but us.
      .eventNotEmitted('mission.completed')
      .eventNotEmitted('enemy.killed')
      .holds('player.died reports cause "guard" on the tick the last shot lands', (r) => {
        const died = r.events.history().find((e) => e.type === 'player.died');
        const data = died?.data as PlayerDiedEvent | undefined;
        return data?.cause === 'guard' && died?.tick === 218;
      })
      .holds(
        'the operative was actually reduced to zero health',
        (r) =>
          r
            .query({ has: ['Operative', 'Health'] })
            .one()
            .get(Health).current === 0,
      );
  },
});
