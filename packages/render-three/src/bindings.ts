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

/**
 * A script action name that is the digital spelling of an axis direction.
 *
 * The platformer's `platformer.intake` reads `axes.MoveX` and falls back to
 * `actions.Right`/`actions.Left`, so `hold Right` and `axis MoveX 1` mean the same thing to the
 * simulation. A keyboard only has the key, so replaying a script that uses the action spelling
 * needs that equivalence written down — here, next to the bindings it relates, rather than
 * guessed at by the thing doing the replay.
 */
export interface DirectionAlias {
  /** The action name a script may use, e.g. `"Right"`. */
  action: string;
  /** The axis it is equivalent to, e.g. `"MoveX"`. */
  axis: string;
  /** The direction along that axis; only the sign is used. */
  value: number;
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
  /** Action spellings of an axis direction, for replaying scripts that use them. */
  directionAliases?: readonly DirectionAlias[];
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
    directionAliases: [
      { action: 'Right', axis: 'MoveX', value: 1 },
      { action: 'Left', axis: 'MoveX', value: -1 },
    ],
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

// --- reading the table ----------------------------------------------------------------------
//
// The browser's input collector and the script-replay compiler must agree exactly on what a set
// of held keys means, or a replayed capture would diverge from what a human's keyboard produces.
// So the table owns the interpretation, and both callers go through these.

/** The analog axis values a set of held key codes produces, each clamped to `[-1, 1]`. */
export function axesFromCodes(
  bindings: ModeBindings,
  codes: Iterable<string>,
): Record<string, number> {
  const held = new Set(codes);
  const axes: Record<string, number> = {};
  for (const binding of bindings.axes) {
    if (!held.has(binding.code)) continue;
    axes[binding.axis] = (axes[binding.axis] ?? 0) + binding.value;
  }
  for (const axis of Object.keys(axes)) {
    axes[axis] = Math.max(-1, Math.min(1, axes[axis] as number));
  }
  return axes;
}

/** The digital actions a single key code maps to. */
export function actionsForCode(bindings: ModeBindings, code: string): string[] {
  return bindings.actions
    .filter((binding) => binding.action !== '' && binding.code === code)
    .map((binding) => binding.action);
}

/** Whether `code` appears anywhere in the table, so the browser default can be suppressed. */
export function isBoundCode(bindings: ModeBindings, code: string): boolean {
  return (
    bindings.actions.some((binding) => binding.code === code) ||
    bindings.axes.some((binding) => binding.code === code)
  );
}
