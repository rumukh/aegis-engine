/**
 * The isometric mode's per-tick systems: pointer intake (click → order), cooldown ticking,
 * pathfinding (with dynamic repath against {@link Blocking} entities), grid movement with
 * sub-cell progress, real-time-with-cooldown combat, trigger detection and camera follow.
 *
 * All behaviour is game-agnostic: systems act on any entity carrying the relevant components,
 * and speak only the generic mode event vocabulary in {@link "./events"}. A game re-emits its
 * own semantic events by listening to these (ADR-0006/0007, two altitudes). Every system is a
 * deterministic pure function of world + tick — no wall-clock, no `Math.random` (CHARTER §3).
 * @packageDocumentation
 */
import { max, Name, round, Transform } from '@aegis/core';
import type { Entity, System, TickContext, World } from '@aegis/core';
import { Health, pointInTrigger, Trigger, Triggered } from '@aegis/content';
import type { TriggerData } from '@aegis/content';
import {
  AttackOrder,
  Attacker,
  Blocking,
  Controlled,
  GridPosition,
  IsoActor,
  MoveOrder,
  NavGrid,
} from './components.js';
import type { Cell, NavGridData } from './components.js';
import {
  ATTACK_FIRED,
  ATTACK_ORDERED,
  CELL_ENTERED,
  DAMAGE_TAKEN,
  ENEMY_DAMAGED,
  ENEMY_KILLED,
  MOVE_ORDERED,
  PATH_BLOCKED,
  PATH_RESOLVED,
} from './events.js';
import type { Blocked } from './grid.js';
import { findAttackPath, findPath, inWeaponRange } from './grid.js';

/** Read the baked nav grid, throwing a clear error if `init` never ran. */
function navGridOf(world: World): NavGridData {
  const nav = world.getResource(NavGrid);
  if (nav === undefined || nav.width === 0) {
    throw new Error(
      "[aegis:mode-iso] NavGrid resource is missing or empty. The iso plugin's init() must run " +
        "before tick 0 to bake it from the scene's IsoGrid resource.",
    );
  }
  return nav;
}

/** Build a passability predicate: static walls plus every live {@link Blocking} entity's cell. */
function blockedPredicate(world: World, nav: NavGridData): Blocked {
  const dynamic = new Set<number>();
  for (const view of world.query({ has: [Blocking, GridPosition] }).views()) {
    const gp = view.get(GridPosition);
    dynamic.add(gp.cellY * nav.width + gp.cellX);
  }
  return (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= nav.width || y >= nav.height) return true;
    if (nav.blocked[y * nav.width + x] === true) return true;
    return dynamic.has(y * nav.width + x);
  };
}

/** The controlled actor, or `undefined` if none / more than one. */
function controlledActor(world: World): Entity | undefined {
  return world.query({ has: [Controlled, GridPosition] }).first()?.entity;
}

/** The cell of an actor. */
function cellOf(world: World, entity: Entity): Cell {
  const gp = world.getOrThrow(entity, GridPosition);
  return { x: gp.cellX, y: gp.cellY };
}

/**
 * Pointer intake: translate a primary click into a {@link MoveOrder} (empty ground) or an
 * {@link AttackOrder} (a cell occupied by another living, damageable actor). One order kind at
 * a time — issuing one clears the other so a re-click cleanly retargets.
 */
export const intakeSystem: System = {
  name: 'iso.intake',
  phase: 'input',
  run({ world, tick, input }: TickContext): void {
    const pointer = input.pointer;
    if (pointer === null || pointer.world === null) return;
    if (!pointer.buttons.includes('primary')) return;

    const actor = controlledActor(world);
    if (actor === undefined) return;

    const target: Cell = { x: round(pointer.world.x), y: round(pointer.world.y) };

    // Is a different, living, damageable actor standing on the clicked cell? → attack.
    let victim: Entity | undefined;
    for (const view of world.query({ has: [GridPosition, Health] }).views()) {
      if (view.entity === actor) continue;
      const gp = view.get(GridPosition);
      if (gp.cellX === target.x && gp.cellY === target.y && view.get(Health).current > 0) {
        victim = view.entity;
        break;
      }
    }

    if (victim !== undefined) {
      world.remove(actor, MoveOrder);
      world.add(actor, AttackOrder, { target: victim, path: [], resolved: false });
      world.events.emit(ATTACK_ORDERED, { entity: actor, target: victim, tick });
    } else {
      world.remove(actor, AttackOrder);
      world.add(actor, MoveOrder, { target, path: [], resolved: false });
      world.events.emit(MOVE_ORDERED, { entity: actor, target, tick });
    }
  },
};

/** Tick every weapon's cooldown down toward ready. Runs before combat so a shot fired this run cools next tick. */
export const cooldownSystem: System = {
  name: 'iso.cooldown',
  phase: 'preUpdate',
  run({ world }: TickContext): void {
    for (const view of world.query({ has: [Attacker] }).views()) {
      const atk = view.get(Attacker);
      if (atk.cooldownRemaining > 0) atk.cooldownRemaining = max(0, atk.cooldownRemaining - 1);
    }
  },
};

/** Does any cell of `path` fail the current passability test (i.e. the grid mutated under us)? */
function pathNowBlocked(path: readonly Cell[], blocked: Blocked): boolean {
  for (const c of path) if (blocked(c.x, c.y)) return true;
  return false;
}

/**
 * Resolve movement and attack paths against the *current* grid. A move order repaths whenever it
 * is unresolved or its remaining route now crosses a blocked cell (dynamic repath). An
 * unreachable destination emits {@link PATH_BLOCKED} and the order is dropped — an honest
 * failure, never a silent half-move. An attack order closes to within weapon range of its
 * (moving) target, or reports blocked if it cannot.
 */
export const pathfindSystem: System = {
  name: 'iso.pathfind',
  phase: 'preUpdate',
  after: ['iso.cooldown'],
  run({ world, tick }: TickContext): void {
    const nav = navGridOf(world);
    const blocked = blockedPredicate(world, nav);

    // Move orders.
    for (const view of world.query({ has: [MoveOrder, GridPosition] }).views()) {
      const actor = view.entity;
      if (isDead(world, actor)) continue;
      const mo = view.get(MoveOrder);
      const start = cellOf(world, actor);
      const needRepath = !mo.resolved || pathNowBlocked(mo.path, blocked);
      if (!needRepath) continue;
      const path = findPath(nav, blocked, start, mo.target);
      if (path === null) {
        world.events.emit(PATH_BLOCKED, { entity: actor, target: { ...mo.target }, tick });
        world.remove(actor, MoveOrder);
      } else {
        mo.path = path;
        mo.resolved = true;
        world.events.emit(PATH_RESOLVED, { entity: actor, length: path.length, tick });
      }
    }

    // Attack orders.
    for (const view of world.query({ has: [AttackOrder, GridPosition, Attacker] }).views()) {
      const actor = view.entity;
      if (isDead(world, actor)) continue;
      const ao = view.get(AttackOrder);
      const targetE = ao.target as Entity;
      if (!targetIsEngageable(world, targetE)) {
        world.remove(actor, AttackOrder);
        continue;
      }
      const start = cellOf(world, actor);
      const tgt = cellOf(world, targetE);
      const range = view.get(Attacker).rangeCells;
      if (inWeaponRange(nav, start, tgt, range)) {
        ao.path = [];
        ao.resolved = true;
        continue;
      }
      const path = findAttackPath(nav, blocked, start, tgt, range);
      if (path === null) {
        world.events.emit(PATH_BLOCKED, { entity: actor, target: tgt, tick });
        world.remove(actor, AttackOrder);
      } else {
        ao.path = path;
        ao.resolved = true;
        world.events.emit(PATH_RESOLVED, { entity: actor, length: path.length, tick });
      }
    }
  },
};

/** Whether `target` is a live, damageable entity worth pathing toward. */
function targetIsEngageable(world: World, target: Entity): boolean {
  if (!world.isAlive(target)) return false;
  const hp = world.get(target, Health);
  return hp !== undefined && hp.current > 0;
}

/** Whether `entity` has been reduced to zero health — a corpse takes no orders. */
function isDead(world: World, entity: Entity): boolean {
  const hp = world.get(entity, Health);
  return hp !== undefined && hp.current <= 0;
}

/**
 * Advance actors along their resolved paths with sub-cell interpolation. `progress` accumulates
 * `speed * dt` per tick; each whole unit snaps the logical cell forward one step and emits
 * {@link CELL_ENTERED}. A move order is removed on arrival; an attack order keeps the actor put
 * once its (possibly empty) closing path is exhausted so the combat system can fire.
 */
export const moveSystem: System = {
  name: 'iso.move',
  phase: 'update',
  run({ world, dt }: TickContext): void {
    for (const view of world
      .query({ has: [IsoActor, GridPosition], any: [MoveOrder, AttackOrder] })
      .views()) {
      const actor = view.entity;
      if (isDead(world, actor)) continue;
      const gp = view.get(GridPosition);
      const speed = view.get(IsoActor).speed;
      const isMove = world.has(actor, MoveOrder);
      const order = isMove
        ? world.getOrThrow(actor, MoveOrder)
        : world.getOrThrow(actor, AttackOrder);
      const path = order.path.slice();

      if (path.length === 0) {
        gp.progress = 0;
        if (isMove) world.remove(actor, MoveOrder);
        continue;
      }

      gp.progress += speed * dt;
      while (gp.progress >= 1 && path.length > 0) {
        const next = path.shift() as Cell;
        gp.cellX = next.x;
        gp.cellY = next.y;
        gp.progress -= 1;
        world.events.emit(CELL_ENTERED, { entity: actor, x: next.x, y: next.y, tick: world.tick });
      }
      order.path = path;
      if (path.length === 0) {
        gp.progress = 0;
        if (isMove) world.remove(actor, MoveOrder);
      }
    }
  },
};

/**
 * Real-time-with-cooldown combat (ADR-0009): any actor holding an {@link AttackOrder} whose
 * weapon is off cooldown and whose target is within range and line of sight fires, applying
 * `Attacker.damage` to the target's `Health`. Events are phrased from the controlled actor's
 * perspective — a hit *it* lands is `enemy.damaged`/`enemy.killed`, a hit *it* takes is
 * `damage.taken`; `attack.fired` is neutral.
 */
export const combatSystem: System = {
  name: 'iso.combat',
  phase: 'update',
  after: ['iso.move'],
  run({ world, tick }: TickContext): void {
    const nav = navGridOf(world);
    for (const view of world.query({ has: [AttackOrder, Attacker, GridPosition] }).views()) {
      const attackerE = view.entity;
      if (world.has(attackerE, Health) && world.getOrThrow(attackerE, Health).current <= 0)
        continue;
      const atk = view.get(Attacker);
      if (atk.cooldownRemaining > 0) continue;

      const ao = view.get(AttackOrder);
      const targetE = ao.target as Entity;
      if (!targetIsEngageable(world, targetE)) continue;

      const from = cellOf(world, attackerE);
      const to = cellOf(world, targetE);
      if (!inWeaponRange(nav, from, to, atk.rangeCells)) continue;

      const targetHp = world.getOrThrow(targetE, Health);
      targetHp.current -= atk.damage;
      atk.cooldownRemaining = atk.cooldownTicks;
      const remaining = targetHp.current;
      world.events.emit(ATTACK_FIRED, { attacker: attackerE, target: targetE, tick });

      const targetName = nameOf(world, targetE);
      if (world.has(targetE, Controlled)) {
        world.events.emit(DAMAGE_TAKEN, {
          amount: atk.damage,
          source: attackerE,
          remaining,
        });
      } else {
        world.events.emit(ENEMY_DAMAGED, { name: targetName, amount: atk.damage, remaining });
        if (remaining <= 0) world.events.emit(ENEMY_KILLED, { name: targetName, tick });
      }
    }
  },
};

/** An entity's `Name`, or `null`. */
function nameOf(world: World, entity: Entity): string | null {
  const n = world.get(entity, Name);
  return n && typeof n.value === 'string' ? n.value : null;
}

/**
 * Grid trigger detection: emit the generic `trigger.entered` when the controlled actor's cell
 * falls inside a {@link Trigger} volume, latching `once` volumes with {@link Triggered}. Games
 * map this to their semantic events (switch/exit/goal). Uses the shared {@link pointInTrigger}.
 */
export const TRIGGER_ENTERED_EVENT = 'trigger.entered';

/** Payload of the mode's `trigger.entered` (mirrors `@aegis/content` convention). */
export interface TriggerEnteredEvent {
  /** The trigger entity. */
  entity: number;
  /** The trigger's `Name`. */
  name: string | null;
  /** The trigger's semantic kind (`switch`, `exit`, `goal`, …). */
  kind: string;
  /** The trigger's optional payload. */
  data?: Record<string, unknown>;
  /** The tick of entry. */
  tick: number;
}

/** Emit `trigger.entered` when the controlled actor stands inside a trigger volume. */
export const triggerSystem: System = {
  name: 'iso.trigger',
  phase: 'postUpdate',
  run({ world, tick }: TickContext): void {
    const actor = controlledActor(world);
    if (actor === undefined) return;
    const gp = world.getOrThrow(actor, GridPosition);
    const point = { x: gp.cellX, y: gp.cellY, z: 0 };

    for (const view of world.query({ has: [Trigger, Transform], none: [Triggered] }).views()) {
      const trig = view.get(Trigger) as TriggerData;
      const center = view.get(Transform).position;
      if (!pointInTrigger(trig, center, point)) continue;
      const payload: TriggerEnteredEvent = {
        entity: view.entity,
        name: nameOf(world, view.entity),
        kind: trig.kind,
        ...(trig.data ? { data: trig.data } : {}),
        tick,
      };
      world.events.emit(TRIGGER_ENTERED_EVENT, payload);
      if (trig.once) world.add(view.entity, Triggered);
    }
  },
};

/** Keep the iso camera centred on its named follow target (minimal; the frame does projection). */
export const cameraSystem: System = {
  name: 'iso.camera',
  phase: 'postUpdate',
  run({ world }: TickContext): void {
    // Camera state is derived by the view provider from the target's position each frame, so
    // there is nothing to integrate here. The system exists for parity with the other modes and
    // as the seam where a real follow-lerp would live. Intentionally a no-op over world state.
    void world;
  },
};

/** The mode's systems, in a stable registration order (the schedule resolves final order). */
export const ISO_SYSTEM_LIST: readonly System[] = [
  intakeSystem,
  cooldownSystem,
  pathfindSystem,
  moveSystem,
  combatSystem,
  triggerSystem,
  cameraSystem,
];
