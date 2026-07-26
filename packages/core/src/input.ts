/**
 * The logical input model consumed by the simulation.
 *
 * Aegis has **no keys** inside the simulation — only logical **actions** (`"Jump"`,
 * `"Fire"`), **axes** (`"MoveX"` in `[-1, 1]`), a relative **look** delta (mouse-look for
 * fps), and an optional **pointer** (click-to-move for iso). A render adapter maps real
 * keyboard/mouse/gamepad hardware onto these logical names; the sim never sees hardware.
 *
 * One {@link InputFrame} describes the input for exactly one tick. The `@aegis/harness`
 * `.input` DSL compiles a script into a deterministic sequence of frames, and the browser
 * adapter produces frames live. Because a frame is plain data, input records and replays
 * are just arrays of frames.
 * @packageDocumentation
 */

/** Pointer/cursor input for a tick (used by iso click-to-move). */
export interface PointerInput {
  /** Screen-space position in virtual pixels. */
  readonly screen: { x: number; y: number };
  /**
   * World-space position the pointer resolves to, when the adapter/harness can project it
   * (e.g. the ground cell under the cursor). `null` when unprojected.
   */
  readonly world: { x: number; y: number; z: number } | null;
  /** Digital pointer buttons active this tick, e.g. `["primary"]`. */
  readonly buttons: readonly string[];
}

/** Immutable logical input for a single tick. */
export interface InputFrame {
  /** Tick this frame applies to. */
  readonly tick: number;
  /** Digital actions currently held, `name -> true`. Absent names are not held. */
  readonly actions: Readonly<Record<string, boolean>>;
  /** Actions whose edge went inactive→active exactly this tick. */
  readonly pressed: readonly string[];
  /** Actions whose edge went active→inactive exactly this tick. */
  readonly released: readonly string[];
  /** Analog axes, `name -> value`. Convention: sticks/directional in `[-1, 1]`. */
  readonly axes: Readonly<Record<string, number>>;
  /** Relative look delta since last tick, in degrees (yaw `dx`, pitch `dy`). For fps. */
  readonly look: { readonly dx: number; readonly dy: number };
  /** Pointer state, or `null` when there is no pointer this tick. */
  readonly pointer: PointerInput | null;
}

/** An empty frame: nothing held, no motion. Useful as a default/idle tick. */
export const EMPTY_INPUT_FRAME: InputFrame = Object.freeze({
  tick: 0,
  actions: Object.freeze({}),
  pressed: Object.freeze([]) as readonly string[],
  released: Object.freeze([]) as readonly string[],
  axes: Object.freeze({}),
  look: Object.freeze({ dx: 0, dy: 0 }),
  pointer: null,
});
