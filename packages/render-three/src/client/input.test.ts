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
