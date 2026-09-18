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
import type { GamepadBindings } from './gamepad.js';

/** Presentation-side interpretation of logical controller axes/actions. */
export interface ControllerProfile {
  bindings: GamepadBindings;
  /** Axis names and signed camera rates in degrees per second at full deflection. */
  look?: { x: string; y: string; yawRate: number; pitchRate: number };
  /** A screen-space cursor, projected through the same picker as a mouse click. */
  pointer?: { x: string; y: string; primary: string; pixelsPerSecond: number };
  /** These actions control the session and are never sent to gameplay. */
  commands?: Readonly<Record<string, 'pause' | 'step' | 'restart'>>;
}

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
  /** Omit for keyboard/mouse only. Standard Gamepad API mapping; no native XInput. */
  gamepad?: ControllerProfile;
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
  /**
   * Sign converting rightward *screen* mouse motion into the mode's yaw delta. Defaults to `1`.
   *
   * See {@link SCREEN_HANDEDNESS} for why the fps mode needs `-1`. Anything that turns pixels
   * into degrees, or degrees back into pixels, must apply it — the browser collector and the
   * script compiler both do.
   */
  lookXSign?: 1 | -1;
  /** Action spellings of an axis direction, for replaying scripts that use them. */
  directionAliases?: readonly DirectionAlias[];
  /** On-screen control list. */
  help: readonly ControlHelp[];
}

/**
 * Why the fps bindings carry negative signs: the simulation's frame and the rendered picture are
 * mirror images, so "toward the screen's right" is **not** the simulation's right.
 *
 * `@aegis/mode-fps` defines yaw 0 as facing `+Z` with the right vector at `+X`
 * (`geometry.ts` `forwardFromLook` / `rightFromYaw`) — a left-handed frame, X right, Y up, Z
 * forward. three.js is right-handed and its cameras look down their local `-Z`. `Matrix4.lookAt`
 * builds the camera basis as `z = eye - target`, `x = cross(up, z)`; for `forward = (0,0,1)` and
 * `up = (0,1,0)` that gives `z = (0,0,-1)` and `x = cross((0,1,0),(0,0,-1)) = (-1,0,0)`. The
 * camera's screen-right is therefore world **−X**, the exact opposite of the simulation's right.
 *
 * That mirror cannot be removed by orienting the camera: `{right, up, -forward}` has determinant
 * −1, so no rotation represents it. The renderer must either mirror the world it draws or mirror
 * the human's screen-relative *intent* on the way in. It does the latter, here, because the sign
 * belongs to the one place that translates hardware into logical input — and because the
 * simulation's convention is pinned by `mode-fps/systems.test.ts` and every fps golden hash.
 *
 * Measured in a real browser before the fix (1280x720, landmark 6 units dead ahead of the eye,
 * screen x 640 at rest): a +100px rightward mouse move produced yaw +14° and moved the landmark
 * to screen x 757 — the landmark went right, so the camera turned **left**. `screen-input.test.ts`
 * pins the corrected behaviour against that first-principles expectation rather than a recorded
 * value.
 *
 * Vertical needs no sign: the same measurement showed a +60px downward move produced pitch −8.4°
 * and moved the landmark from y 360 to y 291, i.e. up the screen — which is what looking down
 * does. Pitch is a rotation about the camera's own right axis, and mirroring that axis mirrors
 * the rotation with it, so the two negations cancel.
 */
export const SCREEN_HANDEDNESS =
  'mode-fps is left-handed (yaw 0 -> +Z, right -> +X); three.js cameras look down -Z, so the ' +
  "camera's screen-right is world -X. Screen-relative human input is negated on the way in.";

const CONTROLLER_COMMANDS = {
  buttons: [
    { button: 9, action: 'SessionPause', label: 'Menu' },
    { button: 8, action: 'SessionRestart', label: 'View' },
  ],
  commands: { SessionPause: 'pause', SessionRestart: 'restart' } as const,
};

/** The binding table for each mode. */
export const BINDINGS: Readonly<Record<GameMode, ModeBindings>> = {
  platformer: {
    gamepad: {
      bindings: {
        sticks: [{ axes: [0, 1], x: 'MoveX', y: 'MoveY' }],
        buttons: [
          { button: 0, action: 'Jump', label: 'A' },
          { button: 14, axis: 'MoveX', scale: -1, label: 'D-pad left' },
          { button: 15, axis: 'MoveX', label: 'D-pad right' },
          ...CONTROLLER_COMMANDS.buttons,
        ],
      },
      commands: CONTROLLER_COMMANDS.commands,
    },
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
      { keys: 'controller: left stick / D-pad', does: 'run (analog stick)' },
      { keys: 'controller: A', does: 'jump' },
    ],
  },
  iso: {
    gamepad: {
      bindings: {
        sticks: [{ axes: [0, 1], x: 'PointerX', y: 'PointerY' }],
        buttons: [
          { button: 0, action: 'PointerPrimary', label: 'A' },
          ...CONTROLLER_COMMANDS.buttons,
        ],
      },
      pointer: { x: 'PointerX', y: 'PointerY', primary: 'PointerPrimary', pixelsPerSecond: 500 },
      commands: CONTROLLER_COMMANDS.commands,
    },
    actions: [],
    axes: [],
    pointer: 'click',
    help: [
      { keys: 'click floor', does: 'move · A* path (pointer)' },
      { keys: 'click the guard', does: 'attack-move · close, then fire' },
      { keys: 'controller: left stick + A', does: 'move cursor, then order / attack-move' },
    ],
  },
  fps: {
    gamepad: {
      bindings: {
        sticks: [
          { axes: [0, 1], x: 'Strafe', y: 'Forward', invertX: true, invertY: true },
          { axes: [2, 3], x: 'LookX', y: 'LookY' },
        ],
        buttons: [
          { button: 0, action: 'Jump', label: 'A' },
          { button: 7, action: 'Fire', threshold: 0.5, label: 'RT' },
          ...CONTROLLER_COMMANDS.buttons,
        ],
      },
      look: { x: 'LookX', y: 'LookY', yawRate: -120, pitchRate: -90 },
      commands: CONTROLLER_COMMANDS.commands,
    },
    actions: [{ code: 'Space', action: 'Jump' }],
    axes: [
      { code: 'KeyW', axis: 'Forward', value: 1 },
      { code: 'ArrowUp', axis: 'Forward', value: 1 },
      { code: 'KeyS', axis: 'Forward', value: -1 },
      { code: 'ArrowDown', axis: 'Forward', value: -1 },
      // Strafe values look inverted and are not: `Strafe` is a *world* quantity (it multiplies
      // `rightFromYaw`), while D means "move toward the right of my screen". Those are opposite
      // directions — see SCREEN_HANDEDNESS above. Writing the sign into the table rather than
      // into the collector keeps the script compiler correct for free: `heldStateFor` picks the
      // key whose value matches the script's sign, so a script asking for `Strafe 1` presses A
      // and still produces `Strafe 1`.
      { code: 'KeyD', axis: 'Strafe', value: -1 },
      { code: 'ArrowRight', axis: 'Strafe', value: -1 },
      { code: 'KeyA', axis: 'Strafe', value: 1 },
      { code: 'ArrowLeft', axis: 'Strafe', value: 1 },
    ],
    pointer: 'lock',
    primaryButtonAction: 'Fire',
    lookDegreesPerPixel: 0.14,
    lookXSign: -1,
    help: [
      { keys: 'W / S', does: 'forward · back · axis Forward' },
      { keys: 'A / D', does: 'strafe · axis Strafe' },
      { keys: 'Space', does: 'jump the coolant pit' },
      { keys: 'mouse', does: 'look · click to capture pointer' },
      { keys: 'left click', does: 'fire · hitscan' },
      { keys: 'controller: left / right stick', does: 'move / look' },
      { keys: 'controller: A / RT', does: 'jump / fire' },
    ],
  },
};

/** Control lines every game shares, appended after the mode-specific help. */
export const SESSION_CONTROLS: readonly ControlHelp[] = [
  { keys: 'P', does: 'pause / resume' },
  { keys: '.', does: 'single-step one tick' },
  { keys: 'R', does: 'restart at tick 0' },
];

/** Help for the standard controller session profile, not keyboard-only custom bindings. */
export const CONTROLLER_SESSION_CONTROLS: readonly ControlHelp[] = [
  { keys: 'controller: Menu / View', does: 'pause / restart (standard mapping)' },
  { keys: 'controller connection', does: 'press a button to expose it, then release to arm' },
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
