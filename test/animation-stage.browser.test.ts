import { createServer } from 'node:http';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  click,
  evaluate,
  launchBrowser,
  openPage,
  stopExternalLagWitness,
  until,
} from '../packages/render-three/src/browser.js';
import type { CdpSession, LaunchedBrowser } from '../packages/render-three/src/browser.js';
import { closeOwnedBrowser } from '../packages/render-three/src/testing/browser-lifecycle.js';
import { generateFixture, wav } from '../poc/animation-lab/fixture.mjs';

/**
 * Section 23 browser acceptance in real Chromium: the 2D stage (ANIM-01..06), the narration
 * playback clock measured against the samples actually rendered (AUDIO-07, F03, F09), the
 * child-safe presets (issue #14) and memory across scene transitions (F08).
 */
const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, '..', 'packages', 'browser', 'dist');
const base = '/stage-lab/';
const files = new Map<string, { bytes: Buffer; type: string }>();
let browser: LaunchedBrowser;
let page: CdpSession;
let origin: string;

const RAMP_SECONDS = 4;
const RATE = 48_000;
/** A DC ramp whose sample value encodes its own media position: value = 0.9 * t / duration. */
function rampWav(): Buffer {
  const samples = new Float32Array(RAMP_SECONDS * RATE);
  for (let i = 0; i < samples.length; i++) samples[i] = (0.9 * i) / samples.length;
  return wav(samples, RATE) as Buffer;
}
const TAP = `class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && this.n++ % 2 === 0)
      this.port.postMessage({ frame: currentFrame + channel.length - 1, value: channel[channel.length - 1] });
    return true;
  }
}
registerProcessor('tap', Tap);`;

const DOCUMENTS = [
  ...['fox', 'cat', 'rabbit', 'bear', 'hedgehog'].flatMap((s) => [
    `avatar.${s}.atlas`,
    `avatar.${s}`,
  ]),
  'acc.scarf.atlas',
  'acc.hats.atlas',
  'acc.scarf.long',
  'acc.hat.detective',
  'acc.hat.beret',
  'acc.hat.cap',
  'acc.badge',
  'wave',
  'nod',
  'hop.small',
  'startle',
  'think',
  'sway',
];

function add(path: string, bytes: Buffer | string, type: string): void {
  files.set(`${base}${path}`, { bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), type });
}
function modules(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) modules(file);
    else if (entry.name.endsWith('.js'))
      add(
        `sdk/${relative(dist, file).replaceAll('\\', '/')}`,
        readFileSync(file),
        'text/javascript',
      );
  }
}
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const value = files.get(url.pathname === base ? `${base}index.html` : url.pathname);
  if (!value) {
    response.writeHead(404).end();
    return;
  }
  response
    .writeHead(200, { 'content-type': value.type, 'cache-control': 'no-store' })
    .end(value.bytes);
});

beforeAll(async () => {
  modules(dist);
  for (const [name, bytes] of generateFixture().files)
    add(
      `assets/${name}`,
      bytes,
      name.endsWith('.png')
        ? 'image/png'
        : name.endsWith('.wav')
          ? 'audio/wav'
          : 'application/json',
    );
  add('assets/ramp.wav', rampWav(), 'audio/wav');
  add('tap.js', TAP, 'text/javascript');
  add(
    'index.html',
    `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Stage</title>
<body style="margin:0"><button id="unlock" style="position:fixed;left:0;top:0;width:60px;height:40px">Звук</button>
<div id="host" style="position:absolute;left:0;top:60px;width:1280px;height:800px"></div>
<script type="module">
import { createStage } from './sdk/stage/index.js';
import { createNarration } from './sdk/audio/index.js';
import * as animation from './sdk/animation/index.js';
import * as ui from './sdk/ui/index.js';
Object.assign(globalThis, { createStage, createNarration, animation, ui, DOCUMENTS: ${JSON.stringify(DOCUMENTS)} });
globalThis.resolveAsset = (id) => 'assets/' + id + (/\\.(png|wav|json)$/.test(id) ? '' : '.json');
globalThis.newStage = async (extra = {}) => {
  const stage = createStage({ host: document.querySelector('#host'), baseUrl: location.href, resolve: resolveAsset,
    seed: 'test', effects: { sparkles: { frame: 'acc.hats.atlas#badge', count: 24 } }, ...extra });
  const result = await stage.load({ documents: DOCUMENTS, images: ['bg.office.png', 'bg.office.warm.png'] });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  stage.setBackground('bg.office.png');
  return stage;
};
/** Read device pixels right after a render, in the same task (no preserveDrawingBuffer needed). */
globalThis.pixels = (stage, points) => {
  const copy = document.createElement('canvas');
  copy.width = stage.canvas.width; copy.height = stage.canvas.height;
  const c = copy.getContext('2d'); c.drawImage(stage.canvas, 0, 0);
  const rect = stage.canvas.getBoundingClientRect();
  const ratio = stage.canvas.width / rect.width;
  return points.map((p) => { const client = stage.toClient(p);
    return Array.from(c.getImageData(Math.round((client.x - rect.left) * ratio), Math.round((client.y - rect.top) * ratio), 1, 1).data); });
};
globalThis.luminance = (stage) => {
  const copy = document.createElement('canvas'); copy.width = 64; copy.height = 40;
  const c = copy.getContext('2d'); c.drawImage(stage.canvas, 0, 0, 64, 40);
  const d = c.getImageData(0, 0, 64, 40).data; let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return sum / (d.length / 4) / 255;
};
globalThis.ready = true;
</script></body></html>`,
    'text/html',
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server failed to bind.');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await launchBrowser({ viewport: { width: 1300, height: 900 } });
  page = await openPage(browser.port, `${origin}${base}`);
  await until(page, 'globalThis.ready', (value) => value === true, 30_000);
}, 180_000);

afterAll(async () => {
  try {
    page?.close();
    if (browser) {
      await closeOwnedBrowser(browser);
      rmSync(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  } finally {
    stopExternalLagWitness();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const execute = <T>(body: string): Promise<T> => evaluate<T>(page, `(async () => { ${body} })()`);
const gesture = async (): Promise<void> => {
  await page.send('Page.bringToFront');
  await click(page, 20, 20);
};

describe('2D stage in Chromium (section 23)', () => {
  it('composes five species with every scarf colour and hat at runtime, with tint and badge anchor (F02)', async () => {
    const result = await execute<{
      combinations: number;
      renderer: string;
      failures: string[];
      textures: number[];
      owned: number[];
    }>(`
      const stage = await newStage({ autoStart: false });
      const colors = ['#c8553d', '#2f6fb3', '#3f8f5a', '#e2b33b', '#7b4fa8', '#e07aa5'];
      const hats = ['', 'acc.hat.detective', 'acc.hat.beret', 'acc.hat.cap'];
      const failures = []; const textures = new Set(); const owned = new Set(); let combinations = 0;
      for (const species of ['fox', 'cat', 'rabbit', 'bear', 'hedgehog'])
        for (const color of colors) for (const hat of hats) {
          const puppet = stage.puppet({ id: 'p', rig: 'avatar.' + species, at: { x: 1280, y: 1450 }, tints: { scarf: color },
            accessories: [{ slot: 'scarf', rig: 'acc.scarf.long' }, ...(hat ? [{ slot: 'hat', rig: hat }] : []), { anchor: 'badge', rig: 'acc.badge' }] });
          stage.renderFrame(0);
          const items = puppet.model.pose(stage.now());
          const wrap = items.find((i) => i.id.endsWith('/scarf.wrap'));
          const m = wrap.matrix;
          const scarfPoint = { x: m[0] * 125 + m[2] * 20 + m[4], y: m[1] * 125 + m[3] * 20 + m[5] };
          const badge = puppet.model.anchorAt('badge', stage.now());
          const [scarfPixel, badgePixel] = pixels(stage, [scarfPoint, badge]);
          const expected = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) * (0xe8 / 255));
          const close = (a, b, t) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= t);
          if (!close(scarfPixel, expected, 26)) failures.push(species + color + hat + ' scarf ' + scarfPixel + ' vs ' + expected.map(Math.round));
          if (!close(badgePixel, [0xf5, 0xc5, 0x18], 30)) failures.push(species + color + hat + ' badge ' + badgePixel);
          if (!!hat !== items.some((i) => i.id.includes('/hat'))) failures.push(species + hat + ' hat missing');
          textures.add(stage.stats().textures); owned.add(stage.stats().ownedBytes);
          puppet.remove(); combinations++;
        }
      const renderer = stage.renderer; await stage.dispose();
      return { combinations, renderer, failures, textures: [...textures], owned: [...owned] };
    `);
    expect(result.combinations).toBe(120);
    expect(result.renderer).toBe('webgl');
    expect(result.failures).toEqual([]);
    // No pre-rendered combinations: the same 9 images serve every composition.
    expect(result.textures).toEqual([9]);
    expect(result.owned).toHaveLength(1);
    console.info('Avatar composition evidence', JSON.stringify(result));
  });

  it('keeps puppets and scene hotspots aligned through resize and letterboxing (ANIM-01)', async () => {
    const result = await execute<{ offsets: number[]; round: boolean[] }>(`
      const stage = await newStage({ autoStart: false });
      const host = document.querySelector('#host');
      const offsets = []; const round = [];
      for (const [w, h] of [[1280, 800], [1024, 768], [700, 900], [1200, 600]]) {
        host.style.width = w + 'px'; host.style.height = h + 'px';
        stage.renderFrame(0);
        for (const point of [{ x: 300, y: 200 }, { x: 2300, y: 1400 }, { x: 1280, y: 800 }]) {
          const client = stage.toClient(point);
          const back = stage.toScene(client);
          offsets.push(Math.hypot(back.x - point.x, back.y - point.y));
          const logical = ui.logicalPoint(client, stage.canvas.getBoundingClientRect(), stage.logical);
          round.push(Math.abs(logical.x - point.x) < 0.5 && Math.abs(logical.y - point.y) < 0.5);
        }
      }
      host.style.width = '1280px'; host.style.height = '800px';
      await stage.dispose();
      return { offsets, round };
    `);
    expect(Math.max(...result.offsets)).toBeLessThan(1e-6);
    expect(result.round.every(Boolean)).toBe(true);
  });

  it('renders four puppets, effects and a 2560x1600 background at the 30 fps floor under 4x CPU throttling (F01)', async () => {
    await page.send('Page.bringToFront');
    await page.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    try {
      const result = await execute<{
        fps: number;
        p95: number;
        slow: number;
        frameMs: number;
        drawCalls: number;
        quads: number;
        renderer: string;
      }>(`
        const stage = await newStage();
        const species = ['fox', 'cat', 'rabbit', 'bear'];
        const puppets = species.map((s, i) => stage.puppet({ rig: 'avatar.' + s, at: { x: 520 + i * 520, y: 1450 },
          tints: { scarf: '#2f6fb3' }, accessories: [{ slot: 'scarf', rig: 'acc.scarf.long' }, { slot: 'hat', rig: 'acc.hat.beret' }, { anchor: 'badge', rig: 'acc.badge' }],
          behaviours: { breathe: {}, blink: { seed: s } } }));
        for (const p of puppets) p.play('sway', { layer: 'idle', loop: true });
        const timer = setInterval(() => { for (const p of puppets) p.play(['wave', 'nod', 'think'][Math.floor(Math.random() * 3)]);
          stage.effect('sparkles', { x: 1280, y: 700 }, 1.5); }, 700);
        await new Promise((r) => setTimeout(r, 1000));
        const times = [];
        await new Promise((resolve) => { const step = (t) => { times.push(t); if (t - times[0] < 5000) requestAnimationFrame(step); else resolve(); }; requestAnimationFrame(step); });
        clearInterval(timer);
        const intervals = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
        const stats = stage.stats(); await stage.dispose();
        return { fps: (times.length - 1) / ((times.at(-1) - times[0]) / 1000), p95: intervals[Math.floor(intervals.length * 0.95)],
          slow: intervals.filter((v) => v > 33.4).length / intervals.length, frameMs: stats.frameMs, drawCalls: stats.drawCalls, quads: stats.quads, renderer: stats.renderer };
      `);
      console.info(
        'Stage frame-rate evidence (Chromium, 4x CPU throttle, 1280x800@1)',
        JSON.stringify(result),
      );
      expect(result.renderer).toBe('webgl');
      expect(result.fps).toBeGreaterThanOrEqual(30);
    } finally {
      await page.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    }
  });

  it('follows the audible narration clock within 50 ms through pause, resume, replay and interruption (F03, F09)', async () => {
    await execute(`
      globalThis.reports = [];
      globalThis.audioContext = new AudioContext({ sampleRate: ${RATE} });
      await audioContext.audioWorklet.addModule('tap.js');
      const tap = new AudioWorkletNode(audioContext, 'tap');
      tap.port.onmessage = (e) => { reports.push(e.data); if (reports.length > 4000) reports.splice(0, 2000); };
      const sink = audioContext.createGain(); sink.gain.value = 0; tap.connect(sink); sink.connect(audioContext.destination);
      const create = audioContext.createGain.bind(audioContext); let tapped = false;
      audioContext.createGain = () => { const node = create(); if (!tapped) { tapped = true; node.connect(tap); } return node; };
      globalThis.events = [];
      globalThis.narration = createNarration({ baseUrl: location.href, onState: () => {}, contextFactory: () => audioContext });
      narration.registerPack({ id: 'voice', revision: '1', assets: [{ id: 'ramp', src: 'assets/ramp.wav' }, { id: 'babble', src: 'assets/lab.babble.wav' }],
        lines: [{ id: 'ramp', asset: 'ramp', caption: 'Пробная реплика', cues: 'lab.babble.cues' }, { id: 'babble', asset: 'babble', caption: 'Ла-ла' }] });
      narration.subscribe((e) => events.push(e.type + (e.reason ? ':' + e.reason : '')));
      globalThis.stage = await newStage({ narration, audioPackId: 'voice' });
      globalThis.speaker = stage.puppet({ rig: 'avatar.fox', at: { x: 1280, y: 1450 } });
      globalThis.drift = []; globalThis.mouths = [];
      /** True audible media position from the rendered samples at the output timestamp's context time. */
      globalThis.truth = () => {
        const stamp = audioContext.getOutputTimestamp();
        if (!stamp.contextTime) return undefined;
        const audible = stamp.contextTime + Math.max(0, performance.now() - stamp.performanceTime) / 1000;
        let best;
        for (let i = reports.length - 1; i >= 0; i--) if (reports[i].frame / ${RATE} <= audible) { best = reports[i]; break; }
        if (!best || best.value < 0.002) return undefined;
        const age = audible - best.frame / ${RATE};
        if (age > 0.1) return undefined;
        return (best.value / 0.9) * ${RAMP_SECONDS} + age;
      };
      globalThis.sampling = true;
      const sample = () => {
        if (!sampling) return;
        const clock = narration.clock();
        if (clock.status === 'playing' && clock.position > 0.08 && clock.position < ${RAMP_SECONDS} - 0.08) {
          const t = truth();
          if (t !== undefined) drift.push(clock.position - t);
        }
        mouths.push([clock.status, speaker.speech().shape]);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      document.querySelector('#unlock').onclick = () => narration.unlock().catch(() => {});
    `);
    await gesture();
    await until(page, 'narration.context().state', (v) => v === 'running', 10_000);
    const phases = await execute<Record<string, number | string>>(`
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await speaker.speak({ packId: 'voice', lineId: 'ramp' });
      await wait(900);
      narration.pause();
      const frozen = narration.clock().position; await wait(400);
      const stillFrozen = narration.clock().position;
      const pausedShape = speaker.speech().mode;
      await narration.resume(); await wait(700);
      const beforeReplay = narration.clock().serial;
      await narration.replay(); const afterReplay = narration.clock().serial; await wait(700);
      return { frozen, stillFrozen, pausedShape, beforeReplay, afterReplay, drifts: drift.length };
    `);
    expect(phases.frozen).toBe(phases.stillFrozen);
    expect(phases.afterReplay).toBe(Number(phases.beforeReplay) + 1);
    // Interruption: the context is suspended by the platform; the mouth rests; a gesture recovers.
    await execute(`await audioContext.suspend(); await new Promise((r) => setTimeout(r, 300));`);
    const interrupted = await execute<{ status: string; mode: string; shape: string }>(
      `return { status: narration.clock().status, mode: speaker.speech().mode, shape: speaker.speech().shape };`,
    );
    expect(interrupted).toEqual({ status: 'blocked', mode: 'unheard', shape: 'X' });
    await gesture();
    await until(page, 'narration.clock().status', (v) => v === 'playing', 10_000);
    await until(page, 'narration.clock().status', (v) => v === 'completed', 15_000);
    const result = await execute<{
      samples: number;
      max: number;
      mean: number;
      events: string[];
      finalShape: string;
      latency: number;
    }>(`
      sampling = false;
      await new Promise((r) => setTimeout(r, 100));
      const abs = drift.map(Math.abs);
      const result = { samples: drift.length, max: Math.max(...abs), mean: abs.reduce((a, b) => a + b, 0) / abs.length,
        events, finalShape: speaker.speech().shape, latency: audioContext.outputLatency ?? audioContext.baseLatency };
      await stage.dispose(); await narration.dispose();
      return result;
    `);
    console.info('Narration clock drift evidence', JSON.stringify(result));
    expect(result.samples).toBeGreaterThan(60);
    expect(result.max).toBeLessThanOrEqual(0.05);
    expect(result.finalShape).toBe('X');
    expect(result.events).toEqual([
      'start',
      'pause',
      'resume',
      'stop:replaced',
      'start',
      'block',
      'resume',
      'complete',
    ]);
  });

  it('falls back without claiming synchronized speech when cues are missing or narration is blocked (F04)', async () => {
    const result = await execute<Record<string, unknown>>(`
      const blocked = createNarration({ baseUrl: location.href, onState: () => {} });
      blocked.registerPack({ id: 'voice', revision: '1', assets: [{ id: 'babble', src: 'assets/lab.babble.wav' }],
        lines: [{ id: 'nocues', asset: 'babble', caption: 'Без дорожки' }] });
      const stage = await newStage({ narration: blocked, audioPackId: 'voice', autoStart: false });
      const neutral = stage.puppet({ id: 'n', rig: 'avatar.cat', at: { x: 800, y: 1450 } });
      const subtle = stage.puppet({ id: 's', rig: 'avatar.bear', at: { x: 1800, y: 1450 } });
      await neutral.speak({ packId: 'voice', lineId: 'nocues' }).catch(() => {});
      const status = blocked.clock().status;
      const shapes = new Set(); const subtleShapes = []; let synchronized = false;
      subtle.speak({ packId: 'voice', lineId: 'nocues' }, { play: false, unheard: 'subtle', maxSubtleSeconds: 1 });
      for (let i = 0; i < 40; i++) { stage.renderFrame(0.05); shapes.add(neutral.speech().shape);
        subtleShapes.push(subtle.speech().shape); synchronized ||= neutral.speech().synchronized || subtle.speech().synchronized; }
      const modes = [neutral.speech().mode, subtle.speech().mode];
      await stage.dispose(); await blocked.dispose();
      return { status, neutral: [...shapes], movedEarly: new Set(subtleShapes.slice(0, 20)).size > 1,
        restLate: subtleShapes.slice(-10).every((s) => s === 'X'), synchronized, modes };
    `);
    expect(result).toEqual({
      status: 'blocked',
      neutral: ['X'],
      movedEarly: true,
      restLate: true,
      synchronized: false,
      modes: ['unheard', 'unheard'],
    });
    // The page already has sticky user activation from earlier gestures, so unlock() resumes.
    await gesture();
    const loop = await execute<{
      modes: string[];
      synchronized: boolean;
      shapes: number;
      rest: string;
    }>(`
        const voice2 = createNarration({ baseUrl: location.href, onState: () => {} });
        await voice2.unlock();
        voice2.registerPack({ id: 'voice', revision: '1', assets: [{ id: 'babble', src: 'assets/lab.babble.wav' }],
          lines: [{ id: 'nocues', asset: 'babble', caption: 'Без дорожки' }] });
        const stage = await newStage({ narration: voice2, audioPackId: 'voice' });
        const p = stage.puppet({ rig: 'avatar.fox', at: { x: 1280, y: 1450 } });
        await p.speak({ packId: 'voice', lineId: 'nocues' });
        const modes = new Set(); const shapes = new Set(); let synchronized = false;
        while (voice2.clock().status !== 'completed') { await new Promise((r) => requestAnimationFrame(r));
          modes.add(p.speech().mode); shapes.add(p.speech().shape); synchronized ||= p.speech().synchronized; }
        await new Promise((r) => setTimeout(r, 100));
        const rest = p.speech().shape; await stage.dispose(); await voice2.dispose();
        return { modes: [...modes], synchronized, shapes: shapes.size, rest };
      `);
    expect(loop.modes).toContain('talk-loop');
    expect(loop.modes).not.toContain('cues');
    expect(loop.synchronized).toBe(false);
    expect(loop.shapes).toBeGreaterThan(3);
    expect(loop.rest).toBe('X');
  });

  it('plays, pauses, skips, replays and restarts a cutscene from a marker with captions and no auto-advance (F05)', async () => {
    await gesture();
    const result = await execute<Record<string, unknown>>(`
      const captions = []; const events = [];
      const voice = createNarration({ baseUrl: location.href, onState: () => {}, onCaption: (l) => captions.push(l?.caption ?? null) });
      document.querySelector('#unlock').onclick = () => voice.unlock().catch(() => {});
      await voice.unlock().catch(() => {});
      voice.registerPack({ id: 'lab-voice', revision: '1', assets: [{ id: 'babble', src: 'assets/lab.babble.wav' }],
        lines: [{ id: 'lab.babble', asset: 'babble', caption: 'Ла-ла', cues: 'lab.babble.cues' }] });
      const stage = await newStage({ narration: voice, audioPackId: 'lab-voice', cameraPresets: {} });
      const file = await (await fetch('assets/lab.intro.json')).json();
      const avatar = { rig: 'avatar.rabbit', tints: { scarf: '#7b4fa8' }, accessories: [{ slot: 'scarf', rig: 'acc.scarf.long' }, { slot: 'hat', rig: 'acc.hat.cap' }] };
      const scene = stage.cutscene(file, { avatar, onEvent: (e) => events.push(e.type + (e.type === 'marker' ? ':' + e.id : '')) });
      scene.play();
      const waitFor = async (predicate, ms = 20000) => { const end = performance.now() + ms;
        while (!predicate()) { if (performance.now() > end) throw new Error('timeout ' + scene.status() + ' ' + events.join(',')); await new Promise((r) => setTimeout(r, 50)); } };
      await waitFor(() => scene.status() === 'awaiting-input');
      const synced = stage.getPuppet('lab.intro:guide') !== undefined;
      // No automatic text advance: it keeps waiting.
      await new Promise((r) => setTimeout(r, 1200));
      const stillWaiting = scene.status();
      scene.pause('menu'); const pausedStatus = scene.status(); const blocked = scene.next(); scene.resume('menu');
      scene.next();
      await waitFor(() => events.includes('marker:met'));
      scene.skip();
      const skipped = scene.status();
      const player = stage.getPuppet('lab.intro:player');
      const playerVisible = player.model.pose(stage.now()).length > 0;
      scene.replay();
      const replayStarted = events.filter((e) => e === 'started').length;
      scene.play({ from: 'met' });
      await waitFor(() => scene.status() === 'awaiting-input');
      const fromMarkerLines = events.filter((e) => e === 'line').length;
      scene.skip();
      await stage.dispose(); await voice.dispose();
      return { synced, stillWaiting, pausedStatus, blocked, skipped, playerVisible, replayStarted, fromMarkerLines,
        captions: captions.filter(Boolean), events: [...new Set(events)].sort() };
    `);
    expect(result).toMatchObject({
      synced: true,
      stillWaiting: 'awaiting-input',
      pausedStatus: 'paused',
      blocked: false,
      skipped: 'skipped',
      playerVisible: true,
      replayStarted: 2,
    });
    expect(result.fromMarkerLines).toBeGreaterThanOrEqual(2);
    expect((result.captions as string[]).every((c) => c === 'Ла-ла')).toBe(true);
    expect((result.captions as string[]).length).toBeGreaterThanOrEqual(2);
    expect(result.events).toEqual(
      expect.arrayContaining([
        'started',
        'line',
        'line-ended',
        'awaiting-input',
        'marker:met',
        'skipped',
        'paused',
        'resumed',
      ]),
    );
  });

  it('applies reduced motion and comfort: cuts instead of pans, gentle fades, brighter warmer frame and no flashing (F06)', async () => {
    const result = await execute<Record<string, unknown>>(`
      const stage = await newStage({ autoStart: false, reducedMotion: true, comfort: { brightness: 1.15, warmth: 0.6 } });
      stage.renderFrame(0); const plain = luminance(stage);
      stage.setComfort(true); stage.renderFrame(0); const warm = luminance(stage);
      const warmPixel = pixels(stage, [{ x: 100, y: 100 }])[0];
      stage.setComfort(false); stage.renderFrame(0); const back = luminance(stage);
      const coolPixel = pixels(stage, [{ x: 100, y: 100 }])[0];
      const pan = stage.setCamera({ x: 900, y: 900, zoom: 1.6 }, { duration: 2 });
      const cam = stage.camera();
      // A reduced-motion cutscene: sample luminance at 30 Hz and look for opposing jumps (flashes).
      const file = await (await fetch('assets/lab.intro.json')).json();
      const scene = stage.cutscene({ ...file, steps: [...file.steps.filter((s) => s.op !== 'line'), { op: 'transition', type: 'fade', duration: 0.1 }] },
        { avatar: { rig: 'avatar.fox' } });
      scene.play();
      const series = [];
      for (let i = 0; i < 400 && scene.status() !== 'completed'; i++) { stage.renderFrame(1 / 30); series.push(luminance(stage)); }
      let flashes = 0;
      for (let i = 1; i < series.length; i++) {
        const up = series[i] - series[i - 1];
        if (Math.abs(up) < 0.1) continue;
        for (let j = i + 1; j < Math.min(series.length, i + 10); j++) if ((series[j] - series[j - 1]) * up < 0 && Math.abs(series[j] - series[j - 1]) >= 0.1) flashes++;
      }
      const maxStep = Math.max(...series.slice(1).map((v, i) => Math.abs(v - series[i])));
      const status = scene.status();
      await stage.dispose();
      return { plain, warm, back, warmPixel, coolPixel, pan, cam, flashes, maxStep, status, frames: series.length };
    `);
    console.info('Reduced motion and comfort evidence', JSON.stringify(result));
    expect(result.warm as number).toBeGreaterThan((result.plain as number) + 0.02);
    expect(Math.abs((result.back as number) - (result.plain as number))).toBeLessThan(0.002);
    const warm = result.warmPixel as number[];
    const cool = result.coolPixel as number[];
    expect(warm[0]! - warm[2]!).toBeGreaterThan(cool[0]! - cool[2]!);
    expect(result.pan).toBe(0);
    expect(result.cam).toEqual({ x: 900, y: 900, zoom: 1.6 });
    expect(result.flashes).toBe(0);
    expect(result.status).toBe('completed');
  });

  it('returns owned image memory, GL textures and listeners to baseline over 50 scene transitions (F08)', async () => {
    const result = await execute<Record<string, number>>(`
      const proto = WebGLRenderingContext.prototype; let live = 0;
      const create = proto.createTexture, remove = proto.deleteTexture;
      proto.createTexture = function () { live++; return create.call(this); };
      proto.deleteTexture = function (t) { if (t) live--; return remove.call(this, t); };
      const counters = [];
      try {
        const stage = createStage({ host: document.querySelector('#host'), baseUrl: location.href, resolve: resolveAsset, autoStart: false });
        const baseline = { owned: stage.stats().ownedBytes, textures: live, listeners: stage.stats().listeners };
        let peak = 0;
        for (let i = 0; i < 50; i++) {
          const loaded = await stage.load({ documents: DOCUMENTS, images: ['bg.office.png'] });
          if (!loaded.ok) throw new Error('load failed');
          stage.setBackground('bg.office.png');
          for (const [k, s] of ['fox', 'cat', 'rabbit', 'bear'].entries())
            stage.puppet({ rig: 'avatar.' + s, at: { x: 500 + k * 500, y: 1450 }, accessories: [{ slot: 'scarf', rig: 'acc.scarf.long' }] });
          for (let f = 0; f < 3; f++) stage.renderFrame(1 / 60);
          peak = Math.max(peak, stage.stats().ownedBytes);
          stage.clearScene();
          stage.release({ atlases: ['avatar.fox.atlas', 'avatar.cat.atlas', 'avatar.rabbit.atlas', 'avatar.bear.atlas', 'avatar.hedgehog.atlas', 'acc.scarf.atlas', 'acc.hats.atlas'],
            images: ['bg.office.png'], rigs: DOCUMENTS.filter((d) => d.startsWith('avatar.') && !d.endsWith('.atlas') || d.startsWith('acc.') && !d.endsWith('.atlas')),
            clips: ['wave', 'nod', 'hop.small', 'startle', 'think', 'sway'] });
        }
        const end = { owned: stage.stats().ownedBytes, textures: live, listeners: stage.stats().listeners };
        await stage.dispose();
        return { baselineOwned: baseline.owned, endOwned: end.owned, peak, baselineTextures: baseline.textures, endTextures: end.textures,
          afterDispose: live, baselineListeners: baseline.listeners, endListeners: end.listeners };
      } finally { proto.createTexture = create; proto.deleteTexture = remove; }
    `);
    console.info('Scene transition memory evidence', JSON.stringify(result));
    expect(result.peak).toBeGreaterThan(10_000_000);
    expect(result.endOwned).toBe(result.baselineOwned);
    expect(result.endTextures).toBe(result.baselineTextures);
    expect(result.afterDispose).toBe(0);
    expect(result.endListeners).toBe(result.baselineListeners);
    const heap = await page.send('Runtime.getHeapUsage');
    console.info('JS heap after transitions', JSON.stringify(heap));
  });

  it('keeps preset styles at zero specificity and honours reduced motion set on <html> (issue #14)', async () => {
    const result = await execute<Record<string, string>>(`
      const style = document.createElement('style');
      style.textContent = ui.CHILD_SAFE_CSS + '.small { min-height: 30px; } @keyframes spin { to { transform: rotate(1turn); } } .spin { animation: spin 1s infinite; }';
      document.head.append(style);
      const root = document.createElement('div'); root.className = 'aegis-child';
      const plain = document.createElement('button'); plain.textContent = 'a';
      const small = document.createElement('button'); small.className = 'small'; small.textContent = 'b';
      const spinner = document.createElement('div'); spinner.className = 'spin';
      root.append(plain, small, spinner); document.body.append(root);
      const before = getComputedStyle(spinner).animationName;
      ui.applyPresentationPreferences(document.documentElement, { locale: 'ru', textScale: 1, reducedMotion: true, comfort: false, hideSpoilers: false, volumes: { narration: 1, music: 1, effects: 1 } });
      const after = getComputedStyle(spinner).animationName;
      const out = { plain: getComputedStyle(plain).minHeight, small: getComputedStyle(small).minHeight, before, after };
      root.remove(); style.remove(); delete document.documentElement.dataset.reducedMotion;
      return out;
    `);
    expect(result).toEqual({ plain: '48px', small: '30px', before: 'spin', after: 'none' });
  });
});
