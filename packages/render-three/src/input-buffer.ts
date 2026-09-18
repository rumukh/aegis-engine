import type { PointerInput } from '@aegis/core';
import type { InputPacket } from './live-input.js';

/** One device's current logical levels, not simulation-tick edges. */
export interface InputLevels {
  held?: readonly string[];
  axes?: Readonly<Record<string, number>>;
}

/** Compose device ownership before deriving edges; drain once per transport/display frame. */
export interface InputBuffer {
  /** Replace this source's levels. Other sources keep ownership of their held actions. */
  setSource(id: string, levels: InputLevels): void;
  /** Release only this source's input. */
  removeSource(id: string): void;
  /** Accumulate relative degrees, already integrated over elapsed display time. */
  addLook(dx: number, dy: number): void;
  /** Queue the latest logical pointer sample for one tick. */
  setPointer(pointer: PointerInput): void;
  /** Drain edges/deltas, retaining levels. Sequence numbers survive clear(). */
  take(): InputPacket;
  /** Drop all ownership and pending impulses, e.g. at a gameplay/UI context boundary. */
  clear(options?: { releaseHeld?: boolean }): void;
}

/** Hardware normalization, not simulation arithmetic. Invalid samples are neutral. */
export function boundedAxis(value: number): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

export function createInputBuffer(): InputBuffer {
  const sources = new Map<string, { held: Set<string>; axes: Record<string, number> }>();
  let held = new Set<string>();
  const pressed = new Set<string>();
  const released = new Set<string>();
  let look = { dx: 0, dy: 0 };
  let pointer: PointerInput | null = null;
  let seq = 0;
  let reset = false;

  const reconcile = (): void => {
    const next = new Set([...sources.values()].flatMap((source) => [...source.held]));
    for (const action of next) if (!held.has(action)) pressed.add(action);
    for (const action of held) if (!next.has(action)) released.add(action);
    held = next;
  };

  return {
    setSource(id, levels): void {
      sources.set(id, {
        held: new Set(levels.held),
        axes: Object.fromEntries(
          Object.entries(levels.axes ?? {}).map(([name, value]) => [name, boundedAxis(value)]),
        ),
      });
      reconcile();
    },
    removeSource(id): void {
      sources.delete(id);
      reconcile();
    },
    addLook(dx, dy): void {
      if (!Number.isFinite(dx) || !Number.isFinite(dy))
        throw new Error('[aegis:input] look deltas must be finite degrees');
      look.dx += dx;
      look.dy += dy;
    },
    setPointer(value): void {
      pointer = {
        ...value,
        screen: { ...value.screen },
        world: value.world === null ? null : { ...value.world },
        buttons: [...value.buttons],
      };
    },
    take(): InputPacket {
      const summed = new Map<string, number>();
      for (const source of sources.values()) {
        for (const [name, value] of Object.entries(source.axes)) {
          summed.set(name, (summed.get(name) ?? 0) + value);
        }
      }
      const axes = Object.fromEntries(
        [...summed].map(([name, value]) => [name, boundedAxis(value)]),
      );
      const packet: InputPacket = {
        seq: ++seq,
        ...(reset ? { reset: true } : {}),
        held: [...held],
        pressed: [...pressed],
        released: [...released],
        axes,
        look,
        pointer,
      };
      pressed.clear();
      released.clear();
      look = { dx: 0, dy: 0 };
      pointer = null;
      reset = false;
      return packet;
    },
    clear(options): void {
      const previous = new Set([...held, ...released]);
      sources.clear();
      held.clear();
      pressed.clear();
      released.clear();
      if (options?.releaseHeld === true) for (const action of previous) released.add(action);
      look = { dx: 0, dy: 0 };
      pointer = null;
      reset = true;
    },
  };
}
