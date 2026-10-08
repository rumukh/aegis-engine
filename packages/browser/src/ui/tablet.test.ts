import { describe, expect, it } from 'vitest';
import { CHILD_SAFE_CSS } from './preferences.js';
import { evaluateViewport, TABLET_PROFILE, TABLET_PROFILE_CSS } from './tablet.js';

describe('tablet profile (UI-10)', () => {
  it('classifies portrait, small landscape and fitting landscape viewports', () => {
    expect(evaluateViewport({ width: 768, height: 1024 })).toMatchObject({
      orientation: 'portrait',
      fits: false,
      reason: 'rotate',
    });
    expect(evaluateViewport({ width: 1000, height: 600 }).reason).toBe('small');
    expect(evaluateViewport({ width: 1024, height: 599 }).reason).toBe('small');
    expect(evaluateViewport({ width: 1024, height: 600 })).toMatchObject({
      fits: true,
      reason: 'ok',
    });
    expect(evaluateViewport({ width: 1180, height: 820 }, TABLET_PROFILE).fits).toBe(true);
    expect(() => evaluateViewport({ width: 0, height: 600 })).toThrow();
    expect(() => evaluateViewport({ width: Number.NaN, height: 600 })).toThrow();
  });

  it('keeps every opt-in preset selector at zero specificity (issue #14)', () => {
    for (const css of [CHILD_SAFE_CSS, TABLET_PROFILE_CSS]) {
      const selectors = css
        .replace(/@media[^{]+\{/g, '')
        .split('}')
        .map((rule) => rule.split('{')[0]!.trim())
        .filter(Boolean)
        .flatMap((list) => list.split(/,(?![^(]*\))/).map((item) => item.trim()));
      expect(selectors.length).toBeGreaterThan(3);
      for (const selector of selectors)
        expect(selector.replace(/::(before|after)$/, '')).toMatch(/^(:where\([^]*\)\s*)+$/);
    }
    expect(CHILD_SAFE_CSS).toContain('[data-reduced-motion="true"] .aegis-child *');
  });
});
