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
import { createSchedule, defineTag, Name } from '@aegis/core';
import type { ComponentType, Entity, Schedule, System, Tag, TickContext, World } from '@aegis/core';
import { Health } from '@aegis/content';
import type { EntityDiedEvent } from '@aegis/content';
import { defineGameTest, expectSim } from '@aegis/harness';
import type { ModePlugin, ViewProvider } from '@aegis/harness';
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
      const e = ev.data.entity as Entity;
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
 */
export const SERVER_VAULT_SCRIPT = `
  click 1,2 @2
  click 1,5 @40
  click 9,1 @72
  click 4,7 @300
`;

// ---------------------------------------------------------------------------
// The acceptance test.
// ---------------------------------------------------------------------------

/** The golden state hash, pinned after the first green run (determinism proof). */
export const GOLDEN_HASH = 'a76c70407b775b92';

export default defineGameTest({
  name: 'server vault: win the firefight, open the door, reach the exit',
  scene: 'games/iso/levels/server-vault.scene.json',
  options: { plugin: serverVaultPlugin, captureHistory: true },
  ticks: 960,
  seed: 'poc-iso',
  input: SERVER_VAULT_SCRIPT,
  expect(result) {
    expectSim(result)
      .eventEmitted('mission.completed', 1)
      .eventEmitted('enemy.killed', 1)
      .eventEmitted('damage.taken', 2)
      .eventNotEmitted('player.died')
      .eventEmitted('switch.activated', 1)
      .eventEmitted('door.opened', 1)
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
