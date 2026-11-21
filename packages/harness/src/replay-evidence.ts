import { canonicalStringify, hashString } from '@aegis/core';
import type { GameEvent, WorldSnapshot } from '@aegis/core';

/** Keys are JSON pointers (entities addressed by packed handle), values index the dictionary. */
interface EvidenceFrame {
  readonly state: Readonly<Record<string, number>>;
  readonly events: readonly GameEvent[];
}

export interface ReplayEvidence {
  readonly format: 'replay-evidence/1';
  readonly values: readonly unknown[];
  /** Bootstrap, then the state/events immediately after each zero-based simulation step. */
  readonly frames: readonly EvidenceFrame[];
}

const MAX_UNITS = 16 * 1024 * 1024;
const MAX_FIELDS = 16;
const MAX_EVENTS = 8;
const MAX_CHARS = 200;
const GLOBAL_PARTS = ['/allocator', '/prng', '/tick'];

function escapeSegment(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

function checkBudget(units: number): void {
  if (units > MAX_UNITS)
    throw new RangeError(
      `[aegis] replay evidence exceeds ${MAX_UNITS} canonical characters. Record a shorter run, or omit detailed evidence.`,
    );
}

/** Only created on opt-in. Static entities and large unchanged resources are retained once. */
export class EvidenceRecorder {
  readonly #values: unknown[] = [];
  readonly #indices = new Map<string, number>();
  readonly #frames: EvidenceFrame[] = [];
  #units = 0;

  #intern(value: unknown): number {
    const text = canonicalStringify(value);
    const existing = this.#indices.get(text);
    if (existing !== undefined) return existing;
    const index = this.#values.length;
    this.#units += text.length;
    checkBudget(this.#units);
    this.#indices.set(text, index);
    this.#values.push(value);
    return index;
  }

  capture(snapshot: WorldSnapshot, events: readonly GameEvent[]): void {
    const state: Record<string, number> = {
      '/allocator': this.#intern(snapshot.allocator),
      '/prng': this.#intern(snapshot.prng),
      '/tick': this.#intern(snapshot.tick),
    };
    for (const [key, value] of Object.entries(snapshot.resources))
      state[`/resources/${escapeSegment(key)}`] = this.#intern(value);
    for (const entity of snapshot.entities) state[`/entities/${entity.id}`] = this.#intern(entity);
    const frame = { state, events };
    this.#units += canonicalStringify(frame).length;
    checkBudget(this.#units);
    this.#frames.push(frame);
  }

  finish(): ReplayEvidence {
    return { format: 'replay-evidence/1', values: this.#values, frames: this.#frames };
  }
}

function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Refuse malformed opt-in pins rather than downgrading a damaged file to hash-only. */
export function parseEvidence(value: unknown, ticks: number): ReplayEvidence {
  const invalid = (path: string): never => {
    throw new Error(`[aegis] invalid recording evidence at evidence.${path}`);
  };
  if (!record(value) || value.format !== 'replay-evidence/1') return invalid('format');
  const { values, frames } = value;
  if (!Array.isArray(values)) return invalid('values');
  if (!Array.isArray(frames) || frames.length !== ticks + 1)
    return invalid('frames (expected bootstrap plus one frame per tick)');
  let units = 0;
  for (const part of values) checkBudget((units += canonicalStringify(part).length));
  for (const [i, f] of frames.entries()) {
    if (!record(f) || !record(f.state) || !Array.isArray(f.events)) return invalid(`frames[${i}]`);
    const state = f.state;
    if (!GLOBAL_PARTS.every((k) => Object.hasOwn(state, k))) return invalid(`frames[${i}].state`);
    for (const [path, index] of Object.entries(f.state)) {
      if (
        (!GLOBAL_PARTS.includes(path) &&
          !/^\/entities\/\d+$/.test(path) &&
          !/^\/resources\/(?:[^~/]|~[01])*$/.test(path)) ||
        typeof index !== 'number' ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= values.length
      )
        return invalid(`frames[${i}].state (invalid path or dictionary reference)`);
    }
    if (
      !f.events.every(
        (e: unknown) =>
          record(e) &&
          typeof e.type === 'string' &&
          Number.isSafeInteger(e.tick) &&
          Number(e.tick) >= 0 &&
          Object.hasOwn(e, 'data'),
      )
    )
      return invalid(`frames[${i}].events`);
    checkBudget((units += canonicalStringify(f).length));
  }
  return { format: 'replay-evidence/1', values, frames };
}

type Preview =
  { value: unknown } | { missing: true } | { preview: string; chars: number; digest: string };
interface FieldDifference {
  path: string;
  pathTruncated: boolean;
  expected: Preview;
  actual: Preview;
}
interface Fields {
  total: number;
  truncated: boolean;
  differences: FieldDifference[];
}
interface EventWindow {
  total: number;
  truncated: boolean;
  entries: { type: string; typeTruncated: boolean; tick: number; data: Preview }[];
}
export type ReplayDetails =
  | {
      status: 'unavailable';
      reason: 'hash-only-recording' | 'replay-not-captured' | 'different-run-length';
    }
  | { status: 'matched' }
  | {
      status: 'diverged';
      tick: number;
      phase: 'initial' | 'step';
      fields: Fields;
      events: {
        firstDifference: number | null;
        offset: number;
        expected: EventWindow;
        actual: EventWindow;
      };
    };

function preview(value: unknown): Preview {
  if (value === undefined) return { missing: true };
  const text = canonicalStringify(value);
  return text.length <= MAX_CHARS
    ? { value }
    : { preview: text.slice(0, MAX_CHARS), chars: text.length, digest: hashString(text) };
}

function unionKeys(a: object, b: object): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
}

function own(obj: Readonly<Record<string, unknown>>, k: string): unknown {
  return Object.hasOwn(obj, k) ? obj[k] : undefined;
}

// Report one change for a whole added/removed/replaced subtree; descend into corresponding
// arrays/objects for exact fields. A missing value is distinct from a present JSON null.
function diff(a: unknown, b: unknown, path: string, fields: Fields): void {
  if (a === b) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff(a[i], b[i], `${path}/${i}`, fields);
  } else if (record(a) && record(b)) {
    for (const k of unionKeys(a, b))
      diff(own(a, k), own(b, k), `${path}/${escapeSegment(k)}`, fields);
  } else {
    fields.total++;
    if (fields.differences.length === MAX_FIELDS) {
      fields.truncated = true;
      return;
    }
    const expected = preview(a);
    const actual = preview(b);
    const pathTruncated = path.length > MAX_CHARS;
    fields.truncated ||= pathTruncated || 'preview' in expected || 'preview' in actual;
    fields.differences.push({ path: path.slice(0, MAX_CHARS), pathTruncated, expected, actual });
  }
}

function eventWindow(events: readonly GameEvent[], offset: number): EventWindow {
  const entries = events.slice(offset, offset + MAX_EVENTS).map((e) => ({
    type: e.type.slice(0, MAX_CHARS),
    typeTruncated: e.type.length > MAX_CHARS,
    tick: e.tick,
    data: preview(e.data),
  }));
  return {
    total: events.length,
    entries,
    truncated:
      events.length !== entries.length ||
      entries.some((e) => e.typeTruncated || 'preview' in e.data),
  };
}

/** Exact comparison, independent of world hashes (which deliberately exclude events). */
export function compareEvidence(
  expected: ReplayEvidence | undefined,
  actual: ReplayEvidence | undefined,
  hashTick?: number,
): ReplayDetails {
  if (!expected) return { status: 'unavailable', reason: 'hash-only-recording' };
  if (!actual) return { status: 'unavailable', reason: 'replay-not-captured' };
  if (actual.frames.length !== expected.frames.length)
    return { status: 'unavailable', reason: 'different-run-length' };
  const before = expected.values.map(canonicalStringify);
  const after = actual.values.map(canonicalStringify);
  for (const [i, a] of expected.frames.entries()) {
    const b = actual.frames[i]!;
    const changed = unionKeys(a.state, b.state).filter(
      (k) => before[a.state[k]!] !== after[b.state[k]!],
    );
    const count = Math.max(a.events.length, b.events.length);
    let firstDifference: number | null = null;
    for (let e = 0; e < count; e++) {
      if (
        !a.events[e] ||
        !b.events[e] ||
        canonicalStringify(a.events[e]) !== canonicalStringify(b.events[e])
      ) {
        firstDifference = e;
        break;
      }
    }
    const hashDiffers = hashTick !== undefined && i === hashTick + 1;
    if (changed.length === 0 && firstDifference === null && !hashDiffers) continue;
    const fields: Fields = { differences: [], total: 0, truncated: false };
    for (const k of changed)
      diff(expected.values[a.state[k]!], actual.values[b.state[k]!], k, fields);
    const offset = firstDifference ?? 0;
    return {
      status: 'diverged',
      tick: Math.max(0, i - 1),
      phase: i === 0 ? 'initial' : 'step',
      fields,
      events: {
        firstDifference,
        offset,
        expected: eventWindow(a.events, offset),
        actual: eventWindow(b.events, offset),
      },
    };
  }
  return { status: 'matched' };
}

export function formatReplayDetails(details: ReplayDetails): string {
  if (details.status === 'unavailable') {
    const fix =
      details.reason === 'hash-only-recording'
        ? 'Record with --explain to pin state fields and events.'
        : 'Replay the original number of steps with captureReplayEvidence: true.';
    return `Detailed comparison unavailable (${details.reason}). ${fix}`;
  }
  if (details.status === 'matched')
    return 'Detailed state and events matched at every recorded step.';
  const { tick, phase, fields, events } = details;
  const lines = [
    `First divergence at tick ${tick} (${phase}); ${fields.total} state difference(s)${fields.truncated ? ' (truncated)' : ''}:`,
  ];
  const show = (v: Preview): string =>
    'missing' in v
      ? '(missing)'
      : 'preview' in v
        ? `${v.preview}… (${v.chars} chars, ${v.digest})`
        : canonicalStringify(v.value);
  for (const d of fields.differences)
    lines.push(
      `  ${d.path}${d.pathTruncated ? '…' : ''}: expected ${show(d.expected)}, actual ${show(d.actual)}`,
    );
  lines.push(
    `Events: ${events.firstDifference === null ? 'matched' : `first difference at index ${events.firstDifference}`}; window starts at ${events.offset}.`,
  );
  for (const side of ['expected', 'actual'] as const) {
    const w = events[side];
    lines.push(
      `  ${side} (${w.total}${w.truncated ? ', truncated' : ''}): ` +
        w.entries
          .map(
            (e) =>
              `${JSON.stringify(e.type)}${e.typeTruncated ? '…' : ''}@${e.tick} ${show(e.data)}`,
          )
          .join(', '),
    );
  }
  return lines.join('\n');
}
