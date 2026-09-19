import { createReadStream, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CdpDisconnectedError,
  CdpProtocolError,
  closeAllPages,
  click,
  evaluate,
  launchBrowser,
  openPage,
  stopExternalLagWitness,
  until,
} from './browser.js';
import type { LaunchedBrowser } from './browser.js';
import { navigateAndWait } from './browser-navigation.js';
import { closeOwnedBrowser } from './testing/browser-lifecycle.js';
import { findRepoRoot } from './catalog.js';
import { importMap } from './pages.js';
import { resolveVendorPath } from './vendor.js';
import { PLATFORMER_SCENE } from './testing/scenes.js';

let browser: LaunchedBrowser;
let url: string;
let revision = 0;
let holding = false;
let held: (() => void) | undefined;
let received: (() => void) | undefined;
let heldImage: (() => void) | undefined;
const repoRoot = findRepoRoot();
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  response.setHeader('cache-control', 'no-store');
  const path = new URL(request.url ?? '/', 'http://local').pathname;
  if (path.startsWith('/vendor/')) {
    const file = resolveVendorPath(repoRoot, path);
    if (file === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('content-type', 'text/javascript');
    createReadStream(file).pipe(response);
    return;
  }
  if (path === '/held.svg') {
    heldImage = () => {
      heldImage = undefined;
      response.setHeader('content-type', 'image/svg+xml');
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#336699"/></svg>',
      );
    };
    return;
  }
  if (path === '/asset-page') {
    response.end(`<!doctype html><title>production asset preload</title>
      <canvas id="stage" style="width:100vw;height:100vh"></canvas>
      <script type="importmap">${importMap('/')}</script>
      <script type="module">
        import {bootStatic} from '/vendor/@aegis/render-three/dist/client/static-boot.js';
        import {platformerPlugin} from '@aegis/mode-platformer';
        bootStatic({gameId:'held-navigation',mode:'platformer',plugin:platformerPlugin,
          scene:${JSON.stringify(PLATFORMER_SCENE)},
          presentation:{manifest:{aegis:'presentation/1',assets:[{
            id:'held',kind:'texture',src:'held.svg',
            provenance:{author:'Aegis tests',license:'MIT',source:'browser-navigation.browser.test.ts'}
          }]},baseUrl:'./'}});
      </script>`);
    return;
  }
  if (request.url === '/child') {
    response.end('<!doctype html><title>child</title>Subframe');
    return;
  }
  if (request.url !== '/page') {
    response.writeHead(204).end();
    return;
  }
  const next = ++revision;
  const write = (reply: ServerResponse): void => {
    reply.end(`<!doctype html><title>revision ${next}</title>
      <button id="retry" onclick="if(event.isTrusted)location.reload()">Retry</button>
      <iframe src="/child"></iframe><script>globalThis.revision=${next};</script>`);
  };
  if (holding) {
    holding = false;
    held = () => {
      held = undefined;
      write(response);
    };
    received?.();
  } else write(response);
});

beforeAll(async () => {
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Navigation fixture did not bind.');
  url = `http://127.0.0.1:${address.port}/page`;
  browser = await launchBrowser({ viewport: { width: 640, height: 360 } });
}, 120_000);

afterAll(async () => {
  held?.();
  heldImage?.();
  try {
    if (browser !== undefined) {
      await closeAllPages(browser.port);
      await closeOwnedBrowser(browser);
      rmSync(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  } finally {
    stopExternalLagWitness();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

describe('real explicit navigation boundaries', () => {
  it('can observe real production asset loading after document load while its image fetch is held', async () => {
    const page = await openPage(browser.port, 'about:blank', { width: 640, height: 360 });
    try {
      const result = await navigateAndWait(page, () =>
        page.send('Page.navigate', { url: new URL('/asset-page', url).href }),
      );
      await until<string>(
        page,
        'globalThis.aegis?.presentation().status',
        (status) => status === 'loading',
        10_000,
      );
      expect(heldImage).toBeDefined();
      expect(await evaluate(page, 'document.readyState')).toBe('complete');
      expect(result.executionContextId).toBeGreaterThan(0);
      expect(await evaluate(page, 'globalThis.aegis.tick()')).toBe(-1);
      expect(await evaluate(page, 'globalThis.aegis.presentation().assets === undefined')).toBe(
        true,
      );
      heldImage?.();
      await until<string>(
        page,
        'globalThis.aegis.presentation().status',
        (status) => status === 'ready',
        10_000,
      );
      expect(await evaluate(page, 'globalThis.aegis.presentation().assets.loadedFiles')).toBe(1);
      expect(await evaluate<number>(page, 'globalThis.aegis.tick()')).toBeGreaterThanOrEqual(0);
      expect(page.diagnostics).toEqual([]);
    } finally {
      heldImage?.();
      try {
        await page.send('Page.navigate', { url: 'about:blank' });
      } finally {
        page.close();
      }
    }
  }, 120_000);

  it('waits for a held reload to commit/load and evaluates only the new default context', async () => {
    const page = await openPage(browser.port, url, { width: 640, height: 360 });
    try {
      const before = await until<number>(
        page,
        'globalThis.revision',
        (value) => typeof value === 'number',
      );
      const original = await page.send<{ frameTree: { frame: { id: string; loaderId: string } } }>(
        'Page.getFrameTree',
      );
      const requested = new Promise<void>((done) => {
        received = done;
      });
      holding = true;
      const calls = vi.spyOn(page, 'send');
      let settled = false;
      const navigation = navigateAndWait(page, () =>
        page.send('Page.reload', { ignoreCache: true }),
      );
      void navigation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.race([
        requested,
        navigation.then(() => {
          throw new Error('Navigation completed before its held document response.');
        }),
      ]);
      expect(settled).toBe(false);
      expect(calls.mock.calls.map(([method]) => method)).not.toContain('Runtime.evaluate');
      held?.();
      const result = await navigation;
      expect(result.frameId).toBe(original.frameTree.frame.id);
      expect(result.loaderId).not.toBe(original.frameTree.frame.loaderId);
      const value = await page.send<{ result: { value: number } }>('Runtime.evaluate', {
        expression: 'globalThis.revision',
        contextId: result.executionContextId,
        returnByValue: true,
      });
      expect(value.result.value).toBeGreaterThan(before);
      expect(page.diagnostics).toEqual([]);
      calls.mockRestore();
    } finally {
      holding = false;
      held?.();
      received = undefined;
      page.close();
    }
  }, 120_000);

  it('arms before a real trusted retry click and observes another document, not its iframe', async () => {
    const page = await openPage(browser.port, url, { width: 640, height: 360 });
    try {
      const before = await until<number>(
        page,
        'globalThis.revision',
        (value) => typeof value === 'number',
      );
      const button = await evaluate<{ x: number; y: number }>(
        page,
        "(()=>{const r=document.getElementById('retry').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
      );
      const result = await navigateAndWait(page, () => click(page, button.x, button.y));
      expect(result.url).toBe(url);
      expect(await evaluate<number>(page, 'globalThis.revision')).toBeGreaterThan(before);
      expect(page.diagnostics).toEqual([]);
    } finally {
      page.close();
    }
  }, 120_000);

  it('rejects a genuinely closed target rather than retrying through it', async () => {
    const page = await openPage(browser.port, url, { width: 640, height: 360 });
    try {
      await expect(navigateAndWait(page, () => page.send('Page.close'))).rejects.toBeInstanceOf(
        CdpDisconnectedError,
      );
    } finally {
      page.close();
    }
  }, 120_000);

  it('reports method and protocol code and leaves non-navigation evaluation failures fatal', async () => {
    const page = await openPage(browser.port, url, { width: 640, height: 360 });
    try {
      const invalid = page.send('Runtime.evaluate', { expression: '1', contextId: -987654 });
      await expect(invalid).rejects.toBeInstanceOf(CdpProtocolError);
      await expect(invalid).rejects.toMatchObject({ method: 'Runtime.evaluate', code: -32000 });
      expect(await evaluate<number>(page, '6 * 7')).toBe(42);
    } finally {
      page.close();
    }
  }, 120_000);
});
