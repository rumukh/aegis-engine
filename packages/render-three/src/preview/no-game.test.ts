import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as settle } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewServerState } from './types.js';

const guards = vi.hoisted(() => ({
  world: vi.fn(() => {
    throw new Error('NO-GAME: world creation');
  }),
  simulation: vi.fn(() => {
    throw new Error('NO-GAME: simulation creation');
  }),
  browser: vi.fn(() => {
    throw new Error('CPU guard never launches a browser');
  }),
  render: vi.fn(),
}));
vi.mock('@aegis/core', async (original) => ({
  ...(await original<typeof import('@aegis/core')>()),
  createWorld: guards.world,
  createSimulation: guards.simulation,
}));
vi.mock('@aegis/harness', () => {
  throw new Error('NO-GAME: harness import');
});
vi.mock('../catalog.js', () => {
  throw new Error('NO-GAME: catalog import');
});
vi.mock('../session.js', () => {
  throw new Error('NO-GAME: live session import');
});
vi.mock('../client/boot.js', () => {
  throw new Error('NO-GAME: game browser boot import');
});
vi.mock('../browser.js', async (original) => ({
  ...(await original<typeof import('../browser.js')>()),
  ['launch' + 'Browser']: guards.browser,
}));
vi.mock('three', async (original) => ({
  ...(await original<typeof import('three')>()),
  WebGLRenderer: class {
    domElement: HTMLCanvasElement;
    info = { memory: { geometries: 0, textures: 0 } };
    constructor({ canvas }: { canvas: HTMLCanvasElement }) {
      this.domElement = canvas;
    }
    setPixelRatio() {}
    setSize(width: number, height: number) {
      this.domElement.width = width;
      this.domElement.height = height;
    }
    render() {
      guards.render();
    }
    getContext() {
      return { isContextLost: () => false };
    }
    dispose() {}
    forceContextLoss() {}
  },
}));
vi.mock('three/examples/jsm/controls/OrbitControls.js', async () => {
  const { Vector3 } = await import('three');
  return {
    OrbitControls: class {
      target = new Vector3();
      listenToKeyEvents() {}
      addEventListener() {}
      update() {}
      dispose() {}
    },
  };
});

let root: string | undefined;
let resizeViewport: (() => void) | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  resizeViewport = undefined;
  vi.unstubAllGlobals();
});

function studioCanvas(): HTMLCanvasElement {
  vi.stubGlobal('document', { baseURI: 'http://127.0.0.1:5000/' });
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeViewport = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  return Object.assign(new EventTarget(), {
    parentElement: null,
    width: 640,
    height: 360,
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
    // Camera-only boundary. Actual PNG pixels are checked in the browser suite.
    toDataURL: () => 'data:image/png;base64,AA==',
  }) as HTMLCanvasElement;
}

function materialRevision(revision: number): PreviewServerState {
  return {
    aegis: 'asset-preview-state/1',
    revision,
    status: 'prepared',
    lastPreparedRevision: revision,
    diagnostics: [],
    document: {
      revision,
      fingerprint: String(revision).repeat(64),
      source: {
        name: 'material.json',
        format: 'presentation/1',
        sha256: 'a'.repeat(64),
        bytes: 123,
      },
      dependencies: [],
      selection: { kind: 'material', id: 'matte' },
      choices: [{ kind: 'material', id: 'matte' }],
      prepareMs: 1,
      presentation: {
        baseUrl: `./assets/r${revision}/`,
        files: [],
        manifest: { aegis: 'presentation/1', materials: [{ id: 'matte', shading: 'standard' }] },
      },
    },
  };
}

describe('no-game proof for both standalone preview entry points', () => {
  it('keeps capture framing stable when an error panel changes the viewport size', async () => {
    const { AssetPreviewStudio } = await import('./studio.js');
    const canvas = studioCanvas();
    const studio = new AssetPreviewStudio(canvas);
    try {
      await studio.accept(materialRevision(1));
      const first = studio.capture(1, 512, 512);
      expect(() => studio.configure({ clip: 'missing' })).toThrow();
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        width: 640,
        height: 240,
        top: 0,
        left: 0,
        right: 640,
        bottom: 240,
        toJSON: () => ({}),
      });
      resizeViewport?.();
      studio.configure({ clip: null, time: 0 });
      expect(studio.capture(1, 512, 512).recipe.camera).toEqual(first.recipe.camera);
    } finally {
      studio.dispose();
    }
  });

  it.each(['renamed', 'shortened', 'removed'] as const)(
    'repairs a %s animation selection on the current asset without restarting',
    async (change) => {
      const assetModule = await import('../presentation/assets.js');
      const { AssetPreviewStudio } = await import('./studio.js');
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const { fixtureGlb } = await import('../testing/presentation-fixture.js');
      const manifest = {
        aegis: 'presentation/1' as const,
        assets: [
          {
            id: 'rig',
            kind: 'gltf' as const,
            src: 'rig.glb',
            provenance: { author: 'Aegis contributors', license: 'MIT', source: 'fixture' },
          },
        ],
      };
      const libraries = [];
      for (const revision of [1, 2]) {
        libraries.push(
          await assetModule.loadPresentationAssets(
            { manifest, baseUrl: './assets/' },
            {
              loaders: {
                texture: async () => {
                  throw new Error('This fixture has no texture.');
                },
                audio: async () => {
                  throw new Error('This fixture has no audio.');
                },
                model: async () => {
                  const model = await new GLTFLoader().parseAsync(fixtureGlb(), '');
                  if (revision === 2) {
                    if (change === 'renamed') model.animations[0]!.name = 'updated';
                    else if (change === 'removed') model.animations = [];
                    else model.animations[0]!.duration = 0.5;
                  }
                  return model;
                },
              },
            },
          ),
        );
      }
      const decode = vi
        .spyOn(assetModule, 'loadPresentationAssets')
        .mockResolvedValueOnce(libraries[0]!)
        .mockResolvedValueOnce(libraries[1]!);
      const studio = new AssetPreviewStudio(studioCanvas(), { clip: 'spin', time: 0.75 });
      const revision = (number: number): PreviewServerState => {
        const state = materialRevision(number);
        state.document!.selection = { kind: 'model', id: 'rig' };
        state.document!.presentation.manifest = manifest;
        return state;
      };
      try {
        await studio.accept(revision(1));
        expect(studio.state().status).toBe('ready');
        const originalCamera = studio.state().recipe!.camera;
        await studio.accept(revision(2));
        expect(studio.state()).toMatchObject({
          revision: 2,
          status: 'failed',
          lastGoodRevision: 1,
        });
        expect(() => studio.capture(2)).toThrow();
        expect(studio.state().recovery?.clips.map((clip) => clip.name)).toEqual(
          change === 'removed' ? [] : [change === 'renamed' ? 'updated' : 'spin'],
        );
        expect(libraries[0]!.stats().modelInstances).toBe(1);
        expect(libraries[1]!.stats().modelInstances).toBe(1);
        expect(() => studio.configure({ clip: 'spin', time: 0.75 })).toThrow();
        expect(() => studio.capture(2)).toThrow();
        const repaired = studio.configure({
          clip: change === 'removed' ? null : change === 'renamed' ? 'updated' : 'spin',
          time: change === 'removed' ? 0 : 0.1,
          playing: false,
        });
        expect(repaired).toMatchObject({ revision: 2, status: 'ready', lastGoodRevision: 2 });
        expect(repaired.recovery).toBeNull();
        expect(repaired.recipe?.camera.position).toEqual(originalCamera.position);
        expect(repaired.recipe?.camera.target).toEqual(originalCamera.target);
        expect(libraries[0]!.stats().modelInstances).toBe(0);
        expect(libraries[1]!.stats().modelInstances).toBe(1);
        expect(studio.capture(2, 256, 256).revision).toBe(2);
        expect(decode).toHaveBeenCalledTimes(2);
      } finally {
        studio.dispose();
        expect(libraries.every((library) => library.stats().modelInstances === 0)).toBe(true);
        decode.mockRestore();
        for (const library of libraries) library.dispose();
      }
    },
  );

  it.each(['perspective', 'orthographic'] as const)(
    'restores an exact stored %s capture camera without applying portrait zoom twice',
    async (projection) => {
      const { AssetPreviewStudio } = await import('./studio.js');
      const studio = new AssetPreviewStudio(studioCanvas(), { projection });
      try {
        await studio.accept(materialRevision(1));
        const first = studio.capture(1, 256, 512);
        expect(first.recipe.camera.zoom).toBeCloseTo(256 / 512 / (640 / 360), 8);
        const camera = first.recipe.camera;
        studio.configure({
          projection: camera.projection,
          camera: {
            position: camera.position,
            target: camera.target,
            zoom: camera.zoom,
            ...(camera.orthographicHeight === null
              ? {}
              : { orthographicHeight: camera.orthographicHeight }),
          },
        });
        const restored = studio.capture(1, 256, 512);
        expect(restored.recipe.camera).toEqual(camera);
      } finally {
        studio.dispose();
      }
    },
  );

  it('arms guards which really fail if a world or simulation is created', () => {
    expect(guards.world).toThrow('NO-GAME: world');
    expect(guards.simulation).toThrow('NO-GAME: simulation');
    guards.world.mockClear();
    guards.simulation.mockClear();
  });

  it('prepares/serves assets without importing any game host, and one-shot reaches only the browser boundary', async () => {
    const { prepareAssetPreview, startAssetPreviewServer, startAssetPreview } =
      await import('./index.js');
    root = mkdtempSync(join(tmpdir(), 'aegis-no-game-preview-'));
    const source = join(root, 'source.svg');
    writeFileSync(
      source,
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#aabbcc"/></svg>',
    );
    writeFileSync(join(root, 'aegis.json'), '{"plugin":"./must-not-run.mjs#plugin"}');
    writeFileSync(
      join(root, 'must-not-run.mjs'),
      'throw new Error("NO-GAME: plugin import or init");',
    );
    expect(prepareAssetPreview({ source }).document.source.format).toBe('direct');
    const server = await startAssetPreviewServer({ source });
    try {
      expect((await fetch(server.url)).status).toBe(200);
      expect((await fetch(`${server.url}api/state`)).status).toBe(200);
      expect(server.reload().status).toBe('prepared');
    } finally {
      await server.close();
    }
    await expect(startAssetPreview({ source })).rejects.toThrow(
      'CPU guard never launches a browser',
    );
    expect(guards.browser).toHaveBeenCalledTimes(1);
    expect(guards.world).not.toHaveBeenCalled();
    expect(guards.simulation).not.toHaveBeenCalled();
  });

  it('mounts, renders, reconfigures, and disposes the actual studio controller with the same no-game guards armed', async () => {
    const { AssetPreviewStudio } = await import('./studio.js');
    const studio = new AssetPreviewStudio(studioCanvas());
    await studio.accept(materialRevision(1));
    expect(studio.state().status).toBe('ready');
    expect(studio.state().stats?.triangles).toBeGreaterThan(100);
    studio.configure({ view: 'left' });
    studio.fit();
    expect(guards.render).toHaveBeenCalled();
    expect(guards.world).not.toHaveBeenCalled();
    expect(guards.simulation).not.toHaveBeenCalled();
    studio.dispose();
    expect(studio.state()).toMatchObject({ status: 'disposed', stats: null });
  });

  it('refuses capture while reloading, commits only the newest load, and aborts work on disposal', async () => {
    const { AssetPreviewStudio } = await import('./studio.js');
    const studio = new AssetPreviewStudio(studioCanvas());
    await studio.accept(materialRevision(1));
    const second = studio.accept(materialRevision(2));
    expect(studio.state()).toMatchObject({ revision: 2, status: 'loading', lastGoodRevision: 1 });
    expect(() => studio.capture(1)).toThrow('not available for rendering');
    const third = studio.accept(materialRevision(3));
    await Promise.all([second, third]);
    expect(studio.state()).toMatchObject({
      revision: 3,
      status: 'ready',
      lastGoodRevision: 3,
      fingerprint: '3'.repeat(64),
    });
    expect(studio.state().stats?.library.materials).toBe(1);
    await studio.accept(materialRevision(2));
    expect(studio.state().revision).toBe(3);
    await studio.accept({
      aegis: 'asset-preview-state/1',
      revision: 4,
      status: 'failed',
      lastPreparedRevision: 3,
      document: null,
      diagnostics: [
        {
          code: 'AEG-PREVIEW-0005',
          severity: 'error',
          message: 'New asset failed to decode.',
          location: { path: 'source' },
          fix: 'Repair the asset.',
        },
      ],
    });
    expect(studio.state()).toMatchObject({ revision: 4, status: 'failed', lastGoodRevision: 3 });
    expect(() => studio.capture(4)).toThrow('not available for rendering');
    const pending = studio.accept(materialRevision(5));
    studio.dispose();
    await pending;
    expect(studio.state()).toMatchObject({ status: 'disposed', stats: null });
    expect(guards.world).not.toHaveBeenCalled();
    expect(guards.simulation).not.toHaveBeenCalled();
  });

  it.each(['loading', 'ready'] as const)(
    'ignores a delayed preparing message after the same revision is already %s',
    async (phase) => {
      const { AssetPreviewStudio } = await import('./studio.js');
      const studio = new AssetPreviewStudio(studioCanvas());
      try {
        await studio.accept(materialRevision(1));
        const second = studio.accept(materialRevision(2));
        if (phase === 'ready') await second;
        expect(studio.state()).toMatchObject({ revision: 2, status: phase });
        await studio.accept({
          ...materialRevision(2),
          status: 'preparing',
          document: null,
          lastPreparedRevision: 1,
        });
        expect(studio.state()).toMatchObject({
          revision: 2,
          status: 'ready',
          lastGoodRevision: 2,
        });
        expect(studio.capture(2, 256, 256).revision).toBe(2);
        await second;
      } finally {
        studio.dispose();
      }
    },
  );

  it('joins an in-flight prepared revision instead of aborting and decoding it twice', async () => {
    const assetModule = await import('../presentation/assets.js');
    const { AssetPreviewStudio } = await import('./studio.js');
    const decode = vi.spyOn(assetModule, 'loadPresentationAssets');
    const studio = new AssetPreviewStudio(studioCanvas());
    try {
      await studio.accept(materialRevision(1));
      const second = studio.accept(materialRevision(2));
      const repeated = studio.accept(materialRevision(2));
      await second;
      expect(studio.state()).toMatchObject({ revision: 2, status: 'ready' });
      await repeated;
      expect(decode).toHaveBeenCalledTimes(2);
      expect(studio.capture(2, 256, 256).revision).toBe(2);
    } finally {
      studio.dispose();
      decode.mockRestore();
    }
  });

  it('waits for the latest load while rejecting an explicitly superseded ready revision', async () => {
    const assetModule = await import('../presentation/assets.js');
    const { AssetPreviewStudio } = await import('./studio.js');
    const studio = new AssetPreviewStudio(studioCanvas());
    const load = assetModule.loadPresentationAssets;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const decode = vi
      .spyOn(assetModule, 'loadPresentationAssets')
      .mockImplementation(async (presentation, options) => {
        if (presentation.baseUrl === './assets/r3/') await gate;
        return load(presentation, options);
      });
    try {
      await studio.accept(materialRevision(1));
      const second = studio.accept(materialRevision(2));
      const settled: string[] = [];
      const waiting = studio.ready().then(
        (state) => {
          settled.push('ready');
          return state;
        },
        (error: unknown) => {
          settled.push('failed');
          return error;
        },
      );
      const pinned = studio.ready(2).catch((error: unknown) => error);
      const third = studio.accept(materialRevision(3));
      await second;
      await settle();
      expect(studio.state()).toMatchObject({ revision: 3, status: 'loading' });
      expect(settled).toEqual([]);
      release();
      await third;
      expect(await waiting).toMatchObject({ revision: 3, status: 'ready' });
      expect(settled).toEqual(['ready']);
      expect(await pinned).toMatchObject({
        diagnostics: [{ code: 'AEG-PREVIEW-0004' }],
      });
      expect(studio.capture(3, 256, 256).revision).toBe(3);
    } finally {
      release();
      studio.dispose();
      decode.mockRestore();
    }
  });

  it.each(['failed', 'closed'] as const)(
    'keeps a %s source invalid despite late preparing messages and settings changes',
    async (status) => {
      const { AssetPreviewStudio } = await import('./studio.js');
      const studio = new AssetPreviewStudio(studioCanvas());
      try {
        await studio.accept(materialRevision(1));
        await studio.accept({
          ...materialRevision(1),
          status,
          document: null,
          diagnostics: [
            {
              code: 'AEG-PREVIEW-0007',
              severity: 'error',
              message: 'Lost contact with the preview server.',
              location: { path: 'connection' },
            },
          ],
        });
        await studio.accept({ ...materialRevision(1), status: 'preparing', document: null });
        await expect(studio.ready(1)).rejects.toThrow('Lost contact');
        expect(() => studio.capture(1)).toThrow();
        expect(() => studio.configure({ view: 'left' })).toThrow('not available');
        await studio.accept(materialRevision(1));
        if (status === 'failed') {
          await expect(studio.ready(1)).resolves.toMatchObject({ revision: 1, status: 'ready' });
          expect(studio.capture(1, 256, 256).revision).toBe(1);
        } else {
          await expect(studio.ready(1)).rejects.toThrow('Lost contact');
        }
      } finally {
        studio.dispose();
      }
    },
  );

  it('invalidates capture for a genuinely newer preparing revision until it is prepared', async () => {
    const { AssetPreviewStudio } = await import('./studio.js');
    const studio = new AssetPreviewStudio(studioCanvas());
    try {
      await studio.accept(materialRevision(1));
      await studio.accept({
        ...materialRevision(2),
        status: 'preparing',
        document: null,
        lastPreparedRevision: 1,
      });
      await expect(studio.ready(2)).rejects.toThrow('loading');
      expect(() => studio.capture(1)).toThrow('not available');
      await studio.accept(materialRevision(2));
      await expect(studio.ready(2)).resolves.toMatchObject({ revision: 2, status: 'ready' });
    } finally {
      studio.dispose();
    }
  });

  it('rejects readiness when the active load is disposed instead of returning last-good state', async () => {
    const { AssetPreviewStudio } = await import('./studio.js');
    const studio = new AssetPreviewStudio(studioCanvas());
    try {
      await studio.accept(materialRevision(1));
      const pending = studio.accept(materialRevision(2));
      const ready = studio.ready(2);
      studio.dispose();
      await pending;
      await expect(ready).rejects.toThrow('disposed');
      expect(studio.state()).toMatchObject({ status: 'disposed', stats: null });
    } finally {
      studio.dispose();
    }
  });
});
