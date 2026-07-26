/**
 * The page's status overlay: tick, run state, the readouts that make each game legible, and a
 * feed of the simulation's own events.
 *
 * Everything shown here is read from the snapshot the page already renders — the HUD is a second
 * consumer of the same world data, never a second source of truth.
 * @packageDocumentation
 */
import type { GameMode, World } from '@aegis/core';
import { Health } from '@aegis/content';
import { Controlled, GridPosition } from '@aegis/mode-iso';
import { PlatformerController } from '@aegis/mode-platformer';
import { FpsCamera, LookState } from '@aegis/mode-fps';
import { Transform } from '@aegis/core';
import type { EventLine } from '../protocol.js';

/** How many event lines the feed keeps. */
const FEED_LENGTH = 8;

/** The overlay's live elements, looked up once. */
export interface Hud {
  /** Update the tick counter and run state. */
  setStatus(tick: number, paused: boolean, fps: number): void;
  /** Update the mode-specific readouts from the rendered world. */
  setStats(mode: GameMode, world: World): void;
  /** Append newly emitted events to the feed. */
  pushEvents(events: readonly EventLine[]): void;
}

/** Attach the HUD to the elements the served page provides. */
export function createHud(root: Document = document): Hud {
  const tickEl = root.getElementById('hud-tick');
  const statusEl = root.getElementById('hud-status');
  const statsEl = root.getElementById('hud-stats');
  const feedEl = root.getElementById('hud-events');
  const feed: string[] = [];

  const set = (element: HTMLElement | null, text: string): void => {
    if (element !== null && element.textContent !== text) element.textContent = text;
  };

  return {
    setStatus(tick: number, paused: boolean, fps: number): void {
      set(tickEl, `tick ${tick}`);
      set(statusEl, paused ? 'paused' : `${Math.round(fps)} fps`);
    },

    setStats(mode: GameMode, world: World): void {
      set(statsEl, statsFor(mode, world));
    },

    pushEvents(events: readonly EventLine[]): void {
      if (events.length === 0 || feedEl === null) return;
      for (const event of events)
        feed.push(`${String(event.tick).padStart(4, ' ')}  ${event.type}`);
      while (feed.length > FEED_LENGTH) feed.shift();
      feedEl.textContent = feed.join('\n');
    },
  };
}

/** The one-line readout that makes each mode legible at a glance. */
function statsFor(mode: GameMode, world: World): string {
  if (mode === 'platformer') {
    const player = world.query({ has: [PlatformerController, Transform] }).first();
    if (player === undefined) return '';
    const position = player.get(Transform).position;
    return `x ${position.x.toFixed(2)}   y ${position.y.toFixed(2)}`;
  }
  if (mode === 'iso') {
    const parts: string[] = [];
    for (const view of world.query({ has: [GridPosition, Health] }).views()) {
      const grid = view.get(GridPosition);
      const health = view.get(Health);
      const label = world.has(view.entity, Controlled) ? 'operative' : 'guard';
      parts.push(`${label} (${grid.cellX},${grid.cellY}) hp ${health.current}/${health.max}`);
    }
    return parts.join('\n');
  }
  const player = world.query({ has: [FpsCamera, LookState, Transform] }).first();
  if (player === undefined) return '';
  const position = player.get(Transform).position;
  const look = player.get(LookState);
  const health = player.tryGet(Health);
  const hp = health === undefined ? '' : `   hp ${health.current}/${health.max}`;
  return (
    `x ${position.x.toFixed(1)}  y ${position.y.toFixed(1)}  z ${position.z.toFixed(1)}\n` +
    `yaw ${look.yawDeg.toFixed(0)}°  pitch ${look.pitchDeg.toFixed(0)}°${hp}`
  );
}
