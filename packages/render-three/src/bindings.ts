/**
 * Keyboard/mouse → logical input bindings, as data.
 *
 * The simulation only knows actions and axes; a binding table is the whole of "how a human
 * drives it". Keeping it as plain data means the browser can apply it and the page can print it
 * as an on-screen control list from the same source, so the help can never drift from the keys.
 *
 * Action and axis names are the ones the modes actually read — `MoveX`/`Jump`
 * (`platformer.intake`), `Forward`/`Strafe`/`Jump`/`Fire` (`fps.intake`, `fps.hitscan`), and the
 * pointer for `iso.intake`. They are the same names the `.input` DSL emits.
 * @packageDocumentation
 */
import type { GameMode } from '@aegis/core';

/** A key that holds a digital action while it is down. */
export interface ActionBinding {
  /** `KeyboardEvent.code`, e.g. `"Space"`, `"KeyW"`, `"ArrowLeft"`. */
  code: string;
  /** The logical action name the simulation reads. */
  action: string;
}

/** A key that contributes a constant value to an analog axis while it is down. */
export interface AxisBinding {
  /** `KeyboardEvent.code`. */
  code: string;
  /** The logical axis name the simulation reads. */
  axis: string;
  /** Contribution while held; opposing keys sum to zero. */
  value: number;
}

/** How the mode uses the mouse. */
export type PointerMode = 'none' | 'lock' | 'click';

/** One line of on-screen help. */
export interface ControlHelp {
  /** Human-readable key list. */
  keys: string;
  /** What it does. */
  does: string;
}

/** Everything needed to drive one mode from a browser. */
export interface ModeBindings {
  /** Digital action keys. */
  actions: readonly ActionBinding[];
  /** Analog axis keys. */
  axes: readonly AxisBinding[];
  /** Mouse handling: pointer-lock look (fps), click-to-order (iso), or unused. */
  pointer: PointerMode;
  /** Action fired by the primary mouse button under pointer lock. */
  primaryButtonAction?: string;
  /** Degrees of look per pixel of mouse movement (fps). */
  lookDegreesPerPixel?: number;
  /** On-screen control list. */
  help: readonly ControlHelp[];
}

/** The binding table for each mode. */
export const BINDINGS: Readonly<Record<GameMode, ModeBindings>> = {
  platformer: {
    actions: [
      { code: 'Space', action: 'Jump' },
      { code: 'KeyW', action: 'Jump' },
      { code: 'ArrowUp', action: 'Jump' },
    ],
    axes: [
      { code: 'KeyA', axis: 'MoveX', value: -1 },
      { code: 'ArrowLeft', axis: 'MoveX', value: -1 },
      { code: 'KeyD', axis: 'MoveX', value: 1 },
      { code: 'ArrowRight', axis: 'MoveX', value: 1 },
    ],
    pointer: 'none',
    help: [
      { keys: 'A / D  ·  ← / →', does: 'run · axis MoveX' },
      { keys: 'Space / W / ↑', does: 'jump · coyote time + buffering' },
    ],
  },
  iso: {
    actions: [],
    axes: [],
    pointer: 'click',
    help: [
      { keys: 'click floor', does: 'move · A* path (pointer)' },
      { keys: 'click the guard', does: 'attack-move · close, then fire' },
    ],
  },
  fps: {
    actions: [{ code: 'Space', action: 'Jump' }],
    axes: [
      { code: 'KeyW', axis: 'Forward', value: 1 },
      { code: 'ArrowUp', axis: 'Forward', value: 1 },
      { code: 'KeyS', axis: 'Forward', value: -1 },
      { code: 'ArrowDown', axis: 'Forward', value: -1 },
      { code: 'KeyD', axis: 'Strafe', value: 1 },
      { code: 'ArrowRight', axis: 'Strafe', value: 1 },
      { code: 'KeyA', axis: 'Strafe', value: -1 },
      { code: 'ArrowLeft', axis: 'Strafe', value: -1 },
    ],
    pointer: 'lock',
    primaryButtonAction: 'Fire',
    lookDegreesPerPixel: 0.14,
    help: [
      { keys: 'W / S', does: 'forward · back · axis Forward' },
      { keys: 'A / D', does: 'strafe · axis Strafe' },
      { keys: 'Space', does: 'jump the coolant pit' },
      { keys: 'mouse', does: 'look · click to capture pointer' },
      { keys: 'left click', does: 'fire · hitscan' },
    ],
  },
};

/** Control lines every game shares, appended after the mode-specific help. */
export const SESSION_CONTROLS: readonly ControlHelp[] = [
  { keys: 'P', does: 'pause / resume' },
  { keys: '.', does: 'single-step one tick' },
  { keys: 'R', does: 'restart at tick 0' },
];
