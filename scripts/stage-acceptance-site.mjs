/**
 * A static site for section 23 browser acceptance, shared by the Chromium specs
 * (test/animation-stage.browser.test.ts) and the optional WebKit run
 * (scripts/webkit-acceptance.mjs): the built `@aegis/browser` modules, the original animation
 * fixture, a self-describing ramp voice, an AudioWorklet tap, and an offline page whose service
 * worker is bundled from the public `@aegis/browser/offline/worker` entry.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { generateFixture, wav } from '../poc/animation-lab/fixture.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RAMP_SECONDS = 4;
export const RAMP_RATE = 48_000;
export const STAGE_DOCUMENTS = [
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

/** A DC ramp whose sample value encodes its own media position: value = 0.9 * t / duration. */
export function rampWav() {
  const samples = new Float32Array(RAMP_SECONDS * RAMP_RATE);
  for (let i = 0; i < samples.length; i++) samples[i] = (0.9 * i) / samples.length;
  return wav(samples, RAMP_RATE);
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

const STAGE_PAGE = (
  documents,
) => `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Stage</title>
<body style="margin:0"><button id="unlock" style="position:fixed;left:0;top:0;width:60px;height:40px">Звук</button>
<div id="host" style="position:absolute;left:0;top:60px;width:1280px;height:800px"></div>
<script type="module">
import { createStage } from './sdk/stage/index.js';
import { createNarration } from './sdk/audio/index.js';
import * as animation from './sdk/animation/index.js';
import * as ui from './sdk/ui/index.js';
import * as save from './sdk/save/index.js';
import { IndexedDbSaveStorage } from './sdk/save/indexeddb.js';
Object.assign(globalThis, { createStage, createNarration, animation, ui, save, IndexedDbSaveStorage, DOCUMENTS: ${JSON.stringify(documents)} });
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
</script></body></html>`;

const OFFLINE_PAGE = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Offline</title><body><p id="state">boot</p>
<script type="module">
import { OfflinePackStore } from './sdk/offline/index.js';
import { registerOfflineWorker } from './sdk/offline/worker.js';
globalThis.installOffline = async (manifest) => {
  const registration = await registerOfflineWorker('worker.js', new URL('./', location.href).href);
  await navigator.serviceWorker.ready;
  const store = new OfflinePackStore({ namespace: 'stage-acceptance', baseUrl: new URL('./', location.href).href });
  const plan = await store.plan([manifest]);
  await store.installSequence([manifest]);
  return { plan, controlled: !!navigator.serviceWorker.controller, scope: registration.scope };
};
const response = await fetch('assets/lab.babble.cues.json').catch(() => undefined);
document.querySelector('#state').textContent = response?.ok ? 'served' : 'missing';
globalThis.ready = true;
</script></body></html>`;

/** Start the site; returns its origin, base path, offline pack manifest and a close function. */
export async function startStageSite({ base = '/stage-lab/' } = {}) {
  const dist = join(root, 'packages', 'browser', 'dist');
  const files = new Map();
  const add = (path, bytes, type) =>
    files.set(`${base}${path}`, {
      bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
      type,
    });
  const modules = (path) => {
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
  };
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
  add('index.html', STAGE_PAGE(STAGE_DOCUMENTS), 'text/html');
  add('offline.html', OFFLINE_PAGE, 'text/html');
  const offlineFiles = ['offline.html', 'assets/lab.babble.cues.json', 'assets/bg.office.png'];
  const manifest = {
    id: 'stage-acceptance',
    revision: 'r1',
    resources: offlineFiles.map((path, i) => {
      const bytes = files.get(`${base}${path}`).bytes;
      return {
        id: `r${String(i)}`,
        src: path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        kind: path.endsWith('.html') ? 'shell' : path.endsWith('.png') ? 'image' : 'data',
      };
    }),
  };
  // Module scripts the offline page imports must be served offline too.
  for (const path of [...files.keys()].filter((key) => key.startsWith(`${base}sdk/`))) {
    const bytes = files.get(path).bytes;
    manifest.resources.push({
      id: `m${String(manifest.resources.length)}`,
      src: path.slice(base.length),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      kind: 'script',
    });
  }
  const worker = await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root,
      contents: `import { OfflinePackStore } from '@aegis/browser/offline';
import { attachOfflineWorker } from '@aegis/browser/offline/worker';
const store = new OfflinePackStore({ namespace: 'stage-acceptance', baseUrl: self.registration.scope });
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
attachOfflineWorker(self, store, { packs: [{ id: 'stage-acceptance', revision: 'r1' }], shell: 'offline.html',
  allowNetwork: true, onError() {} });`,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
  });
  add('worker.js', worker.outputFiles[0].contents, 'text/javascript');
  let offline = false;
  const server = createServer((request, response) => {
    if (offline) {
      response.destroy();
      return;
    }
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
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    base,
    manifest,
    setOffline(value) {
      offline = value;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
