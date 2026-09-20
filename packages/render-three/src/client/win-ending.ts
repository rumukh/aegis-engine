import type { WinEndingSpec } from '../presentation/schema.js';
import type { EndingScene } from '../presentation/ending-scene.js';
import type { AudioState } from './audio.js';

export interface WinEndingState {
  active: boolean;
  phase: 'hidden' | 'playing' | 'shown' | 'restarting';
  seconds: number;
  duration: number;
  paused: boolean;
  reducedMotion: boolean;
}
export interface WinEnding {
  readonly view: EndingScene;
  outcome(value: 'win' | 'lose' | undefined, historical?: boolean): void;
  advance(now: number, paused: boolean): void;
  setReducedMotion(value: boolean): void;
  setAudio(value: AudioState): void;
  reportError(message: string): void;
  state(): WinEndingState;
  dispose(): void;
}

export function createWinEnding(options: {
  spec: WinEndingSpec;
  view: EndingScene;
  canvas: HTMLCanvasElement;
  onGameplayBlocked(blocked: boolean): void;
  onRestart(): void;
  onMute(): void;
  onCue(event: string): void;
  root?: Document;
}): WinEnding {
  const root = options.root ?? document;
  const element = (id: string): HTMLElement => {
    const value = root.getElementById(id);
    if (value === null) throw new Error(`[aegis:ending] Missing required element "${id}".`);
    return value;
  };
  const dialog = element('win-ending');
  const shell = element('game-shell');
  const shade = element('win-shade');
  const card = element('win-card');
  const caption = element('win-caption');
  const error = element('win-error');
  const skip = element('win-skip');
  const pause = element('win-pause');
  const mute = element('win-mute');
  const restart = element('win-restart');
  if (!(dialog instanceof HTMLDialogElement) || !(restart instanceof HTMLButtonElement))
    throw new Error('[aegis:ending] The win ending requires a dialog and restart button.');
  let phase: WinEndingState['phase'] = 'hidden';
  let seconds = 0;
  let paused = false;
  let reducedMotion = false;
  let lastTime: number | undefined;
  let nextCue = 0;
  let disposed = false;
  const freshActivation = new Set<string>();
  const listeners: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, handler: EventListener): void => {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  };
  const active = (): boolean => phase !== 'hidden' && !disposed;
  const setPhase = (value: WinEndingState['phase']): void => {
    phase = value;
    dialog.dataset.phase = value;
  };
  const clearError = (): void => {
    error.textContent = '';
    error.hidden = true;
  };
  const reportError = (message: string): void => {
    if (!active()) return;
    error.textContent = message;
    error.hidden = false;
    if (phase === 'restarting') {
      setPhase('shown');
      restart.disabled = false;
      restart.textContent = 'Play again';
    }
  };
  const finish = (): void => {
    if (phase !== 'playing') return;
    setPhase('shown');
    lastTime = undefined;
    freshActivation.clear();
    nextCue = options.spec.cues?.length ?? 0;
    shade.style.opacity = '1';
    caption.hidden = true;
    card.hidden = false;
    skip.hidden = true;
    pause.hidden = true;
    restart.focus({ preventScroll: true });
  };
  const reset = (): void => {
    if (!active()) return;
    setPhase('hidden');
    lastTime = undefined;
    seconds = 0;
    nextCue = 0;
    paused = false;
    freshActivation.clear();
    clearError();
    delete shell.dataset.ending;
    if (dialog.open) dialog.close();
    options.onGameplayBlocked(false);
    options.canvas.focus({ preventScroll: true });
  };
  const show = (): void => {
    if (active() || disposed) return;
    seconds = 0;
    paused = false;
    nextCue = 0;
    lastTime = undefined;
    freshActivation.clear();
    clearError();
    setPhase('playing');
    shell.dataset.ending = 'win';
    card.hidden = true;
    caption.hidden = true;
    skip.hidden = false;
    pause.hidden = false;
    pause.textContent = 'Pause';
    pause.setAttribute('aria-pressed', 'false');
    restart.disabled = false;
    restart.textContent = 'Play again';
    shade.style.opacity = '0';
    options.view.sample(0);
    options.onGameplayBlocked(true);
    if (root.pointerLockElement !== null) {
      try {
        root.exitPointerLock();
      } catch (cause) {
        reportError(
          `Mouse capture could not be released: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    dialog.showModal();
    if (reducedMotion) finish();
    else skip.focus({ preventScroll: true });
  };
  listen(skip, 'click', finish);
  listen(pause, 'click', () => {
    if (phase !== 'playing') return;
    paused = !paused;
    lastTime = undefined;
    pause.textContent = paused ? 'Resume' : 'Pause';
    pause.setAttribute('aria-pressed', String(paused));
  });
  listen(mute, 'click', options.onMute);
  listen(restart, 'click', () => {
    if (phase !== 'shown' || disposed) return;
    setPhase('restarting');
    restart.disabled = true;
    restart.textContent = 'Restarting...';
    try {
      options.onRestart();
    } catch (cause) {
      reportError(`Restart failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });
  listen(dialog, 'cancel', (event) => {
    event.preventDefault();
    finish();
  });
  listen(dialog, 'keydown', (event) => {
    if (!(event instanceof KeyboardEvent) || !['Space', 'Enter'].includes(event.code)) return;
    if (event.repeat) event.preventDefault();
    else freshActivation.add(event.code);
  });
  listen(dialog, 'keyup', (event) => {
    if (!(event instanceof KeyboardEvent) || !['Space', 'Enter'].includes(event.code)) return;
    if (!freshActivation.delete(event.code)) event.preventDefault();
  });
  listen(root, 'visibilitychange', () => {
    lastTime = undefined;
  });
  listen(root, 'pointerlockchange', () => {
    if (!active() || root.pointerLockElement !== null) return;
    (phase === 'playing' ? skip : restart).focus({ preventScroll: true });
  });
  return {
    view: options.view,
    outcome(value, historical = false): void {
      if (value === 'win') {
        show();
        if (historical) finish();
      } else if (value === undefined) reset();
    },
    advance(now, sessionPaused): void {
      if (phase !== 'playing' || disposed) return;
      if (!Number.isFinite(now))
        throw new Error('[aegis:ending] Display timestamp must be finite.');
      if (sessionPaused || paused || root.hidden) {
        lastTime = undefined;
        return;
      }
      const delta = lastTime === undefined ? 0 : Math.max(0, now - lastTime) / 1000;
      lastTime = now;
      seconds = Math.min(options.view.duration, seconds + delta);
      options.view.sample(seconds);
      const cues = options.spec.cues ?? [];
      while (nextCue < cues.length && cues[nextCue]!.atSeconds <= seconds) {
        const cue = cues[nextCue++]!;
        // A suspended/overloaded display must not burst obsolete speech on its next frame.
        if (seconds - cue.atSeconds <= 0.25) options.onCue(cue.event);
      }
      const line = options.spec.captions?.find(
        (entry) => seconds >= entry.startSeconds && seconds < entry.endSeconds,
      );
      if (caption.textContent !== (line?.text ?? '')) caption.textContent = line?.text ?? '';
      caption.hidden = line === undefined;
      const fade = options.spec.fadeSeconds ?? 1.5;
      shade.style.opacity = String(
        fade === 0 ? 0 : Math.max(0, 1 - (options.view.duration - seconds) / fade),
      );
      if (seconds >= options.view.duration) finish();
    },
    setReducedMotion(value): void {
      reducedMotion = value;
      if (value) finish();
    },
    setAudio(value): void {
      mute.textContent =
        value.status === 'unavailable'
          ? 'Sound unavailable'
          : value.status === 'error'
            ? 'Retry sound'
            : value.status === 'locked'
              ? 'Enable sound'
              : value.muted
                ? 'Unmute'
                : 'Mute';
      if (mute instanceof HTMLButtonElement) mute.disabled = value.status === 'unavailable';
      mute.setAttribute('aria-disabled', String(value.status === 'unavailable'));
      mute.setAttribute('aria-pressed', String(value.muted));
      if (value.error !== undefined) reportError(`Audio: ${value.error}`);
    },
    reportError,
    state: () => ({
      active: active(),
      phase,
      seconds,
      duration: options.view.duration,
      paused,
      reducedMotion,
    }),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      setPhase('hidden');
      for (const remove of listeners) remove();
      if (dialog.open) dialog.close();
      delete shell.dataset.ending;
      options.view.dispose();
    },
  };
}
