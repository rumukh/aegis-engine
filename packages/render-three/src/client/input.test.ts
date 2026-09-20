import { afterEach, describe, expect, it, vi } from 'vitest';
import { BINDINGS } from '../bindings.js';
import { installFakeDom, keyEvent } from '../testing/dom.js';
import type { FakeDom } from '../testing/dom.js';
import { createInputCollector } from './input.js';
import type { InputCollector } from './input.js';
import { createLiveInput } from '../live-input.js';
import { buttonEvent } from '../testing/dom.js';
import { virtualGamepad } from '../testing/gamepad.js';

let dom: FakeDom | undefined;
let collector: InputCollector | undefined;
afterEach(() => {
  collector?.dispose();
  dom?.restore();
  vi.unstubAllGlobals();
});

describe('gameplay input and UI controls', () => {
  it('accepts an explicitly bound Control key itself but not Ctrl+letters or focused text input', () => {
    class TextField {
      closest(): TextField {
        return this;
      }
    }
    vi.stubGlobal('Element', TextField);
    dom = installFakeDom();
    collector = createInputCollector({
      canvas: dom.canvas,
      bindings: { ...BINDINGS.fps, actions: [{ code: 'ControlLeft', action: 'Crouch' }] },
      pick: () => null,
      onCommand: () => undefined,
    });
    dom.dispatch('keydown', { ...keyEvent('ControlLeft'), ctrlKey: true, target: new TextField() });
    expect(collector.take().held).toEqual([]);
    dom.dispatch('keydown', { ...keyEvent('KeyW'), ctrlKey: true });
    expect(collector.take().axes).toEqual({});
    dom.dispatch('keydown', { ...keyEvent('ControlLeft'), ctrlKey: true });
    expect(collector.take()).toMatchObject({ held: ['Crouch'], pressed: ['Crouch'] });
    dom.dispatch('keyup', keyEvent('ControlLeft'));
    expect(collector.take()).toMatchObject({ held: [], released: ['Crouch'] });
    dom.dispatch('keydown', { ...keyEvent('ControlRight'), ctrlKey: true });
    expect(collector.take().held).toEqual([]);
  });
  it('blocks ended gameplay but retains fresh R on a focused button and neutral-armed View restart', () => {
    class UiElement {
      closest(): UiElement {
        return this;
      }
    }
    vi.stubGlobal('Element', UiElement);
    dom = installFakeDom();
    const pad = virtualGamepad();
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    const command = vi.fn();
    const intent = vi.fn();
    collector = createInputCollector({
      canvas: dom.canvas,
      bindings: BINDINGS.fps,
      pick: () => null,
      onCommand: command,
      onControlIntent: intent,
    });
    collector.poll(0);
    dom.dispatch('keydown', keyEvent('KeyW'));
    pad.buttons[0]!.value = 1;
    collector.poll(0);
    collector.setGameplayBlocked(true);
    intent.mockClear();
    dom.dispatch('mousemove', { movementX: 40, movementY: 5 });
    dom.dispatch('mousedown', buttonEvent());
    dom.dispatch('keydown', keyEvent('Space'));
    collector.poll(1 / 60);
    expect(collector.take()).toMatchObject({
      held: [],
      pressed: [],
      axes: {},
      look: { dx: 0, dy: 0 },
    });
    expect(command).not.toHaveBeenCalled();
    expect(intent).not.toHaveBeenCalled();
    dom.dispatch('keydown', { ...keyEvent('KeyR'), target: new UiElement() });
    expect(command).toHaveBeenCalledExactlyOnceWith('restart');
    dom.dispatch('keydown', { ...keyEvent('KeyR'), target: new UiElement(), repeat: true });
    expect(command).toHaveBeenCalledOnce();
    pad.buttons[8]!.value = 1;
    collector.poll(0);
    expect(command).toHaveBeenCalledOnce();
    pad.buttons[0]!.value = 0;
    pad.buttons[8]!.value = 0;
    collector.poll(0);
    pad.buttons[8]!.value = 1;
    collector.poll(0);
    expect(command).toHaveBeenCalledTimes(2);
    collector.setGameplayBlocked(false);
    dom.dispatch('keydown', { ...keyEvent('KeyW'), repeat: true });
    expect(collector.take().axes).toEqual({});
    dom.dispatch('keyup', keyEvent('KeyW'));
    dom.dispatch('keydown', keyEvent('KeyW'));
    expect(collector.take().axes).toMatchObject({ Forward: 1 });
  });
  it('claims only fresh gameplay intent, not held polls, releases, UI keys or cancelled input', () => {
    class UiElement {
      closest(): UiElement {
        return this;
      }
    }
    vi.stubGlobal('Element', UiElement);
    dom = installFakeDom();
    const intent = vi.fn();
    collector = createInputCollector({
      canvas: dom.canvas,
      bindings: BINDINGS.fps,
      pick: () => null,
      onCommand: () => undefined,
      onControlIntent: intent,
    });
    dom.dispatch('keydown', { ...keyEvent('KeyW'), target: new UiElement() });
    expect(intent).not.toHaveBeenCalled();
    dom.dispatch('keydown', keyEvent('KeyW'));
    expect(intent).toHaveBeenLastCalledWith(true);
    intent.mockClear();
    collector.take();
    collector.poll(1 / 60);
    dom.dispatch('keydown', { ...keyEvent('KeyW'), repeat: true });
    collector.take();
    dom.dispatch('keyup', keyEvent('KeyW'));
    expect(intent).not.toHaveBeenCalled();
    dom.dispatch('keydown', keyEvent('KeyW'));
    dom.dispatch('blur', {});
    expect(intent).toHaveBeenLastCalledWith(false);
    expect(collector.take().axes).toEqual({});
  });

  it('reports pointer-lock promise rejection without an unhandled rejection or a fake mouse-look fallback', async () => {
    dom = installFakeDom({ pointerLocked: false });
    const request = vi
      .fn()
      .mockRejectedValue(new DOMException('Host denied mouse capture', 'NotSupportedError'));
    Object.defineProperty(dom.canvas, 'requestPointerLock', { value: request, configurable: true });
    const state = vi.fn();
    collector = createInputCollector({
      canvas: dom.canvas,
      bindings: BINDINGS.fps,
      pick: () => null,
      onCommand: () => undefined,
      onCaptureState: state,
    });
    dom.dispatch('mousedown', buttonEvent());
    await Promise.resolve();
    expect(state).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pointer: 'denied',
        error: expect.stringContaining('Host denied mouse capture'),
      }),
    );
    dom.dispatch('mousemove', { movementX: 100, movementY: 40 });
    expect(collector.take().look).toEqual({ dx: 0, dy: 0 });
    dom.dispatch('mouseup', buttonEvent());
    dom.dispatch('mousedown', buttonEvent());
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('ignores a late capture rejection after disposal and reports paused capture state', async () => {
    dom = installFakeDom({ pointerLocked: false });
    let reject!: (reason: unknown) => void;
    Object.defineProperty(dom.canvas, 'requestPointerLock', {
      value: () =>
        new Promise<void>((_done, fail) => {
          reject = fail;
        }),
      configurable: true,
    });
    const state = vi.fn();
    collector = createInputCollector({
      canvas: dom.canvas,
      bindings: BINDINGS.fps,
      pick: () => null,
      onCommand: () => undefined,
      onCaptureState: state,
    });
    collector.setPaused(true);
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({ paused: true }));
    dom.dispatch('mousedown', buttonEvent());
    collector.dispose();
    state.mockClear();
    reject(new Error('Late denial'));
    await Promise.resolve();
    expect(state).not.toHaveBeenCalled();
  });

  it('clears held actions and pending edges on restart without recreating event listeners', () => {
    dom = installFakeDom();
    collector = createInputCollector({
      canvas: dom.canvas,
      bindings: BINDINGS.platformer,
      pick: () => null,
      onCommand: () => undefined,
    });
    dom.dispatch('keydown', keyEvent('Space'));
    expect(collector.take().pressed).toContain('Jump');
    collector.clear();
    expect(collector.take().held).toEqual([]);
    expect(collector.take().pressed).toEqual([]);
    dom.dispatch('keydown', keyEvent('Space'));
    expect(collector.take().pressed).toContain('Jump');
  });

  describe('controller collector integration', () => {
    it('does not arm in an initially unfocused page and resumes only after neutral', () => {
      dom = installFakeDom();
      Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true });
      const pad = virtualGamepad();
      vi.stubGlobal('navigator', { getGamepads: () => [pad] });
      collector = createInputCollector({
        canvas: dom.canvas,
        bindings: BINDINGS.platformer,
        pick: () => null,
        onCommand: () => undefined,
      });
      collector.poll(0);
      expect(collector.gamepad?.status).toBe('suspended');
      dom.dispatch('keydown', keyEvent('Space'));
      expect(collector.take().held).toEqual([]);
      pad.buttons[0]!.value = 1;
      dom.dispatch('focus', {});
      collector.poll(0);
      expect(collector.take().pressed).toEqual([]);
      pad.buttons[0]!.value = 0;
      collector.poll(0);
      pad.buttons[0]!.value = 1;
      collector.poll(0);
      expect(collector.take().pressed).toEqual(['Jump']);
    });

    function setup(mode: keyof typeof BINDINGS = 'fps') {
      dom = installFakeDom({ viewport: { width: 1000, height: 500 } });
      const pad = virtualGamepad();
      const devices = [pad];
      vi.stubGlobal('navigator', { getGamepads: () => devices });
      const command = vi.fn();
      const pointer = vi.fn();
      const pick = vi.fn((x: number, y: number) => ({ x, y, z: 0 }));
      collector = createInputCollector({
        canvas: dom.canvas,
        bindings: BINDINGS[mode],
        pick,
        onCommand: command,
        onGamepadPointer: pointer,
      });
      collector.poll(0);
      return { pad, devices, command, pointer, pick, input: collector, browser: dom };
    }

    it('merges controller, mouse and keyboard ownership instead of losing held Fire', () => {
      const { pad, input, browser } = setup();
      const live = createLiveInput();
      browser.dispatch('mousedown', buttonEvent());
      live.submit(input.take());
      expect(live.frameFor(0).pressed).toEqual(['Fire']);
      pad.buttons[7]!.value = 1;
      input.poll(1 / 60);
      expect(input.take().pressed).toEqual([]);
      browser.dispatch('mouseup', buttonEvent());
      expect(input.take()).toMatchObject({ held: ['Fire'], released: [] });
      pad.connected = false;
      input.poll(1 / 60);
      expect(input.take()).toMatchObject({ held: [], released: ['Fire'] });
      browser.dispatch('keydown', keyEvent('Space'));
      expect(input.lastActiveDevice).toBe('keyboard');
      expect(input.take().pressed).toEqual(['Jump']);
    });

    it('polls taps at display rate while take waits for a slower transport', () => {
      const { pad, input } = setup('platformer');
      pad.buttons[0]!.value = 1;
      input.poll(1 / 120);
      pad.buttons[0]!.value = 0;
      input.poll(1 / 120);
      const live = createLiveInput();
      live.submit(input.take());
      expect(live.frameFor(0)).toMatchObject({ pressed: ['Jump'], released: ['Jump'] });
      expect(live.frameFor(1).pressed).toEqual([]);
      expect(input.take().pressed).toEqual([]);
    });

    it.each([30, 60, 120])('uses elapsed seconds, not sample or catch-up count (%i Hz)', (hz) => {
      const { pad, input } = setup();
      pad.axes[2] = 1;
      const live = createLiveInput();
      for (let frame = 0; frame < hz; frame++) {
        input.poll(1 / hz);
        live.submit(input.take());
      }
      live.spreadLookOver(4);
      expect([0, 1, 2, 3].map((tick) => live.frameFor(tick).look.dx)).toEqual([-30, -30, -30, -30]);
      expect(live.frameFor(4).look.dx).toBe(0);
      expect(() => input.poll(NaN)).toThrow(/elapsedSeconds/);
    });

    it('keeps analog movement, uses the fps screen signs, and caps a stalled display interval', () => {
      const { pad, input } = setup();
      pad.axes[0] = 0.6;
      pad.axes[3] = 1;
      input.poll(10);
      const packet = input.take();
      expect(packet.axes?.Strafe).toBeCloseTo(-0.5, 12);
      expect(packet.look).toEqual({ dx: 0, dy: -22.5 });
      expect(packet.axes).not.toHaveProperty('LookY');
      expect(input.lastActiveDevice).toBe('gamepad');
    });

    it('maps iso controller cursor through the actual mouse picker, clicking only on an edge', () => {
      const { pad, input, pick, pointer, browser } = setup('iso');
      pad.axes[0] = 1;
      input.poll(0.2);
      expect(pointer).toHaveBeenLastCalledWith({ x: 600, y: 250 });
      expect(pick).not.toHaveBeenCalled();
      pad.buttons[0]!.value = 1;
      input.poll(0);
      const packet = input.take();
      expect(pick).toHaveBeenCalledExactlyOnceWith(expect.closeTo(0.2, 10), 0);
      expect(packet.pointer).toMatchObject({ screen: { x: 600, y: 250 }, buttons: ['primary'] });
      expect(packet.held).not.toContain('PointerPrimary');
      input.poll(0);
      expect(input.take().pointer).toBeNull();
      pad.axes[0] = 0;
      browser.dispatch('mousemove', { movementX: 1, movementY: 0 });
      input.poll(0);
      expect(pointer).toHaveBeenLastCalledWith(null);
      pad.connected = false;
      input.poll(0);
      expect(pointer).toHaveBeenLastCalledWith(null);
    });

    it('clears focus loss without a buffered press, and rearms only after release', () => {
      const { pad, input, browser } = setup();
      pad.buttons[7]!.value = 1;
      input.poll(0);
      browser.dispatch('keydown', keyEvent('Space'));
      browser.dispatch('blur', {});
      input.poll(0);
      const blurred = input.take();
      expect(blurred).toMatchObject({ held: [], pressed: [] });
      expect([...(blurred.released ?? [])].sort()).toEqual(['Fire', 'Jump']);
      browser.dispatch('focus', {});
      input.poll(0);
      browser.dispatch('keydown', keyEvent('Space'));
      expect(input.take().held).toEqual([]);
      pad.buttons[7]!.value = 0;
      input.poll(0);
      browser.dispatch('keyup', keyEvent('Space'));
      browser.dispatch('keydown', keyEvent('Space'));
      pad.buttons[7]!.value = 1;
      input.poll(0);
      expect([...(input.take().held ?? [])].sort()).toEqual(['Fire', 'Jump']);
      input.dispose();
      browser.dispatch('keydown', keyEvent('Space'));
      input.poll(0);
      expect(input.take().held).toEqual([]);
    });

    it('samples commands while paused but requires neutral rearm before gameplay resumes', () => {
      const { pad, input, command } = setup();
      input.setPaused(true);
      input.poll(0);
      pad.buttons[7]!.value = 1;
      pad.buttons[9]!.value = 1;
      input.poll(0);
      expect(command).toHaveBeenCalledExactlyOnceWith('pause');
      expect(input.take().held).toEqual([]);
      input.setPaused(false);
      input.poll(0);
      expect(input.take().held).toEqual([]);
      pad.buttons[7]!.value = 0;
      pad.buttons[9]!.value = 0;
      input.poll(0);
      pad.buttons[7]!.value = 1;
      input.poll(0);
      expect(input.take().pressed).toEqual(['Fire']);
    });
  });

  it('lets a focused button handle Space instead of also jumping, with an unfocused positive control', () => {
    class UiElement {
      closest(): UiElement {
        return this;
      }
    }
    vi.stubGlobal('Element', UiElement);
    dom = installFakeDom();
    const command = vi.fn();
    collector = createInputCollector({
      canvas: dom.canvas,
      bindings: BINDINGS.platformer,
      pick: () => null,
      onCommand: command,
    });
    dom.dispatch('keydown', { ...keyEvent('Space'), target: new UiElement() });
    expect(collector.take().pressed).toEqual([]);
    dom.dispatch('keydown', { ...keyEvent('KeyR'), target: new UiElement() });
    expect(command).not.toHaveBeenCalled();
    dom.dispatch('keydown', keyEvent('Space'));
    expect(collector.take().pressed).toContain('Jump');
  });

  it('preserves keyboard scrolling in focusable diagnostics without disabling a focused canvas', () => {
    class FocusTarget {
      constructor(readonly canvas = false) {}
      closest(selector: string): FocusTarget | null {
        return !this.canvas && selector.includes('[tabindex]:not(canvas)') ? this : null;
      }
    }
    vi.stubGlobal('Element', FocusTarget);
    dom = installFakeDom();
    collector = createInputCollector({
      canvas: dom.canvas,
      bindings: BINDINGS.platformer,
      pick: () => null,
      onCommand: () => undefined,
    });
    dom.dispatch('keydown', { ...keyEvent('Space'), target: new FocusTarget() });
    expect(collector.take().pressed).toEqual([]);
    dom.dispatch('keydown', { ...keyEvent('Space'), target: new FocusTarget(true) });
    expect(collector.take().pressed).toContain('Jump');
  });

  it('leaves modified browser shortcuts alone while preserving the ordinary restart key', () => {
    dom = installFakeDom();
    const command = vi.fn();
    collector = createInputCollector({
      canvas: dom.canvas,
      bindings: BINDINGS.platformer,
      pick: () => null,
      onCommand: command,
    });
    dom.dispatch('keydown', { ...keyEvent('KeyR'), ctrlKey: true });
    dom.dispatch('keydown', { ...keyEvent('KeyR'), metaKey: true });
    expect(command).not.toHaveBeenCalled();
    dom.dispatch('keydown', keyEvent('KeyR'));
    expect(command).toHaveBeenCalledExactlyOnceWith('restart');
  });
});
