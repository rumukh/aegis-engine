/**
 * Compiling a game's own `.input` script into browser input, so a capture cannot drift from the
 * playthrough the acceptance test proves.
 *
 * The screenshot run used to carry hand-written `keydown`/`keyup` timings against a wall clock.
 * That is an *enumeration*, and an enumeration is only ever as good as the enumeration: when the
 * platformer's level was retuned, the canned timings silently began running into a gap. Worse, it
 * was never stable to begin with — the same commit died in 2 runs out of 3, because hand-tuned
 * wall-clock timings race the browser's frame pacing.
 *
 * So the timings are gone. This module takes the **compiled `InputFrame`s** of the game's own
 * script — the same `parseInputScript(...).frames(n)` the harness feeds a headless run — and
 * derives the browser events that reproduce them, using the same {@link ModeBindings} table a
 * human's keyboard goes through. There is nothing left to hand-tune, and nothing to keep in sync:
 * if the game's script changes, the capture changes with it.
 *
 * Everything here is a pure function of (frames, bindings). No DOM, no clock, no browser — so it
 * is unit-tested directly.
 * @packageDocumentation
 */
import type { InputFrame } from '@aegis/core';
import { actionsForCode, axesFromCodes } from './bindings.js';
import type { ModeBindings } from './bindings.js';
import { createLiveInput } from './live-input.js';

/**
 * One run of ticks that share a single browser input *state*, plus any one-tick impulses to
 * deliver at its start. A segment is the unit the driver applies: set the state, then advance
 * {@link InputSegment.ticks} simulation ticks.
 */
export interface InputSegment {
  /** First simulation tick this segment covers. */
  tick: number;
  /** How many ticks to advance under this state. Always `>= 1`. */
  ticks: number;
  /** Key codes to press at the start of the segment (`KeyboardEvent.code`). */
  keyDown: readonly string[];
  /** Key codes to release at the start of the segment. */
  keyUp: readonly string[];
  /** Press the primary mouse button at the start (the bound button action, e.g. `Fire`). */
  buttonDown: boolean;
  /** Release the primary mouse button at the start. */
  buttonUp: boolean;
  /** Whole-pixel mouse movement to dispatch (pointer-locked look). Omitted when zero. */
  mouse?: { dx: number; dy: number };
  /** A primary click resolving to this logical world point (pointer modes). */
  click?: { x: number; y: number; z: number };
}

/** A whole script, compiled to browser input. */
export interface DomInputPlan {
  /** Total ticks the plan covers. */
  totalTicks: number;
  /** The segments, in tick order, contiguous and covering `[0, totalTicks)`. */
  segments: readonly InputSegment[];
}

/**
 * Thrown when a frame asks for a logical action or axis that the mode's binding table cannot
 * produce from a keyboard or mouse.
 *
 * This is deliberately fatal. A capture that silently dropped an unmappable input would go on to
 * photograph a playthrough that never happened — which is the exact failure this module exists to
 * remove. If a game's script starts using a new action, the capture stops, and someone adds a
 * binding.
 */
export class UnmappableInputError extends Error {
  /** The logical names that could not be produced. */
  readonly names: readonly string[];
  constructor(names: readonly string[]) {
    super(
      `[aegis:render-three] this mode's binding table cannot produce: ${names.join(', ')}. ` +
        'Add a binding (or a direction alias) in bindings.ts. Failing here is deliberate — ' +
        'silently dropping an input would photograph a playthrough that never happened.',
    );
    this.name = 'UnmappableInputError';
    this.names = names;
  }
}

/** The level (held-down) browser state one frame implies. */
interface HeldState {
  /** Key codes that must be down. Sorted, so two states compare element-wise. */
  codes: readonly string[];
  /** Whether the primary mouse button must be down. */
  button: boolean;
}

/** Whether two held states are the same. */
function sameHeld(a: HeldState, b: HeldState): boolean {
  if (a.button !== b.button) return false;
  if (a.codes.length !== b.codes.length) return false;
  return a.codes.every((code, i) => code === b.codes[i]);
}

/**
 * The key codes and button state a frame's `actions` + `axes` require.
 *
 * Resolution order per logical name: a digital action binding, then a *direction alias* (the
 * platformer's `Right`/`Left` are the action spelling of the `MoveX` axis — `platformer.intake`
 * reads either, so the binding table declares the equivalence), then the button action.
 */
export function heldStateFor(frame: InputFrame, bindings: ModeBindings): HeldState {
  const codes = new Set<string>();
  let button = false;
  const unmapped: string[] = [];

  for (const [name, active] of Object.entries(frame.actions)) {
    if (!active) continue;
    const action = bindings.actions.find((binding) => binding.action === name);
    if (action !== undefined) {
      codes.add(action.code);
      continue;
    }
    const alias = (bindings.directionAliases ?? []).find((entry) => entry.action === name);
    if (alias !== undefined) {
      const axis = bindings.axes.find(
        (binding) =>
          binding.axis === alias.axis && Math.sign(binding.value) === Math.sign(alias.value),
      );
      if (axis !== undefined) {
        codes.add(axis.code);
        continue;
      }
    }
    if (bindings.primaryButtonAction === name) {
      button = true;
      continue;
    }
    unmapped.push(name);
  }

  for (const [name, value] of Object.entries(frame.axes)) {
    if (value === 0) continue;
    const axis = bindings.axes.find(
      (binding) => binding.axis === name && Math.sign(binding.value) === Math.sign(value),
    );
    if (axis === undefined) {
      unmapped.push(`${name}=${value}`);
      continue;
    }
    codes.add(axis.code);
  }

  if (unmapped.length > 0) throw new UnmappableInputError(unmapped);
  return { codes: [...codes].sort(), button };
}

/** Options for {@link compileDomInput}. */
export interface CompileOptions {
  /** Degrees of look per pixel of mouse movement. Defaults to the binding table's value. */
  degreesPerPixel?: number;
}

/**
 * Compile per-tick {@link InputFrame}s into a {@link DomInputPlan}.
 *
 * Level channels (held actions, axes, the button) become segment boundaries only when they
 * change, so a 400-tick script collapses to a handful of segments. Impulse channels (a pointer
 * click, a look delta) always occupy their own single tick.
 *
 * Look deltas are converted to **whole pixels with the fractional remainder carried forward**, so
 * rounding error is bounded below one pixel for the whole run instead of accumulating per turn.
 */
export function compileDomInput(
  frames: readonly InputFrame[],
  bindings: ModeBindings,
  options: CompileOptions = {},
): DomInputPlan {
  const degreesPerPixel = options.degreesPerPixel ?? bindings.lookDegreesPerPixel ?? 0.14;
  const segments: InputSegment[] = [];
  let previous: HeldState = { codes: [], button: false };
  let carryX = 0;
  let carryY = 0;

  for (let tick = 0; tick < frames.length; tick++) {
    const frame = frames[tick] as InputFrame;
    const held = heldStateFor(frame, bindings);

    // Impulses: a click, or a look delta big enough to move at least one pixel once the carried
    // remainder is included.
    const click =
      bindings.pointer === 'click' &&
      frame.pointer !== null &&
      frame.pointer.world !== null &&
      frame.pointer.buttons.includes('primary')
        ? { ...frame.pointer.world }
        : undefined;

    let mouse: { dx: number; dy: number } | undefined;
    if (bindings.pointer === 'lock' && (frame.look.dx !== 0 || frame.look.dy !== 0)) {
      carryX += frame.look.dx / degreesPerPixel;
      // The collector reads `lookDy -= movementY * sensitivity`, so pitching up is -movementY.
      carryY += -frame.look.dy / degreesPerPixel;
      const dx = Math.round(carryX);
      const dy = Math.round(carryY);
      carryX -= dx;
      carryY -= dy;
      if (dx !== 0 || dy !== 0) mouse = { dx, dy };
    }

    const impulse = click !== undefined || mouse !== undefined;
    const last = segments[segments.length - 1];
    const changed = !sameHeld(held, previous);

    if (
      last !== undefined &&
      !changed &&
      !impulse &&
      last.click === undefined &&
      last.mouse === undefined
    ) {
      last.ticks++;
    } else {
      const segment: InputSegment = {
        tick,
        ticks: 1,
        keyDown: held.codes.filter((code) => !previous.codes.includes(code)),
        keyUp: previous.codes.filter((code) => !held.codes.includes(code)),
        buttonDown: held.button && !previous.button,
        buttonUp: !held.button && previous.button,
        ...(mouse !== undefined ? { mouse } : {}),
        ...(click !== undefined ? { click } : {}),
      };
      segments.push(segment);
    }
    previous = held;
  }

  return { totalTicks: frames.length, segments };
}

/**
 * Replay a {@link DomInputPlan} back into per-tick {@link InputFrame}s, exactly as the browser
 * would: key state through the same {@link axesFromCodes}/{@link actionsForCode} the collector
 * uses, packets through the same {@link createLiveInput} the dev server runs.
 *
 * This closes the loop. `compileDomInput` claims "these browser events reproduce that script";
 * this evaluates the claim, so `script-input.test.ts` can assert the round trip drives a
 * simulation to the **same state hash** as the script itself — headlessly, with no browser and no
 * screenshot involved. A drift in the compiler stops being something you notice in a PNG.
 */
export function framesFromPlan(
  plan: DomInputPlan,
  bindings: ModeBindings,
  degreesPerPixel = bindings.lookDegreesPerPixel ?? 0.14,
): InputFrame[] {
  const live = createLiveInput();
  const heldCodes = new Set<string>();
  const heldActions = new Set<string>();
  let button = false;
  let seq = 0;
  const frames: InputFrame[] = [];

  for (const segment of plan.segments) {
    const pressed: string[] = [];
    const released: string[] = [];

    for (const code of segment.keyUp) {
      heldCodes.delete(code);
      for (const action of actionsForCode(bindings, code)) {
        const stillHeld = [...heldCodes].some((other) =>
          actionsForCode(bindings, other).includes(action),
        );
        if (!stillHeld && heldActions.delete(action)) released.push(action);
      }
    }
    for (const code of segment.keyDown) {
      heldCodes.add(code);
      for (const action of actionsForCode(bindings, code)) {
        if (!heldActions.has(action)) {
          heldActions.add(action);
          pressed.push(action);
        }
      }
    }

    const buttonAction = bindings.primaryButtonAction;
    if (buttonAction !== undefined) {
      if (segment.buttonDown && !button) {
        button = true;
        if (!heldActions.has(buttonAction)) {
          heldActions.add(buttonAction);
          pressed.push(buttonAction);
        }
      }
      if (segment.buttonUp && button) {
        button = false;
        if (heldActions.delete(buttonAction)) released.push(buttonAction);
      }
    }

    live.submit({
      seq: ++seq,
      held: [...heldActions],
      pressed,
      released,
      axes: axesFromCodes(bindings, heldCodes),
      look:
        segment.mouse === undefined
          ? { dx: 0, dy: 0 }
          : { dx: segment.mouse.dx * degreesPerPixel, dy: -segment.mouse.dy * degreesPerPixel },
      pointer:
        segment.click === undefined
          ? null
          : { screen: { x: 0, y: 0 }, world: { ...segment.click }, buttons: ['primary'] },
    });

    for (let i = 0; i < segment.ticks; i++) frames.push(live.frameFor(segment.tick + i));
  }
  return frames;
}
