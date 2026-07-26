/**
 * Isometric-mode event vocabulary. These are the *mode-level* (generic) events the iso engine
 * emits: order acknowledgements, path outcomes, movement and combat facts. Per ADR-0007's
 * two-altitude rule the game layer listens to these and re-emits its own *semantic* events
 * (e.g. `switch.activated`, `mission.completed`); the mode never speaks the game's vocabulary.
 *
 * Combat events are phrased from the pointer-controlled actor's perspective: a hit it *lands* is
 * an `enemy.*` event, a hit it *takes* is `damage.taken`. `attack.fired` is perspective-neutral.
 * @packageDocumentation
 */
import type { Cell } from './components.js';

/** Emitted when a click resolves to a move command for the controlled actor. */
export const MOVE_ORDERED = 'move.ordered';
/** Emitted when a click resolves to an attack command against an entity. */
export const ATTACK_ORDERED = 'attack.ordered';
/** Emitted when a path is successfully resolved for a move/attack order. */
export const PATH_RESOLVED = 'path.resolved';
/** Emitted when a requested destination is unreachable (honest failure, no half-move). */
export const PATH_BLOCKED = 'path.blocked';
/** Emitted when an actor's logical cell changes (one per cell crossed). */
export const CELL_ENTERED = 'cell.entered';
/** Emitted every time any attacker's weapon discharges. */
export const ATTACK_FIRED = 'attack.fired';
/** Emitted when the controlled actor damages a non-controlled actor. */
export const ENEMY_DAMAGED = 'enemy.damaged';
/** Emitted when the controlled actor's hit reduces a non-controlled actor to 0 HP. */
export const ENEMY_KILLED = 'enemy.killed';
/** Emitted when the controlled actor takes damage. */
export const DAMAGE_TAKEN = 'damage.taken';

/** Payload of {@link MOVE_ORDERED}. */
export interface MoveOrderedEvent {
  /** Entity that received the order. */
  entity: number;
  /** Destination cell. */
  target: Cell;
  /** Tick the order was issued. */
  tick: number;
}

/** Payload of {@link ATTACK_ORDERED}. */
export interface AttackOrderedEvent {
  /** Entity that received the order. */
  entity: number;
  /** Entity being attacked. */
  target: number;
  /** Tick the order was issued. */
  tick: number;
}

/** Payload of {@link PATH_RESOLVED}. */
export interface PathResolvedEvent {
  /** Entity the path was resolved for. */
  entity: number;
  /** Number of cells in the resolved path (0 = already at/within target). */
  length: number;
  /** Tick the path was resolved. */
  tick: number;
}

/** Payload of {@link PATH_BLOCKED}. */
export interface PathBlockedEvent {
  /** Entity whose order could not be satisfied. */
  entity: number;
  /** Destination cell that proved unreachable. */
  target: Cell;
  /** Tick the failure was detected. */
  tick: number;
}

/** Payload of {@link CELL_ENTERED}. */
export interface CellEnteredEvent {
  /** Entity that entered the cell. */
  entity: number;
  /** Newly entered cell. */
  x: number;
  y: number;
  /** Tick of entry. */
  tick: number;
}

/** Payload of {@link ATTACK_FIRED} — perspective-neutral; either combatant may fire. */
export interface AttackFiredEvent {
  /** Entity that fired the shot. */
  attacker: number;
  /** Entity that was hit. */
  target: number;
  /** Tick the shot landed. */
  tick: number;
}

/** Payload of {@link ENEMY_DAMAGED} — the controlled actor hit a non-controlled actor. */
export interface EnemyDamagedEvent {
  /** The struck entity's `Name`, or `null`. */
  name: string | null;
  /** Damage applied by this shot. */
  amount: number;
  /** The struck entity's remaining HP after the shot. */
  remaining: number;
}

/** Payload of {@link ENEMY_KILLED} — the controlled actor's hit reduced a foe to 0 HP. */
export interface EnemyKilledEvent {
  /** The killed entity's `Name`, or `null`. */
  name: string | null;
  /** Tick the killing blow landed. */
  tick: number;
}

/** Payload of {@link DAMAGE_TAKEN} — the controlled actor was hit. */
export interface DamageTakenEvent {
  /** Damage applied by this shot. */
  amount: number;
  /** The attacking entity. */
  source: number;
  /** The controlled actor's remaining HP after the shot. */
  remaining: number;
}
