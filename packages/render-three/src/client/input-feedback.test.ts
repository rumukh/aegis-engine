import { describe, expect, it } from 'vitest';
import { createInputFeedback } from './input-feedback.js';
import type { InputCaptureState } from './input.js';

describe('visible gameplay input feedback', () => {
  it('reports ownership and pause/capture denial without hiding errors behind a disclosure', () => {
    const element = { textContent: '', hidden: true, setAttribute(): void {} };
    const feedback = createInputFeedback({ getElementById: () => element } as unknown as Document);
    const capture: InputCaptureState = {
      focused: true,
      visible: true,
      paused: false,
      gameplayBlocked: false,
      pointer: 'locked',
    };
    feedback.capture(capture);
    feedback.transport({ role: 'observing', accepted: false, reason: 'observing', lastSeq: 8 });
    expect(element.textContent).toMatch(/take control/);
    expect(element.hidden).toBe(false);
    feedback.transport({ role: 'controlling', accepted: true, reason: 'accepted', lastSeq: 9 });
    expect(element.hidden).toBe(true);
    feedback.capture({ ...capture, paused: true });
    expect(element.textContent).toMatch(/Paused/);
    feedback.capture({
      ...capture,
      pointer: 'denied',
      error: 'Mouse capture was denied: blocked by host',
    });
    expect(element.textContent).toMatch(/blocked by host/);
    expect(element.hidden).toBe(false);
    feedback.capture({ ...capture, focused: false });
    expect(element.textContent).toMatch(/not focused/);
    expect(feedback.state().transport?.role).toBe('controlling');
  });
});
