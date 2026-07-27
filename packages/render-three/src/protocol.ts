/**
 * The dev server's wire protocol, shared by the Node process and the page.
 *
 * The browser never receives simulation *objects* — only a `WorldSnapshot`, which CHARTER
 * principle 4 already guarantees is plain JSON. The page rebuilds a throwaway `World` from it and
 * renders that. The renderer therefore holds a different world from the simulation and could not
 * write to it even if it tried; non-interference is structural here, not a convention.
 * @packageDocumentation
 */
import type { StateHash, WorldSnapshot } from '@aegis/core';
import type { InputPacket } from './live-input.js';

/** POST body sent once per displayed frame. */
export interface FrameRequest {
  /** The human's input since the previous frame. */
  input: InputPacket;
}

/** One event the simulation emitted, flattened for the HUD feed. */
export interface EventLine {
  /** Event type, e.g. `"switch.activated"`. */
  type: string;
  /** Tick it was emitted on. */
  tick: number;
}

/** The world as the page should draw it. */
export interface FrameResponse {
  /** The tick the snapshot represents. */
  tick: number;
  /** How many fixed steps ran for this frame. */
  steps: number;
  /** Whether the session is paused. */
  paused: boolean;
  /**
   * Deterministic digest of the state in `snapshot`, when the endpoint computes one.
   *
   * `POST /frame` deliberately leaves this **undefined**. Hashing a world walks every component
   * of every entity *and every resource*, and the fps PoC carries a 17.5 KB extruded floorplan as
   * a resource: measured, `world.hash()` costs 11.3ms there (platformer 5.3ms, iso 1.9ms) against
   * 0.55ms to snapshot it and 0.14ms to serialise it. Computing it once per displayed frame put a
   * hard ceiling of ~26 exchanges per second on the fps game — for a value the page never read.
   * The low-frequency `GET /state` and `POST /control` responses still carry it, which is where
   * anything that wants to check the snapshot is lossless should look.
   */
  hash?: StateHash;
  /** The full world state as plain JSON. */
  snapshot: WorldSnapshot;
  /** Events emitted since the previous frame response. */
  events: readonly EventLine[];
}

/** Session commands that are not gameplay input. */
export type ControlCommand = 'pause' | 'resume' | 'toggle' | 'step' | 'restart';

/** POST body for a session control. */
export interface ControlRequest {
  /** What to do. */
  command: ControlCommand;
  /** For `step`: how many fixed ticks to advance. Defaults to `1`. */
  ticks?: number;
}

/** The full recorded event log of a session — read-only, and does not disturb the frame cursor. */
export interface EventLog {
  /** The tick the session has reached. */
  tick: number;
  /** Every event emitted since the session started (or since the last restart). */
  events: readonly EventLine[];
}

/** Everything the page needs to boot, embedded in the served HTML. */
export interface BootConfig {
  /** URL slug of the game. */
  gameId: string;
  /** The mode whose adapter draws it. */
  mode: 'platformer' | 'iso' | 'fps';
  /** Display title. */
  title: string;
  /** What winning looks like. */
  objective: string;
  /** API prefix, e.g. `"/api/iso"`. */
  api: string;
}
