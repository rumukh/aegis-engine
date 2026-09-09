import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.unstubAllGlobals();
});

describe('no-game proof for both standalone preview entry points', () => {
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
    vi.stubGlobal('document', { baseURI: 'http://127.0.0.1:5000/' });
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const canvas = Object.assign(new EventTarget(), {
      parentElement: null,
      width: 640,
      height: 360,
      getBoundingClientRect: () => ({ width: 640, height: 360 }),
    }) as HTMLCanvasElement;
    const studio = new AssetPreviewStudio(canvas);
    await studio.accept({
      aegis: 'asset-preview-state/1',
      revision: 1,
      status: 'prepared',
      lastPreparedRevision: 1,
      diagnostics: [],
      document: {
        revision: 1,
        fingerprint: 'fixture',
        source: { name: 'material.json', format: 'presentation/1', sha256: 'fixture', bytes: 123 },
        dependencies: [],
        selection: { kind: 'material', id: 'matte' },
        choices: [{ kind: 'material', id: 'matte' }],
        prepareMs: 1,
        presentation: {
          baseUrl: './assets/r1/',
          files: [],
          manifest: { aegis: 'presentation/1', materials: [{ id: 'matte', shading: 'standard' }] },
        },
      },
    });
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
});
