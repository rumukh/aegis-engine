import {
  Color,
  DirectionalLight,
  HemisphereLight,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DiagnosticError } from '@aegis/core';
import { loadPresentationAssets } from '../presentation/assets.js';
import type { PresentationAssets } from '../presentation/assets.js';
import { CinematicPipeline, cinematicSize } from '../presentation/pipeline.js';
import type {
  PreviewCamera,
  PreviewDocument,
  PreviewFrame,
  PreviewRecipe,
  PreviewServerState,
  PreviewSettings,
  PreviewStats,
  PreviewStudioState,
  PreviewView,
} from './types.js';
import { PreviewCode, previewDiagnostics, previewError } from './diagnostics.js';
import { captureDimensions, validatePreviewSettings } from './settings.js';
import { assetBounds, meshStats, PreviewSubject, tuple } from './subject.js';

interface LoadedSubject {
  document: PreviewDocument;
  assets: PresentationAssets;
  subject: PreviewSubject;
  loadMs: number;
}

const DIRECTIONS: Record<PreviewView, readonly [number, number, number]> = {
  'three-quarter': [1, 0.65, 1.4],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0.0001],
};

/** A Three scene containing exactly one asset specimen. It has no world, host, or mode. */
export class AssetPreviewStudio {
  readonly #scene = new Scene();
  readonly #renderer: WebGLRenderer;
  readonly #canvas: HTMLCanvasElement;
  readonly #onChange: (state: PreviewStudioState) => void;
  readonly #hemisphere = new HemisphereLight('#dceaff', '#69717c', 2);
  readonly #key = new DirectionalLight('#ffffff', 3);
  readonly #rim = new DirectionalLight('#aacbff', 1.5);
  readonly #reducedMotion: MediaQueryList;
  readonly #resize: ResizeObserver;
  #camera: PerspectiveCamera | OrthographicCamera = new PerspectiveCamera(40, 1, 0.01, 1000);
  #controls: OrbitControls;
  #loaded?: LoadedSubject;
  #pending?: LoadedSubject;
  #pipeline?: CinematicPipeline;
  #controller?: AbortController;
  #revision = 0;
  #serverStatus?: PreviewServerState['status'];
  #accepting: Promise<void> = Promise.resolve();
  #lastGood: number | null = null;
  #status: PreviewStudioState['status'] = 'loading';
  #diagnostics: PreviewStudioState['diagnostics'] = [];
  #settings: Required<Omit<PreviewSettings, 'camera'>> & Pick<PreviewSettings, 'camera'>;
  #animation?: number;
  #lastAnimationTime?: number;
  #width = 1;
  #height = 1;
  #framingAspect = 1;
  #capturing = false;
  #disposed = false;
  #notifyQueued = false;
  readonly #defaultView: boolean;

  constructor(
    canvas: HTMLCanvasElement,
    settings: PreviewSettings = {},
    onChange: (state: PreviewStudioState) => void = () => {},
  ) {
    this.#canvas = canvas;
    this.#onChange = onChange;
    this.#defaultView = settings.view === undefined && settings.camera === undefined;
    this.#settings = {
      view: 'three-quarter',
      projection: 'perspective',
      lighting: 'studio',
      background: '#18212f',
      clip: null,
      time: 0,
      playing: false,
      shape: 'sphere',
      ...validatePreviewSettings(settings),
    };
    this.#renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    this.#renderer.outputColorSpace = SRGBColorSpace;
    this.#renderer.setPixelRatio(1);
    this.#key.position.set(4, 6, 5);
    this.#rim.position.set(-4, 2, -3);
    this.#scene.add(this.#hemisphere, this.#key, this.#rim);
    this.#controls = this.#makeControls();
    this.#reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    if (this.#reducedMotion.matches) this.#settings.playing = false;
    this.#reducedMotion.addEventListener('change', this.#motionChanged);
    this.#canvas.addEventListener('keydown', this.#keyDown);
    this.#canvas.addEventListener('webglcontextlost', this.#contextLost);
    this.#resize = new ResizeObserver(() => this.#resizeViewport());
    this.#resize.observe(canvas.parentElement ?? canvas);
    this.#resizeViewport();
    this.#setLighting();
  }

  #makeControls(): OrbitControls {
    const controls = new OrbitControls(this.#camera, this.#canvas);
    controls.enableDamping = false;
    controls.listenToKeyEvents(this.#canvas);
    controls.addEventListener('change', this.#orbitChanged);
    return controls;
  }

  #orbitChanged = (): void => {
    if (this.#disposed || this.#capturing) return;
    this.render();
    this.#notify();
  };

  #motionChanged = (): void => {
    if (this.#reducedMotion.matches) {
      this.#settings.playing = false;
      this.#stopAnimation();
      this.#notify();
    }
  };

  #contextLost = (event: Event): void => {
    event.preventDefault();
    this.#fail(
      previewError(
        PreviewCode.Browser,
        'webgl',
        'The preview WebGL context was lost.',
        'Reload this page to recreate its renderer; a lost context cannot produce a valid capture.',
      ),
    );
  };

  #keyDown = (event: KeyboardEvent): void => {
    if (event.target !== this.#canvas || this.#status !== 'ready') return;
    if (event.key.toLowerCase() === 'f' || event.key === 'Home') {
      event.preventDefault();
      this.fit();
    } else if (['+', '=', '-'].includes(event.key)) {
      event.preventDefault();
      const scale = event.key === '-' ? 1.12 : 1 / 1.12;
      if (this.#camera instanceof OrthographicCamera) this.#camera.zoom /= scale;
      else
        this.#camera.position
          .sub(this.#controls.target)
          .multiplyScalar(scale)
          .add(this.#controls.target);
      this.#camera.updateProjectionMatrix();
      this.#controls.update();
      this.render();
      this.#notify();
    }
  };

  #notify(): void {
    if (this.#notifyQueued || this.#disposed) return;
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      if (!this.#disposed) this.#onChange(this.state());
    });
  }

  #resizeViewport(): void {
    if (this.#capturing || this.#disposed) return;
    const box = (this.#canvas.parentElement ?? this.#canvas).getBoundingClientRect();
    this.#width = Math.max(1, Math.round(box.width));
    this.#height = Math.max(1, Math.round(box.height));
    this.#size(this.#width, this.#height);
    this.render();
  }

  #size(width: number, height: number): void {
    const manifest = this.#loaded?.document.presentation.manifest;
    const size =
      manifest?.pipeline === undefined
        ? { width, height }
        : cinematicSize(width, height, 1, manifest.quality ?? 'standard');
    if (this.#capturing && (size.width !== width || size.height !== height))
      throw previewError(
        PreviewCode.Settings,
        'capture',
        'Requested capture exceeds the declared cinematic pixel budget.',
        'Reduce capture size or author quality: "photo" in the presentation descriptor for up to 4K.',
      );
    this.#renderer.setSize(size.width, size.height, false);
    this.#pipeline?.resize(size.width, size.height);
    const aspect = width / height;
    if (this.#camera instanceof PerspectiveCamera) this.#camera.aspect = aspect;
    else {
      const halfHeight = (this.#camera.top - this.#camera.bottom) / 2;
      this.#camera.left = -halfHeight * aspect;
      this.#camera.right = halfHeight * aspect;
    }
    this.#camera.updateProjectionMatrix();
  }

  #setLighting(): void {
    this.#scene.background = new Color(this.#settings.background);
    this.#hemisphere.intensity = this.#settings.lighting === 'neutral' ? 3 : 2;
    this.#key.intensity = this.#settings.lighting === 'neutral' ? 1 : 3;
    this.#key.color.set(this.#settings.lighting === 'warm' ? '#ffd6ab' : '#ffffff');
    this.#rim.color.set(this.#settings.lighting === 'warm' ? '#b3cbff' : '#aacbff');
  }

  #assertLoaded(): LoadedSubject {
    const loaded = this.#pending ?? this.#loaded;
    if (
      this.#disposed ||
      loaded === undefined ||
      loaded.document.revision !== this.#revision ||
      this.#serverStatus !== 'prepared' ||
      this.#status === 'loading'
    )
      throw previewError(
        PreviewCode.Revision,
        'revision',
        `Revision ${this.#revision} is not available for rendering.`,
        'Wait for this revision to load or repair it and reload. Last-good pixels cannot satisfy a new revision.',
      );
    return loaded;
  }

  #fail(error: unknown): void {
    this.#status = 'failed';
    this.#diagnostics = previewDiagnostics(error);
    this.#settings.playing = false;
    this.#stopAnimation();
    this.#notify();
  }

  #disposePending(): void {
    this.#pending?.subject.dispose();
    this.#pending?.assets.dispose();
    this.#pending = undefined;
  }

  /** New requests immediately invalidate capture; an old load can never commit over a newer one. */
  accept(server: PreviewServerState): Promise<void> {
    if (this.#disposed || server.revision < this.#revision) return this.#accepting;
    if (
      server.revision === this.#revision &&
      (server.status === this.#serverStatus ||
        this.#serverStatus === 'closed' ||
        (server.status === 'preparing' && this.#serverStatus !== undefined))
    )
      return this.#accepting;
    // HTTP and SSE can deliver one revision out of order; duplicates must join its real load.
    this.#serverStatus = server.status;
    this.#accepting = this.#apply(server);
    return this.#accepting;
  }

  async ready(revision?: number): Promise<PreviewStudioState> {
    let accepting: Promise<void>;
    do {
      accepting = this.#accepting;
      await accepting;
    } while (accepting !== this.#accepting);
    const state = this.state();
    if (state.status !== 'ready' || (revision !== undefined && revision !== state.revision))
      throw new DiagnosticError(
        state.diagnostics.length > 0
          ? state.diagnostics
          : previewDiagnostics(
              previewError(
                PreviewCode.Revision,
                'revision',
                `Revision ${state.revision} is ${state.status}, not the requested ready revision.`,
                'Wait for the current source to load or repair it and reload.',
              ),
            ),
      );
    return state;
  }

  async #apply(server: PreviewServerState): Promise<void> {
    this.#controller?.abort();
    this.#disposePending();
    const controller = (this.#controller = new AbortController());
    this.#revision = server.revision;
    this.#stopAnimation();
    this.#status = server.status === 'failed' || server.status === 'closed' ? 'failed' : 'loading';
    this.#diagnostics = server.diagnostics;
    this.#notify();
    if (server.status !== 'prepared' || server.document === null) return;
    const document = server.document;
    const started = performance.now();
    let assets: PresentationAssets | undefined;
    let subject: PreviewSubject | undefined;
    try {
      assets = await loadPresentationAssets(document.presentation, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const previous = this.#loaded;
      const sameSelection =
        previous?.document.selection.kind === document.selection.kind &&
        previous.document.selection.id === document.selection.id;
      const settings = { ...this.#settings };
      if (previous !== undefined && !sameSelection) {
        settings.clip = null;
        settings.time = 0;
        settings.playing = false;
        settings.camera = undefined;
      }
      if (previous === undefined && document.selection.kind === 'texture' && this.#defaultView)
        settings.view = 'front';
      subject = new PreviewSubject(
        assets,
        document.presentation.manifest,
        document.selection,
        settings.shape,
      );
      assetBounds(subject.root);
      if (meshStats(subject.root).triangles <= 0)
        throw previewError(
          PreviewCode.Load,
          'geometry',
          'The selected asset has no triangles to render.',
          'Export a model with visible mesh geometry.',
        );
      controller.signal.throwIfAborted();
      if (document.revision !== this.#revision || this.#disposed) {
        subject.dispose();
        assets.dispose();
        return;
      }
      try {
        subject.validateSample(settings.clip, settings.time);
      } catch (error) {
        if (!(error instanceof DiagnosticError)) throw error;
        // Keep the last-good pixels until the operator explicitly repairs the new model's settings.
        this.#pending = { document, assets, subject, loadMs: performance.now() - started };
        this.#fail(error);
        return;
      }
      subject.sample(settings.clip, settings.time);
      assetBounds(subject.root);
      this.#loaded = { document, assets, subject, loadMs: performance.now() - started };
      this.#settings = settings;
      this.#scene.add(subject.root);
      this.#setPipeline();
      previous?.subject.dispose();
      previous?.assets.dispose();
      this.#setProjection();
      if (previous === undefined || !sameSelection) this.fit(true);
      else this.#setClipPlanes();
      this.#status = 'ready';
      this.#diagnostics = [];
      this.#lastGood = document.revision;
      this.render();
      this.#startAnimation();
      this.#notify();
    } catch (error) {
      subject?.dispose();
      assets?.dispose();
      if (controller.signal.aborted || document.revision !== this.#revision || this.#disposed)
        return;
      this.#fail(error);
    }
  }

  #setProjection(): void {
    const orthographic = this.#settings.projection === 'orthographic';
    if (orthographic === this.#camera instanceof OrthographicCamera) return;
    const old = this.#camera;
    const target = this.#controls.target.clone();
    this.#controls.dispose();
    this.#camera = orthographic
      ? new OrthographicCamera(-2, 2, 2, -2, 0.01, 1000)
      : new PerspectiveCamera(40, this.#width / this.#height, 0.01, 1000);
    this.#camera.position.copy(old.position);
    this.#camera.up.copy(old.up);
    this.#controls = this.#makeControls();
    this.#controls.target.copy(target);
    this.#size(this.#width, this.#height);
  }

  #setClipPlanes(): void {
    if (this.#loaded === undefined) return;
    const bounds = assetBounds(this.#loaded.subject.root);
    const center = new Vector3().fromArray(bounds.center);
    const radius = new Vector3().fromArray(bounds.size).length() / 2;
    const distance = this.#camera.position.distanceTo(center);
    this.#camera.near = Math.max(radius / 10000, distance - radius * 3, 0.000001);
    this.#camera.far = Math.max(this.#camera.near * 2, distance + radius * 6);
    this.#camera.updateProjectionMatrix();
  }

  fit(useExplicitCamera = false): void {
    if (this.#loaded === undefined || this.#disposed) return;
    if (!useExplicitCamera) this.#settings.camera = undefined;
    const bounds = assetBounds(this.#loaded.subject.root);
    const center = new Vector3().fromArray(bounds.center);
    const radius = new Vector3().fromArray(bounds.size).length() / 2;
    const aspect = this.#renderer.domElement.width / this.#renderer.domElement.height;
    this.#framingAspect = aspect;
    const vertical = (40 * Math.PI) / 360;
    const horizontal = Math.atan(Math.tan(vertical) * aspect);
    const distance = (radius / Math.sin(Math.min(vertical, horizontal))) * 1.12;
    this.#camera.position
      .copy(center)
      .add(
        new Vector3()
          .fromArray(DIRECTIONS[this.#settings.view])
          .normalize()
          .multiplyScalar(distance),
      );
    this.#camera.up.set(0, 1, 0);
    this.#camera.zoom = 1;
    if (this.#camera instanceof OrthographicCamera) {
      const halfHeight = (radius * 1.12) / Math.min(1, aspect);
      this.#camera.top = halfHeight;
      this.#camera.bottom = -halfHeight;
      this.#camera.left = -halfHeight * aspect;
      this.#camera.right = halfHeight * aspect;
    }
    this.#controls.target.copy(center);
    if (this.#settings.camera !== undefined) {
      this.#camera.position.fromArray(this.#settings.camera.position);
      this.#controls.target.fromArray(this.#settings.camera.target);
      this.#camera.zoom = this.#settings.camera.zoom ?? 1;
      if (
        this.#camera instanceof OrthographicCamera &&
        this.#settings.camera.orthographicHeight !== undefined
      ) {
        const halfHeight = this.#settings.camera.orthographicHeight / 2;
        this.#camera.top = halfHeight;
        this.#camera.bottom = -halfHeight;
        this.#camera.left = -halfHeight * aspect;
        this.#camera.right = halfHeight * aspect;
      }
    }
    this.#setClipPlanes();
    if (this.#settings.camera === undefined) this.#controls.update();
    else this.#camera.lookAt(this.#controls.target);
    this.render();
    this.#notify();
  }

  configure(input: PreviewSettings): PreviewStudioState {
    const loaded = this.#assertLoaded();
    try {
      const patch = validatePreviewSettings(input);
      const next = { ...this.#settings, ...patch };
      if (patch.clip !== undefined && patch.time === undefined) next.time = 0;
      if (next.playing && next.clip === null)
        throw previewError(
          PreviewCode.Settings,
          'playing',
          'Studio playback requires a model clip.',
          'Select a clip before pressing Play.',
        );
      if (patch.shape !== undefined && loaded.document.selection.kind !== 'material')
        throw previewError(
          PreviewCode.Settings,
          'shape',
          'Sample shape applies only to a declared material.',
          'Select a material to use sphere, cube, or plane samples.',
        );
      loaded.subject.validateSample(next.clip, next.time);
      if (patch.view !== undefined && patch.camera === undefined) next.camera = undefined;
      if (patch.shape !== undefined && patch.shape !== this.#settings.shape) {
        const replacement = new PreviewSubject(
          loaded.assets,
          loaded.document.presentation.manifest,
          loaded.document.selection,
          patch.shape,
        );
        this.#scene.add(replacement.root);
        loaded.subject.dispose();
        loaded.subject = replacement;
      }
      this.#settings = next;
      loaded.subject.sample(next.clip, next.time);
      assetBounds(loaded.subject.root);
      const installing = loaded === this.#pending;
      const hadPrevious = this.#loaded !== undefined;
      if (installing) {
        const previous = this.#loaded;
        this.#loaded = loaded;
        this.#pending = undefined;
        this.#scene.add(loaded.subject.root);
        this.#setPipeline();
        previous?.subject.dispose();
        previous?.assets.dispose();
      }
      this.#setProjection();
      if (
        (installing && !hadPrevious) ||
        patch.view !== undefined ||
        patch.projection !== undefined ||
        patch.camera !== undefined ||
        patch.shape !== undefined
      )
        this.fit(true);
      else this.#setClipPlanes();
      this.#setLighting();
      this.#status = 'ready';
      this.#diagnostics = [];
      this.#lastGood = this.#revision;
      this.render();
      this.#stopAnimation();
      this.#startAnimation();
      this.#notify();
      return this.state();
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  #stopAnimation(): void {
    if (this.#animation !== undefined) cancelAnimationFrame(this.#animation);
    this.#animation = undefined;
    this.#lastAnimationTime = undefined;
  }

  #startAnimation(): void {
    if (!this.#settings.playing || this.#status !== 'ready' || this.#disposed) return;
    this.#animation = requestAnimationFrame(this.#animate);
  }

  #animate = (now: number): void => {
    this.#animation = undefined;
    if (
      this.#status !== 'ready' ||
      this.#loaded === undefined ||
      !this.#settings.playing ||
      this.#disposed
    )
      return;
    const duration =
      this.#loaded.subject.clips.find((clip) => clip.name === this.#settings.clip)?.duration ?? 0;
    if (this.#lastAnimationTime !== undefined && duration > 0) {
      this.#settings.time =
        (this.#settings.time + (now - this.#lastAnimationTime) / 1000) % duration;
      this.#loaded.subject.sample(this.#settings.clip, this.#settings.time);
      this.render();
      this.#notify();
    }
    this.#lastAnimationTime = now;
    this.#startAnimation();
  };

  render(): void {
    if (this.#disposed) return;
    if (this.#pipeline === undefined) this.#renderer.render(this.#scene, this.#camera);
    else this.#pipeline.render({ scene: this.#scene, camera: this.#camera });
  }

  #setPipeline(): void {
    this.#pipeline?.dispose();
    this.#pipeline = undefined;
    const loaded = this.#loaded;
    if (loaded?.document.presentation.manifest.pipeline !== undefined) {
      this.#pipeline = new CinematicPipeline(
        this.#renderer,
        { scene: this.#scene, camera: this.#camera },
        loaded.document.presentation.manifest,
        loaded.assets,
      );
      this.#size(this.#width, this.#height);
    }
  }

  #cameraState(): PreviewCamera {
    return {
      projection: this.#camera instanceof PerspectiveCamera ? 'perspective' : 'orthographic',
      position: tuple(this.#camera.position),
      target: tuple(this.#controls.target),
      up: tuple(this.#camera.up),
      near: this.#camera.near,
      far: this.#camera.far,
      zoom: this.#camera.zoom,
      fov: this.#camera instanceof PerspectiveCamera ? this.#camera.fov : null,
      orthographicHeight:
        this.#camera instanceof OrthographicCamera ? this.#camera.top - this.#camera.bottom : null,
    };
  }

  #recipe(): PreviewRecipe | null {
    if (this.#loaded === undefined) return null;
    const manifest = this.#loaded.document.presentation.manifest;
    return {
      selection: this.#loaded.document.selection,
      view: this.#settings.view,
      camera: this.#cameraState(),
      lighting: this.#settings.lighting,
      background: this.#settings.background,
      clip: this.#settings.clip,
      time: this.#settings.time,
      shape: this.#settings.shape,
      ...(manifest.pipeline === undefined
        ? {}
        : {
            pipeline: {
              quality: manifest.quality ?? 'standard',
              settings: manifest.pipeline,
              ...(manifest.environment?.reflections === undefined
                ? {}
                : { reflections: manifest.environment.reflections }),
            },
          }),
    };
  }

  #stats(): PreviewStats | null {
    if (this.#loaded === undefined) return null;
    return {
      ...meshStats(this.#loaded.subject.root),
      bounds: assetBounds(this.#loaded.subject.root),
      clips: this.#loaded.subject.clips.map((clip) => ({
        name: clip.name,
        duration: clip.duration,
        tracks: clip.tracks.length,
      })),
      library: this.#loaded.assets.stats(),
      gpu: { ...this.#renderer.info.memory },
      ...(this.#pipeline === undefined ? {} : { pipeline: this.#pipeline.stats() }),
    };
  }

  state(): PreviewStudioState {
    return {
      revision: this.#revision,
      status: this.#status,
      lastGoodRevision: this.#lastGood,
      fingerprint: this.#loaded?.document.fingerprint ?? null,
      diagnostics: this.#diagnostics,
      recipe: this.#recipe(),
      stats: this.#stats(),
      loadMs: this.#loaded?.loadMs ?? null,
      playing: this.#settings.playing,
      recovery:
        this.#pending === undefined
          ? null
          : {
              clips: this.#pending.subject.clips.map((clip) => ({
                name: clip.name,
                duration: clip.duration,
                tracks: clip.tracks.length,
              })),
            },
    };
  }

  capture(revision: number, width = 1024, height = 768): PreviewFrame {
    const loaded = this.#assertLoaded();
    if (revision !== this.#revision || this.#status !== 'ready')
      throw new DiagnosticError(
        this.#diagnostics.length > 0
          ? this.#diagnostics
          : previewDiagnostics(
              previewError(
                PreviewCode.Revision,
                'revision',
                `Cannot capture requested revision ${revision}; current revision ${this.#revision} is ${this.#status}.`,
                'Capture only the current ready revision.',
              ),
            ),
      );
    captureDimensions(width, height);
    if (this.#renderer.getContext().isContextLost())
      throw previewError(
        PreviewCode.Browser,
        'webgl',
        'The WebGL context is lost.',
        'Reload the preview page before capturing.',
      );
    this.#stopAnimation();
    this.#capturing = true;
    // Loading/error UI can resize the viewport without changing the authored capture framing.
    const oldAspect = this.#framingAspect;
    const oldZoom = this.#camera.zoom;
    try {
      this.#size(width, height);
      // An explicit camera can be a saved capture recipe; applying the fit again would shrink it.
      if (this.#settings.camera === undefined)
        this.#camera.zoom = oldZoom * Math.min(1, width / height / oldAspect);
      this.#camera.updateProjectionMatrix();
      const renderStart = performance.now();
      this.render();
      const renderMs = performance.now() - renderStart;
      const encodeStart = performance.now();
      const dataUrl = this.#canvas.toDataURL('image/png');
      const encodeMs = performance.now() - encodeStart;
      if (!dataUrl.startsWith('data:image/png;base64,'))
        throw previewError(
          PreviewCode.Browser,
          'capture',
          'The browser did not encode PNG pixels.',
          'Use a browser with a working WebGL canvas and PNG encoder.',
        );
      return {
        revision,
        fingerprint: loaded.document.fingerprint,
        width,
        height,
        dataUrl,
        recipe: this.#recipe()!,
        stats: this.#stats()!,
        loadMs: loaded.loadMs,
        renderMs,
        encodeMs,
      };
    } finally {
      this.#camera.zoom = oldZoom;
      this.#capturing = false;
      this.#size(this.#width, this.#height);
      this.render();
      this.#startAnimation();
    }
  }

  capabilities(): { browser: string; renderer: string } {
    const gl = this.#renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      browser: navigator.userAgent,
      renderer: String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)),
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#status = 'disposed';
    this.#controller?.abort();
    this.#stopAnimation();
    this.#resize.disconnect();
    this.#reducedMotion.removeEventListener('change', this.#motionChanged);
    this.#canvas.removeEventListener('keydown', this.#keyDown);
    this.#canvas.removeEventListener('webglcontextlost', this.#contextLost);
    this.#controls.dispose();
    this.#disposePending();
    this.#pipeline?.dispose();
    this.#loaded?.subject.dispose();
    this.#loaded?.assets.dispose();
    this.#loaded = undefined;
    this.#scene.clear();
    this.#renderer.dispose();
    this.#renderer.forceContextLoss();
  }
}
