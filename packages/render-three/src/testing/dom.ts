/**
 * The smallest browser a real input collector needs, so its tests can run in Node.
 *
 * `createInputCollector`'s contract with a browser is narrow and worth writing down: `movementX`
 * and `movementY` on a mouse move under pointer lock, `code` / `repeat` / `preventDefault` on a
 * key event, `button` on a mouse button, and `document.pointerLockElement`. Everything else it
 * does is arithmetic over the binding table.
 *
 * Faking exactly that keeps the *code under test* real — the tests drive the same module the page
 * loads, not a re-implementation — while letting the assertion run in the same deterministic
 * process as the simulation. It lives here rather than inside one test file because two of them
 * need it, and a second copy of a DOM shim is the kind of thing that drifts in whichever copy is
 * read less often.
 * @packageDocumentation
 */

/** A stand-in for the browser objects `createInputCollector` reaches for. */
export interface FakeDom {
  /** The element the collector treats as the canvas. */
  canvas: HTMLCanvasElement;
  /** Deliver an event to every listener the collector registered for `type`. */
  dispatch(type: string, event: object): void;
  /** Undo the globals. */
  restore(): void;
}

/** Options for {@link installFakeDom}. */
export interface FakeDomOptions {
  /** Canvas size in CSS pixels. Defaults to 1280x720. */
  viewport?: { width: number; height: number };
  /**
   * Whether the pointer is locked to the canvas. Defaults to `true`.
   *
   * The collector ignores mouse movement without it and a human plays the fps game locked, so a
   * rig that forgot this would silently measure nothing at all.
   */
  pointerLocked?: boolean;
}

/** Install the smallest DOM the collector needs, and hand back a way to fire events at it. */
export function installFakeDom(options: FakeDomOptions = {}): FakeDom {
  const viewport = options.viewport ?? { width: 1280, height: 720 };
  const listeners = new Map<string, ((event: object) => void)[]>();
  const add = (type: string, handler: (event: object) => void): void => {
    const existing = listeners.get(type);
    if (existing === undefined) listeners.set(type, [handler]);
    else existing.push(handler);
  };
  const remove = (type: string, handler: (event: object) => void): void => {
    const existing = listeners.get(type);
    if (existing === undefined) return;
    const at = existing.indexOf(handler);
    if (at >= 0) existing.splice(at, 1);
  };

  const canvas = {
    addEventListener: add,
    removeEventListener: remove,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: viewport.width,
      height: viewport.height,
    }),
    requestPointerLock: () => undefined,
    clientWidth: viewport.width,
    clientHeight: viewport.height,
  } as unknown as HTMLCanvasElement;

  const globals = globalThis as unknown as Record<string, unknown>;
  const priorWindow = globals['window'];
  const priorDocument = globals['document'];
  globals['window'] = { addEventListener: add, removeEventListener: remove };
  globals['document'] = {
    pointerLockElement: (options.pointerLocked ?? true) ? canvas : null,
  };

  return {
    canvas,
    dispatch(type: string, event: object): void {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
    restore(): void {
      globals['window'] = priorWindow;
      globals['document'] = priorDocument;
    },
  };
}

/** A keyboard event shaped the way the collector expects one. */
export function keyEvent(code: string): object {
  return { code, repeat: false, preventDefault: () => undefined };
}

/** A primary mouse button event shaped the way the collector expects one. */
export function buttonEvent(): object {
  return { button: 0, clientX: 0, clientY: 0, preventDefault: () => undefined };
}
