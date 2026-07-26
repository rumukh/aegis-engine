/**
 * The fixed-timestep accumulator — the **only** place in this package that reads a clock.
 *
 * Real-time play needs wall-clock; determinism forbids it inside the simulation. The accumulator
 * is the standard reconciliation: wall-clock time goes in, a whole number of *fixed* simulation
 * steps comes out, and any leftover time is carried to the next frame. The simulation therefore
 * only ever sees `dt = 1 / tickRate`, exactly as a headless `runScene` does, no matter how
 * irregularly frames arrive (`loop.test.ts` proves the resulting state hash is identical to a
 * fixed-step run driven with jittered frame times).
 *
 * Nothing here touches the world: it counts steps and hands them to a callback.
 * @packageDocumentation
 */

/** Options for {@link createFixedStepLoop}. */
export interface FixedStepLoopOptions {
  /** Simulation ticks per second. Must be > 0. */
  tickRate: number;
  /**
   * Maximum simulation steps executed for one frame. Caps the "spiral of death" when the host
   * stalls: time beyond this is dropped rather than simulated in a burst. Defaults to `8`.
   */
  maxStepsPerFrame?: number;
}

/** A fixed-timestep accumulator. */
export interface FixedStepLoop {
  /** Fixed seconds per simulation step (`1 / tickRate`). */
  readonly dt: number;
  /** Unconsumed time, in seconds, carried to the next frame. */
  readonly pending: number;
  /** Total steps this loop has produced. */
  readonly steps: number;
  /**
   * Advance by `elapsedSeconds` of wall-clock, invoking `step` once per whole fixed tick.
   * Returns how many steps ran (never more than `maxStepsPerFrame`).
   */
  advance(elapsedSeconds: number, step: () => void): number;
  /** Drop any accumulated time — use after a pause so the loop does not catch up in a burst. */
  reset(): void;
}

/** Create a fixed-timestep accumulator. */
export function createFixedStepLoop(options: FixedStepLoopOptions): FixedStepLoop {
  if (!(options.tickRate > 0)) {
    throw new Error(
      `[aegis:render-three] createFixedStepLoop: tickRate must be > 0, got ${options.tickRate}`,
    );
  }
  const dt = 1 / options.tickRate;
  const maxSteps = options.maxStepsPerFrame ?? 8;
  let accumulator = 0;
  let steps = 0;

  const loop: FixedStepLoop = {
    dt,
    get pending() {
      return accumulator;
    },
    get steps() {
      return steps;
    },
    advance(elapsedSeconds: number, step: () => void): number {
      if (Number.isFinite(elapsedSeconds) && elapsedSeconds > 0) accumulator += elapsedSeconds;
      let ran = 0;
      while (accumulator >= dt && ran < maxSteps) {
        accumulator -= dt;
        step();
        ran++;
        steps++;
      }
      // Frames longer than `maxSteps * dt` are dropped, not queued: better to lose a little
      // simulated time than to freeze the page catching up.
      if (accumulator >= dt) accumulator = 0;
      return ran;
    },
    reset(): void {
      accumulator = 0;
    },
  };
  return loop;
}

/** Reads a monotonic wall clock in seconds. Injectable so tests never touch a real clock. */
export type Clock = () => number;

/**
 * The host's monotonic clock, in seconds. This is the single wall-clock read in the package; it
 * exists so the accumulator above can convert real time into fixed simulation steps.
 */
export const systemClock: Clock = () => performance.now() / 1000;
