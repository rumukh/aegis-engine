import { describe, expect, it, vi } from 'vitest';
import { key } from './browser.js';

describe('browser keyboard vocabulary', () => {
  it('supplies the native Enter character needed for browser button activation', async () => {
    const send = vi
      .fn<(method: string, params?: object) => Promise<unknown>>()
      .mockResolvedValue({});
    await key({ send }, 'Enter', true);
    expect(send.mock.lastCall?.[1]).toMatchObject({
      code: 'Enter',
      key: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
    });
    await key({ send }, 'Enter', false);
    expect(send.mock.lastCall?.[1]).toMatchObject({
      type: 'keyUp',
      code: 'Enter',
      text: undefined,
    });
  });
  it('dispatches every standard letter and number, not only the original PoC bindings', async () => {
    const send = vi
      .fn<(method: string, params?: object) => Promise<unknown>>()
      .mockResolvedValue({});
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      await key({ send }, `Key${letter}`, true);
      expect(send).toHaveBeenLastCalledWith('Input.dispatchKeyEvent', {
        type: 'keyDown',
        code: `Key${letter}`,
        key: letter.toLowerCase(),
        windowsVirtualKeyCode: letter.charCodeAt(0),
        nativeVirtualKeyCode: letter.charCodeAt(0),
        text: letter.toLowerCase(),
      });
      await key({ send }, `Key${letter}`, false);
      expect(send.mock.lastCall?.[1]).toMatchObject({
        type: 'keyUp',
        code: `Key${letter}`,
        text: undefined,
      });
    }
    for (const digit of '0123456789') {
      await key({ send }, `Digit${digit}`, true);
      expect(send.mock.lastCall?.[1]).toMatchObject({
        code: `Digit${digit}`,
        key: digit,
        windowsVirtualKeyCode: digit.charCodeAt(0),
      });
    }
  });

  it('preserves left/right modifier location and rejects unknown physical codes explicitly', async () => {
    const send = vi
      .fn<(method: string, params?: object) => Promise<unknown>>()
      .mockResolvedValue({});
    for (const modifier of ['Shift', 'Control', 'Alt', 'Meta']) {
      for (const [side, location] of [
        ['Left', 1],
        ['Right', 2],
      ] as const) {
        const code = `${modifier}${side}`;
        await key({ send }, code, true);
        expect(send.mock.lastCall?.[1]).toMatchObject({
          type: 'keyDown',
          code,
          key: modifier,
          location,
          text: undefined,
        });
        await key({ send }, code, false);
        expect(send.mock.lastCall?.[1]).toMatchObject({
          type: 'keyUp',
          code,
          key: modifier,
          location,
          text: undefined,
        });
      }
    }
    await expect(key({ send }, 'NotAKeyboardCode', true)).rejects.toThrow(/no virtual-key mapping/);
    expect(send).toHaveBeenCalledTimes(16);
  });
});
