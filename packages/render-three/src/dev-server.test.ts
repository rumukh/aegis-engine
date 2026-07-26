/**
 * The dev server: pages, module serving, and the one round trip that makes the game playable
 * (input up, world snapshot down).
 *
 * The server is driven with a fake clock so the fixed-step behaviour is asserted exactly rather
 * than raced against a real one — which is also a small proof that the only wall-clock dependency
 * is injectable, and therefore isolated.
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld } from '@aegis/core';
import { PlatformerController } from '@aegis/mode-platformer';
import { platformerPlugin } from '@aegis/mode-platformer';
import { isoPlugin } from '@aegis/mode-iso';
import { startDevServer, resolveVendorPath } from './dev-server.js';
import type { DevServer } from './dev-server.js';
import { findRepoRoot } from './games.js';
import { BINDINGS } from './bindings.js';
import { escapeHtml, importMap } from './pages.js';
import type { FrameResponse } from './protocol.js';
import type { GameDefinition } from './games.js';
import { ISO_SCENE, PLATFORMER_SCENE } from './testing/scenes.js';

const repoRoot = findRepoRoot();

/** A two-entry catalogue built from the mode plugins — the server is game-agnostic. */
const GAMES: GameDefinition[] = [
  {
    id: 'platformer',
    title: 'Test Platformer',
    blurb: 'a side-on test level',
    objective: 'reach the goal',
    mode: 'platformer',
    plugin: platformerPlugin,
    scene: PLATFORMER_SCENE,
    bindings: BINDINGS.platformer,
  },
  {
    id: 'iso',
    title: 'Test Vault',
    blurb: 'an isometric test level',
    objective: 'reach the exit',
    mode: 'iso',
    plugin: isoPlugin,
    scene: ISO_SCENE,
    bindings: BINDINGS.iso,
  },
];

/** A fake monotonic clock, in seconds. */
let now = 0;

let server: DevServer;

beforeAll(async () => {
  now = 0;
  server = await startDevServer({ games: GAMES, port: 0, repoRoot, clock: () => now });
});

afterAll(async () => {
  await server.close();
});

/** POST a frame with no input and return the response body. */
async function frame(id: string): Promise<FrameResponse> {
  const response = await fetch(`${server.url}/api/${id}/frame`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { seq: Date.now(), axes: {} } }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as FrameResponse;
}

describe('dev server', () => {
  it('refuses to start with an empty catalogue', () => {
    expect(() => startDevServer({ games: [], repoRoot })).toThrow(/at least one game/);
  });

  it('serves a landing page linking every game', async () => {
    const html = await (await fetch(server.url)).text();
    for (const game of GAMES) {
      expect(html).toContain(`/play/${game.id}`);
      expect(html).toContain(escapeHtml(game.title));
    }
  });

  it('serves a play page with the import map and the boot script', async () => {
    const html = await (await fetch(`${server.url}/play/iso`)).text();
    expect(html).toContain('<canvas id="stage">');
    expect(html).toContain('importmap');
    expect(html).toContain('/vendor/@aegis/render-three/dist/client/boot.js');
    expect(html).toContain('"mode":"iso"');
    // The control help is rendered from the same binding table the browser applies.
    for (const line of BINDINGS.iso.help) expect(html).toContain(escapeHtml(line.does));
  });

  it('escapes untrusted-looking text in pages', () => {
    expect(escapeHtml('<script>"x" & y</script>')).toBe(
      '&lt;script&gt;&quot;x&quot; &amp; y&lt;/script&gt;',
    );
  });

  it('maps every bare specifier the client imports', () => {
    const map = JSON.parse(importMap()) as { imports: Record<string, string> };
    for (const specifier of [
      'three',
      '@aegis/core',
      '@aegis/core/math',
      '@aegis/content',
      '@aegis/mode-platformer',
      '@aegis/mode-iso',
      '@aegis/mode-fps',
    ]) {
      expect(map.imports[specifier], specifier).toMatch(/^\/vendor\//);
    }
  });

  it('serves workspace modules and three from /vendor', async () => {
    const core = await fetch(`${server.url}/vendor/@aegis/core/dist/index.js`);
    expect(core.status).toBe(200);
    expect(core.headers.get('content-type')).toContain('text/javascript');
    expect(await core.text()).toContain('export');

    const three = await fetch(`${server.url}/vendor/three/build/three.module.js`);
    expect(three.status).toBe(200);
  });

  it('refuses to serve anything outside the vendor roots', async () => {
    expect(
      resolveVendorPath(repoRoot, '/vendor/@aegis/core/../../../package.json'),
    ).toBeUndefined();
    expect(resolveVendorPath(repoRoot, '/vendor/../package.json')).toBeUndefined();
    expect(resolveVendorPath(repoRoot, '/vendor/node_modules/vitest/package.json')).toBeUndefined();
    expect(resolveVendorPath(repoRoot, '/vendor/')).toBeUndefined();
    expect(resolveVendorPath(repoRoot, '/vendor/@aegis/core/dist/index.js')).toBeDefined();
    expect((await fetch(`${server.url}/vendor/@aegis/core/nope.js`)).status).toBe(404);
  });

  it('returns 404 for an unknown game and an unknown route', async () => {
    expect((await fetch(`${server.url}/api/nope/state`)).status).toBe(404);
    expect((await fetch(`${server.url}/nowhere`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/iso/frame`)).status).toBe(405);
  });

  it('advances exactly the fixed steps the elapsed wall-clock has earned', async () => {
    const initial = await frame('platformer');
    expect(initial.tick).toBe(0);
    expect(initial.steps).toBe(0);

    now += 1 / 60 - 1e-6;
    expect((await frame('platformer')).steps).toBe(0);

    now += 1e-6;
    const one = await frame('platformer');
    expect(one.steps).toBe(1);
    expect(one.tick).toBe(1);

    now += 5 / 60;
    const five = await frame('platformer');
    expect(five.steps).toBe(5);
    expect(five.tick).toBe(6);
  });

  it('feeds live input into the simulation and returns the resulting world', async () => {
    const before = server.session('iso');
    expect(before).toBeDefined();

    const response = await fetch(`${server.url}/api/platformer/frame`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { seq: 10_000, axes: { MoveX: 1 } } }),
    });
    now += 1;
    await frame('platformer');
    const body = (await (
      await fetch(`${server.url}/api/platformer/state`)
    ).json()) as FrameResponse;
    expect(response.status).toBe(200);

    // The renderer's view of the world: rebuild it from JSON, exactly as the page does.
    const mirror = createWorld({ seed: 0 });
    mirror.restore(body.snapshot);
    const player = mirror.query({ has: [PlatformerController] }).one();
    expect(player).toBeDefined();
    expect(mirror.tick).toBe(body.tick);
    expect(mirror.hash()).toBe(body.hash);
  });

  it('reports the simulation events emitted since the previous frame', async () => {
    now += 2;
    await frame('iso');
    const body = await frame('iso');
    expect(Array.isArray(body.events)).toBe(true);
    for (const event of body.events) {
      expect(typeof event.type).toBe('string');
      expect(typeof event.tick).toBe('number');
    }
  });

  it('supports pause, single-step and restart', async () => {
    await fetch(`${server.url}/api/iso/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'restart' }),
    });
    const start = await frame('iso');
    expect(start.tick).toBe(0);

    const paused = (await (
      await fetch(`${server.url}/api/iso/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'pause' }),
      })
    ).json()) as FrameResponse;
    expect(paused.paused).toBe(true);

    now += 1;
    expect((await frame('iso')).tick).toBe(0);

    const stepped = (await (
      await fetch(`${server.url}/api/iso/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'step' }),
      })
    ).json()) as FrameResponse;
    expect(stepped.tick).toBe(1);

    const resumed = (await (
      await fetch(`${server.url}/api/iso/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'resume' }),
      })
    ).json()) as FrameResponse;
    expect(resumed.paused).toBe(false);
  });
});
