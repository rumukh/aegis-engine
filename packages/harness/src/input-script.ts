/**
 * The input-scripting format (CHARTER principle 5): "input is a script".
 *
 * An agent authors input as text, in a small line-oriented DSL, and the harness compiles it
 * to a deterministic sequence of {@link InputFrame}s — one per tick. The same text round-trips
 * from a recording, so a recorded session *is* a readable script. Ticks are addressed
 * absolutely so a script diffs cleanly and reorders safely.
 *
 * ## Grammar
 * ```text
 * # comments start with '#'
 * hold   <Action> <a>..<b>          # hold a digital action across tick range [a, b)
 * press  <Action> @<t>              # activate for exactly tick t (edge press)
 * release <Action> @<t>             # deactivate at tick t
 * axis   <Name> <value> <a>..<b>    # set analog axis (e.g. -1..1) across [a, b)
 * look   <dyaw> <dpitch> @<t>       # relative mouse-look delta (degrees) at tick t   [fps]
 * look   <dyaw> <dpitch> <a>..<b>   # spread the delta evenly across [a, b)           [fps]
 * aim    <yaw> <pitch> @<t>         # absolute look target; compiled to look deltas   [fps]
 * click  <x>,<y> @<t>               # primary pointer click at world/grid (x, y)      [iso]
 * point  <x>,<y> @<t>               # pointer move without a click                    [iso]
 * ```
 * Ranges `a..b` are half-open (include `a`, exclude `b`). `@t` is the single tick `t`.
 * Example (platformer): `hold Right 0..90` then `press Jump @30`.
 * @packageDocumentation
 */
import { notImplemented } from '@aegis/core';
import type { InputFrame, Validated } from '@aegis/core';

/** Inclusive-start, exclusive-end tick span. `@t` parses to `{ start: t, end: t + 1 }`. */
export interface TickSpan {
  start: number;
  end: number;
}

/** Hold a digital action across a span. */
export interface HoldCommand {
  kind: 'hold';
  action: string;
  span: TickSpan;
}

/** Edge-press a digital action for one tick. */
export interface PressCommand {
  kind: 'press';
  action: string;
  tick: number;
}

/** Release a digital action at a tick. */
export interface ReleaseCommand {
  kind: 'release';
  action: string;
  tick: number;
}

/** Set an analog axis to a value across a span. */
export interface AxisCommand {
  kind: 'axis';
  axis: string;
  value: number;
  span: TickSpan;
}

/** Apply a relative look delta (degrees), at a tick or spread across a span. */
export interface LookCommand {
  kind: 'look';
  dyaw: number;
  dpitch: number;
  span: TickSpan;
}

/** Aim at an absolute yaw/pitch; the compiler converts to look deltas. */
export interface AimCommand {
  kind: 'aim';
  yaw: number;
  pitch: number;
  tick: number;
}

/** Move the pointer, optionally clicking, at a tick. */
export interface PointerCommand {
  kind: 'pointer';
  x: number;
  y: number;
  click: boolean;
  tick: number;
}

/** One parsed command in an input script. */
export type InputCommand =
  | HoldCommand
  | PressCommand
  | ReleaseCommand
  | AxisCommand
  | LookCommand
  | AimCommand
  | PointerCommand;

/** A parsed, validated input script: its command AST plus a compiler to per-tick frames. */
export interface InputScript {
  /** The parsed commands, in source order. */
  readonly commands: readonly InputCommand[];
  /**
   * Compile to exactly `totalTicks` frames. Edge sets (`pressed`/`released`) are derived by
   * diffing the held-action set between consecutive ticks, so a `hold` implies a `pressed`
   * on its first tick and a `released` on the tick after its last.
   */
  frames(totalTicks: number): readonly InputFrame[];
}

/** Parse input-script `text` into an {@link InputScript}, reporting syntax errors as diagnostics. */
export function parseInputScript(text: string): Validated<InputScript> {
  return notImplemented('parseInputScript');
}

/** Build an {@link InputScript} directly from commands (skips parsing). */
export function scriptFromCommands(commands: readonly InputCommand[]): InputScript {
  return notImplemented('scriptFromCommands');
}

/** Render an {@link InputScript} back to canonical DSL text (for recordings). */
export function formatInputScript(script: InputScript): string {
  return notImplemented('formatInputScript');
}
