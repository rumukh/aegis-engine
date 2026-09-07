/**
 * Session record & replay (CHARTER principle 5).
 *
 * A {@link Recording} is the complete, portable description of a run: the scene reference,
 * the seed, the tick count/rate, and the input — stored as DSL text so the recording is itself a
 * readable, diffable script. Replaying a recording re-runs the simulation and MUST produce
 * the same final {@link StateHash}; a mismatch means changed inputs or a determinism bug, and the recording pins
 * the expected hash so the harness can assert it (see {@link "./run".replayRecording}).
 * @packageDocumentation
 */
import type { StateHash } from '@aegis/core';
import { isValidTickRate } from '@aegis/core';
import { asError } from './report.js';

/** A portable, human-readable recording of a run. */
export interface Recording {
  /** Format discriminator and version. */
  readonly aegis: 'recording/1';
  /** Path or logical id of the scene that was run. */
  scene: string;
  /** The seed used. */
  seed: number | string;
  /** Number of ticks simulated. */
  ticks: number;
  /** Fixed ticks per second. New recordings always include this; legacy files omit it (60 Hz). */
  tickRate?: number;
  /** The input, as canonical input-script DSL text. */
  input: string;
  /** The final state hash observed when the recording was captured. */
  finalHash: StateHash;
  /** Optional per-tick hashes, enabling pinpointing the first divergent tick on replay. */
  tickHashes?: readonly StateHash[];
}

/** Read and validate the recorded rate, using the historical 60 Hz default only when absent. */
export function recordingTickRate(recording: { readonly tickRate?: unknown }): number {
  const rate = recording.tickRate === undefined ? 60 : recording.tickRate;
  if (!isValidTickRate(rate)) {
    throw new RangeError(
      `[aegis] recording tickRate must be a finite positive number with a finite timestep, got ${String(rate)}.`,
    );
  }
  return rate;
}

/**
 * Serialise a recording to canonical JSON text for `*.replay.json`.
 *
 * Keys are emitted in a fixed order (not object-insertion order) so two recordings of the
 * same run are byte-identical and diff cleanly in review.
 */
export function serializeRecording(recording: Recording): string {
  const ordered: Record<string, unknown> = {
    aegis: recording.aegis,
    scene: recording.scene,
    seed: recording.seed,
    ticks: recording.ticks,
    ...(recording.tickRate !== undefined ? { tickRate: recordingTickRate(recording) } : {}),
    input: recording.input,
    finalHash: recording.finalHash,
  };
  if (recording.tickHashes && recording.tickHashes.length > 0) {
    ordered.tickHashes = recording.tickHashes;
  }
  return JSON.stringify(ordered, null, 2) + '\n';
}

/** Parse a `*.replay.json` document, validating the format discriminator and required fields. */
export function parseRecording(text: string): Recording {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`[aegis] parseRecording: not valid JSON — ${asError(err).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('[aegis] parseRecording: document root must be a JSON object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.aegis !== 'recording/1') {
    throw new Error(
      `[aegis] parseRecording: unknown format "${String(obj.aegis)}", expected "recording/1".`,
    );
  }
  const require = <T>(key: string, kinds: readonly string[]): T => {
    const value = obj[key];
    if (!kinds.includes(typeof value)) {
      throw new Error(
        `[aegis] parseRecording: field "${key}" must be ${kinds.join(' or ')}, got ${typeof value}.`,
      );
    }
    return value as T;
  };
  const recording: Recording = {
    aegis: 'recording/1',
    scene: require<string>('scene', ['string']),
    seed: require<number | string>('seed', ['number', 'string']),
    ticks: require<number>('ticks', ['number']),
    input: require<string>('input', ['string']),
    finalHash: require<StateHash>('finalHash', ['string']),
  };
  if (obj.tickRate !== undefined) {
    recording.tickRate = recordingTickRate({ tickRate: obj.tickRate });
  }
  if (Array.isArray(obj.tickHashes)) {
    recording.tickHashes = obj.tickHashes.map((h) => String(h));
  }
  return recording;
}
