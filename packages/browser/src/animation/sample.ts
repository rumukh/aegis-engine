import { ease } from './easing.js';
import type { ClipFile, ClipTrack, NumericProperty } from './types.js';

export interface ClipSample {
  /** Numeric property values by part: offsets (x, y, rotation) or factors (scale, opacity). */
  numbers: Map<string, Partial<Record<NumericProperty, number>>>;
  variants: Map<string, string>;
  expression?: string;
}

/** Map a clip time to its local time: wrapped for loops, clamped otherwise. */
export function clipTime(clip: Pick<ClipFile, 'duration' | 'loop'>, time: number): number {
  if (!Number.isFinite(time)) return clip.duration;
  if (clip.loop) {
    const wrapped = time % clip.duration;
    return wrapped < 0 ? wrapped + clip.duration : wrapped;
  }
  return Math.min(clip.duration, Math.max(0, time));
}

function lastKeyIndex(track: ClipTrack, time: number): number {
  const keys = track.keys;
  let low = 0;
  let high = keys.length - 1;
  if (time < keys[0]!.t) return -1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (keys[middle]!.t <= time) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Sample one numeric track; before the first key it holds the first value, after the last the last. */
export function sampleTrack(track: ClipTrack, time: number): number | string {
  const keys = track.keys;
  const index = lastKeyIndex(track, time);
  if (index < 0) return keys[0]!.v;
  const key = keys[index]!;
  const next = keys[index + 1];
  if (!next || typeof key.v !== 'number' || typeof next.v !== 'number' || key.ease === 'step')
    return key.v;
  const progress = ease(key.ease, (time - key.t) / (next.t - key.t));
  return key.v + (next.v - key.v) * progress;
}

/**
 * Deterministic clip sampling (ANIM-03): a clip time maps to exactly one pose. Seeking and
 * skip-to-end use this same function.
 */
export function sampleClip(clip: ClipFile, time: number): ClipSample {
  const local = clipTime(clip, time);
  const sample: ClipSample = { numbers: new Map(), variants: new Map() };
  for (const track of clip.tracks) {
    if (!track.keys.length) continue;
    const value = sampleTrack(track, local);
    if (track.property === 'expression') sample.expression = String(value);
    else if (track.property === 'variant') sample.variants.set(track.part!, String(value));
    else {
      const part = sample.numbers.get(track.part!) ?? {};
      part[track.property] = value as number;
      sample.numbers.set(track.part!, part);
    }
  }
  return sample;
}

/** Clip events crossed in `(from, to]`, in order; loops are unrolled. */
export function clipEventsBetween(
  clip: ClipFile,
  from: number,
  to: number,
): { name: string; t: number; data?: Readonly<Record<string, string | number | boolean>> }[] {
  if (!clip.events?.length || !(to > from)) return [];
  const result: {
    name: string;
    t: number;
    data?: Readonly<Record<string, string | number | boolean>>;
  }[] = [];
  if (!clip.loop) {
    for (const event of clip.events)
      if (event.t > from && event.t <= to && event.t <= clip.duration) result.push(event);
    return result.sort((a, b) => a.t - b.t);
  }
  const first = Math.floor(from / clip.duration);
  const last = Math.floor(to / clip.duration);
  for (let cycle = first; cycle <= last && cycle - first < 1000; cycle++)
    for (const event of [...clip.events].sort((a, b) => a.t - b.t)) {
      const at = cycle * clip.duration + event.t;
      if (at > from && at <= to) result.push({ ...event, t: at });
    }
  return result;
}

/** 2D affine matrix [a, b, c, d, e, f] as used by Canvas `setTransform` and CSS `matrix()`. */
export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Readonly<Matrix> = Object.freeze([1, 0, 0, 1, 0, 0]) as Readonly<Matrix>;

export function multiply(m: Readonly<Matrix>, n: Readonly<Matrix>): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** translate(x, y) · rotate(degrees) · scale(sx, sy) */
export function compose(x: number, y: number, degrees: number, sx: number, sy: number): Matrix {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos * sx, sin * sx, -sin * sy, cos * sy, x, y];
}

export function apply(m: Readonly<Matrix>, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function invert(m: Readonly<Matrix>): Matrix | undefined {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return undefined;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}
