/**
 * Shared gameplay vocabulary — components and systems that every mode needs, so they live in
 * the engine rather than being copy-pasted into each game.
 *
 * Two altitudes of events, deliberately not collapsed (CHARTER principle 6):
 *  - **Generic, mode-agnostic** facts emitted here: `entity.died`, and (when a mode's detection
 *    system uses {@link pointInTrigger}) `trigger.entered`. These carry no game meaning.
 *  - **Semantic** facts (`enemy.killed`, `player.died`, `level.completed`) are layered on top by
 *    each game's own systems, which read the generic events and re-emit in their own vocabulary.
 *
 * Keeping the generic layer in `@aegis/content` means all three PoC games — and their gameplay
 * assertions — share one spelling of "something died" and "something entered a volume".
 * @packageDocumentation
 */
import { defineComponent, defineTag, Name } from '@aegis/core';
import type { ComponentType, Entity, System, Vec3 } from '@aegis/core';
import { describeComponent } from '../schema.js';

/** Data of {@link Health}. */
export interface HealthData {
  /** Current hit points. At or below zero the entity is considered dead. */
  current: number;
  /** Maximum hit points; `current` is never expected to exceed this. */
  max: number;
}

/**
 * Hit points, shared across **all** modes. The architect had put health only in `mode-fps`;
 * the PM's design-review ruling moved it here because the platformer (spikes), the iso game
 * (vault turrets) and the fps (guards) all need the same notion of "took damage / died".
 */
export const Health: ComponentType<HealthData> = defineComponent<HealthData>({
  id: 'Health',
  defaults: () => ({ current: 1, max: 1 }),
});

/**
 * Latch marking an entity the {@link healthSystem} has already reported as dead. Prevents a
 * duplicate `entity.died` on subsequent ticks while the corpse is still being cleaned up.
 */
export const Dead: ComponentType<Record<string, never>> = defineTag('Dead');

/** The shape of a trigger volume. */
export type TriggerShape = 'box' | 'sphere';

/**
 * Semantic role of a {@link Trigger}. Free-form by design — a mode may invent its own kinds —
 * but these four cover every documented PoC use (goal/exit, hazard, switch).
 */
export type TriggerKind = 'goal' | 'hazard' | 'switch' | 'exit' | (string & {});

/** Data of {@link Trigger}. */
export interface TriggerData {
  /** What this volume means to the game. Detection is mode-owned; this is just a label. */
  kind: TriggerKind;
  /** Volume shape. `box` uses {@link TriggerData.half}; `sphere` uses {@link TriggerData.radius}. */
  shape: TriggerShape;
  /** Half-extents for a `box`, relative to the entity's `Transform` position. */
  half: Vec3;
  /** Radius for a `sphere`. */
  radius: number;
  /** Fire at most once, then latch with {@link Triggered}. When `false`, fires every tick inside. */
  once: boolean;
  /** Optional payload copied onto the generic `trigger.entered` event (e.g. a switch id). */
  data?: Record<string, unknown>;
}

/**
 * A generic goal / hazard / switch / exit **volume**. All three games use it. The engine does
 * not run detection for you — where and how overlap is tested is mode-specific (2D AABB in the
 * platformer, grid cell in iso, 3D box in fps) — but {@link pointInTrigger} gives a pure,
 * deterministic overlap test the mode's own system can call, and the convention is to emit a
 * generic `trigger.entered` which the game maps to its semantic event.
 */
export const Trigger: ComponentType<TriggerData> = defineComponent<TriggerData>({
  id: 'Trigger',
  defaults: () => ({
    kind: 'goal',
    shape: 'box',
    half: { x: 0.5, y: 0.5, z: 0.5 },
    radius: 0.5,
    once: true,
  }),
});

// `data` is optional and so absent from the defaults, which would make schema validation read
// it as an unknown field; `shape` is a closed set a bare string default cannot express, and a
// mistyped one ("spere") would silently be treated as a box. `kind` is deliberately *not*
// listed: TriggerKind is open by design, so a mode may invent its own kinds.
describeComponent(Trigger, {
  optional: { data: 'object' },
  enums: { shape: ['box', 'sphere'] },
});

/** Latch marking a `once` {@link Trigger} that has already fired. */
export const Triggered: ComponentType<Record<string, never>> = defineTag('Triggered');

/** Payload of the generic `entity.died` event. */
export interface EntityDiedEvent {
  /**
   * The entity that reached zero health — a real {@link Entity} handle, not a bare number.
   * Consumers pass it straight to `world.has` / `world.get` / `world.add`; the brand is what
   * stops a slot index or an array position being mistaken for a live handle at that boundary.
   */
  entity: Entity;
  /** Its `Name` value, if it had one — handy in assertion messages and semantic mapping. */
  name: string | null;
}

/** The generic, mode-agnostic death event type emitted by {@link healthSystem}. */
export const ENTITY_DIED = 'entity.died';

/** The generic, mode-agnostic volume-entry event type by convention used with {@link pointInTrigger}. */
export const TRIGGER_ENTERED = 'trigger.entered';

/**
 * Emits a single generic {@link ENTITY_DIED} event the first tick any entity's `Health.current`
 * reaches zero, and latches it with {@link Dead} so the report fires exactly once.
 *
 * This is intentionally *dumb*: it says only "entity N died", not "the player died" or "an enemy
 * was killed". Games add their own system that reads `entity.died` and re-emits `player.died` /
 * `enemy.killed` based on which tags the dead entity carried — the two-altitude rule.
 *
 * Runs in `postUpdate`, after damage has been applied in `update`/`physics`.
 */
export const healthSystem: System = {
  name: 'content.health.death',
  phase: 'postUpdate',
  run({ world }) {
    for (const view of world.query({ has: [Health], none: [Dead] }).views()) {
      const hp = view.get(Health);
      if (hp.current <= 0) {
        const name = world.get(view.entity, Name)?.value ?? null;
        const payload: EntityDiedEvent = { entity: view.entity, name };
        world.events.emit(ENTITY_DIED, payload);
        world.add(view.entity, Dead);
      }
    }
  },
};

/**
 * Pure, deterministic overlap test between a point and a {@link Trigger} volume positioned at
 * `center`. No banned math — box is component-wise magnitude, sphere is squared-distance.
 *
 * Half-open on the boundary is not meaningful for continuous space, so the boundary counts as
 * inside (`<=`); modes that need strict containment can compare themselves.
 */
export function pointInTrigger(trigger: TriggerData, center: Vec3, point: Vec3): boolean {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const dz = point.z - center.z;
  if (trigger.shape === 'sphere') {
    const r = trigger.radius;
    return dx * dx + dy * dy + dz * dz <= r * r;
  }
  const h = trigger.half;
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  const az = dz < 0 ? -dz : dz;
  return ax <= h.x && ay <= h.y && az <= h.z;
}
