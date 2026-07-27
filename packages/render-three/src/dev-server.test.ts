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
import { findRepoRoot } from './catalog.js';
import { BINDINGS } from './bindings.js';
import { escapeHtml, importMap } from './pages.js';
import type { ControlRequest, EventLog, FrameResponse } from './protocol.js';
import type { GameDefinition } from './catalog.js';
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

/** POST a session-control command and return the response body. */
async function postControl(id: string, body: ControlRequest): Promise<FrameResponse> {
  const response = await fetch(`${server.url}/api/${id}/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
    // Without this the comparison below is vacuous: `hash` is optional on the wire, and
    // `undefined === undefined` would read as "the snapshot round-trips losslessly".
    expect(typeof body.hash).toBe('string');
    expect(mirror.hash()).toBe(body.hash);
  });

  it('omits the state hash from the per-frame channel and keeps it on /state', async () => {
    // A cost guard, not a preference. Hashing a world walks every entity *and every resource*;
    // measured on the PoC worlds it costs 11.3ms (fps), 5.3ms (platformer) and 1.9ms (iso)
    // against 0.55ms to snapshot and 0.14ms to serialise. Computing it once per displayed frame
    // capped the fps game at ~26 exchanges per second, for a field the page never reads.
    now += 1;
    const frameBody = await frame('platformer');
    expect(frameBody.snapshot).toBeDefined();
    expect(frameBody.hash).toBeUndefined();

    const stateBody = (await (
      await fetch(`${server.url}/api/platformer/state`)
    ).json()) as FrameResponse;
    expect(typeof stateBody.hash).toBe('string');
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

  it('steps a batch of ticks in one request, so a script replay is not thousands of them', async () => {
    await postControl('platformer', { command: 'restart' });
    await postControl('platformer', { command: 'pause' });
    const before = await postControl('platformer', { command: 'step', ticks: 0 });
    const after = await postControl('platformer', { command: 'step', ticks: 40 });
    expect(after.tick).toBe(before.tick + 40);

    // A missing count means one tick; a silly one is clamped rather than hanging the server.
    const one = await postControl('platformer', { command: 'step' });
    expect(one.tick).toBe(after.tick + 1);
    const clamped = await postControl('platformer', { command: 'step', ticks: -5 });
    expect(clamped.tick).toBe(one.tick);
  });

  it('restart leaves the session paused, so a caller can reach a known tick 0', async () => {
    await postControl('iso', { command: 'pause' });
    const restarted = await postControl('iso', { command: 'restart' });
    expect(restarted.tick).toBe(0);
    expect(restarted.paused).toBe(true);
    now += 5;
    expect((await frame('iso')).tick).toBe(0);
    await postControl('iso', { command: 'resume' });
  });

  it('reports the full event log without disturbing the page feed', async () => {
    await postControl('platformer', { command: 'restart' });
    await postControl('platformer', { command: 'resume' });
    now += 2;
    await frame('platformer');

    const log = (await (await fetch(`${server.url}/api/platformer/events`)).json()) as EventLog;
    expect(log.tick).toBeGreaterThan(0);
    expect(log.events.length).toBeGreaterThan(0);
    // Reading it twice returns the same thing: it is a log, not a queue.
    const again = (await (await fetch(`${server.url}/api/platformer/events`)).json()) as EventLog;
    expect(again.events).toEqual(log.events);
  });

  it('only the page frame channel drains the event cursor', async () => {
    // The screenshot capture drives sessions through `control`; when that drained the cursor, the
    // page's on-screen feed came out empty and the photograph showed no evidence of the run.
    await postControl('platformer', { command: 'restart' });
    await postControl('platformer', { command: 'resume' });
    now += 2;

    const control1 = await postControl('platformer', { command: 'step', ticks: 30 });
    expect(control1.events).toEqual([]);
    const state = (await (
      await fetch(`${server.url}/api/platformer/state`)
    ).json()) as FrameResponse;
    expect(state.events).toEqual([]);

    // The page still receives everything emitted since it last looked.
    const page = await frame('platformer');
    expect(page.events.length).toBeGreaterThan(0);
  });
});
