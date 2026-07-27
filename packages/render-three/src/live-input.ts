/**
 * Live input: turning a human's keyboard and mouse into the very same logical
 * {@link InputFrame}s the `.input` DSL compiles to.
 *
 * The simulation has no keys (see `@aegis/core/input`): it reads actions (`Jump`, `Fire`), axes
 * (`MoveX`, `Forward`, `Strafe`), a relative look delta in degrees, and an optional pointer. A
 * script produces those frames; so does this. That means a human drives a game through exactly
 * the same path a scripted playthrough does — there is no second, privileged input route.
 *
 * Edges matter: a `pressed` action must be true on exactly one tick no matter how many frames the
 * browser sent in between, and a fast mouse flick must not lose degrees. So the browser reports
 * *level* state (held actions, axes) plus *accumulated* edges and look deltas, and this drains the
 * accumulated part into the next tick.
 * @packageDocumentation
 */
import { EMPTY_INPUT_FRAME } from '@aegis/core';
import type { InputFrame, InputSource, PointerInput } from '@aegis/core';

/** One report from the browser, coalesced over a display frame. */
export interface InputPacket {
  /** Monotonic counter; stale packets that arrive out of order are ignored. */
  seq: number;
  /** Logical actions currently held down. */
  held?: readonly string[];
  /** Actions whose press edge happened since the last packet. */
  pressed?: readonly string[];
  /** Actions whose release edge happened since the last packet. */
  released?: readonly string[];
  /** Analog axes, `name -> value` (conventionally `[-1, 1]`). */
  axes?: Readonly<Record<string, number>>;
  /** Accumulated look delta in degrees since the last packet. */
  look?: { dx: number; dy: number };
  /** A pointer sample; delivered to exactly one tick. */
  pointer?: PointerInput | null;
}

/** A live, human-driven {@link InputSource}. */
export interface LiveInput extends InputSource {
  /** Merge a browser report into the pending input state. Returns `false` for a stale packet. */
  submit(packet: InputPacket): boolean;
  /** Build (and consume the edges of) the frame for `tick`. */
  frameFor(tick: number): InputFrame;
  /**
   * Declare that the next `steps` frames all belong to one displayed frame, so the look delta
   * accumulated for it is handed out in equal shares instead of landing entirely on the first
   * tick.
   *
   * A displayed frame covers however many simulation ticks the wall clock earned — 1 on a fast
   * machine, up to the accumulator's cap on a slow one. Draining the whole accumulated mouse
   * delta into the first tick and then running the rest with zero look makes the camera lurch
   * once per displayed frame, and `fps.look` clamps pitch to `±maxPitchDeg` **per tick**, so a
   * single large lump silently loses everything past the clamp while fifteen small ones do not.
   * Same total rotation, same determinism (the batch is drained synchronously, so nothing new
   * can arrive mid-batch), and the human gets a camera that tracks their hand.
   *
   * Edges (`pressed`/`released`) and the pointer sample are deliberately **not** spread: they are
   * impulses and must land on exactly one tick.
   */
  spreadLookOver(steps: number): void;
  /** Drop all held state and pending edges — used on pause and restart. */
  clear(): void;
  /** The highest packet sequence accepted so far. */
  readonly lastSeq: number;
}

/** Append the members of `source` to `target`, skipping duplicates. */
function pushUnique(target: string[], source: readonly string[] | undefined): void {
  if (source === undefined) return;
  for (const value of source) if (!target.includes(value)) target.push(value);
}

/** Create a live input source fed by {@link InputPacket}s from a browser. */
export function createLiveInput(): LiveInput {
  let held: string[] = [];
  let axes: Record<string, number> = {};
  let pendingPressed: string[] = [];
  let pendingReleased: string[] = [];
  let lookDx = 0;
  let lookDy = 0;
  let pendingPointer: PointerInput | null = null;
  let lastSeq = -1;
  /** Frames left in the current displayed-frame batch; `<= 1` means "hand over everything". */
  let lookShares = 0;

  const live: LiveInput = {
    get lastSeq() {
      return lastSeq;
    },

    submit(packet: InputPacket): boolean {
      if (packet.seq <= lastSeq) return false;
      lastSeq = packet.seq;
      if (packet.held !== undefined) held = [...packet.held];
      if (packet.axes !== undefined) axes = { ...packet.axes };
      pushUnique(pendingPressed, packet.pressed);
      pushUnique(pendingReleased, packet.released);
      if (packet.look !== undefined) {
        lookDx += packet.look.dx;
        lookDy += packet.look.dy;
      }
      if (packet.pointer !== undefined && packet.pointer !== null) pendingPointer = packet.pointer;
      return true;
    },

    spreadLookOver(steps: number): void {
      lookShares = Number.isFinite(steps) && steps > 1 ? Math.floor(steps) : 0;
    },

    frameFor(tick: number): InputFrame {
      const pressed = pendingPressed;
      const released = pendingReleased;
      pendingPressed = [];
      pendingReleased = [];
      // Take this tick's share and leave the rest. Taking `1/n`, then `1/(n-1)` of what is left,
      // and so on, hands out equal shares and drains to exactly zero on the last tick — so the
      // total rotation is the same whether or not the batch was spread.
      const share = lookShares > 1 ? 1 / lookShares : 1;
      const look = { dx: lookDx * share, dy: lookDy * share };
      lookDx -= look.dx;
      lookDy -= look.dy;
      if (lookShares > 0) lookShares--;
      const pointer = pendingPointer;
      pendingPointer = null;

      // A tap that started and ended inside one display frame still has to read as "held" for
      // the tick it lands on, or a 60 Hz press would be invisible to a 60 Hz simulation.
      const actions: Record<string, boolean> = {};
      for (const action of held) actions[action] = true;
      for (const action of pressed) actions[action] = true;

      const frame: InputFrame = {
        ...EMPTY_INPUT_FRAME,
        tick,
        actions,
        pressed,
        released,
        axes: { ...axes },
        look,
        pointer,
      };
      return frame;
    },

    clear(): void {
      held = [];
      axes = {};
      pendingPressed = [];
      pendingReleased = [];
      lookDx = 0;
      lookDy = 0;
      lookShares = 0;
      pendingPointer = null;
    },
  };
  return live;
}
