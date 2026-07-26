/**
 * Appearance resolution: how world data becomes something you can see.
 *
 * Two sources, in priority order:
 *
 * 1. The declarative appearance components from `@aegis/content` — `Sprite` (2D modes), `Model`
 *    (3D) and `Light`. These are authored content the simulation ignores entirely (ADR-0005), so
 *    honouring them costs the sim nothing.
 * 2. A **role palette**: none of the three PoC scenes author appearance yet, so the adapter falls
 *    back to a colour chosen from the components an entity carries (a `PlatformerController` is
 *    the player, a `Blocking` grid entity is the door, …). Crude by design — the charter's
 *    anti-goal is explicit that rendering is a thin adapter, and legibility beats beauty.
 *
 * Everything here is a pure function of world data. Nothing writes back.
 * @packageDocumentation
 */
import { Color } from 'three';
import type { Material } from 'three';
import { MeshLambertMaterial, MeshBasicMaterial, DoubleSide } from 'three';
import type { SpriteData, ModelData } from '@aegis/content';

/**
 * The visual roles the adapters draw. A role maps to one colour so the same thing looks the same
 * in all three games, which is the whole point of a legibility-first palette.
 */
export type VisualRole =
  | 'player'
  | 'enemy'
  | 'neutral'
  | 'platform'
  | 'wall'
  | 'floor'
  | 'ceiling'
  | 'hazard'
  | 'goal'
  | 'switch'
  | 'door'
  | 'pit'
  | 'dead'
  | 'unknown';

/** Base colour per {@link VisualRole}, as `#rrggbb`. */
export const ROLE_COLORS: Readonly<Record<VisualRole, string>> = {
  player: '#4ade80',
  enemy: '#f43f5e',
  neutral: '#c084fc',
  platform: '#fbbf24',
  wall: '#6b7a8f',
  floor: '#2b3a4d',
  ceiling: '#141c28',
  hazard: '#ef4444',
  goal: '#22d3ee',
  switch: '#facc15',
  door: '#fb923c',
  pit: '#7f1d1d',
  dead: '#4b5563',
  unknown: '#94a3b8',
};

/** Background clear colour per mode, chosen for contrast against {@link ROLE_COLORS}. */
export const MODE_BACKGROUNDS = {
  platformer: '#0b1220',
  iso: '#0d1117',
  fps: '#05070d',
} as const;

/** A fully-resolved appearance for one drawable thing. */
export interface Appearance {
  /** Resolved colour as `#rrggbb`. */
  color: string;
  /** Whether the thing should be drawn at all. */
  visible: boolean;
  /** Opacity in `[0, 1]`; `< 1` turns on transparency. */
  opacity: number;
}

/** Parse the `#rrggbb` / `#rrggbbaa` tint of a {@link SpriteData} into colour + opacity. */
function parseTint(tint: string | undefined): { color?: string; opacity?: number } {
  if (tint === undefined || !tint.startsWith('#')) return {};
  if (tint.length === 9) {
    return { color: tint.slice(0, 7), opacity: Number.parseInt(tint.slice(7), 16) / 255 };
  }
  if (tint.length === 7 || tint.length === 4) return { color: tint };
  return {};
}

/** Options for {@link resolveAppearance}. */
export interface AppearanceInput {
  /** The role the adapter inferred from the entity's simulation components. */
  role: VisualRole;
  /** The entity's `Sprite`, when it has one. */
  sprite?: SpriteData | undefined;
  /** The entity's `Model`, when it has one. */
  model?: ModelData | undefined;
  /** Opacity to use when neither component overrides it. Defaults to `1`. */
  opacity?: number;
}

/**
 * Resolve the appearance of one entity: authored `Sprite`/`Model` data wins, otherwise the role
 * palette. Pure — the same input always yields the same appearance.
 */
export function resolveAppearance(input: AppearanceInput): Appearance {
  const fallback = ROLE_COLORS[input.role];
  const tint = parseTint(input.sprite?.tint);
  const visible = (input.sprite?.visible ?? input.model?.visible ?? true) !== false;
  return {
    color: tint.color ?? fallback,
    visible,
    opacity: tint.opacity ?? input.opacity ?? 1,
  };
}

/** Build a lit material for solid geometry from a resolved {@link Appearance}. */
export function litMaterial(appearance: Appearance): Material {
  const material = new MeshLambertMaterial({ color: new Color(appearance.color) });
  if (appearance.opacity < 1) {
    material.transparent = true;
    material.opacity = appearance.opacity;
  }
  return material;
}

/**
 * Build an unlit material for volumes and markers — trigger boxes, floor plates, health bars.
 * Unlit keeps them readable regardless of where the lights are.
 */
export function flatMaterial(appearance: Appearance): Material {
  const material = new MeshBasicMaterial({ color: new Color(appearance.color), side: DoubleSide });
  if (appearance.opacity < 1) {
    material.transparent = true;
    material.opacity = appearance.opacity;
  }
  return material;
}
