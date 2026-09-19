import type { FrameInputStatus } from '../frame-clients.js';
import type { InputCaptureState } from './input.js';

export interface InputFeedback {
  capture(state: InputCaptureState): void;
  transport(state: FrameInputStatus): void;
  state(): { capture?: InputCaptureState; transport?: FrameInputStatus };
}

/** Capture and shared-session ownership are visible state, not a silent input failure. */
export function createInputFeedback(root: Document = document): InputFeedback {
  const element = root.getElementById('hud-input');
  let capture: InputCaptureState | undefined;
  let transport: FrameInputStatus | undefined;
  const publish = (): void => {
    if (element === null) return;
    const message =
      capture?.error ??
      (capture?.visible === false || capture?.focused === false
        ? 'Game input is not focused. Click the game to capture controls.'
        : capture?.gameplayBlocked === true
          ? 'Run ended. Choose Restart, press R or use the controller View button.'
          : capture?.paused === true
            ? 'Paused. Resume the session to move; single-step controls remain available.'
            : capture?.pointer === 'pending'
              ? 'Requesting mouse capture...'
              : capture?.pointer === 'unlocked'
                ? 'Click the game to capture mouse-look and keyboard controls. Esc releases the mouse.'
                : transport?.reason === 'stale'
                  ? 'An out-of-order input packet was ignored. Fresh input remains available.'
                  : transport?.role === 'observing'
                    ? 'Viewing a shared session. Click the game or press a gameplay key to take control.'
                    : '');
    if (element.textContent !== message) element.textContent = message;
    element.hidden = message === '';
    element.setAttribute?.('data-state', capture?.error === undefined ? 'info' : 'error');
  };
  return {
    capture(value): void {
      capture = { ...value };
      publish();
    },
    transport(value): void {
      transport = { ...value };
      publish();
    },
    state: () => ({
      ...(capture === undefined ? {} : { capture: { ...capture } }),
      ...(transport === undefined ? {} : { transport: { ...transport } }),
    }),
  };
}
