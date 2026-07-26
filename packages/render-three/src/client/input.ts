/**
 * Browser input capture: real keyboard and mouse events in, {@link InputPacket}s out.
 *
 * This is the *only* place hardware exists. It applies the {@link ModeBindings} table and emits
 * the same logical actions, axes, look deltas and pointer samples that the `.input` DSL compiles
 * to, so a human and a script reach the simulation through one identical door.
 *
 * Edges are accumulated rather than sampled: a key tapped and released between two display frames
 * still produces a press and a release, and mouse movement is summed in degrees so a fast flick
 * is never truncated. {@link InputCollector.take} drains them.
 * @packageDocumentation
 */
import type { PointerInput } from '@aegis/core';
import { actionsForCode, axesFromCodes, isBoundCode } from '../bindings.js';
import type { ModeBindings } from '../bindings.js';
import type { InputPacket } from '../live-input.js';
import type { PickedPoint } from '../adapter.js';

/** Session-level commands that are not gameplay input. */
export type SessionCommand = 'pause' | 'step' | 'restart';

/** Options for {@link createInputCollector}. */
export interface InputCollectorOptions {
  /** The canvas that owns pointer capture. */
  canvas: HTMLCanvasElement;
  /** The mode's binding table. */
  bindings: ModeBindings;
  /** Project a normalised-device pointer position to the mode's logical world point. */
  pick: (ndcX: number, ndcY: number) => PickedPoint | null;
  /** Called for pause / step / restart keys. */
  onCommand: (command: SessionCommand) => void;
}

/** Captures browser input and hands it over as packets. */
export interface InputCollector {
  /** Build the packet for this display frame, draining accumulated edges. */
  take(): InputPacket;
  /** Whether the pointer is currently locked to the canvas (fps look). */
  readonly pointerLocked: boolean;
  /** Detach every listener. */
  dispose(): void;
}

/** Keys that drive the session rather than the game. */
const COMMAND_KEYS: Readonly<Record<string, SessionCommand>> = {
  KeyP: 'pause',
  Period: 'step',
  KeyR: 'restart',
};

/** Create a collector bound to `options.canvas` and the document. */
export function createInputCollector(options: InputCollectorOptions): InputCollector {
  const { canvas, bindings } = options;
  const heldCodes = new Set<string>();
  const heldActions = new Set<string>();
  let pressed: string[] = [];
  let released: string[] = [];
  let lookDx = 0;
  let lookDy = 0;
  let pointer: PointerInput | null = null;
  let seq = 0;

  const actionsFor = (code: string): string[] => actionsForCode(bindings, code);

  const addPressed = (action: string): void => {
    if (heldActions.has(action)) return;
    heldActions.add(action);
    if (!pressed.includes(action)) pressed.push(action);
  };

  const addReleased = (action: string): void => {
    if (!heldActions.has(action)) return;
    heldActions.delete(action);
    if (!released.includes(action)) released.push(action);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const command = COMMAND_KEYS[event.code];
    if (command !== undefined && !event.repeat) {
      event.preventDefault();
      options.onCommand(command);
      return;
    }
    if (event.repeat) return;
    if (!heldCodes.has(event.code)) {
      heldCodes.add(event.code);
      for (const action of actionsFor(event.code)) addPressed(action);
    }
    if (isBoundCode(bindings, event.code)) event.preventDefault();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (!heldCodes.delete(event.code)) return;
    for (const action of actionsFor(event.code)) {
      // Only release when no other held key still maps to the same action.
      const stillHeld = [...heldCodes].some((code) => actionsFor(code).includes(action));
      if (!stillHeld) addReleased(action);
    }
  };

  const onBlur = (): void => {
    for (const code of [...heldCodes]) {
      heldCodes.delete(code);
      for (const action of actionsFor(code)) addReleased(action);
    }
  };

  const ndcFromEvent = (event: MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    };
  };

  const onMouseMove = (event: MouseEvent): void => {
    if (bindings.pointer !== 'lock') return;
    if (document.pointerLockElement !== canvas) return;
    const sensitivity = bindings.lookDegreesPerPixel ?? 0.14;
    lookDx += event.movementX * sensitivity;
    lookDy -= event.movementY * sensitivity;
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (bindings.pointer === 'lock') {
      // First click also captures the pointer, but it still fires: a wasted click is bad for a
      // human and fatal for an automated capture where pointer lock may never engage.
      if (document.pointerLockElement !== canvas) void canvas.requestPointerLock();
      const action = bindings.primaryButtonAction;
      if (action !== undefined) addPressed(action);
      return;
    }
    if (bindings.pointer === 'click') {
      const ndc = ndcFromEvent(event);
      const picked = options.pick(ndc.x, ndc.y);
      const rect = canvas.getBoundingClientRect();
      pointer = {
        screen: { x: event.clientX - rect.left, y: event.clientY - rect.top },
        world: picked,
        buttons: ['primary'],
      };
    }
  };

  const onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    const action = bindings.primaryButtonAction;
    if (bindings.pointer === 'lock' && action !== undefined) addReleased(action);
  };

  const onContextMenu = (event: Event): void => event.preventDefault();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('contextmenu', onContextMenu);

  const collector: InputCollector = {
    get pointerLocked() {
      return document.pointerLockElement === canvas;
    },

    take(): InputPacket {
      const packet: InputPacket = {
        seq: ++seq,
        held: [...heldActions],
        pressed,
        released,
        axes: axesFromCodes(bindings, heldCodes),
        look: { dx: lookDx, dy: lookDy },
        pointer,
      };
      pressed = [];
      released = [];
      lookDx = 0;
      lookDy = 0;
      pointer = null;
      return packet;
    },

    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
  };
  return collector;
}
