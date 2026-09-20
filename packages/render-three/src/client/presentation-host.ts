import { Vector3, WebGLRenderer } from 'three';
import { DiagnosticError } from '@aegis/core';
import type { GameMode, World } from '@aegis/core';
import { createRenderAdapter } from '../adapters/index.js';
import type { RenderAdapter } from '../adapter.js';
import type { EventLine } from '../protocol.js';
import { loadPresentationAssets } from '../presentation/assets.js';
import type { PresentationAssets } from '../presentation/assets.js';
import { QUALITY } from '../presentation/schema.js';
import { CinematicPipeline, cinematicSize } from '../presentation/pipeline.js';
import { renderAdapter } from '../render.js';
import { validatePresentationWorld } from '../presentation/world.js';
import type { QualityTier, ResolvedPresentation } from '../presentation/schema.js';
import { createAudio } from './audio.js';
import type { AudioController } from './audio.js';
import { createHud } from './hud.js';
import type { Hud } from './hud.js';
import type { SessionCommand } from './input.js';
import type { InputCaptureState } from './input.js';
import type { FrameInputStatus } from '../frame-clients.js';
import { createInputFeedback } from './input-feedback.js';
import { createLossEnding } from './loss-ending.js';
import type { LossEnding } from './loss-ending.js';
import { EndingScene } from '../presentation/ending-scene.js';
import { createWinEnding } from './win-ending.js';
import type { WinEnding } from './win-ending.js';

export interface PresentationHostOptions {
  canvas: HTMLCanvasElement;
  mode: GameMode;
  presentation?: ResolvedPresentation;
  objective?: string;
  tickRate?: number;
  onCommand(command: SessionCommand): void;
  onGameplayBlocked?(blocked: boolean): void;
}

/** Shared browser-only lifecycle; neither transport gives this host the simulation's world. */
export class PresentationHost {
  readonly #inputFeedback = createInputFeedback();
  readonly renderer: WebGLRenderer;
  readonly hud: Hud;
  readonly ready: Promise<void>;
  readonly #preload: Promise<void>;
  readonly #options: PresentationHostOptions;
  readonly #abort = new AbortController();
  readonly #listeners: (() => void)[] = [];
  #adapter: RenderAdapter | undefined;
  #assets: PresentationAssets | undefined;
  #audio: AudioController | undefined;
  #pipeline: CinematicPipeline | undefined;
  #ending: LossEnding | undefined;
  #winEnding: WinEnding | undefined;
  #tick = 0;
  #paused = false;
  #endingResetPending = false;
  #endingOutcome: 'win' | 'lose' | undefined;
  #endingHistorical = false;
  #hydrating = false;
  #width = 1;
  #height = 1;
  #quality: QualityTier;
  #motionPreference: MediaQueryList | undefined;
  #generation = 0;
  #hydrated = false;
  #historyThrough = -1;
  #events: EventLine[] = [];
  #disposed = false;
  #ready = false;
  #mounted = false;
  #error: string | undefined;
  #resolveReady!: () => void;
  #rejectReady!: (error: unknown) => void;

  constructor(options: PresentationHostOptions) {
    this.#options = options;
    this.ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    void this.ready.catch(() => {
      /* The same failure is rendered and logged by fail(). */
    });
    this.#quality = options.presentation?.manifest.quality ?? 'standard';
    this.hud = createHud(document, {
      ...(options.objective === undefined ? {} : { objective: options.objective }),
      ...(options.presentation?.manifest.hud === undefined
        ? {}
        : { spec: options.presentation.manifest.hud }),
      onOutcome: (outcome) => {
        if (this.#ending === undefined && this.#winEnding === undefined) return;
        if (outcome === undefined) {
          this.#endingResetPending = true;
          this.#endingOutcome = undefined;
        } else if (this.#endingResetPending) {
          this.#endingOutcome = outcome;
          this.#endingHistorical = this.#hydrating;
        } else {
          this.#ending?.outcome(outcome);
          this.#winEnding?.outcome(outcome, this.#hydrating);
        }
      },
    });
    this.hud.setLoading('loading', 'Preparing presentation');
    try {
      this.renderer = new WebGLRenderer({ canvas: options.canvas, antialias: true });
      this.#applyQuality();
    } catch (error) {
      this.hud.setLoading(
        'error',
        `WebGL is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    this.#controls();
    const loss = options.presentation?.manifest.ui?.lossEnding;
    if (loss !== undefined) {
      if (options.onGameplayBlocked === undefined)
        throw new Error(
          '[aegis:ending] Loss presentation requires a gameplay input blocking callback.',
        );
      this.#ending = createLossEnding({
        spec: loss,
        canvas: options.canvas,
        onGameplayBlocked: options.onGameplayBlocked,
        onRestart: () => options.onCommand('restart'),
      });
    }
    if (
      options.presentation?.manifest.ui?.winEnding !== undefined &&
      options.onGameplayBlocked === undefined
    )
      throw new Error(
        '[aegis:ending] Win presentation requires a gameplay input blocking callback.',
      );
    if (options.presentation === undefined) {
      this.#adapter = createRenderAdapter(options.mode);
      this.#applyMotionPreference();
      this.#ready = true;
      this.#preload = Promise.resolve();
    } else {
      this.#preload = this.#load(options.presentation);
      void this.#preload.catch((error: unknown) => this.fail(error));
    }
  }

  get adapter(): RenderAdapter {
    if (this.#adapter === undefined)
      throw new Error(
        '[aegis:render-three] presentation is not ready; await ready before mounting.',
      );
    return this.#adapter;
  }

  start(onReady: () => void): void {
    const start = (): void => {
      if (this.#disposed) return;
      try {
        onReady();
      } catch (error) {
        this.fail(error);
      }
    };
    if (this.#ready) start();
    else
      void this.#preload.then(start, () => {
        /* The readiness failure is already surfaced. */
      });
  }

  async #load(config: ResolvedPresentation): Promise<void> {
    this.#assets = await loadPresentationAssets(config, {
      signal: this.#abort.signal,
      onProgress: (loaded, total) =>
        this.hud.setLoading('loading', `Loading assets ${loaded}/${total}`),
    });
    if (this.#disposed) {
      this.#assets.dispose();
      return;
    }
    this.#adapter = createRenderAdapter(this.#options.mode, {
      presentation: { manifest: config.manifest, assets: this.#assets, quality: this.#quality },
    });
    const win = config.manifest.ui?.winEnding;
    if (win !== undefined) {
      const view = new EndingScene(this.#assets, win);
      try {
        this.#winEnding = createWinEnding({
          spec: win,
          view,
          canvas: this.#options.canvas,
          onGameplayBlocked: this.#options.onGameplayBlocked!,
          onRestart: () => this.#options.onCommand('restart'),
          onMute: () => this.#toggleMute(),
          onCue: (event) =>
            this.#audio?.consume([{ type: event, tick: this.#tick }], this.#generation, this.#tick),
        });
        view.resize(this.#width, this.#height);
      } catch (error) {
        view.dispose();
        throw error;
      }
    }
    if (config.manifest.pipeline !== undefined)
      this.#pipeline = new CinematicPipeline(
        this.renderer,
        this.#adapter,
        config.manifest,
        this.#assets,
        this.#quality,
      );
    this.#applyMotionPreference();
    const assets = this.#assets;
    const adapter = this.#adapter;
    const direction = new Vector3();
    const position = new Vector3();
    const up = new Vector3();
    const runtime = adapter.presentation;
    this.#audio = createAudio({
      ...(config.manifest.audio === undefined ? {} : { spec: config.manifest.audio }),
      readBuffer: (id) => assets.audio(id),
      quality: this.#quality,
      onState: (state) => {
        this.hud.setAudio(state);
        this.#winEnding?.setAudio(state);
        if (state.error !== undefined) this.#ending?.reportError(`Audio: ${state.error}`);
      },
      onCaption: (caption, tick) => this.hud.setCaption(caption, tick),
      ...(runtime === undefined
        ? {}
        : {
            spatial: {
              listener: () => {
                adapter.camera.getWorldPosition(position);
                adapter.camera.getWorldDirection(direction);
                up.set(0, 1, 0).transformDirection(adapter.camera.matrixWorld);
                return {
                  position: position.toArray(),
                  forward: direction.toArray(),
                  up: up.toArray(),
                };
              },
              position: (entity: string) => runtime.state.position(entity),
              matches: (condition: import('../presentation/schema.js').StateCondition) =>
                runtime.state.matches(condition),
            },
          }),
    });
    this.hud.setAudio(this.#audio.state());
    this.#winEnding?.setAudio(this.#audio.state());
    this.#ready = true;
  }

  #listen(target: EventTarget, name: string, listener: EventListener): void {
    target.addEventListener(name, listener);
    this.#listeners.push(() => target.removeEventListener(name, listener));
  }

  #controls(): void {
    if (typeof globalThis.matchMedia === 'function') {
      this.#motionPreference = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
      this.#listen(this.#motionPreference, 'change', () => this.#applyMotionPreference());
    }
    const button = (id: string, click: () => void): void => {
      const element = document.getElementById(id);
      if (element !== null) this.#listen(element, 'click', click);
    };
    button('action-pause', () => this.#options.onCommand('pause'));
    button('action-restart', () => this.#options.onCommand('restart'));
    button('action-retry', () => globalThis.location.reload());
    button('action-mute', () => this.#toggleMute());
    const quality = document.getElementById('quality');
    if (typeof HTMLSelectElement !== 'undefined' && quality instanceof HTMLSelectElement) {
      quality.value = this.#quality;
      this.#listen(quality, 'change', () => {
        if (
          quality.value !== 'low' &&
          quality.value !== 'standard' &&
          quality.value !== 'high' &&
          quality.value !== 'photo'
        )
          return;
        this.#quality = quality.value;
        this.#applyQuality();
        this.#adapter?.presentation?.setQuality(this.#quality);
        this.#audio?.setQuality(this.#quality);
        this.#pipeline?.setQuality(this.#quality);
        this.resize(this.#width, this.#height);
      });
    }
    const debug = document.getElementById('collision-debug');
    if (typeof HTMLInputElement !== 'undefined' && debug instanceof HTMLInputElement)
      this.#listen(debug, 'change', () =>
        this.#adapter?.presentation?.setDebugGeometry(debug.checked),
      );
    const unlock = (event: Event): void => {
      if (!event.isTrusted || this.#audio?.state().status !== 'locked') return;
      void this.#audio.unlock().catch((error: unknown) => this.audioFailure(error));
    };
    this.#listen(this.#options.canvas, 'pointerdown', unlock);
    this.#listen(globalThis, 'keydown', unlock);
  }

  #applyQuality(): void {
    this.renderer.setPixelRatio(
      this.#options.presentation?.manifest.pipeline !== undefined
        ? 1
        : Math.min(globalThis.devicePixelRatio ?? 1, QUALITY[this.#quality].pixelRatio),
    );
  }

  #toggleMute(): void {
    if (this.#audio === undefined) return;
    if (['locked', 'error'].includes(this.#audio.state().status)) {
      void this.#audio.unlock().catch((error: unknown) => this.audioFailure(error));
    } else this.#audio.setMuted(!this.#audio.state().muted);
  }

  #audioPaused(): boolean {
    const ending = this.#winEnding?.state();
    return (
      this.#error !== undefined ||
      this.#paused ||
      (ending?.active === true && (ending.paused || ending.phase !== 'playing' || document.hidden))
    );
  }

  resize(width: number, height: number): void {
    this.#width = width;
    this.#height = height;
    if (this.#pipeline === undefined) this.renderer.setSize(width, height, false);
    else {
      const size = cinematicSize(width, height, globalThis.devicePixelRatio ?? 1, this.#quality);
      this.renderer.setSize(size.width, size.height, false);
      this.#pipeline.resize(size.width, size.height);
    }
    this.#adapter?.resize(width, height);
    this.#winEnding?.view.resize(width, height);
  }

  render(): void {
    this.#audio?.setPaused(this.#audioPaused());
    this.#winEnding?.advance(performance.now(), this.#paused);
    this.#audio?.setPaused(this.#audioPaused());
    const view = this.#winEnding?.state().active ? this.#winEnding.view : this.adapter;
    if (view !== this.adapter) {
      view.scene.environment = this.adapter.scene.environment;
      view.scene.environmentIntensity = this.adapter.scene.environmentIntensity;
    }
    if (this.#pipeline === undefined) renderAdapter(this.renderer, view);
    else this.#pipeline.render(view);
  }

  captureInput(state: InputCaptureState): void {
    this.#inputFeedback.capture(state);
  }
  inputStatus(state: FrameInputStatus): void {
    this.#inputFeedback.transport(state);
  }

  #applyMotionPreference(): void {
    this.#adapter?.presentation?.setReducedMotion(this.#motionPreference?.matches ?? false);
    this.#ending?.setReducedMotion(this.#motionPreference?.matches ?? false);
    this.#winEnding?.setReducedMotion(this.#motionPreference?.matches ?? false);
  }

  receive(events: readonly EventLine[], generation = this.#generation): void {
    if (generation < this.#generation) return;
    if (generation !== this.#generation) this.reset(generation);
    const fresh = events.filter(
      (event) => event.sequence === undefined || event.sequence > this.#historyThrough,
    );
    this.#events.push(...fresh);
    this.hud.pushEvents(fresh);
  }

  hydrate(events: readonly EventLine[], generation: number, tick: number): void {
    if (generation < this.#generation) return;
    if (generation !== this.#generation) this.reset(generation);
    if (this.#hydrated) return;
    const runtime = this.adapter.presentation;
    if (runtime === undefined)
      throw new Error('[aegis] Cannot hydrate event history without a presentation runtime.');
    runtime.hydrate({
      tick,
      generation,
      events,
      paused: false,
      tickRate: this.#options.tickRate ?? 60,
    });
    this.#historyThrough = events.length - 1;
    this.#events = this.#events.filter(
      (event) => event.sequence === undefined || event.sequence > this.#historyThrough,
    );
    this.hud.reset();
    this.#hydrating = true;
    try {
      this.hud.pushEvents(events);
    } finally {
      this.#hydrating = false;
    }
    this.hud.pushEvents(this.#events);
    this.#hydrated = true;
  }

  reset(generation = this.#generation + 1): void {
    this.#generation = generation;
    this.#hydrated = false;
    this.#historyThrough = -1;
    this.#events.length = 0;
    this.hud.reset();
    this.#adapter?.resetPresentation?.();
    this.#audio?.reset(generation);
  }

  present(tick: number, paused: boolean): void {
    this.#tick = tick;
    this.#paused = paused;
    if (this.#endingResetPending) {
      this.#endingResetPending = false;
      this.#ending?.outcome(undefined);
      this.#winEnding?.outcome(undefined);
      if (this.#endingOutcome !== undefined) {
        this.#ending?.outcome(this.#endingOutcome);
        this.#winEnding?.outcome(this.#endingOutcome, this.#endingHistorical);
      }
      this.#endingOutcome = undefined;
      this.#endingHistorical = false;
    }
    const events = this.#events;
    this.#events = [];
    this.#adapter?.present?.({
      tick,
      paused,
      generation: this.#generation,
      tickRate: this.#options.tickRate ?? 60,
      events,
    });
    this.#audio?.setPaused(this.#audioPaused());
    this.#audio?.sync();
    this.#audio?.consume(events, this.#generation, tick);
  }

  mounted(): void {
    if (this.#mounted) return;
    this.#mounted = true;
    this.hud.setLoading('ready', '');
    this.#resolveReady();
  }

  validateWorld(world: World): void {
    if (this.#options.presentation === undefined) return;
    const result = validatePresentationWorld(this.#options.presentation.manifest, world);
    if (!result.ok) throw new DiagnosticError(result.diagnostics);
  }

  connection(error?: unknown): void {
    if (this.#error !== undefined) return;
    if (error !== undefined) {
      this.#ending?.reportError(
        `Connection interrupted: ${error instanceof Error ? error.message : String(error)}. Retrying.`,
      );
      this.#winEnding?.reportError(
        `Connection interrupted: ${error instanceof Error ? error.message : String(error)}. Retrying.`,
      );
    }
    this.hud.setLoading(
      error === undefined ? 'ready' : 'reconnecting',
      error === undefined
        ? ''
        : `Connection interrupted: ${error instanceof Error ? error.message : String(error)}. Retrying.`,
    );
  }

  audioFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#ending?.reportError(`Audio: ${message}`);
    this.#winEnding?.reportError(`Audio: ${message}`);
    this.hud.setAudio({
      status: 'error',
      muted: this.#audio?.state().muted ?? false,
      error: message,
    });
    console.error('[aegis:audio]', error);
  }

  fail(error: unknown): void {
    this.#error =
      error instanceof DiagnosticError
        ? error.diagnostics
            .map(
              (diagnostic) =>
                `${diagnostic.code}: ${diagnostic.message}${diagnostic.location?.path === undefined ? '' : `\n${diagnostic.location.path}`}${diagnostic.fix === undefined ? '' : `\n${diagnostic.fix}`}`,
            )
            .join('\n\n')
        : error instanceof Error
          ? error.message
          : String(error);
    this.hud.setLoading('error', this.#error);
    this.#ending?.reportError(this.#error);
    this.#winEnding?.reportError(this.#error);
    console.error('[aegis:presentation]', error);
    this.#audio?.setPaused(true);
    this.#rejectReady(error);
  }

  stats(): object {
    return {
      status: this.#disposed
        ? 'disposed'
        : this.#error !== undefined
          ? 'error'
          : this.#mounted
            ? 'ready'
            : 'loading',
      ...(this.#error === undefined ? {} : { error: this.#error }),
      quality: this.#quality,
      generation: this.#generation,
      assets: this.#assets?.stats(),
      render: this.#adapter?.presentation?.stats(),
      audio: this.#audio?.state(),
      input: this.#inputFeedback.state(),
      ...(this.#ending === undefined ? {} : { ending: this.#ending.state() }),
      ...(this.#winEnding === undefined ? {} : { winEnding: this.#winEnding.state() }),
      pipeline: this.#pipeline?.stats(),
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (!this.#mounted)
      this.#rejectReady(new Error('[aegis:presentation] disposed before the first frame mounted.'));
    const errors: unknown[] = [];
    const releases = [
      () => this.#abort.abort(),
      ...this.#listeners,
      () => this.#audio?.dispose(),
      () => this.#ending?.dispose(),
      () => this.#winEnding?.dispose(),
      () => this.#pipeline?.dispose(),
      () => this.#adapter?.dispose(),
      () => this.#assets?.dispose(),
      () => this.renderer.dispose(),
      () => this.renderer.forceContextLoss(),
    ];
    for (const release of releases) {
      try {
        release();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#listeners.length = 0;
    this.#events.length = 0;
    if (errors.length > 0) throw new AggregateError(errors, 'Presentation disposal failed.');
  }
}
