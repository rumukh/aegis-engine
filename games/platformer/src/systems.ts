/**
 * Coyote Gap's game-owned systems: the deterministic critter patrol, stomp-vs-gore
 * discrimination, hazard/fall death, the two-altitude death mapping, and goal detection. All are
 * pure functions of world state + tick (no wall-clock, no RNG) and read the mode's generic facts
 * to emit the game's semantic events.
 * @packageDocumentation
 */
import { abs, floor, Transform } from '@aegis/core';
import type { Entity, System, TickContext, World } from '@aegis/core';
import { Dead, ENTITY_DIED, Health, pointInTrigger, Trigger, Triggered } from '@aegis/content';
import type { EntityDiedEvent } from '@aegis/content';
import { TileCollider, Velocity } from '@aegis/mode-platformer';
import { Critter, LethalHit, Patrol, Player } from './components.js';
import { DAMAGE_TAKEN, ENEMY_KILLED, LEVEL_COMPLETED, PLAYER_DIED } from './events.js';

/** Bounce velocity imparted to the player on a successful stomp, world units per second. */
const STOMP_BOUNCE = 10;
/** Below this world-y the player has fallen out of the level. */
const FELL_OUT_Y = -4;

/** Deterministic patrol centre along x at `tick`: a triangle wave between `minX` and `maxX`. */
export function patrolX(
  p: { minX: number; maxX: number; speed: number; phase: number },
  tick: number,
  dt: number,
): number {
  const range = p.maxX - p.minX;
  if (range <= 0) return p.minX;
  const cycle = 2 * range;
  const dist = p.speed * dt * tick + p.phase * cycle;
  const d = dist - floor(dist / cycle) * cycle;
  const tri = d <= range ? d : cycle - d;
  return p.minX + tri;
}

/** Move each critter to its deterministic patrol position for this tick. */
const patrolSystem: System = {
  name: 'game.patrol',
  phase: 'update',
  run({ world, tick, dt }: TickContext): void {
    for (const view of world.query({ has: [Critter, Patrol, Transform] }).views()) {
      view.get(Transform).position.x = patrolX(view.get(Patrol), tick, dt);
    }
  },
};

/**
 * Stomp vs gore. Runs after the mode has integrated positions (so overlaps reflect where bodies
 * actually are this tick). A descending player whose feet clear the critter's centre stomps it
 * (→ the critter's `Health` drops to 0, which `healthSystem` turns into `entity.died` →
 * `enemy.killed`) and gets a bounce; any other overlap gores the player.
 */
const stompGoreSystem: System = {
  name: 'game.stompgore',
  phase: 'physics',
  after: ['platformer.integrate'],
  run({ world }: TickContext): void {
    const pv = world
      .query({ has: [Player, Transform, Velocity, TileCollider, Health], none: [Dead] })
      .first();
    if (!pv) return;
    const pt = pv.get(Transform).position;
    const pc = pv.get(TileCollider);
    const pvel = pv.get(Velocity);
    const phealth = pv.get(Health);
    if (phealth.current <= 0) return;

    for (const cv of world
      .query({ has: [Critter, Transform, TileCollider, Health], none: [Dead] })
      .views()) {
      const ch = cv.get(Health);
      if (ch.current <= 0) continue;
      const ct = cv.get(Transform).position;
      const cc = cv.get(TileCollider);

      const overlapX = abs(pt.x - ct.x) < pc.halfWidth + cc.halfWidth;
      const overlapY = abs(pt.y - ct.y) < pc.halfHeight + cc.halfHeight;
      if (!overlapX || !overlapY) continue;

      const feet = pt.y - pc.halfHeight;
      const descending = pvel.dy < 0;
      if (descending && feet >= ct.y - cc.halfHeight) {
        // Stomp: kill the critter (healthSystem → entity.died → enemy.killed) and bounce.
        ch.current = 0;
        pvel.dy = STOMP_BOUNCE;
      } else {
        // Gore: the player takes a lethal hit.
        phealth.current = 0;
        world.add(pv.entity, LethalHit, { cause: 'critter' });
        world.events.emit(DAMAGE_TAKEN, { amount: 1, source: 'critter' });
        return;
      }
    }
  },
};

/**
 * Hazard and fall death. Runs in `postUpdate` before `content.health.death` so a lethal touch is
 * reflected in `Health` the same tick it happens. A player inside any `hazard` {@link Trigger}
 * volume, or fallen below {@link FELL_OUT_Y}, drops to zero health with a labelled cause.
 */
const hazardSystem: System = {
  name: 'game.hazard',
  phase: 'postUpdate',
  before: ['content.health.death'],
  run({ world }: TickContext): void {
    const pv = world.query({ has: [Player, Transform, Health], none: [Dead] }).first();
    if (!pv) return;
    const health = pv.get(Health);
    if (health.current <= 0) return;
    const p = pv.get(Transform).position;

    if (p.y < FELL_OUT_Y) {
      health.current = 0;
      world.add(pv.entity, LethalHit, { cause: 'fell' });
      return;
    }

    for (const hv of world.query({ has: [Trigger, Transform] }).views()) {
      const trig = hv.get(Trigger);
      if (trig.kind !== 'hazard') continue;
      const center = hv.get(Transform).position;
      if (pointInTrigger(trig, center, p)) {
        health.current = 0;
        world.add(pv.entity, LethalHit, { cause: 'hazard' });
        world.events.emit(DAMAGE_TAKEN, { amount: 1, source: 'hazard' });
        return;
      }
    }
  },
};

/**
 * The two-altitude death mapping: translate this tick's generic `entity.died` facts into the
 * game's semantic vocabulary — `player.died { cause }` for the player, `enemy.killed { name }`
 * for a critter. Runs in `events`, after `healthSystem` has emitted `entity.died` in `postUpdate`.
 */
const deathMapSystem: System = {
  name: 'game.deathmap',
  phase: 'events',
  run({ world, tick }: TickContext): void {
    for (const ev of world.events.ofType<EntityDiedEvent>(ENTITY_DIED)) {
      // `EntityDiedEvent.entity` is `number` in @aegis/content while the World API takes the
      // branded `Entity`; `games/iso` narrows the same way. Reported to the PM — the proper fix
      // is to declare the payload as `Entity` in @aegis/content.
      const entity = ev.data.entity as Entity;
      if (world.has(entity, Player)) {
        const cause = world.get(entity, LethalHit)?.cause ?? 'unknown';
        world.events.emit(PLAYER_DIED, { cause, tick });
      } else if (world.has(entity, Critter)) {
        world.events.emit(ENEMY_KILLED, { name: ev.data.name, tick });
      }
    }
  },
};

/** Whether the player's collider centre is inside a goal trigger. */
function playerInGoal(world: World): { hit: boolean; entity: Entity | null } {
  const pv = world.query({ has: [Player, Transform] }).first();
  if (!pv) return { hit: false, entity: null };
  const p = pv.get(Transform).position;
  for (const gv of world.query({ has: [Trigger, Transform], none: [Triggered] }).views()) {
    const trig = gv.get(Trigger);
    if (trig.kind !== 'goal') continue;
    if (pointInTrigger(trig, gv.get(Transform).position, p))
      return { hit: true, entity: gv.entity };
  }
  return { hit: false, entity: null };
}

/** Emit `level.completed` exactly once, the tick the player enters the goal volume. */
const goalSystem: System = {
  name: 'game.goal',
  phase: 'postUpdate',
  run({ world, tick }: TickContext): void {
    const { hit, entity } = playerInGoal(world);
    if (!hit || entity === null) return;
    world.events.emit(LEVEL_COMPLETED, { tick });
    world.add(entity, Triggered);
  },
};

/** All game-owned systems, in registration order (the scheduler resolves final order by phase). */
export const COYOTE_GAP_GAME_SYSTEMS: readonly System[] = [
  patrolSystem,
  stompGoreSystem,
  hazardSystem,
  deathMapSystem,
  goalSystem,
];
