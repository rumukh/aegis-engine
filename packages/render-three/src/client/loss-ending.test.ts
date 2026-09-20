import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLossEnding } from './loss-ending.js';
import type { LossEnding } from './loss-ending.js';

class Element extends EventTarget {
  textContent = '';
  hidden = false;
  dataset: Record<string, string> = {};
  properties = new Map<string, string>();
  style = { setProperty: (name: string, value: string) => this.properties.set(name, value) };
  focus = vi.fn();
  getBoundingClientRect = vi.fn(() => ({}));
}
class Dialog extends Element {
  open = false;
  showModal = vi.fn(() => {
    this.open = true;
  });
  close = vi.fn(() => {
    this.open = false;
  });
}
class Button extends Element {
  disabled = false;
}
let ending: LossEnding | undefined;
afterEach(() => {
  ending?.dispose();
  ending = undefined;
  vi.unstubAllGlobals();
});

function setup() {
  vi.stubGlobal('HTMLDialogElement', Dialog);
  vi.stubGlobal('HTMLButtonElement', Button);
  const dialog = new Dialog();
  const restart = new Button();
  const shade = new Element();
  const error = new Element();
  const canvas = new Element();
  const nodes: Record<string, Element> = {
    'loss-ending': dialog,
    'loss-restart': restart,
    'loss-shade': shade,
    'loss-error': error,
  };
  const root = Object.assign(new EventTarget(), {
    pointerLockElement: canvas as Element | null,
    getElementById: (id: string) => nodes[id] ?? null,
    exitPointerLock: vi.fn(() => {
      root.pointerLockElement = null;
    }),
  });
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const blocked = vi.fn();
  const command = vi.fn();
  ending = createLossEnding({
    spec: { fadeSeconds: 1 },
    root: root as unknown as Document,
    canvas: canvas as unknown as HTMLCanvasElement,
    onGameplayBlocked: blocked,
    onRestart: command,
  });
  return { dialog, restart, shade, error, canvas, root, frames, blocked, command, ending };
}
function keyboard(code: string, repeat = false, type = 'keydown'): Event {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { code, repeat });
  return event;
}

describe('opt-in loss dialog lifecycle', () => {
  it('opens once, releases capture, blocks gameplay and does not replay the fade for repeated loss', () => {
    const { ending, root, blocked, restart, dialog, frames } = setup();
    ending.outcome('win');
    expect(dialog.open).toBe(false);
    ending.outcome('lose');
    ending.outcome('lose');
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(root.exitPointerLock).toHaveBeenCalledOnce();
    expect(blocked).toHaveBeenCalledExactlyOnceWith(true);
    expect(restart.focus).toHaveBeenCalledOnce();
    expect(ending.state()).toMatchObject({ active: true, phase: 'fading', fadeSeconds: 1 });
    expect(frames.size).toBe(1);
    root.dispatchEvent(new Event('pointerlockchange'));
    expect(restart.focus).toHaveBeenCalledTimes(2);
    ending.outcome(undefined);
    expect(frames.size).toBe(0);
    expect(dialog.open).toBe(false);
    expect(blocked).toHaveBeenLastCalledWith(false);
    expect(ending.state().phase).toBe('hidden');
  });

  it('immediately dims for reduced motion and exposes restart failures rather than hiding controls', () => {
    const { ending, dialog, restart, command, frames, error } = setup();
    ending.setReducedMotion(true);
    ending.outcome('lose');
    expect(ending.state()).toEqual({
      active: true,
      phase: 'shown',
      fadeSeconds: 0,
      reducedMotion: true,
    });
    expect(dialog.dataset.visible).toBe('true');
    expect(frames.size).toBe(0);
    restart.dispatchEvent(new Event('click'));
    restart.dispatchEvent(new Event('click'));
    expect(command).toHaveBeenCalledOnce();
    expect(restart.disabled).toBe(true);
    ending.reportError('Restart request failed');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('Restart request failed');
    expect(restart.disabled).toBe(false);
    expect(ending.state().phase).toBe('shown');
  });

  it('prevents Escape dismissal and held Space/Enter repeats without blocking fresh native activation', () => {
    const { ending, dialog } = setup();
    ending.outcome('lose');
    const escape = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    for (const code of ['Space', 'Enter']) {
      const repeated = keyboard(code, true);
      dialog.dispatchEvent(repeated);
      expect(repeated.defaultPrevented).toBe(true);
      const staleRelease = keyboard(code, false, 'keyup');
      dialog.dispatchEvent(staleRelease);
      expect(staleRelease.defaultPrevented).toBe(true);
      const fresh = keyboard(code);
      dialog.dispatchEvent(fresh);
      const release = keyboard(code, false, 'keyup');
      dialog.dispatchEvent(release);
      expect(fresh.defaultPrevented).toBe(false);
      expect(release.defaultPrevented).toBe(false);
    }
  });

  it('cancels owned callbacks/listeners on dispose without resuming a disposed input collector', () => {
    const { ending, frames, blocked, dialog, restart, command } = setup();
    ending.outcome('lose');
    ending.dispose();
    ending.dispose();
    expect(frames.size).toBe(0);
    expect(dialog.open).toBe(false);
    expect(ending.state().active).toBe(false);
    expect(blocked).toHaveBeenCalledExactlyOnceWith(true);
    restart.dispatchEvent(new Event('click'));
    expect(command).not.toHaveBeenCalled();
  });
});
