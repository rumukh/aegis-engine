/**
 * Sector Breach components: the game-altitude vocabulary layered on top of `@aegis/mode-fps`.
 *
 * These are deliberately thin. The mode owns the *physics* nouns (capsule, camera, hitscan);
 * the game owns the *meaning* nouns: who is the player, who is an enemy, what is the shootable
 * button, and how the lone security grunt decides to fire. Registering them via the plugin's
 * `components()` is what lets a scene's `tags: ["Player"]` become a queryable marker and a
 * scene's `GruntAi: { … }` data merge over these defaults (ADR-0003, and the harness note that
 * unregistered scene component ids are a validation error).
 * @packageDocumentation
 */
import { defineComponent, defineTag } from '@aegis/core';
import type { ComponentType, Vec3 } from '@aegis/core';

/** Marker: the human-controlled first-person actor. Queried by the assertions as `"Player"`. */
export const Player: ComponentType<Record<string, never>> = defineTag('Player');

/** Marker: a hostile entity. The grunt carries it; `deathMappingSystem` reads it to re-spell
 * a generic `entity.died` as the semantic `enemy.killed`. */
export const Enemy: ComponentType<Record<string, never>> = defineTag('Enemy');

/** Marker: the shootable wall panel that opens the blast door when a hitscan ray strikes it. */
export const Button: ComponentType<Record<string, never>> = defineTag('Button');

/** Data of {@link GruntAi}: a deterministic, RNG-free "fire on sight" turret cadence. */
export interface GruntAiData {
  /** Maximum engagement distance (world units) from the grunt's eye to the target's eye. */
  range: number;
  /** Damage applied to the player's `Health` per shot. */
  damage: number;
  /** Ticks between shots. The first eligible tick fires immediately (`cooldownRemaining` 0). */
  fireInterval: number;
  /** Ticks until the grunt may fire again. Counts down each tick; a shot resets it to `fireInterval`. */
  cooldownRemaining: number;
  /** The unit direction the grunt looks; a target only counts as "in front" when it lies along it. */
  facing: Vec3;
}

/**
 * The security grunt's targeting brain. Purely a function of the two actors' positions and the
 * collision grid — no randomness, no wall-clock — so incoming damage is bit-reproducible, which
 * is exactly what the game test's `Health.current >= 70` invariant pins.
 */
export const GruntAi: ComponentType<GruntAiData> = defineComponent<GruntAiData>({
  id: 'GruntAi',
  defaults: () => ({
    range: 6,
    damage: 10,
    fireInterval: 60,
    cooldownRemaining: 0,
    facing: { x: 0, y: 0, z: -1 },
  }),
});

/**
 * The cause of the blow that killed the player, latched on the player the tick it lands.
 *
 * Exists so a *hazard* death is a real death and not just an announcement. `hazardSystem` used to
 * emit `player.died` without touching `Health`, so `Dead` never latched for a pit fall: nothing in
 * the world knew the player was dead, and a run that kept driving `Forward` climbed back out of
 * the pit and reached the exit at t200 — emitting `player.died` and `level.completed` in one run.
 * Now the hazard zeroes `Health` and records the cause here; `@aegis/content`'s `healthSystem`
 * turns that into `entity.died` + `Dead`, and `deathMappingSystem` re-spells it with this cause.
 * Mirrors `games/platformer`'s `LethalHit`.
 */
export const LethalHit: ComponentType<{ cause: string }> = defineComponent<{ cause: string }>({
  id: 'LethalHit',
  defaults: () => ({ cause: 'unknown' }),
});

/** Every component the game contributes to the registry (in addition to the mode's set). */
export const GAME_COMPONENTS: readonly ComponentType<unknown>[] = [
  Player,
  Enemy,
  Button,
  GruntAi,
  LethalHit,
] as readonly ComponentType<unknown>[];
