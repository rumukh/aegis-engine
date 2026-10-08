import { BrowserServiceError } from '../errors.js';
import { MOUTH_SHAPES } from './types.js';
import type { Cue, CueTrackFile, MouthShape } from './types.js';

/** Rest shape used whenever no line is speaking. */
export const REST_MOUTH: MouthShape = 'X';
/** Shapes every rig must provide; `G` and `H` are optional. */
export const REQUIRED_MOUTH_SHAPES: readonly MouthShape[] = ['X', 'A', 'B', 'C', 'D', 'E', 'F'];
/** Rhubarb's documented substitutions for the extended shapes. */
export const MOUTH_FALLBACK: Readonly<Partial<Record<MouthShape, MouthShape>>> = Object.freeze({
  G: 'B',
  H: 'C',
  X: 'A',
});

/** Azure Speech `VisemeReceived` IDs 0..21 mapped to engine shapes (docs/api/animation.md 5.1). */
export const AZURE_VISEMES: readonly MouthShape[] = Object.freeze([
  'X',
  'C',
  'D',
  'E',
  'C',
  'E',
  'B',
  'F',
  'F',
  'D',
  'E',
  'D',
  'B',
  'E',
  'H',
  'B',
  'B',
  'B',
  'G',
  'B',
  'B',
  'A',
]) as readonly MouthShape[];

/** Oculus/Meta OVR LipSync visemes mapped to engine shapes. */
export const OVR_VISEMES: Readonly<Record<string, MouthShape>> = Object.freeze({
  sil: 'X',
  PP: 'A',
  FF: 'G',
  TH: 'B',
  DD: 'B',
  kk: 'B',
  CH: 'B',
  SS: 'B',
  nn: 'B',
  RR: 'E',
  aa: 'D',
  E: 'C',
  ih: 'B',
  oh: 'E',
  ou: 'F',
});

export function isMouthShape(value: unknown): value is MouthShape {
  return typeof value === 'string' && (MOUTH_SHAPES as readonly string[]).includes(value);
}

/** The shape to draw on a rig that provides `available` shapes. */
export function resolveMouthShape(shape: MouthShape, available: ReadonlySet<string>): MouthShape {
  let current: MouthShape | undefined = shape;
  for (let guard = 0; current && guard < 4; guard++) {
    if (available.has(current)) return current;
    current = MOUTH_FALLBACK[current];
  }
  return available.has(REST_MOUTH) ? REST_MOUTH : 'A';
}

/**
 * The cue active at `time`, by binary search: each shape holds until the next cue, and the mouth
 * is at rest before the first cue and from `duration` on.
 */
export function sampleCues(track: Pick<CueTrackFile, 'cues' | 'duration'>, time: number): Cue {
  const cues = track.cues;
  if (!(time >= 0) || time >= track.duration || !cues.length || time < cues[0]!.t)
    return { t: Math.max(0, Math.min(time, track.duration)), s: REST_MOUTH };
  let low = 0;
  let high = cues.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (cues[middle]!.t <= time) low = middle;
    else high = middle - 1;
  }
  return cues[low]!;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** Collapse repeated shapes and sort; the result is a valid `aegis-cues/1` cue list. */
function normalize(cues: Cue[]): Cue[] {
  cues.sort((a, b) => a.t - b.t);
  const result: Cue[] = [];
  for (const cue of cues) {
    const last = result.at(-1);
    if (last && last.t === cue.t) result[result.length - 1] = cue;
    else if (!last || last.s !== cue.s || last.a !== cue.a) result.push(cue);
  }
  return result;
}

/** Import Rhubarb Lip Sync's JSON export (`rhubarb -f json`). */
export function importRhubarb(
  input: unknown,
  options: { line: string; revision?: string; duration?: number },
): CueTrackFile {
  const value = input as {
    metadata?: { duration?: unknown };
    mouthCues?: { start?: unknown; end?: unknown; value?: unknown }[];
  };
  if (!value || typeof value !== 'object' || !Array.isArray(value.mouthCues))
    throw new BrowserServiceError('invalid-data', 'Not a Rhubarb JSON export (mouthCues missing).');
  const duration =
    options.duration ??
    (typeof value.metadata?.duration === 'number' ? value.metadata.duration : undefined) ??
    (value.mouthCues.length && typeof value.mouthCues.at(-1)!.end === 'number'
      ? (value.mouthCues.at(-1)!.end as number)
      : undefined);
  if (typeof duration !== 'number' || !(duration > 0))
    throw new BrowserServiceError('invalid-data', 'The Rhubarb export has no positive duration.');
  const cues = value.mouthCues.map((cue, index): Cue => {
    if (typeof cue.start !== 'number' || !isMouthShape(cue.value))
      throw new BrowserServiceError(
        'invalid-data',
        `Rhubarb cue ${String(index)} has no numeric start or a shape outside A-H/X.`,
      );
    return { t: round(cue.start), s: cue.value };
  });
  return {
    format: 'aegis-cues/1',
    line: options.line,
    ...(options.revision ? { revision: options.revision } : {}),
    duration: round(duration),
    cues: normalize(cues.filter((cue) => cue.t < duration)),
  };
}

/**
 * Import viseme events from another set: `azure` (IDs 0-21 with `audioOffset` in 100 ns ticks or
 * `time` in seconds) or `ovr` (names with `time` in seconds).
 */
export function importVisemes(
  set: 'azure' | 'ovr',
  events: readonly { visemeId?: number; viseme?: string; audioOffset?: number; time?: number }[],
  options: { line: string; revision?: string; duration: number },
): CueTrackFile {
  if (!(options.duration > 0))
    throw new BrowserServiceError('invalid-data', 'Viseme import requires a positive duration.');
  const cues = events.map((event, index): Cue => {
    const time =
      event.time ?? (event.audioOffset === undefined ? undefined : event.audioOffset / 10_000_000);
    const shape =
      set === 'azure'
        ? event.visemeId !== undefined && Number.isInteger(event.visemeId)
          ? AZURE_VISEMES[event.visemeId]
          : undefined
        : event.viseme !== undefined && Object.hasOwn(OVR_VISEMES, event.viseme)
          ? OVR_VISEMES[event.viseme]
          : undefined;
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || !shape)
      throw new BrowserServiceError(
        'invalid-data',
        `Viseme event ${String(index)} has no valid time or a viseme outside the ${set} set.`,
      );
    return { t: round(time), s: shape };
  });
  return {
    format: 'aegis-cues/1',
    line: options.line,
    ...(options.revision ? { revision: options.revision } : {}),
    duration: round(options.duration),
    cues: normalize(cues.filter((cue) => cue.t < options.duration)),
  };
}
