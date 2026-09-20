/**
 * The page's status overlay: tick, run state, the readouts that make each game legible, and a
 * feed of the simulation's own events.
 *
 * Everything shown here is read from the snapshot the page already renders — the HUD is a second
 * consumer of the same world data, never a second source of truth.
 * @packageDocumentation
 */
import type { EntityView, GameMode, World } from '@aegis/core';
import { Health } from '@aegis/content';
import { Controlled, GridPosition } from '@aegis/mode-iso';
import { PlatformerController } from '@aegis/mode-platformer';
import { FpsCamera, LookState } from '@aegis/mode-fps';
import { Name, Transform } from '@aegis/core';
import type { EventLine } from '../protocol.js';
import type { CaptionSpec, HudSpec } from '../presentation/schema.js';
import { PresentationState } from '../presentation/state.js';

/** How many event lines the feed keeps. */
const FEED_LENGTH = 8;

export interface HudOptions {
  spec?: HudSpec;
  objective?: string;
  onOutcome?(outcome: 'win' | 'lose' | undefined): void;
}

/** The overlay's live elements, looked up once. */
export interface Hud {
  /** Update the tick counter and run state. */
  setStatus(tick: number, paused: boolean, fps: number): void;
  /** Update the mode-specific readouts from the rendered world. */
  setStats(mode: GameMode, world: World): void;
  /** Append newly emitted events to the feed. */
  pushEvents(events: readonly EventLine[]): void;
  /** Clear run-local readouts without changing session pause or audio/quality preferences. */
  reset(): void;
  setLoading(state: 'loading' | 'ready' | 'error' | 'reconnecting', message: string): void;
  setAudio(state: { status: string; muted: boolean; error?: string }): void;
  setCaption(caption: CaptionSpec, tick: number): void;
}

/** Attach the HUD to the elements the served page provides. */
export function createHud(root: Document = document, options: HudOptions = {}): Hud {
  const tickEl = root.getElementById('hud-tick');
  const statusEl = root.getElementById('hud-status');
  const statsEl = root.getElementById('hud-stats');
  const feedEl = root.getElementById('hud-events');
  const objectiveEl = root.getElementById('hud-objective');
  const promptEl = root.getElementById('hud-prompt');
  const subtitleEl = root.getElementById('hud-subtitle');
  const threatEl = root.getElementById('hud-narrative-status');
  const healthEl = root.getElementById('hud-health');
  const healthBar = root.getElementById('hud-health-bar');
  const healthReadout = root.getElementById('health-readout');
  const progressEl = root.getElementById('hud-progress');
  const outcomeEl = root.getElementById('hud-outcome');
  const pauseButton = root.getElementById('action-pause');
  const restartButton = root.getElementById('action-restart');
  const muteButton = root.getElementById('action-mute');
  const audioEl = root.getElementById('hud-audio');
  const sessionMenu = root.getElementById('session-menu');
  const loadingPanel = root.getElementById('loading-panel');
  const loadingTitle = root.getElementById('loading-title');
  const loadingMessage = root.getElementById('loading-message');
  const retryButton = root.getElementById('action-retry');
  const stage = root.getElementById('stage');
  const objective = options.objective ?? objectiveEl?.textContent ?? '';
  const steps = (options.spec?.steps ?? []).map((step, index) => ({
    ...step,
    element: root.getElementById(`hud-step-${index}`),
  }));
  const completed = new Set<string>();
  const feed: string[] = [];
  let outcome: 'win' | 'lose' | undefined;
  let lastSequence = -1;
  let caption: { text: string; until: number } | undefined;

  const set = (element: HTMLElement | null, text: string): void => {
    if (element !== null && element.textContent !== text) element.textContent = text;
  };
  const attribute = (element: HTMLElement | null, name: string, value: string): void => {
    if (element !== null && element.getAttribute?.(name) !== value)
      element.setAttribute?.(name, value);
  };
  const hidden = (element: HTMLElement | null, value: boolean): void => {
    if (element !== null && element.hidden !== value) element.hidden = value;
  };
  const disabled = (element: HTMLElement | null, value: boolean): void => {
    attribute(element, 'aria-disabled', String(value));
    if (element !== null && 'disabled' in element && element.disabled !== value)
      element.disabled = value;
  };
  const progress = (): void => {
    set(progressEl, steps.length === 0 ? '' : `${completed.size} / ${steps.length} complete`);
    hidden(progressEl, steps.length === 0);
    for (const step of steps) {
      const done = completed.has(step.id);
      set(step.element, `${done ? '✓ ' : ''}${step.label}`);
      attribute(step.element, 'data-complete', String(done));
    }
  };
  const pause = (paused: boolean): void => {
    set(pauseButton, paused ? 'Resume' : 'Pause');
    attribute(pauseButton, 'aria-pressed', String(paused));
    attribute(pauseButton, 'aria-label', paused ? 'Resume game' : 'Pause game');
  };
  set(objectiveEl, objective);
  progress();

  return {
    setStatus(tick: number, paused: boolean, fps: number): void {
      set(tickEl, `tick ${tick}`);
      set(statusEl, paused ? 'paused' : `${Math.round(fps)} fps`);
      pause(paused);
    },

    setStats(mode: GameMode, world: World): void {
      set(statsEl, statsFor(mode, world));
      const health = hudPlayer(mode, world, options.spec?.playerName)?.tryGet(Health);
      set(healthEl, health === undefined ? '—' : `${health.current} / ${health.max}`);
      hidden(healthReadout, health === undefined);
      if (health !== undefined) {
        attribute(healthBar, 'max', String(Math.max(1, health.max)));
        attribute(healthBar, 'value', String(Math.max(0, Math.min(health.current, health.max))));
        attribute(healthBar, 'aria-valuetext', `${health.current} of ${health.max} health`);
      }
      const bindings = options.spec?.bindings;
      let subtitle = caption !== undefined && world.tick < caption.until ? caption.text : '';
      if (bindings !== undefined) {
        const state = new PresentationState(mode);
        state.sync(world);
        for (const [field, element] of [
          ['objective', objectiveEl],
          ['prompt', promptEl],
          ['status', threatEl],
        ] as const) {
          const binding = bindings[field];
          if (binding === undefined) continue;
          const value = state.read(binding);
          if (typeof value !== 'string')
            throw new Error(`[aegis:hud] ${field} binding must resolve to a string.`);
          set(element, value);
          hidden(element, value === '');
        }
        if (bindings.subtitle !== undefined) {
          const text = state.read(bindings.subtitle);
          const until =
            bindings.subtitleUntil === undefined ? Infinity : state.read(bindings.subtitleUntil);
          if (typeof text !== 'string' || typeof until !== 'number')
            throw new Error('[aegis:hud] subtitle must be a string and subtitleUntil a number.');
          if (text !== '' && world.tick < until) subtitle = text;
        }
      }
      set(subtitleEl, subtitle);
      hidden(subtitleEl, subtitle === '');
    },

    pushEvents(events: readonly EventLine[]): void {
      if (events.length === 0) return;
      const previousSequence = lastSequence;
      const batch = new Set<number>();
      const previousOutcome = outcome;
      for (const event of events) {
        if (event.sequence !== undefined) {
          if (event.sequence <= previousSequence || batch.has(event.sequence)) continue;
          batch.add(event.sequence);
          lastSequence = Math.max(lastSequence, event.sequence);
        }
        feed.push(`${String(event.tick).padStart(4, ' ')}  ${event.type}`);
        for (const step of steps) {
          if (step.event === event.type) completed.add(step.id);
        }
        if (outcome === undefined && options.spec !== undefined) {
          if (event.type === options.spec.winEvent) outcome = 'win';
          else if (options.spec.loseEvents.includes(event.type)) outcome = 'lose';
        }
      }
      while (feed.length > FEED_LENGTH) feed.shift();
      set(feedEl, feed.join('\n'));
      progress();
      if (outcome !== undefined) {
        set(outcomeEl, outcome === 'win' ? 'Objective complete' : 'Run ended · try again');
        attribute(outcomeEl, 'data-outcome', outcome);
        hidden(outcomeEl, false);
      }
      if (outcome !== previousOutcome) options.onOutcome?.(outcome);
    },

    reset(): void {
      feed.length = 0;
      completed.clear();
      outcome = undefined;
      lastSequence = -1;
      caption = undefined;
      for (const element of [promptEl, subtitleEl, threatEl]) {
        set(element, '');
        hidden(element, true);
      }
      set(tickEl, 'tick 0');
      set(statusEl, 'starting…');
      set(statsEl, '');
      set(feedEl, '');
      set(objectiveEl, objective);
      set(healthEl, '—');
      hidden(healthReadout, true);
      set(outcomeEl, '');
      attribute(outcomeEl, 'data-outcome', '');
      hidden(outcomeEl, true);
      progress();
      options.onOutcome?.(undefined);
    },

    setLoading(state, message): void {
      disabled(pauseButton, state === 'loading' || state === 'error');
      disabled(restartButton, state === 'loading' || state === 'error');
      set(loadingMessage, message);
      set(
        loadingTitle,
        state === 'error'
          ? 'Unable to start'
          : state === 'reconnecting'
            ? 'Reconnecting'
            : state === 'ready'
              ? 'Ready'
              : 'Getting ready',
      );
      attribute(loadingPanel, 'data-state', state);
      attribute(stage, 'aria-busy', String(state === 'loading' || state === 'reconnecting'));
      hidden(retryButton, state !== 'error' && state !== 'reconnecting');
      hidden(loadingPanel, state === 'ready');
    },

    setAudio(state): void {
      const unavailable = state.status === 'unavailable';
      const locked = state.status === 'locked';
      const failed = state.status === 'error';
      if (failed && sessionMenu !== null && 'open' in sessionMenu) sessionMenu.open = true;
      set(
        audioEl,
        state.error ??
          (unavailable
            ? 'Sound unavailable'
            : locked
              ? 'Sound needs a gesture'
              : state.muted
                ? 'Sound muted'
                : 'Sound on'),
      );
      set(
        muteButton,
        unavailable
          ? 'Sound unavailable'
          : failed
            ? 'Retry sound'
            : locked
              ? 'Enable sound'
              : state.muted
                ? 'Unmute'
                : 'Mute',
      );
      attribute(muteButton, 'aria-pressed', String(state.muted));
      disabled(muteButton, unavailable);
      attribute(audioEl, 'data-status', state.status);
    },
    setCaption(value, tick): void {
      caption = {
        text: value.speaker === undefined ? value.text : `${value.speaker}: ${value.text}`,
        until: tick + (value.durationTicks ?? 240),
      };
      set(subtitleEl, caption.text);
      hidden(subtitleEl, false);
    },
  };
}

function hudPlayer(mode: GameMode, world: World, name?: string): EntityView | undefined {
  if (name !== undefined) {
    for (const view of world.query({ has: [Name] }).views()) {
      if (view.get(Name).value === name) return view;
    }
    return undefined;
  }
  if (mode === 'platformer') return world.query({ has: [PlatformerController] }).first();
  if (mode === 'iso') return world.query({ has: [Controlled] }).first();
  return world.query({ has: [FpsCamera] }).first();
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
