/**
 * Session record & replay (CHARTER principle 5).
 *
 * A {@link Recording} is the complete, portable description of a run: the scene reference,
 * the seed, the tick count, and the input — stored as DSL text so the recording is itself a
 * readable, diffable script. Replaying a recording re-runs the simulation and MUST produce
 * the same final {@link StateHash}; a mismatch is a determinism bug, and the recording pins
 * the expected hash so the harness can assert it.
 * @packageDocumentation
 */
import { notImplemented } from '@aegis/core';
import type { StateHash } from '@aegis/core';

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
  /** The input, as canonical input-script DSL text. */
  input: string;
  /** The final state hash observed when the recording was captured. */
  finalHash: StateHash;
  /** Optional per-tick hashes, enabling pinpointing the first divergent tick on replay. */
  tickHashes?: readonly StateHash[];
}

/** Serialise a recording to canonical JSON text for `*.replay.json`. */
export function serializeRecording(recording: Recording): string {
  return notImplemented('serializeRecording');
}

/** Parse a `*.replay.json` document. */
export function parseRecording(text: string): Recording {
  return notImplemented('parseRecording');
}
