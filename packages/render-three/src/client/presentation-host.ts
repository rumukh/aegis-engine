import { WebGLRenderer } from 'three';
import { DiagnosticError } from '@aegis/core';
import type { GameMode, World } from '@aegis/core';
import { createRenderAdapter } from '../adapters/index.js';
import type { RenderAdapter } from '../adapter.js';
import type { EventLine } from '../protocol.js';
import { loadPresentationAssets } from '../presentation/assets.js';
import type { PresentationAssets } from '../presentation/assets.js';
import { QUALITY } from '../presentation/schema.js';
import { validatePresentationWorld } from '../presentation/world.js';
import type { QualityTier, ResolvedPresentation } from '../presentation/schema.js';
import { createAudio } from './audio.js';
import type { AudioController } from './audio.js';
import { createHud } from './hud.js';
import type { Hud } from './hud.js';
import type { SessionCommand } from './input.js';

export interface PresentationHostOptions {
  canvas: HTMLCanvasElement;
  mode: GameMode;
  presentation?: ResolvedPresentation;
  objective?: string;
  tickRate?: number;
  onCommand(command: SessionCommand): void;
}

/** Shared browser-only lifecycle; neither transport gives this host the simulation's world. */
export class PresentationHost {
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
  #quality: QualityTier;
  #motionPreference: MediaQueryList | undefined;
  #generation = 0;
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
    this.#applyMotionPreference();
    const assets = this.#assets;
    this.#audio = createAudio({
      ...(config.manifest.audio === undefined ? {} : { spec: config.manifest.audio }),
      readBuffer: (id) => assets.audio(id),
      quality: this.#quality,
      onState: (state) => this.hud.setAudio(state),
    });
    this.hud.setAudio(this.#audio.state());
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
    button('action-mute', () => {
      if (this.#audio === undefined) return;
      if (['locked', 'error'].includes(this.#audio.state().status)) {
        void this.#audio.unlock().catch((error: unknown) => this.audioFailure(error));
      } else this.#audio.setMuted(!this.#audio.state().muted);
    });
    const quality = document.getElementById('quality');
    if (typeof HTMLSelectElement !== 'undefined' && quality instanceof HTMLSelectElement) {
      quality.value = this.#quality;
      this.#listen(quality, 'change', () => {
        if (quality.value !== 'low' && quality.value !== 'standard') return;
        this.#quality = quality.value;
        this.#applyQuality();
        this.#adapter?.presentation?.setQuality(this.#quality);
        this.#audio?.setQuality(this.#quality);
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
      Math.min(globalThis.devicePixelRatio ?? 1, QUALITY[this.#quality].pixelRatio),
    );
  }

  #applyMotionPreference(): void {
    this.#adapter?.presentation?.setReducedMotion(this.#motionPreference?.matches ?? false);
  }

  receive(events: readonly EventLine[], generation = this.#generation): void {
    if (generation < this.#generation) return;
    if (generation !== this.#generation) this.reset(generation);
    this.#events.push(...events);
    this.hud.pushEvents(events);
  }

  reset(generation = this.#generation + 1): void {
    this.#generation = generation;
    this.#events.length = 0;
    this.hud.reset();
    this.#adapter?.resetPresentation?.();
    this.#audio?.reset(generation);
  }

  present(tick: number, paused: boolean): void {
    const events = this.#events;
    this.#events = [];
    this.#adapter?.present?.({
      tick,
      paused,
      generation: this.#generation,
      tickRate: this.#options.tickRate ?? 60,
      events,
    });
    this.#audio?.setPaused(paused);
    this.#audio?.consume(events, this.#generation, tick);
  }

  mounted(): void {
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
    this.hud.setLoading(
      error === undefined ? 'ready' : 'reconnecting',
      error === undefined
        ? ''
        : `Connection interrupted: ${error instanceof Error ? error.message : String(error)}. Retrying.`,
    );
  }

  audioFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
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
      () => this.#adapter?.dispose(),
      () => this.#assets?.dispose(),
      () => this.renderer.dispose(),
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
