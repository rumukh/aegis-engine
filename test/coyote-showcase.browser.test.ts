import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashString } from '@aegis/core';
import { parseInputScript, runScene } from '@aegis/harness';
import {
  corpseCannotFinishTest,
  critterGoreTest,
  fellOutOfWorldTest,
  spikePitDeathTest,
} from '../games/platformer/src/coyote-gap.gametest.js';
import { platformer } from '../poc/platformer.mjs';
import { pocGames, pocStaticGames, pocStaticModules } from '../poc/poc-games.mjs';
import {
  click,
  evaluate,
  key,
  launchBrowser,
  openPage,
  screenshot,
  stopExternalLagWitness,
  until,
  waitForPaint,
} from '../packages/render-three/src/browser.js';
import type { CdpSession, LaunchedBrowser } from '../packages/render-three/src/browser.js';
import { closeOwnedBrowser } from '../packages/render-three/src/testing/browser-lifecycle.js';
import { startDevServer } from '../packages/render-three/src/dev-server.js';
import type { DevServer } from '../packages/render-three/src/dev-server.js';
import type { GameDefinition } from '../packages/render-three/src/catalog.js';
import { exportStaticSite } from '../packages/render-three/src/static-site.js';
import { compileDomInput } from '../packages/render-three/src/script-input.js';
import type { EventLine } from '../packages/render-three/src/protocol.js';
import type { AudioState } from '../packages/render-three/src/client/audio.js';
import type { PresentationAssetStats } from '../packages/render-three/src/presentation/assets.js';
import type { PresentationStats } from '../packages/render-three/src/presentation/runtime.js';

type Transport = 'dev' | 'static';
interface HostStats {
  status: string;
  generation: number;
  assets: PresentationAssetStats;
  render: PresentationStats;
  audio: AudioState;
}
interface Seen {
  tick: number;
  hash: string;
  position: { x: number; y: number };
  velocity: { dx: number; dy: number };
  body: { grounded: boolean; carriedBy: number };
  playerFrame: string | null;
  goalFrame: string | null;
  critterFrame: string | null;
  progress: string;
  outcome: string;
  host: HostStats;
}

const VIEWPORT = { width: 640, height: 360 };
const PREFIX = '/nested/coyote/';
const CAPTURE = process.env['AEGIS_COYOTE_CAPTURE_DIR'];
const REPORT: Record<string, unknown> = {
  testedBase: process.env['AEGIS_COYOTE_TESTED_SHA'] ?? 'working tree',
  viewport: VIEWPORT,
  routes: [],
  images: [],
  lifecycle: [],
};
const BEATS = new Map([
  [0, 'vista'],
  [16, 'walk'],
  [96, 'stomp-approach'],
  [104, 'stomp'],
  [158, 'ferry-boarded'],
  [186, 'ferry-carried'],
  [289, 'coyote'],
  [318, 'buffered-press'],
  [321, 'landing'],
  [322, 'buffered-jump'],
  [329, 'victory'],
  [400, 'finish'],
]);
const LOSSES = [
  { id: 'spikes', spec: spikePitDeathTest, tick: 43, cause: 'hazard' },
  { id: 'gore', spec: critterGoreTest, tick: 91, cause: 'critter' },
  { id: 'missed-jump', spec: fellOutOfWorldTest, tick: 319, cause: 'fell' },
  { id: 'corpse-at-goal', spec: corpseCannotFinishTest, tick: 91, cause: 'critter' },
];
let temporary: string;
let browser: LaunchedBrowser;
let dev: DevServer;
let fileServer: Server;
let origin: string;
let game: GameDefinition;
let holdAsset: Promise<void> | undefined;
let releaseAsset: (() => void) | undefined;
const requests: { path: string; method: string; status: number }[] = [];

const READ = `(async () => {
  const {Name,Transform}=await import('@aegis/core');
  const {BodyState,Velocity}=await import('@aegis/mode-platformer');
  const a=globalThis.aegis, runtime=a.adapter.presentation;
  const player=a.world.query({has:[Name]}).views().find(v=>v.get(Name).value==='player');
  const frame=(entity,asset) => {
    const map=runtime.entity(entity).object.material.map;
    const frames=runtime.manifest.assets.find(a=>a.id===asset).frames;
    return Object.entries(frames).find(([,r])=>Math.abs(map.offset.x-r[0])<1e-9&&Math.abs(map.offset.y-(1-r[3]))<1e-9)?.[0]??null;
  };
  return {tick:a.tick(),hash:a.world.hash(),position:player.get(Transform).position,
    velocity:player.get(Velocity),body:player.get(BodyState),host:a.presentation(),
    playerFrame:frame('player','engineer'),goalFrame:frame('goal','beacon'),critterFrame:frame('critter','critter'),
    progress:document.getElementById('hud-progress').textContent,
    outcome:document.getElementById('hud-outcome').textContent};
})()`;

function record(section: string, value: unknown): void {
  const entries = REPORT[section];
  assert.ok(Array.isArray(entries));
  entries.push(value);
}

async function capture(cdp: CdpSession, name: string, decision: string): Promise<void> {
  if (CAPTURE === undefined) return;
  const file = join(CAPTURE, `check-${name}.png`);
  await screenshot(cdp, file);
  const viewport = await evaluate(cdp, '({width:innerWidth,height:innerHeight})');
  record('images', {
    file,
    tick: await evaluate(cdp, 'globalThis.aegis?.tick() ?? -1'),
    viewport,
    assertion: decision,
  });
}

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'aegis-coyote-browser-'));
  const found = (await pocGames()).find((entry) => entry.id === 'platformer');
  assert.ok(found?.script);
  game = found;
  dev = await startDevServer({ games: [game], port: 0, basePath: '/coyote-dev/' });
  const site = exportStaticSite({
    games: (await pocStaticGames()).filter((entry) => entry.id === 'platformer'),
    modules: await pocStaticModules(),
    repoRoot: resolve('.'),
    outDir: join(temporary, 'site'),
  });
  const files = new Map(
    site.files.map((file) => [
      `${PREFIX}${file.replaceAll('\\', '/')}`,
      join(site.outDir, ...file.split(/[\\/]/)),
    ]),
  );
  const mime: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.wav': 'audio/wav',
  };
  fileServer = createServer((request, response) => {
    let path = new URL(request.url ?? '/', 'http://local').pathname;
    if (path.endsWith('/')) path += 'index.html';
    const file = files.get(path);
    const status = request.method === 'GET' && file !== undefined ? 200 : 404;
    requests.push({ path, method: request.method ?? '', status });
    if (status !== 200 || file === undefined) {
      response.writeHead(404).end(`Unexported request ${path}`);
      return;
    }
    void (async () => {
      if (path.endsWith('/engineer.svg') && holdAsset !== undefined) await holdAsset;
      const bytes = await readFile(file);
      response.writeHead(200, {
        'content-type': mime[extname(file)] ?? 'application/octet-stream',
      });
      response.end(bytes);
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((done, fail) => {
    fileServer.once('error', fail);
    fileServer.listen(0, '127.0.0.1', done);
  });
  const address = fileServer.address();
  assert.ok(address !== null && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  expect((await fetch(`${dev.url}/play/platformer/`)).status).toBe(200);
  expect((await fetch(`${origin}${PREFIX}play/platformer/`)).status).toBe(200);
  browser = await launchBrowser({ viewport: VIEWPORT });
  REPORT['browser'] = { pid: browser.process.pid, port: browser.port, profile: browser.profile };
  const blank = await openPage(browser.port, 'about:blank', VIEWPORT);
  try {
    await waitForPaint(blank);
  } finally {
    blank.close();
  }
  REPORT['assetFiles'] = site.files.filter((file) => file.startsWith('assets/'));
}, 150_000);

afterAll(async () => {
  releaseAsset?.();
  try {
    if (browser !== undefined) {
      try {
        await closeOwnedBrowser(browser);
        REPORT['teardown'] = {
          method: 'Browser.close',
          processExited: true,
          exitCode: browser.process.exitCode,
        };
      } catch (error) {
        REPORT['teardownFailure'] = String(error);
        throw error;
      } finally {
        await rm(browser.profile, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        });
      }
    }
  } finally {
    stopExternalLagWitness();
    await dev?.close();
    if (fileServer !== undefined) {
      fileServer.closeAllConnections();
      await new Promise<void>((done, fail) =>
        fileServer.close((error) => (error === undefined ? done() : fail(error))),
      );
    }
    if (CAPTURE !== undefined) {
      await mkdir(CAPTURE, { recursive: true });
      await writeFile(
        join(CAPTURE, 'coyote-browser-acceptance.json'),
        `${JSON.stringify({ ...REPORT, requests }, null, 2)}\n`,
      );
    }
    if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
  }
});

const urlFor = (transport: Transport) =>
  transport === 'dev' ? `${dev.url}/play/platformer/` : `${origin}${PREFIX}play/platformer/`;

async function ready(cdp: CdpSession): Promise<void> {
  await until<string>(
    cdp,
    'globalThis.aegis?.presentation().status',
    (value) => value === 'ready' || value === 'error',
  );
  await evaluate(cdp, 'globalThis.aegis.ready.then(() => true)');
}

async function withPage(transport: Transport, action: (cdp: CdpSession) => Promise<void>) {
  const cdp = await openPage(browser.port, urlFor(transport), VIEWPORT);
  try {
    await ready(cdp);
    await action(cdp);
    expect(cdp.diagnostics).toEqual([]);
  } finally {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    cdp.close();
  }
}

async function tap(cdp: CdpSession, code: string): Promise<void> {
  await key(cdp, code, true);
  await key(cdp, code, false);
}

async function control(command: string, ticks?: number): Promise<void> {
  const response = await fetch(`${dev.url}/api/platformer/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, ticks }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
}

async function sync(cdp: CdpSession): Promise<void> {
  await evaluate(cdp, 'globalThis.aegis.sync().then(() => null)');
}

async function reset(cdp: CdpSession, transport: Transport): Promise<void> {
  await evaluate(cdp, "document.getElementById('stage').focus(); null");
  if (transport === 'dev') {
    await control('pause');
    await control('restart');
  } else {
    if (!(await evaluate<boolean>(cdp, 'globalThis.aegis.paused()'))) await tap(cdp, 'KeyP');
    await tap(cdp, 'KeyR');
  }
  await until<number>(cdp, 'globalThis.aegis.tick()', (tick) => tick === 0);
  await sync(cdp);
}

async function events(transport: Transport, cdp: CdpSession): Promise<readonly EventLine[]> {
  return transport === 'static'
    ? evaluate(cdp, 'globalThis.aegis.events()')
    : dev.session('platformer')!.world.events.history();
}

async function pressControl(cdp: CdpSession, selector: string): Promise<void> {
  const point = await evaluate<{ x: number; y: number }>(
    cdp,
    `(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await click(cdp, point.x, point.y);
}

async function drive(
  cdp: CdpSession,
  transport: Transport,
  script: string,
  ticks: number,
  route: string,
  deathTick?: number,
): Promise<{ seen: Map<number, Seen>; hashes: string[] }> {
  const parsed = parseInputScript(script);
  assert.ok(parsed.ok && parsed.value);
  const frames = parsed.value.frames(ticks);
  const plan = compileDomInput(frames, game.bindings);
  const seen = new Map<number, Seen>();
  const hashes: string[] = [];
  await reset(cdp, transport);
  if (route === 'win') {
    seen.set(0, await evaluate<Seen>(cdp, READ));
    await capture(cdp, `${transport}-vista`, 'Initial real character, terrain and canyon visible.');
  }
  for (const segment of plan.segments) {
    for (const code of segment.keyUp) await key(cdp, code, false);
    for (const code of segment.keyDown) await key(cdp, code, true);
    await sync(cdp);
    for (let tick = segment.tick + 1; tick <= segment.tick + segment.ticks; tick++) {
      if (transport === 'dev') await control('step', 1);
      else await tap(cdp, 'Period');
      await until<number>(cdp, 'globalThis.aegis.tick()', (actual) => actual === tick, 10_000);
      if (route === 'win')
        hashes.push(await evaluate<string>(cdp, 'globalThis.aegis.world.hash()'));
      if ((route === 'win' && BEATS.has(tick)) || tick === deathTick || tick === ticks) {
        await sync(cdp);
        const frame = await evaluate<Seen>(cdp, READ);
        seen.set(tick, frame);
        if (route === 'win' && (tick === 158 || tick === 186))
          expect(frames[tick - 1]!.actions['Right']).not.toBe(true);
        await capture(
          cdp,
          `${transport}-${route === 'win' ? BEATS.get(tick) : `${route}-${tick}`}`,
          route === 'win'
            ? `Original playthrough beat at world tick ${tick}.`
            : `Original ${route} lose route; failure must remain visible and cannot become a win.`,
        );
      }
    }
  }
  for (const code of new Set(plan.segments.flatMap((segment) => segment.keyDown)))
    await key(cdp, code, false);
  await sync(cdp);
  return { seen, hashes };
}

describe('Coyote Gap real browser acceptance', () => {
  for (const transport of ['dev', 'static'] as const) {
    it(`${transport}: completes the original route, including no-input carry, coyote and buffered jumps`, async () => {
      await withPage(transport, async (cdp) => {
        assert.ok(game.script);
        const { seen, hashes } = await drive(cdp, transport, game.script, 400, 'win');
        expect(hashes).toHaveLength(400);
        expect(hashes.at(-1)).toBe('d813e4e19db7444d');
        expect(hashString(hashes.join('|'))).toBe('79d373c4785825ca');
        const before = seen.get(158)!;
        const after = seen.get(186)!;
        expect(before.body.carriedBy).not.toBe(-1);
        expect(after.body.carriedBy).toBe(before.body.carriedBy);
        expect(before.velocity.dx).toBe(0);
        expect(after.velocity.dx).toBe(0);
        expect(after.position.x).toBeGreaterThan(before.position.x);
        expect(seen.get(289)!.playerFrame).toBe('jump');
        expect(seen.get(318)!.body.grounded).toBe(false);
        expect(seen.get(321)!.body.grounded).toBe(true);
        expect(seen.get(322)!.playerFrame).toBe('jump');
        const final = seen.get(400)!;
        expect(final.goalFrame).toBe('active');
        expect(final.critterFrame).toBe('clear');
        expect(final.playerFrame).toBe('win-2');
        expect(final.progress).toBe('3 / 3 complete');
        expect(final.outcome).toBe('Objective complete');
        expect(final.host.render.effects.active).toBe(0);
        const log = await events(transport, cdp);
        expect(
          log.filter((event) => event.type === 'level.completed').map((event) => event.tick),
        ).toEqual([328]);
        expect(
          log.filter((event) => event.type === 'enemy.killed').map((event) => event.tick),
        ).toEqual([103]);
        expect(
          log.filter((event) => event.type === 'platform.boarded').map((event) => event.tick),
        ).toEqual([145]);
        expect(log.some((event) => event.type === 'player.died')).toBe(false);
        const traffic = await evaluate<string[]>(
          cdp,
          "performance.getEntriesByType('resource').map(e=>e.name)",
        );
        const base = transport === 'dev' ? `${dev.url}/` : `${origin}${PREFIX}`;
        expect(
          traffic.filter((name) => name.startsWith('http')).every((name) => name.startsWith(base)),
        ).toBe(true);
        if (transport === 'static')
          expect(traffic.some((name) => name.includes('/api/'))).toBe(false);
        record('routes', {
          transport,
          route: 'win',
          url: urlFor(transport),
          final,
          trajectory: hashString(hashes.join('|')),
          beats: Object.fromEntries(seen),
        });

        if (transport === 'dev') {
          const timeOrigin = await evaluate<number>(cdp, 'performance.timeOrigin');
          await cdp.send('Page.reload', { ignoreCache: true });
          await until<boolean>(
            cdp,
            `performance.timeOrigin !== ${timeOrigin} && globalThis.aegis?.presentation().status === 'ready'`,
            Boolean,
          );
          const reloaded = await evaluate<Seen>(cdp, READ);
          expect(reloaded.hash).toBe(final.hash);
          expect(reloaded.goalFrame).toBe('active');
          expect(reloaded.critterFrame).toBe('clear');
          expect(reloaded.playerFrame).toBe('win-2');
          expect(reloaded.progress).toBe(final.progress);
          expect(reloaded.host.render.effects.active).toBe(0);
          expect(reloaded.host.audio.voices).toBe(0);
          expect(reloaded.host.audio.dropped).toBe(0);
          record('lifecycle', { transport, reloadHydratesHeldArtWithoutOldCues: true });
        }
      });
    }, 240_000);

    for (const loss of LOSSES) {
      it(`${transport}: preserves the existing ${loss.id} lose route`, async () => {
        assert.equal(typeof loss.spec.input, 'string');
        const script = loss.spec.input as string;
        const expected = await runScene(loss.spec.scene, {
          plugin: platformer.plugin,
          ticks: loss.spec.ticks,
          input: script,
          captureHistory: true,
        });
        await loss.spec.expect?.(expected);
        await withPage(transport, async (cdp) => {
          const { seen } = await drive(
            cdp,
            transport,
            script,
            loss.spec.ticks,
            loss.id,
            loss.tick + 1,
          );
          const log = await events(transport, cdp);
          expect(
            log
              .filter((event) => event.type === 'player.died')
              .map((event) => ({ tick: event.tick, data: event.data })),
          ).toEqual([{ tick: loss.tick, data: { tick: loss.tick, cause: loss.cause } }]);
          expect(log.some((event) => event.type === 'level.completed')).toBe(false);
          const final = seen.get(loss.spec.ticks)!;
          expect(final.hash).toBe(expected.hash);
          expect(final.playerFrame).toBe('hurt');
          expect(final.goalFrame).toBe('idle');
          expect(final.outcome).toMatch(/Run ended.*try again/i);
          record('routes', {
            transport,
            route: loss.id,
            final,
            deathTick: loss.tick,
            deathCause: loss.cause,
          });
        });
      }, 240_000);
    }

    it(`${transport}: keeps controls usable at narrow sizes and unlocks, mutes, restarts and disposes real resources`, async () => {
      await withPage(transport, async (cdp) => {
        await reset(cdp, transport);
        const initial = await evaluate<Seen>(cdp, READ);
        const assetUrls = await evaluate<string[]>(
          cdp,
          "performance.getEntriesByType('resource').filter(e=>e.name.includes('/assets/')).map(e=>e.name)",
        );
        expect(assetUrls.length).toBeGreaterThanOrEqual(27);
        const resourceIds = await evaluate<string[]>(
          cdp,
          `(() => {
          const ids=new Set();globalThis.aegis.adapter.scene.traverse(o=>{
            for(const m of Array.isArray(o.material)?o.material:[o.material]) if(m?.map) ids.add(m.map.uuid);
          });return [...ids].sort();
        })()`,
        );
        // A synthetic event is not an autoplay authorization.
        if (initial.host.audio.status === 'locked') {
          await evaluate(
            cdp,
            "document.getElementById('stage').dispatchEvent(new Event('pointerdown')); null",
          );
          expect((await evaluate<Seen>(cdp, READ)).host.audio.status).toBe('locked');
        }
        await pressControl(cdp, '#action-mute');
        await until<string>(
          cdp,
          'globalThis.aegis.presentation().audio.status',
          (status) => status === 'ready',
        );
        if ((await evaluate<Seen>(cdp, READ)).host.audio.muted)
          await pressControl(cdp, '#action-mute');
        await pressControl(cdp, '#action-pause');
        await until<number>(
          cdp,
          'globalThis.aegis.presentation().audio.voices',
          (voices) => voices === 1,
        );
        await evaluate(
          cdp,
          `(() => {
          document.getElementById('stage').focus();
          globalThis.coyoteAudioProbe={peak:0,frame:0};
          const sample=()=>{const p=globalThis.coyoteAudioProbe;p.peak=Math.max(p.peak,globalThis.aegis.presentation().audio.voices);p.frame=requestAnimationFrame(sample)};
          sample();
        })()`,
        );
        await tap(cdp, 'Space');
        await until<number>(cdp, 'globalThis.coyoteAudioProbe.peak', (peak) => peak >= 2, 10_000);
        const voicePeak = await evaluate<number>(
          cdp,
          'cancelAnimationFrame(globalThis.coyoteAudioProbe.frame); globalThis.coyoteAudioProbe.peak',
        );
        expect((await events(transport, cdp)).some((event) => event.type === 'player.jumped')).toBe(
          true,
        );
        await pressControl(cdp, '#action-mute');
        await until<boolean>(cdp, 'globalThis.aegis.presentation().audio.muted', Boolean);
        expect((await evaluate<Seen>(cdp, READ)).host.audio.voices).toBe(0);
        await pressControl(cdp, '#action-mute');
        await until<number>(
          cdp,
          'globalThis.aegis.presentation().audio.voices',
          (voices) => voices === 1,
        );
        await pressControl(cdp, '#action-pause');
        await until<number>(
          cdp,
          'globalThis.aegis.presentation().audio.voices',
          (voices) => voices === 0,
        );
        await reset(cdp, transport);
        const baseline = await evaluate<Seen>(cdp, READ);

        for (const viewport of [{ width: 390, height: 844 }, VIEWPORT]) {
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            ...viewport,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await until<number>(cdp, 'innerWidth', (width) => width === viewport.width);
          await sync(cdp);
          const controls = await evaluate<{ id: string; inside: boolean; hittable: boolean }[]>(
            cdp,
            `['action-pause','action-restart','action-mute','quality'].map(id=>{
            const e=document.getElementById(id),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
            return {id,inside:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,hittable:hit===e||e.contains(hit)};
          })`,
          );
          expect(controls.every((control) => control.inside && control.hittable)).toBe(true);
          await pressControl(cdp, '#controls summary');
          expect(await evaluate(cdp, "document.getElementById('controls').open")).toBe(true);
          expect(await evaluate(cdp, "document.getElementById('controls').textContent")).toMatch(
            /coyote time/,
          );
          await capture(
            cdp,
            `${transport}-controls-${viewport.width}`,
            'All controls are on-screen and hit-testable; control reference opens.',
          );
          await pressControl(cdp, '#controls summary');
          await reset(cdp, transport);
          await key(cdp, 'KeyD', true);
          await sync(cdp);
          if (transport === 'dev') await control('step', 5);
          else for (let i = 0; i < 5; i++) await tap(cdp, 'Period');
          await until<number>(cdp, 'globalThis.aegis.tick()', (tick) => tick === 5);
          await key(cdp, 'KeyD', false);
          expect((await evaluate<Seen>(cdp, READ)).position.x).toBeGreaterThan(2.5);
          record('lifecycle', { transport, viewport, controls, freshKeyboardMovedPlayer: true });
        }

        await reset(cdp, transport);
        const after = await evaluate<Seen>(cdp, READ);
        expect(after.host.assets).toEqual(baseline.host.assets);
        expect(after.host.render.resources).toEqual(baseline.host.render.resources);
        expect(after.host.render.effects.active).toBe(0);
        expect(after.progress).toBe('0 / 3 complete');
        expect(after.goalFrame).toBe('idle');
        expect(
          await evaluate<string[]>(
            cdp,
            `(() => {
          const ids=new Set();globalThis.aegis.adapter.scene.traverse(o=>{
            for(const m of Array.isArray(o.material)?o.material:[o.material]) if(m?.map) ids.add(m.map.uuid);
          });return [...ids].sort();
        })()`,
          ),
        ).toEqual(resourceIds);
        expect(
          await evaluate(
            cdp,
            "performance.getEntriesByType('resource').filter(e=>e.name.includes('/assets/')).length",
          ),
        ).toBe(assetUrls.length);

        await evaluate(
          cdp,
          `addEventListener('beforeunload',()=>sessionStorage.setItem('coyote-disposed',JSON.stringify(globalThis.aegis.presentation()))); null`,
        );
        await cdp.send('Page.navigate', {
          url: transport === 'dev' ? `${dev.url}/` : `${origin}${PREFIX}`,
        });
        await until<boolean>(
          cdp,
          'globalThis.aegis === undefined && document.readyState === "complete"',
          Boolean,
        );
        const disposed = await evaluate<HostStats>(
          cdp,
          "JSON.parse(sessionStorage.getItem('coyote-disposed'))",
        );
        expect(disposed.status).toBe('disposed');
        expect(disposed.assets.textures).toBe(0);
        expect(disposed.assets.materials).toBe(0);
        expect(disposed.assets.audioBytes).toBe(0);
        expect(disposed.audio.voices).toBe(0);
        record('lifecycle', {
          transport,
          trustedAudioUnlock: true,
          freshJumpPlayedCue: true,
          voicePeak,
          muteStoppedVoices: true,
          noDuplicateAmbient: true,
          resetReusesTextureIds: true,
          noRefetchOnRestart: true,
          initial: initial.host,
          baseline: baseline.host,
          disposed,
        });
      });
    }, 240_000);
  }

  it('shows real loading and required-asset failure, then successfully retries the same static page', async () => {
    const cdp = await openPage(browser.port, 'about:blank', VIEWPORT);
    try {
      holdAsset = new Promise<void>((done) => {
        releaseAsset = done;
      });
      await cdp.send('Page.navigate', { url: urlFor('static') });
      await until<string>(
        cdp,
        'globalThis.aegis?.presentation().status',
        (status) => status === 'loading',
      );
      expect(await evaluate(cdp, 'globalThis.aegis.tick()')).toBe(-1);
      await tap(cdp, 'KeyP');
      expect(await evaluate(cdp, "document.getElementById('loading-panel').dataset.state")).toBe(
        'loading',
      );
      await capture(
        cdp,
        'static-loading',
        'Required images are still loading; no ready simulation or hidden fallback.',
      );
      assert.ok(releaseAsset);
      releaseAsset();
      holdAsset = undefined;
      await ready(cdp);
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: ['*assets/platformer/engineer.svg*'] });
      const timeOrigin = await evaluate<number>(cdp, 'performance.timeOrigin');
      await cdp.send('Page.reload', { ignoreCache: true });
      await until<boolean>(
        cdp,
        `performance.timeOrigin !== ${timeOrigin} && globalThis.aegis?.presentation().status === 'error'`,
        Boolean,
      );
      expect(await evaluate(cdp, 'globalThis.aegis.tick()')).toBe(-1);
      expect(await evaluate(cdp, "document.getElementById('loading-message').textContent")).toMatch(
        /engineer\.svg/,
      );
      expect(await evaluate(cdp, "document.getElementById('action-retry').hidden")).toBe(false);
      await capture(
        cdp,
        'static-required-asset-error',
        'Blocked required engineer texture is an actionable failure, never a box fallback.',
      );
      await cdp.send('Network.setBlockedURLs', { urls: [] });
      const failedOrigin = await evaluate<number>(cdp, 'performance.timeOrigin');
      await pressControl(cdp, '#action-retry');
      await until<boolean>(
        cdp,
        `performance.timeOrigin !== ${failedOrigin} && globalThis.aegis !== undefined`,
        Boolean,
      );
      await ready(cdp);
      expect(await evaluate(cdp, 'globalThis.aegis.presentation().assets.loadedFiles')).toBe(27);
      record('lifecycle', {
        transport: 'static',
        loadingBeforeSimulation: true,
        requiredAssetFailure: 'engineer.svg',
        retryMountedActualAssets: true,
      });
    } finally {
      releaseAsset?.();
      holdAsset = undefined;
      await cdp.send('Page.navigate', { url: 'about:blank' });
      cdp.close();
    }
  }, 180_000);

  it('meets the existing draw-call and frame-payload budgets on the real game at both quality settings', async () => {
    await withPage('dev', async (cdp) => {
      await reset(cdp, 'dev');
      const samples = [];
      for (const quality of ['standard', 'low']) {
        const before = await evaluate<{
          frames: number;
          snapshots: number;
          exchangeErrors: number;
        }>(
          cdp,
          `(() => {const e=document.getElementById('quality');e.value='${quality}';e.dispatchEvent(new Event('change'));globalThis.aegis.resetTimings();return globalThis.aegis.timings();})()`,
        );
        await until<boolean>(
          cdp,
          `globalThis.aegis.samples().work.length >= 20 && globalThis.aegis.timings().snapshots >= ${before.snapshots + 3}`,
          Boolean,
          20_000,
        );
        const measured = await evaluate<{
          timings: {
            frames: number;
            snapshots: number;
            drawCalls: number;
            exchangeBytes: number;
            exchangeErrors: number;
          };
          samples: {
            work: number[];
            gaps: number[];
            restore: number[];
            sync: number[];
            render: number[];
          };
        }>(cdp, '({timings:globalThis.aegis.timings(),samples:globalThis.aegis.samples()})');
        expect(measured.timings.frames - before.frames).toBeGreaterThanOrEqual(20);
        expect(measured.timings.drawCalls).toBeGreaterThan(0);
        expect(measured.timings.drawCalls).toBeLessThanOrEqual(2000);
        expect(measured.timings.exchangeBytes).toBeGreaterThan(0);
        expect(measured.timings.exchangeBytes).toBeLessThanOrEqual(24_000);
        expect((measured.timings.exchangeErrors - before.exchangeErrors) * 2).toBeLessThanOrEqual(
          measured.timings.snapshots - before.snapshots,
        );
        expect(measured.samples.work.length).toBeGreaterThanOrEqual(20);
        const p95 = (values: number[]) =>
          [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
        samples.push({
          quality,
          timings: measured.timings,
          freshSnapshots: measured.timings.snapshots - before.snapshots,
          p95: Object.fromEntries(
            Object.entries(measured.samples).map(([key, values]) => [key, p95(values)]),
          ),
        });
      }
      record('lifecycle', {
        transport: 'dev',
        existingBudgetsUnchanged: { drawCalls: 2000, frameBytes: 24000 },
        samples,
      });
    });
    expect(requests.some((request) => request.path.endsWith('/engineer.svg'))).toBe(true);
    expect(requests.filter((request) => request.status !== 200)).toEqual([]);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  }, 150_000);
});
