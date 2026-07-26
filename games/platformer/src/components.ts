/**
 * Game-owned components for "Coyote Gap". These are the vocabulary the *game* adds on top of the
 * mode: marker tags the assertions query by (`Player`, `Critter`), the deterministic critter
 * patrol descriptor, and a transient record of what dealt the killing blow (so the game can emit
 * `player.died { cause }`). Physics/collision components come from `@aegis/mode-platformer`;
 * `Health` and `Trigger` come from `@aegis/content`.
 * @packageDocumentation
 */
import { defineComponent, defineTag } from '@aegis/core';
import type { ComponentType } from '@aegis/core';

/** Marker: the player-controlled character. Queried by the gameplay assertions (`has: ['Player']`). */
export const Player: ComponentType<Record<string, never>> = defineTag('Player');

/** Marker: a patrolling critter enemy. */
export const Critter: ComponentType<Record<string, never>> = defineTag('Critter');

/** Data of {@link Patrol}: a deterministic left–right patrol along x, a pure function of the tick. */
export interface PatrolData {
  /** Minimum patrol centre x, world units. */
  minX: number;
  /** Maximum patrol centre x, world units. */
  maxX: number;
  /** Patrol speed, world units per second. */
  speed: number;
  /** Phase in `[0, 1)` along the triangle-wave cycle (`0` starts at `minX` heading right). */
  phase: number;
}

/** A deterministic horizontal patrol; the {@link PatrolSystem} makes position a pure fn of tick. */
export const Patrol: ComponentType<PatrolData> = defineComponent<PatrolData>({
  id: 'Patrol',
  defaults: () => ({ minX: 0, maxX: 0, speed: 3, phase: 0 }),
});

/** Data of {@link LethalHit}: why the player died, set by whichever system delivered the blow. */
export interface LethalHitData {
  /** Cause label, surfaced on the `player.died` event. */
  cause: 'hazard' | 'critter' | 'fell' | 'unknown';
}

/**
 * Transient marker added to the player on the tick a lethal hit lands, carrying the cause so the
 * death-mapping system can label `player.died`. Separate from `Health` so the generic
 * `entity.died` altitude stays game-agnostic.
 */
export const LethalHit: ComponentType<LethalHitData> = defineComponent<LethalHitData>({
  id: 'LethalHit',
  defaults: () => ({ cause: 'unknown' }),
});

/** All game-owned component types, registered via the plugin so scenes can author/query them. */
export const COYOTE_GAP_COMPONENTS: readonly ComponentType<unknown>[] = [
  Player,
  Critter,
  Patrol,
  LethalHit,
] as readonly ComponentType<unknown>[];
