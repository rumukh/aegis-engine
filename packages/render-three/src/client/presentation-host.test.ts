import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresentationAssets } from '../presentation/assets.js';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  createAdapter: vi.fn(),
  rendererDispose: vi.fn(),
  contextLoss: vi.fn(),
  setLoading: vi.fn(),
  hudReset: vi.fn(),
  audio: vi.fn(),
}));
vi.mock('../presentation/assets.js', () => ({ loadPresentationAssets: mocks.load }));
vi.mock('../adapters/index.js', () => ({ createRenderAdapter: mocks.createAdapter }));
vi.mock('./audio.js', () => ({ createAudio: mocks.audio }));
vi.mock('./hud.js', () => ({
  createHud: () => ({
    setLoading: mocks.setLoading,
    reset: mocks.hudReset,
    pushEvents: vi.fn(),
    setAudio: vi.fn(),
  }),
}));
vi.mock('three', async (importOriginal) => ({
  ...(await importOriginal<typeof import('three')>()),
  WebGLRenderer: class {
    setPixelRatio(): void {}
    dispose = mocks.rendererDispose;
    forceContextLoss = mocks.contextLoss;
  },
}));
import { PresentationHost } from './presentation-host.js';

let host: PresentationHost | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('document', { getElementById: () => null });
  vi.stubGlobal('addEventListener', vi.fn());
  vi.stubGlobal('removeEventListener', vi.fn());
  mocks.audio.mockReturnValue({
    state: () => ({ status: 'locked', muted: false, voices: 0, dropped: 0 }),
    setPaused: vi.fn(),
    sync: vi.fn(),
    reset: vi.fn(),
    consume: vi.fn(),
    dispose: vi.fn(),
  });
});
afterEach(() => {
  host?.dispose();
  host = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function library(): PresentationAssets {
  return {
    texture: vi.fn(),
    material: vi.fn(),
    instantiateModel: vi.fn(),
    audio: vi.fn(),
    stats: () => ({
      textures: 0,
      materials: 0,
      geometries: 0,
      modelInstances: 0,
      audioBytes: 0,
      loadedFiles: 0,
    }),
    dispose: vi.fn(),
  };
}
function canvas(): HTMLCanvasElement {
  return new EventTarget() as HTMLCanvasElement;
}

describe('shared browser presentation lifecycle', () => {
  it('does not signal readiness when only loading chrome or decoded assets exist', async () => {
    let resolve!: (assets: PresentationAssets) => void;
    mocks.load.mockReturnValue(
      new Promise<PresentationAssets>((done) => {
        resolve = done;
      }),
    );
    const adapter = {
      dispose: vi.fn(),
      presentation: { stats: () => ({}), setReducedMotion: vi.fn() },
    };
    mocks.createAdapter.mockReturnValue(adapter);
    host = new PresentationHost({
      canvas: canvas(),
      mode: 'platformer',
      onCommand: () => undefined,
      presentation: { manifest: { aegis: 'presentation/1' }, baseUrl: './assets/' },
    });
    const started = vi.fn();
    const ready = vi.fn();
    host.start(started);
    void host.ready.then(ready);
    expect(started).not.toHaveBeenCalled();
    resolve(library());
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
    expect(host.stats()).toMatchObject({ status: 'loading' });
    host.mounted();
    await host.ready;
    expect(ready).toHaveBeenCalledTimes(1);
    expect(host.stats()).toMatchObject({ status: 'ready' });
  });

  it('releases adapter instances before their shared asset library and ignores stale event generations', async () => {
    const order: string[] = [];
    const assets = library();
    assets.dispose = () => {
      order.push('assets');
    };
    mocks.load.mockResolvedValue(assets);
    const present = vi.fn();
    mocks.createAdapter.mockReturnValue({
      present,
      resetPresentation: vi.fn(),
      dispose: () => {
        order.push('adapter');
      },
    });
    host = new PresentationHost({
      canvas: canvas(),
      mode: 'fps',
      onCommand: () => undefined,
      presentation: { manifest: { aegis: 'presentation/1' }, baseUrl: './assets/' },
    });
    host.start(() => host?.mounted());
    await host.ready;
    host.receive([{ type: 'old', tick: 1 }], 0);
    host.reset(1);
    host.receive([{ type: 'stale', tick: 2 }], 0);
    host.receive([{ type: 'fresh', tick: 0 }], 1);
    host.present(1, false);
    expect(present.mock.calls[0]?.[0].events).toEqual([{ type: 'fresh', tick: 0 }]);
    host.dispose();
    host.dispose();
    expect(order).toEqual(['adapter', 'assets']);
    expect(mocks.rendererDispose).toHaveBeenCalledTimes(1);
    expect(mocks.contextLoss).toHaveBeenCalledTimes(1);
  });

  it('rejects readiness and surfaces the precise asset failure, never starting an empty adapter', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.load.mockRejectedValue(new Error('AEG-RENDER-0004 missing required texture'));
    host = new PresentationHost({
      canvas: canvas(),
      mode: 'iso',
      onCommand: () => undefined,
      presentation: { manifest: { aegis: 'presentation/1' }, baseUrl: './assets/' },
    });

    const start = vi.fn();
    host.start(start);
    await expect(host.ready).rejects.toThrow(/missing required texture/);
    expect(start).not.toHaveBeenCalled();
    expect(mocks.createAdapter).not.toHaveBeenCalled();
    expect(mocks.setLoading).toHaveBeenLastCalledWith(
      'error',
      'AEG-RENDER-0004 missing required texture',
    );
  });

  it('hydrates once per generation, retaining buffered live events but not sending historical cues to audio', async () => {
    mocks.load.mockResolvedValue(library());
    const hydrate = vi.fn();
    const present = vi.fn();
    mocks.createAdapter.mockReturnValue({
      present,
      dispose: vi.fn(),
      resetPresentation: vi.fn(),
      presentation: { hydrate, setReducedMotion: vi.fn() },
    });
    host = new PresentationHost({
      canvas: canvas(),
      mode: 'fps',
      onCommand: () => undefined,
      presentation: { manifest: { aegis: 'presentation/1' }, baseUrl: './assets/' },
    });
    host.start(() => host?.mounted());
    await host.ready;
    const historical = { type: 'old', tick: 0, sequence: 0 };
    const fresh = { type: 'fresh', tick: 1, sequence: 1 };
    host.receive([historical, fresh], 0);
    host.hydrate([historical], 0, 1);
    host.hydrate([historical], 0, 1);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(mocks.hudReset).toHaveBeenCalledTimes(1);
    host.present(1, false);
    expect(present).toHaveBeenLastCalledWith(expect.objectContaining({ events: [fresh] }));
    const audio = mocks.audio.mock.results[0]!.value;
    expect(audio.consume).toHaveBeenLastCalledWith([fresh], 0, 1);
    host.receive([historical], 0);
    host.present(2, false);
    expect(audio.consume).toHaveBeenLastCalledWith([], 0, 2);
    host.reset(1);
    host.hydrate([], 1, 0);
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it('still releases GPU owners when audio cleanup fails', async () => {
    const assets = library();
    const adapterDispose = vi.fn();
    mocks.load.mockResolvedValue(assets);
    mocks.createAdapter.mockReturnValue({ dispose: adapterDispose });
    mocks.audio.mockReturnValue({
      state: () => ({ status: 'ready', muted: false, voices: 0, dropped: 0 }),
      dispose: () => {
        throw new Error('audio cleanup failed');
      },
    });
    host = new PresentationHost({
      canvas: canvas(),
      mode: 'fps',
      onCommand: () => undefined,
      presentation: { manifest: { aegis: 'presentation/1' }, baseUrl: './assets/' },
    });
    host.start(() => host?.mounted());
    await host.ready;
    expect(() => host?.dispose()).toThrow(/Presentation disposal failed/);
    expect(adapterDispose).toHaveBeenCalledTimes(1);
    expect(assets.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.rendererDispose).toHaveBeenCalledTimes(1);
    expect(host.stats()).toMatchObject({ status: 'disposed' });
  });

  it('rejects pending readiness if disposed before a legacy first frame', async () => {
    mocks.createAdapter.mockReturnValue({ dispose: vi.fn() });
    host = new PresentationHost({ canvas: canvas(), mode: 'iso', onCommand: () => undefined });
    host.dispose();
    await expect(host.ready).rejects.toThrow(/disposed before the first frame/);
  });

  it('applies and follows reduced-motion preferences without retaining listeners after disposal', async () => {
    class MotionPreference extends EventTarget {
      matches = true;
    }
    const preference = new MotionPreference();
    vi.stubGlobal('matchMedia', () => preference);
    const reducedMotion = vi.fn();
    mocks.load.mockResolvedValue(library());
    mocks.createAdapter.mockReturnValue({
      dispose: vi.fn(),
      presentation: { setReducedMotion: reducedMotion },
    });
    host = new PresentationHost({
      canvas: canvas(),
      mode: 'fps',
      onCommand: () => undefined,
      presentation: { manifest: { aegis: 'presentation/1' }, baseUrl: './assets/' },
    });
    host.start(() => host?.mounted());
    await host.ready;
    expect(reducedMotion).toHaveBeenLastCalledWith(true);
    preference.matches = false;
    preference.dispatchEvent(new Event('change'));
    expect(reducedMotion).toHaveBeenLastCalledWith(false);
    expect(reducedMotion).toHaveBeenCalledTimes(2);
    host.dispose();
    preference.matches = true;
    preference.dispatchEvent(new Event('change'));
    expect(reducedMotion).toHaveBeenCalledTimes(2);
  });
});
