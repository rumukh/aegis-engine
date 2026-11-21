import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  closeAllPages,
  evaluate,
  key,
  launchBrowser,
  openPage,
  stopExternalLagWitness,
  until,
} from '../packages/render-three/src/browser.js';
import { closeOwnedBrowser } from '../packages/render-three/src/testing/browser-lifecycle.js';
import { standaloneFixture } from './support/standalone-game.js';

let f: ReturnType<typeof standaloneFixture>;
let live: Awaited<ReturnType<typeof f.startLive>>;
let browser: Awaited<ReturnType<typeof launchBrowser>>;
let server: ReturnType<typeof createServer>;
let staticUrl: string;
const staticPaths: string[] = [];
const rejected: string[] = [];

beforeAll(async () => {
  f = standaloneFixture();
  await f.cli(['scaffold', 'game', 'first-light']);
  const result = JSON.parse((await f.cli(['export', '.', '--json'], f.game)).stdout);
  const prefix = '/review/static/';
  const files = new Map(
    (result.files as string[]).map((path) => [prefix + path, join(result.outDir, path)]),
  );
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    staticPaths.push(path);
    const file = files.get(path.endsWith('/') ? path + 'index.html' : path);
    if (req.method !== 'GET' || !file) {
      rejected.push(`${req.method} ${path}`);
      res.writeHead(404).end();
      return;
    }
    const type =
      extname(file) === '.js'
        ? 'text/javascript'
        : extname(file) === '.html'
          ? 'text/html'
          : 'text/plain';
    res.writeHead(200, { 'content-type': type });
    res.end(readFileSync(file));
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No static HTTP listener.');
  staticUrl = `http://127.0.0.1:${address.port}${prefix}play/first-light/`;
  live = await f.startLive();
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  try {
    if (browser) {
      try {
        await closeAllPages(browser.port);
      } finally {
        await closeOwnedBrowser(browser);
      }
      rmSync(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  } finally {
    stopExternalLagWitness();
    if (live) await live.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
    f?.dispose();
  }
});

it.each(['live', 'static'] as const)(
  'plays the actual scaffold under a prefix on the %s host',
  async (transport) => {
    const url = transport === 'live' ? live.url : staticUrl;
    const page = await openPage(browser.port, url);
    try {
      await until(page, 'globalThis.aegis?.presentation().status', (value) => value === 'ready');
      expect(await evaluate(page, 'document.title')).toContain('first-light');
      expect(await evaluate(page, 'document.body.textContent')).toContain(
        'first-light · platformer',
      );
      const x = "aegis.world.query({has:['Player','Transform']}).one().get('Transform').position.x";
      const start = await evaluate<number>(page, x);
      const tick = await evaluate<number>(page, 'aegis.tick()');
      await key(page, 'KeyD', true);
      try {
        await until<number>(page, x, (value) => value > start + 0.5);
      } finally {
        await key(page, 'KeyD', false);
      }
      expect(await evaluate<number>(page, 'aegis.tick()')).toBeGreaterThan(tick);
      expect(
        await evaluate(
          page,
          `fetch(document.querySelector('a[download]').href).then(r => r.text())`,
        ),
      ).toContain('hold Right 0..120');
      expect(page.diagnostics).toEqual([]);
      if (transport === 'static') {
        expect(staticPaths).toContain('/review/static/play/first-light/boot.js');
        expect(staticPaths.some((p) => p.includes('/vendor/'))).toBe(true);
        expect(staticPaths.some((p) => p.includes('/api/'))).toBe(false);
        expect(rejected).toEqual([]);
      }
    } finally {
      try {
        await page.send('Page.navigate', { url: 'about:blank' });
      } finally {
        page.close();
      }
    }
  },
  120_000,
);
