import type { Easing, EasingName } from './types.js';

const BACK = 1.70158;
export const EASINGS: Readonly<Record<EasingName, (t: number) => number>> = Object.freeze({
  linear: (t) => t,
  step: () => 0,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  easeInSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  easeOutSine: (t) => Math.sin((t * Math.PI) / 2),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeInBack: (t) => (BACK + 1) * t * t * t - BACK * t * t,
  easeOutBack: (t) => 1 + (BACK + 1) * (t - 1) ** 3 + BACK * (t - 1) ** 2,
  easeInOutBack: (t) => {
    const c = BACK * 1.525;
    return t < 0.5
      ? ((2 * t) ** 2 * ((c + 1) * 2 * t - c)) / 2
      : ((2 * t - 2) ** 2 * ((c + 1) * (t * 2 - 2) + c) + 2) / 2;
  },
});

export function isEasing(value: unknown): value is Easing {
  if (typeof value === 'string') return Object.hasOwn(EASINGS, value);
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item)) &&
    value[0] >= 0 &&
    value[0] <= 1 &&
    value[2] >= 0 &&
    value[2] <= 1
  );
}

/** CSS-style cubic Bezier timing function, solved by bisection (deterministic). */
function bezier([x1, y1, x2, y2]: readonly [number, number, number, number], t: number): number {
  const at = (a: number, b: number, s: number): number =>
    3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2;
    if (at(x1, x2, middle) < t) low = middle;
    else high = middle;
  }
  return at(y1, y2, (low + high) / 2);
}

/** Map normalized segment progress (0..1) through an easing. */
export function ease(easing: Easing | undefined, t: number): number {
  const progress = Math.min(1, Math.max(0, t));
  if (easing === undefined) return progress;
  if (typeof easing === 'string') return EASINGS[easing](progress);
  if (progress === 0 || progress === 1) return progress;
  return bezier(easing, progress);
}
