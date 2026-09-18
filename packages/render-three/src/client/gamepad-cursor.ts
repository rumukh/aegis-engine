import type { GamepadSample } from '../gamepad.js';

/** Render the collector's canvas-local pointer without giving input ownership of page DOM. */
export function gamepadCursor(
  canvas: HTMLCanvasElement,
): (point: { x: number; y: number } | null) => void {
  const element = document.getElementById?.('gamepad-cursor');
  return (point): void => {
    if (element === null || element === undefined) return;
    element.hidden = point === null;
    if (point === null) return;
    const rect = canvas.getBoundingClientRect();
    element.style.left = `${rect.left + point.x}px`;
    element.style.top = `${rect.top + point.y}px`;
  };
}

export function gamepadStatus(): (sample: GamepadSample) => void {
  const element = document.getElementById?.('hud-controller');
  return (sample): void => {
    if (element === null || element === undefined) return;
    const message =
      sample.status === 'ready'
        ? `${sample.device?.id ?? 'Standard controller'}: ${sample.armed ? 'ready' : 'release controls to arm'}`
        : {
            unsupported: 'Controller API unavailable',
            'no-device': 'No controller exposed; press a button, then release',
            'unsupported-mapping': 'Controller mapping unsupported; standard mapping required',
            blocked: 'Controller access blocked by browser permissions policy',
            suspended: 'Controller suspended; focus the game and release controls',
            disposed: 'Controller input disposed',
          }[sample.status];
    if (element.textContent !== message) element.textContent = message;
  };
}
