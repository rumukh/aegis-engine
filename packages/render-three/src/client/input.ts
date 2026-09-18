/**
 * Browser hardware -> source-owned logical packets -> the existing fixed-tick LiveInput.
 * Poll controllers every displayed frame, including while a transport request is outstanding;
 * take() drains accumulated impulses only when the consumer is ready.
 * @packageDocumentation
 */
import type { PointerInput } from '@aegis/core';
import { actionsForCode, axesFromCodes, isBoundCode } from '../bindings.js';
import type { ModeBindings } from '../bindings.js';
import { createGamepadInput } from '../gamepad.js';
import type { GamepadInput, GamepadSample } from '../gamepad.js';
import { createInputBuffer } from '../input-buffer.js';
import type { InputPacket } from '../live-input.js';
import { MAX_CATCHUP_SECONDS } from '../loop.js';

export type SessionCommand = 'pause' | 'step' | 'restart';
export type InputDevice = 'keyboard' | 'mouse' | 'gamepad' | null;

export interface InputCollectorOptions {
  canvas: HTMLCanvasElement;
  bindings: ModeBindings;
  /** The same logical picker is used by mouse clicks and the controller's screen cursor. */
  pick: (ndcX: number, ndcY: number) => { x: number; y: number; z: number } | null;
  onCommand: (command: SessionCommand) => void;
  /** Optional externally configured sampler. Its lifecycle remains owned by the caller. */
  gamepad?: GamepadInput;
  /** Cursor in canvas-local CSS pixels, or null when inactive. No DOM is created by input. */
  onGamepadPointer?: (point: { x: number; y: number } | null) => void;
  /** Device/permission/rearm feedback, including unavailable states. */
  onGamepadSample?: (sample: GamepadSample) => void;
}

export interface InputCollector {
  /** Sample hardware once per display frame; seconds, not simulation ticks. */
  poll(elapsedSeconds: number): void;
  /** Drain accumulated edges/deltas, retaining levels. Does not poll hardware. */
  take(): InputPacket;
  readonly pointerLocked: boolean;
  readonly lastActiveDevice: InputDevice;
  readonly gamepad: GamepadSample | null;
  /** Controller commands still work while paused; keyboard/mouse remain usable for single-step. */
  setPaused(paused: boolean): void;
  /** Drop pending input. A held controller must return to neutral before it can rearm. */
  clear(): void;
  /** Stop gameplay capture; resume requires neutral controller controls and fresh key presses. */
  suspend(): void;
  resume(): void;
  dispose(): void;
}

const COMMAND_KEYS: Readonly<Record<string, SessionCommand>> = {
  KeyP: 'pause',
  Period: 'step',
  KeyR: 'restart',
};

export function createInputCollector(options: InputCollectorOptions): InputCollector {
  const { canvas, bindings } = options;
  const buffer = createInputBuffer();
  const heldCodes = new Set<string>();
  const blockedCodes = new Set<string>();
  const profile = bindings.gamepad;
  if (
    profile?.look !== undefined &&
    (!Number.isFinite(profile.look.yawRate) || !Number.isFinite(profile.look.pitchRate))
  ) {
    throw new Error('[aegis:input] controller look rates must be finite degrees per second');
  }
  if (
    profile?.pointer !== undefined &&
    (!Number.isFinite(profile.pointer.pixelsPerSecond) || profile.pointer.pixelsPerSecond < 0)
  ) {
    throw new Error('[aegis:input] controller cursor speed must be finite and non-negative');
  }
  const pad =
    options.gamepad ??
    (profile === undefined
      ? undefined
      : createGamepadInput({ bindings: profile.bindings, manageFocus: false }));
  let mouseHeld = false;
  let blockedMouse = false;
  let paused = false;
  let suspended = false;
  let focused = document.hasFocus?.() ?? true;
  let disposed = false;
  let lastActiveDevice: InputDevice = null;
  let gamepad: GamepadSample | null = null;
  let lastActivity = 0;
  let cursor = { x: 0.5, y: 0.5 };
  let cursorVisible = false;

  const active = (): boolean =>
    !disposed && !suspended && focused && document.visibilityState !== 'hidden';
  const hideCursor = (): void => {
    cursorVisible = false;
    options.onGamepadPointer?.(null);
  };
  const keyboardLevels = (): void => {
    buffer.setSource('keyboard', {
      held: [...heldCodes].flatMap((code) => actionsForCode(bindings, code)),
      axes: axesFromCodes(bindings, heldCodes),
    });
  };
  const mouseLevels = (): void => {
    buffer.setSource('mouse', {
      held:
        mouseHeld && bindings.primaryButtonAction !== undefined
          ? [bindings.primaryButtonAction]
          : [],
    });
  };
  const reset = (rearmKeyboard: boolean): void => {
    if (rearmKeyboard) {
      for (const code of heldCodes) blockedCodes.add(code);
      blockedMouse ||= mouseHeld;
    }
    heldCodes.clear();
    mouseHeld = false;
    pad?.clear();
    buffer.clear({ releaseHeld: rearmKeyboard });
    hideCursor();
  };
  const updateFocus = (): void => {
    if (active()) pad?.resume();
    else {
      reset(true);
      pad?.suspend();
    }
  };
  const onBlur = (): void => {
    focused = false;
    updateFocus();
  };
  const onFocus = (): void => {
    focused = true;
    updateFocus();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!active() || event.ctrlKey || event.metaKey || event.altKey) return;
    if (
      typeof Element !== 'undefined' &&
      event.target instanceof Element &&
      event.target.closest(
        'button,input,select,textarea,summary,a,[contenteditable="true"],[tabindex]:not(canvas)',
      ) !== null
    )
      return;
    if (event.repeat || blockedCodes.has(event.code)) return;
    const command = COMMAND_KEYS[event.code];
    if (command !== undefined) {
      lastActiveDevice = 'keyboard';
      event.preventDefault();
      options.onCommand(command);
      return;
    }
    if (!isBoundCode(bindings, event.code)) return;
    if (!heldCodes.has(event.code)) {
      heldCodes.add(event.code);
      lastActiveDevice = 'keyboard';
      keyboardLevels();
    }
    event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    blockedCodes.delete(event.code);
    if (heldCodes.delete(event.code)) keyboardLevels();
  };
  const clickAt = (x: number, y: number): void => {
    const rect = canvas.getBoundingClientRect();
    const point: PointerInput = {
      screen: { x, y },
      world: options.pick((x / rect.width) * 2 - 1, 1 - (y / rect.height) * 2),
      buttons: ['primary'],
    };
    buffer.setPointer(point);
  };
  const onMouseMove = (event: MouseEvent): void => {
    if (!active()) return;
    if (event.movementX !== 0 || event.movementY !== 0) {
      lastActiveDevice = 'mouse';
      hideCursor();
    }
    if (bindings.pointer !== 'lock' || document.pointerLockElement !== canvas) return;
    const sensitivity = bindings.lookDegreesPerPixel ?? 0.14;
    buffer.addLook(
      event.movementX * sensitivity * (bindings.lookXSign ?? 1),
      -event.movementY * sensitivity,
    );
  };
  const onMouseDown = (event: MouseEvent): void => {
    if (!active() || blockedMouse || event.button !== 0) return;
    lastActiveDevice = 'mouse';
    hideCursor();
    if (bindings.pointer === 'lock') {
      if (document.pointerLockElement !== canvas) void canvas.requestPointerLock();
      mouseHeld = true;
      mouseLevels();
    } else if (bindings.pointer === 'click') {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        clickAt(event.clientX - rect.left, event.clientY - rect.top);
    }
  };
  const onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    blockedMouse = false;
    mouseHeld = false;
    mouseLevels();
  };
  const onContextMenu = (event: Event): void => event.preventDefault();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  document.addEventListener?.('visibilitychange', updateFocus);
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('contextmenu', onContextMenu);
  if (!active()) updateFocus();

  return {
    get pointerLocked() {
      return document.pointerLockElement === canvas;
    },
    get lastActiveDevice() {
      return lastActiveDevice;
    },
    get gamepad() {
      return gamepad;
    },
    poll(elapsedSeconds): void {
      if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0)
        throw new Error('[aegis:input] elapsedSeconds must be finite and non-negative');
      if (disposed || pad === undefined) return;
      gamepad = pad.sample();
      options.onGamepadSample?.(gamepad);
      if (!active()) return;
      if (gamepad.activity !== lastActivity) {
        lastActivity = gamepad.activity;
        lastActiveDevice = 'gamepad';
        cursorVisible = true;
      }
      // A throttled/background frame must not integrate minutes of camera or cursor movement.
      const dt = Math.min(elapsedSeconds, MAX_CATCHUP_SECONDS);
      for (const action of gamepad.pressed) {
        const command = profile?.commands?.[action];
        if (command !== undefined) {
          if (command !== 'step') reset(true);
          options.onCommand(command);
          // A command can restart/pause synchronously. Never reuse that sample as gameplay.
          return;
        }
      }
      if (paused) {
        buffer.removeSource('gamepad');
        hideCursor();
        return;
      }
      const look = profile?.look;
      const pointer = profile?.pointer;
      const reserved = new Set([
        ...Object.keys(profile?.commands ?? {}),
        ...(pointer === undefined ? [] : [pointer.primary]),
      ]);
      const reservedAxes = new Set([
        ...(look === undefined ? [] : [look.x, look.y]),
        ...(pointer === undefined ? [] : [pointer.x, pointer.y]),
      ]);
      buffer.setSource('gamepad', {
        held: gamepad.held.filter((action) => !reserved.has(action)),
        axes: Object.fromEntries(
          Object.entries(gamepad.axes).filter(([name]) => !reservedAxes.has(name)),
        ),
      });
      if (look !== undefined) {
        buffer.addLook(
          (gamepad.axes[look.x] ?? 0) * look.yawRate * dt,
          (gamepad.axes[look.y] ?? 0) * look.pitchRate * dt,
        );
      }
      if (pointer !== undefined) {
        const rect = canvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          cursor = {
            x: Math.max(
              0,
              Math.min(
                1,
                cursor.x +
                  ((gamepad.axes[pointer.x] ?? 0) * pointer.pixelsPerSecond * dt) / rect.width,
              ),
            ),
            y: Math.max(
              0,
              Math.min(
                1,
                cursor.y +
                  ((gamepad.axes[pointer.y] ?? 0) * pointer.pixelsPerSecond * dt) / rect.height,
              ),
            ),
          };
          const screen = { x: cursor.x * rect.width, y: cursor.y * rect.height };
          if (gamepad.status !== 'ready') hideCursor();
          else if (cursorVisible) options.onGamepadPointer?.(screen);
          if (gamepad.pressed.includes(pointer.primary)) clickAt(screen.x, screen.y);
        }
      }
    },
    take: () => buffer.take(),
    setPaused(value): void {
      if (paused === value) return;
      paused = value;
      reset(true);
    },
    clear(): void {
      reset(false);
      blockedCodes.clear();
      blockedMouse = false;
    },
    suspend(): void {
      suspended = true;
      updateFocus();
    },
    resume(): void {
      suspended = false;
      updateFocus();
    },
    dispose(): void {
      if (disposed) return;
      reset(true);
      disposed = true;
      if (options.gamepad === undefined) pad?.dispose();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener?.('visibilitychange', updateFocus);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
