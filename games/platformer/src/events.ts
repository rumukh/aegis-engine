/**
 * The game's *semantic* event vocabulary — the second altitude on top of the engine's generic
 * facts (CHARTER principle 6). The mode emits generic movement facts (`player.jumped`,
 * `player.landed`, `platform.boarded`) and `@aegis/content` emits `entity.died`; the game's
 * systems read those and re-emit these game-meaningful events, which the assertions check.
 * @packageDocumentation
 */

/** The player stomped a critter. Payload `{ name, tick }`. */
export const ENEMY_KILLED = 'enemy.killed';

/** The player took damage (gore or hazard). Payload `{ amount, source: 'critter' | 'hazard' }`. */
export const DAMAGE_TAKEN = 'damage.taken';

/** The player died (emitted once). Payload `{ cause, tick }`. */
export const PLAYER_DIED = 'player.died';

/** The player reached the goal flag (emitted once). Payload `{ tick }`. */
export const LEVEL_COMPLETED = 'level.completed';
