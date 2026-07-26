/**
 * Sector Breach systems: the game-altitude rules that turn mode-level facts (a ray hit a named
 * thing, an entity's `Health` reached zero) into the semantic beats the spec asserts — the blast
 * door opening, the grunt's return fire, the kill, the pit death, the exit.
 *
 * Two altitudes, deliberately not collapsed (CHARTER principle 6): the mode emits `hitscan.hit`
 * and `@aegis/content` emits the generic `entity.died`; these systems *read* those and *re-emit*
 * `door.opened`, `enemy.killed`, `player.died`, `level.completed`. All are pure functions of the
 * world + tick, using only `@aegis/core/math`, so a whole run is bit-reproducible (ADR-0001).
 * @packageDocumentation
 */
import { Name, Transform } from '@aegis/core';
import type { Entity, System, Vec3, World } from '@aegis/core';
import { abs, dot3, length3, normalize3, sub3 } from '@aegis/core/math';
import { ENTITY_DIED, Health, Trigger, Triggered, pointInTrigger } from '@aegis/content';
import type { EntityDiedEvent, TriggerData } from '@aegis/content';
import { FPS_COLLISION, HITSCAN_HIT, Hitscan, raycastGrid } from '@aegis/mode-fps';
import type { CollisionGrid, HitscanHitEvent } from '@aegis/mode-fps';
import { Button, Enemy, GruntAi, Player } from './components.js';

// --- semantic event vocabulary -------------------------------------------------------------

/** `door.opened` payload. */
export interface DoorOpenedEvent {
  /** Name of the door that opened (the blast door). */
  name: string;
}
/** `enemy.damaged` payload. */
export interface EnemyDamagedEvent {
  /** `Name` of the grunt that was hit. */
  name: string;
  /** Damage dealt by this shot. */
  amount: number;
  /** The grunt's remaining `Health` after the hit. */
  remaining: number;
}
/** `enemy.killed` payload. */
export interface EnemyKilledEvent {
  /** `Name` of the grunt that died. */
  name: string;
  tick: number;
}
/** `damage.taken` payload (incoming damage to the player). */
export interface DamageTakenEvent {
  /** Damage dealt to the player. */
  amount: number;
  /** Who dealt it (the grunt's `Name`). */
  source: string;
  /** The player's remaining `Health` after the hit. */
  remaining: number;
}
/** `player.died` payload. */
export interface PlayerDiedEvent {
  /** Why the player died (`"coolant"` for the pit, `"killed"` for lethal damage). */
  cause: string;
  tick: number;
}
/** `level.completed` payload. */
export interface LevelCompletedEvent {
  tick: number;
}

/** The blast door opens when the button is shot. */
export const DOOR_OPENED = 'door.opened';
/** The grunt took a player hitscan hit. */
export const ENEMY_DAMAGED = 'enemy.damaged';
/** The grunt's `Health` reached zero. */
export const ENEMY_KILLED = 'enemy.killed';
/** The grunt hit the player. */
export const DAMAGE_TAKEN = 'damage.taken';
/** The player died (pit or lethal damage), emitted once. */
export const PLAYER_DIED = 'player.died';
/** The player reached the exit, emitted once. */
export const LEVEL_COMPLETED = 'level.completed';

/** The eye height reused for the grunt's line-of-sight ray (matches the FPS camera default). */
const EYE_HEIGHT = 1.6;

// --- systems ------------------------------------------------------------------------------

/**
 * The security grunt's return fire. Deterministic and RNG-free: the grunt fires at the player
 * when the player is within `range`, ahead of the grunt's `facing`, roughly column-aligned, and
 * not occluded by a wall (a `raycastGrid` line-of-sight probe). A shot costs the player `damage`
 * `Health` and re-arms after `fireInterval` ticks. Runs after the capsule has moved this tick so
 * targeting sees the player's current position.
 */
export const gruntAiSystem: System = {
  name: 'game.grunt.ai',
  phase: 'physics',
  after: ['fps.integrate'],
  run({ world }) {
    const grid = world.getResource(FPS_COLLISION) as CollisionGrid | undefined;
    if (grid === undefined) return;

    const player = world.query({ has: [Player, Transform, Health] }).views()[0];
    if (player === undefined) return;
    const playerHp = player.get(Health);
    const playerPos = player.get(Transform).position;
    const playerEye: Vec3 = { x: playerPos.x, y: playerPos.y + EYE_HEIGHT, z: playerPos.z };

    for (const view of world.query({ has: [GruntAi, Transform, Health] }).views()) {
      const ai = view.get(GruntAi);
      if (ai.cooldownRemaining > 0) ai.cooldownRemaining -= 1;

      const gruntHp = view.get(Health);
      if (gruntHp.current <= 0) continue; // dead grunts hold their fire

      const gruntPos = view.get(Transform).position;
      const gruntEye: Vec3 = { x: gruntPos.x, y: gruntPos.y + EYE_HEIGHT, z: gruntPos.z };

      const toPlayer = sub3(playerEye, gruntEye);
      const dist = length3(toPlayer);
      if (dist > ai.range || dist <= 1e-6) continue;
      if (dot3(toPlayer, ai.facing) <= 0) continue; // behind the grunt
      if (abs(toPlayer.x) > 1.5) continue; // not roughly in the grunt's lane

      const dir = normalize3(toPlayer);
      const wall = raycastGrid(grid, gruntEye, dir, dist);
      if (wall !== undefined) continue; // a wall stands between them

      if (ai.cooldownRemaining > 0) continue;
      playerHp.current -= ai.damage;
      ai.cooldownRemaining = ai.fireInterval;
      const source = world.get(view.entity, Name)?.value ?? 'grunt';
      world.events.emit<DamageTakenEvent>(DAMAGE_TAKEN, {
        amount: ai.damage,
        source,
        remaining: playerHp.current,
      });
    }
  },
};

/**
 * Open the blast door the first time a hitscan ray names the {@link Button}. Removes the door by
 * flipping every `door` cell in the collision grid to non-solid (a door opening is deterministic
 * simulation state carried in the hashed grid resource, per the geometry note), then emits
 * `door.opened` exactly once.
 */
export const doorSystem: System = {
  name: 'game.door',
  phase: 'postUpdate',
  run({ world }) {
    const grid = world.getResource(FPS_COLLISION) as CollisionGrid | undefined;
    if (grid === undefined) return;
    if (!grid.cells.some((c) => c.door && c.solid)) return; // already open

    const buttonNames = new Set(
      world
        .query({ has: [Button, Name] })
        .views()
        .map((v) => v.get(Name).value),
    );
    const hits = world.events.ofType<HitscanHitEvent>(HITSCAN_HIT);
    if (!hits.some((e) => buttonNames.has(e.data.target))) return;

    for (const cell of grid.cells) if (cell.door) cell.solid = false;
    world.events.emit<DoorOpenedEvent>(DOOR_OPENED, { name: 'blast-door' });
  },
};

/**
 * Re-spell a mode `hitscan.hit` on the grunt as the semantic `enemy.damaged`. The mode has
 * already applied the weapon's damage to the grunt's `Health`; this reports the amount and the
 * remaining total for the game's own event vocabulary.
 */
export const enemyDamageSystem: System = {
  name: 'game.enemy.damage',
  phase: 'postUpdate',
  run({ world }) {
    const hits = world.events.ofType<HitscanHitEvent>(HITSCAN_HIT);
    if (hits.length === 0) return;

    const player = world.query({ has: [Player, Hitscan] }).views()[0];
    const amount = player?.get(Hitscan).damage ?? 0;

    const grunts = world.query({ has: [Enemy, Name, Health] }).views();
    for (const hit of hits) {
      const grunt = grunts.find((v) => v.get(Name).value === hit.data.target);
      if (grunt === undefined) continue;
      world.events.emit<EnemyDamagedEvent>(ENEMY_DAMAGED, {
        name: hit.data.target,
        amount,
        remaining: grunt.get(Health).current,
      });
    }
  },
};

/**
 * Map the generic `entity.died` to the game's semantic deaths: an {@link Enemy} becomes
 * `enemy.killed`, the {@link Player} becomes `player.died`. Runs after `@aegis/content`'s
 * `healthSystem` (which fires `entity.died` once and latches `Dead`), so each maps exactly once.
 */
export const deathMappingSystem: System = {
  name: 'game.death.map',
  phase: 'postUpdate',
  after: ['content.health.death'],
  run({ world, tick }) {
    for (const ev of world.events.ofType<EntityDiedEvent>(ENTITY_DIED)) {
      const entity = ev.data.entity as Entity;
      const name = ev.data.name ?? 'unknown';
      if (world.get(entity, Enemy) !== undefined) {
        world.events.emit<EnemyKilledEvent>(ENEMY_KILLED, { name, tick });
      } else if (world.get(entity, Player) !== undefined) {
        world.events.emit<PlayerDiedEvent>(PLAYER_DIED, { cause: 'killed', tick });
      }
    }
  },
};

/** Fire `emit` once when the player's feet enter a `once` trigger of `kind`, latching it. */
function detectTriggerOnce(
  world: World,
  kind: string,
  playerFeet: Vec3,
  emit: (data: TriggerData) => void,
): void {
  for (const view of world.query({ has: [Trigger, Transform], none: [Triggered] }).views()) {
    const trigger = view.get(Trigger);
    if (trigger.kind !== kind) continue;
    const center = view.get(Transform).position;
    if (!pointInTrigger(trigger, center, playerFeet)) continue;
    emit(trigger);
    world.add(view.entity, Triggered);
  }
}

/**
 * The toxic coolant pit: if the player's feet drop into a `hazard` trigger volume, the player
 * dies once. In a completing run the jump clears the pit and this never fires — it is the loud
 * failure a botched jump produces.
 */
export const hazardSystem: System = {
  name: 'game.hazard',
  phase: 'postUpdate',
  run({ world, tick }) {
    const player = world.query({ has: [Player, Transform] }).views()[0];
    if (player === undefined) return;
    const feet = player.get(Transform).position;
    detectTriggerOnce(world, 'hazard', feet, (trigger) => {
      const cause = typeof trigger.data?.['cause'] === 'string' ? trigger.data['cause'] : 'coolant';
      world.events.emit<PlayerDiedEvent>(PLAYER_DIED, { cause, tick });
    });
  },
};

/** The exit: reaching the goal trigger behind the grunt completes the level, once. */
export const goalSystem: System = {
  name: 'game.goal',
  phase: 'postUpdate',
  run({ world, tick }) {
    const player = world.query({ has: [Player, Transform] }).views()[0];
    if (player === undefined) return;
    const feet = player.get(Transform).position;
    detectTriggerOnce(world, 'goal', feet, () => {
      world.events.emit<LevelCompletedEvent>(LEVEL_COMPLETED, { tick });
    });
  },
};

/** The game's systems, layered on top of {@link FPS_SYSTEMS} and content's `healthSystem`. */
export const SECTOR_BREACH_SYSTEMS: readonly System[] = [
  gruntAiSystem,
  doorSystem,
  enemyDamageSystem,
  deathMappingSystem,
  hazardSystem,
  goalSystem,
];
