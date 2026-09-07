import { afterEach, describe, expect, it, vi } from 'vitest';
import { BINDINGS } from '../bindings.js';
import { installFakeDom, keyEvent } from '../testing/dom.js';
import type { FakeDom } from '../testing/dom.js';
import { createInputCollector } from './input.js';
import type { InputCollector } from './input.js';

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
