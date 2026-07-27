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

/**
 * The longest stretch of wall-clock one displayed frame may convert into simulation, in seconds.
 *
 * This is the project's single answer to "how far behind may the simulation fall before we start
 * dropping time?", and it exists as one constant because it used to be two. The dev server capped
 * the elapsed time it handed in at 0.25s while this module capped the steps it would run at 8 —
 * 0.133s at 60Hz — and then **discarded** the difference. Every displayed frame slower than 133ms
 * silently lost simulated time, so a slow picture became a slow *game*: measured on `/play/fps`
 * at ~6.5fps, 42.5 simulated ticks per wall-clock second against a 60Hz simulation.
 *
 * Both the elapsed clamp and the step cap are now derived from this, so they cannot disagree
 * again. `frame-pacing.test.ts` asserts that.
 */
export const MAX_CATCHUP_SECONDS = 0.25;

/** Steps that {@link MAX_CATCHUP_SECONDS} of wall-clock buys at `tickRate`. */
export function maxStepsFor(tickRate: number): number {
  return Math.max(1, Math.ceil(MAX_CATCHUP_SECONDS * tickRate));
}

/** Options for {@link createFixedStepLoop}. */
export interface FixedStepLoopOptions {
  /** Simulation ticks per second. Must be > 0. */
  tickRate: number;
  /**
   * Maximum simulation steps executed for one frame. Caps the "spiral of death" when the host
   * stalls: time beyond this is dropped rather than simulated in a burst. Defaults to
   * {@link maxStepsFor}, i.e. {@link MAX_CATCHUP_SECONDS} at this tick rate.
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
   *
   * The callback receives the tick's index within this frame's batch and the batch size, so a
   * caller can distribute a per-frame quantity (an accumulated mouse-look delta, say) across the
   * ticks it actually covers instead of dumping it all on the first one.
   *
   * Returns how many steps ran (never more than `maxStepsPerFrame`).
   */
  advance(elapsedSeconds: number, step: (index: number, count: number) => void): number;
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
  const maxSteps = options.maxStepsPerFrame ?? maxStepsFor(options.tickRate);
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
    advance(elapsedSeconds: number, step: (index: number, count: number) => void): number {
      if (Number.isFinite(elapsedSeconds) && elapsedSeconds > 0) accumulator += elapsedSeconds;
      // Size the batch before running it, with the identical predicate the drain below uses, so
      // `count` cannot disagree with the number of `step` calls that follow.
      let count = 0;
      for (let remaining = accumulator; remaining >= dt && count < maxSteps; remaining -= dt) {
        count++;
      }
      for (let index = 0; index < count; index++) {
        accumulator -= dt;
        step(index, count);
        steps++;
      }
      // Frames longer than `maxSteps * dt` are dropped, not queued: better to lose a little
      // simulated time than to freeze the page catching up.
      if (accumulator >= dt) accumulator = 0;
      return count;
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
