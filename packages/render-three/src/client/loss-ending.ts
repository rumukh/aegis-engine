import type { LossEndingSpec } from '../presentation/schema.js';

export interface LossEndingState {
  active: boolean;
  phase: 'hidden' | 'fading' | 'shown' | 'restarting';
  reducedMotion: boolean;
  fadeSeconds: number;
}

export interface LossEnding {
  outcome(value: 'win' | 'lose' | undefined): void;
  setReducedMotion(value: boolean): void;
  reportError(message: string): void;
  state(): LossEndingState;
  dispose(): void;
}

export function createLossEnding(options: {
  spec: LossEndingSpec;
  canvas: HTMLCanvasElement;
  onGameplayBlocked(blocked: boolean): void;
  onRestart(): void;
  root?: Document;
}): LossEnding {
  const root = options.root ?? document;
  const dialog = root.getElementById('loss-ending');
  const restart = root.getElementById('loss-restart');
  const shade = root.getElementById('loss-shade');
  const error = root.getElementById('loss-error');
  if (
    typeof HTMLDialogElement === 'undefined' ||
    typeof HTMLButtonElement === 'undefined' ||
    !(dialog instanceof HTMLDialogElement) ||
    !(restart instanceof HTMLButtonElement) ||
    shade === null ||
    error === null
  )
    throw new Error(
      '[aegis:ending] The configured loss ending requires its dialog, shade, restart and error elements.',
    );
  const fadeSeconds = options.spec.fadeSeconds ?? 1;
  let active = false;
  let phase: LossEndingState['phase'] = 'hidden';
  let reducedMotion = false;
  let disposed = false;
  let animation: number | undefined;
  const freshActivation = new Set<string>();
  const cancelAnimation = (): void => {
    if (animation !== undefined) globalThis.cancelAnimationFrame(animation);
    animation = undefined;
  };
  const clearError = (): void => {
    error.textContent = '';
    error.hidden = true;
  };
  const setPhase = (value: LossEndingState['phase']): void => {
    phase = value;
    dialog.dataset.phase = value;
  };
  const reportError = (message: string): void => {
    if (!active || disposed) return;
    error.textContent = message;
    error.hidden = false;
    if (phase === 'restarting') {
      setPhase('shown');
      restart.disabled = false;
      restart.textContent = 'Restart';
    }
  };
  const show = (): void => {
    if (active || disposed) return;
    active = true;
    freshActivation.clear();
    clearError();
    restart.disabled = false;
    restart.textContent = 'Restart';
    dialog.style.setProperty('--loss-fade', `${reducedMotion ? 0 : fadeSeconds}s`);
    dialog.dataset.visible = 'false';
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
    restart.focus({ preventScroll: true });
    if (reducedMotion || fadeSeconds === 0) {
      dialog.dataset.visible = 'true';
      setPhase('shown');
    } else {
      setPhase('fading');
      // Establish the starting opacity before changing it; the fade is presentation time only.
      shade.getBoundingClientRect();
      animation = globalThis.requestAnimationFrame(() => {
        animation = undefined;
        if (!active || disposed) return;
        dialog.dataset.visible = 'true';
      });
    }
  };
  const reset = (): void => {
    if (!active || disposed) return;
    cancelAnimation();
    active = false;
    freshActivation.clear();
    dialog.dataset.visible = 'false';
    setPhase('hidden');
    clearError();
    restart.disabled = false;
    restart.textContent = 'Restart';
    if (dialog.open) dialog.close();
    options.onGameplayBlocked(false);
    options.canvas.focus({ preventScroll: true });
  };
  const requestRestart = (): void => {
    if (!active || disposed || phase === 'restarting') return;
    setPhase('restarting');
    restart.disabled = true;
    restart.textContent = 'Restarting...';
    try {
      options.onRestart();
    } catch (cause) {
      reportError(`Restart failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  const cancel = (event: Event): void => event.preventDefault();
  const keyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' && event.code !== 'Enter') return;
    if (event.repeat) event.preventDefault();
    else freshActivation.add(event.code);
  };
  const keyUp = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' && event.code !== 'Enter') return;
    if (!freshActivation.delete(event.code)) event.preventDefault();
  };
  const faded = (event: TransitionEvent): void => {
    if (event.target === shade && event.propertyName === 'opacity' && active && phase === 'fading')
      setPhase('shown');
  };
  const unlocked = (): void => {
    if (active && !disposed && root.pointerLockElement === null && !restart.disabled)
      restart.focus({ preventScroll: true });
  };
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('keydown', keyDown);
  dialog.addEventListener('keyup', keyUp);
  shade.addEventListener('transitionend', faded);
  restart.addEventListener('click', requestRestart);
  root.addEventListener('pointerlockchange', unlocked);
  return {
    outcome(value): void {
      if (value === 'lose') show();
      else if (value === undefined) reset();
    },
    reportError,
    setReducedMotion(value): void {
      reducedMotion = value;
      dialog.style.setProperty('--loss-fade', `${value ? 0 : fadeSeconds}s`);
      if (value && active && phase === 'fading') {
        cancelAnimation();
        dialog.dataset.visible = 'true';
        setPhase('shown');
      }
    },
    state: () => ({ active, phase, reducedMotion, fadeSeconds: reducedMotion ? 0 : fadeSeconds }),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      active = false;
      setPhase('hidden');
      dialog.dataset.visible = 'false';
      cancelAnimation();
      dialog.removeEventListener('cancel', cancel);
      dialog.removeEventListener('keydown', keyDown);
      dialog.removeEventListener('keyup', keyUp);
      shade.removeEventListener('transitionend', faded);
      restart.removeEventListener('click', requestRestart);
      root.removeEventListener('pointerlockchange', unlocked);
      if (dialog.open) dialog.close();
    },
  };
}
