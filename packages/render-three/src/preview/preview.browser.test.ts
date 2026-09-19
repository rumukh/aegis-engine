import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closeAllPages,
  evaluate,
  key,
  launchBrowser,
  mouseButton,
  mouseMove,
  openPage,
  screenshot,
  startSystemLoadWindow,
  stopExternalLagWitness,
  until,
  waitForPaint,
} from '../browser.js';
import type { CdpSession, LaunchedBrowser } from '../browser.js';
import { fixturePng, writePresentationFixture } from '../testing/presentation-fixture.js';
import type { PresentationManifest } from '../presentation/schema.js';
import { startAssetPreview, readPreviewCapture } from './capture.js';
import type { AssetPreview, AssetPreviewOptions } from './capture.js';
import { prepareAssetPreview } from './source.js';
import type { PreviewCaptureReport, PreviewStudioState } from './types.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ISO = join(ROOT, 'games', 'iso', 'assets', 'operative.gltf');
const CONSOLE = join(ROOT, 'games', 'iso', 'assets', 'access-console.gltf');
const ENGINEER = join(ROOT, 'games', 'platformer', 'assets', 'engineer.svg');
const FPS = join(ROOT, 'games', 'fps', 'assets', 'generated');
const SIZE = { width: 640, height: 480 };
let temporary: string;
let evidence: string;
let browser: LaunchedBrowser | undefined;
let browserStartMs: number;
const sessions: AssetPreview[] = [];
const pages: CdpSession[] = [];
const pairs: {
  source: string;
  coldSessionMs: number;
  warmReloadCaptureMs: number;
  fingerprint: string;
}[] = [];
let systemLoad: ReturnType<typeof startSystemLoadWindow>;

function copyAsset(source: string, directory: string): string {
  const closure = prepareAssetPreview({ source });
  for (const file of closure.prepared.files) {
    const target = join(directory, ...file.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.source, target);
  }
  // A accidental "zero-tick game" path must not get away with resolving a neighboring config.
  writeFileSync(join(directory, 'aegis.json'), '{"plugin":"./no-game.mjs#plugin"}');
  writeFileSync(
    join(directory, 'no-game.mjs'),
    'throw new Error("NO-GAME: preview imported a plugin");',
  );
  return join(directory, basename(source));
}

async function start(options: AssetPreviewOptions): Promise<AssetPreview> {
  if (browser === undefined) throw new Error('The browser fixture is not running.');
  const preview = await startAssetPreview({ ...options, outputDir: evidence, browser });
  sessions.push(preview);
  return preview;
}

async function waitReady(preview: AssetPreview, after: number): Promise<PreviewStudioState> {
  const deadline = performance.now() + 15_000;
  for (;;) {
    const state = await preview.state();
    if (state.revision > after && state.status === 'ready') return state;
    if (state.revision > after && state.status === 'failed')
      throw new Error(JSON.stringify(state.diagnostics));
    if (performance.now() > deadline)
      throw new Error(`Preview did not finish a revision after ${after}: ${JSON.stringify(state)}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

async function waitFailed(preview: AssetPreview, after: number): Promise<PreviewStudioState> {
  const deadline = performance.now() + 15_000;
  for (;;) {
    const state = await preview.state();
    if (state.revision > after && state.status === 'failed') return state;
    if (performance.now() > deadline)
      throw new Error(`Preview never exposed its failed revision: ${JSON.stringify(state)}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** Inspect persisted PNG pixels independently of the renderer's readiness and statistics. */
function pixels(report: PreviewCaptureReport): { foreground: number; colors: number } {
  const png = readFileSync(report.output.path);
  expect(png.readUInt32BE(16)).toBe(report.output.width);
  expect(png.readUInt32BE(20)).toBe(report.output.height);
  expect(png[24]).toBe(8);
  expect(png[28]).toBe(0);
  const channels = png[25] === 6 ? 4 : png[25] === 2 ? 3 : 0;
  expect(channels).toBeGreaterThan(0);
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT')
      chunks.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const packed = inflateSync(Buffer.concat(chunks));
  const stride = report.output.width * channels;
  expect(packed.length).toBe((stride + 1) * report.output.height);
  const rows = Buffer.alloc(stride * report.output.height);
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const da = Math.abs(p - a),
      db = Math.abs(p - b),
      dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < report.output.height; y++) {
    const filter = packed[y * (stride + 1)]!;
    expect(filter).toBeLessThanOrEqual(4);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x < channels ? 0 : rows[at - channels]!;
      const up = y === 0 ? 0 : rows[at - stride]!;
      const diagonal = y === 0 || x < channels ? 0 : rows[at - stride - channels]!;
      const prediction =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paeth(left, up, diagonal);
      rows[at] = (packed[y * (stride + 1) + 1 + x]! + prediction) & 255;
    }
  }
  const background = [1, 3, 5].map((at) =>
    Number.parseInt(report.recipe.background.slice(at, at + 2), 16),
  );
  let foreground = 0;
  const colors = new Set<number>();
  for (let at = 0; at < rows.length; at += channels) {
    const r = rows[at]!,
      g = rows[at + 1]!,
      b = rows[at + 2]!;
    if (
      Math.abs(r - background[0]!) + Math.abs(g - background[1]!) + Math.abs(b - background[2]!) >
      12
    )
      foreground++;
    colors.add((r << 16) | (g << 8) | b);
  }
  expect(foreground).toBeGreaterThan(report.output.width * report.output.height * 0.01);
  expect(colors.size).toBeGreaterThan(32);
  return { foreground, colors: colors.size };
}

async function stopBrowser(): Promise<void> {
  const current = browser;
  browser = undefined;
  if (current === undefined) return;
  try {
    await closeAllPages(current.port);
  } finally {
    if (current.process.exitCode === null && current.process.signalCode === null) {
      const stopped = new Promise<void>((done) => current.process.once('exit', () => done()));
      current.process.kill();
      await stopped;
    }
    rmSync(current.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    stopExternalLagWitness();
  }
}

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'aegis-preview-browser-'));
  evidence =
    process.env['AEGIS_PREVIEW_EVIDENCE_DIR'] === undefined
      ? join(temporary, 'captures')
      : resolve(process.env['AEGIS_PREVIEW_EVIDENCE_DIR']);
  mkdirSync(evidence, { recursive: true });
  systemLoad = startSystemLoadWindow();
  const began = performance.now();
  browser = await launchBrowser({ viewport: { width: 1280, height: 900 } });
  browserStartMs = performance.now() - began;
  const blank = await openPage(browser.port, 'about:blank');
  try {
    await waitForPaint(blank);
  } finally {
    blank.close();
  }
}, 120_000);

afterEach(async () => {
  for (const page of pages.splice(0)) page.close();
  for (const preview of sessions.splice(0)) await preview.close();
  if (browser !== undefined) await closeAllPages(browser.port);
});

afterAll(async () => {
  await stopBrowser();
  const ordered = pairs.map((entry) => entry.warmReloadCaptureMs).sort((a, b) => a - b);
  const median = ordered.length === 0 ? null : ordered[Math.floor(ordered.length / 2)]!;
  const report = {
    aegis: 'asset-preview-benchmark/1',
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    logicalCpus: cpus().length,
    memoryGiB: totalmem() / 2 ** 30,
    browserStartMs,
    viewport: SIZE,
    systemLoad: systemLoad?.(),
    pairs,
    medianWarmReloadCaptureMs: median,
    targetMs: 1000,
    targetMet: median === null ? null : median <= 1000,
    scope:
      'Cold asset sessions reuse one explicitly borrowed Chromium; each warm sample includes reload through PNG and sidecar publication. The built CLI case separately measures a fully cold browser.',
  };
  writeFileSync(join(evidence, 'preview-benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[asset-preview] ${JSON.stringify(report)}`);
  rmSync(temporary, { recursive: true, force: true });
}, 120_000);

describe('standalone asset preview: actual browser acceptance', () => {
  it('captures the real animated operative, without a scene or game, at two independently different poses', async () => {
    const source = copyAsset(ISO, join(temporary, 'operative'));
    const preview = await start({ source, settings: { clip: 'walk', time: 0 } });
    const first = await preview.capture({ filename: 'operative-walk-0.png', ...SIZE });
    const second = await preview.capture({
      filename: 'operative-walk-quarter.png',
      ...SIZE,
      settings: { time: 0.25 },
    });
    expect(first.rendered).toEqual({ kind: 'model', id: 'preview-asset' });
    expect(first.stats.meshes).toBeGreaterThan(3);
    expect(first.stats.textures).toBe(0); // The operative is vertex-colored, not textured.
    expect(first.stats.library.audioBytes).toBe(0);
    expect(first.stats.clips.map((clip) => clip.name)).toContain('walk');
    expect(second.stats.poseSampleHash).not.toBe(first.stats.poseSampleHash);
    expect(second.output.sha256).not.toBe(first.output.sha256);
    expect(second.recipe.camera.position).toEqual(first.recipe.camera.position);
    expect(second.recipe.camera.target).toEqual(first.recipe.camera.target);
    expect(second.source.sha256).toBe(prepareAssetPreview({ source: ISO }).document.source.sha256);
    expect(readPreviewCapture(second.output.sidecar)).toEqual(second);
    pixels(first);
    pixels(second);
    await expect(
      preview.capture({ filename: 'bad-clip.png', settings: { clip: 'absent-clip' } }),
    ).rejects.toThrow('Unsupported clip');
    expect(existsSync(join(evidence, 'bad-clip.png'))).toBe(false);
    expect((await preview.state()).status).toBe('failed');
    const repaired = await preview.capture({
      filename: 'operative-recovered-clip.png',
      ...SIZE,
      settings: { clip: 'walk', time: 0.25 },
    });
    expect(repaired.output.sha256).toBe(second.output.sha256);
    const portrait = await preview.capture({
      filename: 'operative-portrait.png',
      width: 320,
      height: 640,
    });
    const camera = portrait.recipe.camera;
    const restored = await preview.capture({
      filename: 'operative-portrait-restored.png',
      width: 320,
      height: 640,
      settings: {
        projection: camera.projection,
        camera: {
          position: camera.position,
          target: camera.target,
          zoom: camera.zoom,
          ...(camera.orthographicHeight === null
            ? {}
            : { orthographicHeight: camera.orthographicHeight }),
        },
      },
    });
    expect(restored.recipe.camera).toEqual(camera);
    expect(restored.output.sha256).toBe(portrait.output.sha256);
    pixels(restored);
  });

  it('watches source/texture edits, preserves orbit and clip, rejects failed revisions, and recovers without restarting', async () => {
    const source = copyAsset(CONSOLE, join(temporary, 'iteration'));
    const preview = await start({ source, watch: true, settings: { clip: 'activate', time: 0 } });
    await preview.configure({ camera: { position: [2.5, 1.8, 3], target: [0, 0.65, 0] } });
    const locked = await preview.capture({ filename: 'console-locked.png', ...SIZE });
    const baseline = await preview.capture({
      filename: 'iteration-original.png',
      ...SIZE,
      settings: { time: 0.4 },
    });
    expect(baseline.stats.textures).toBeGreaterThan(0);
    expect(baseline.stats.poseSampleHash).not.toBe(locked.stats.poseSampleHash);
    expect(baseline.output.sha256).not.toBe(locked.output.sha256);
    pixels(locked);
    pixels(baseline);
    const image = prepareAssetPreview({ source }).prepared.files.find(
      (entry) => entry.path === 'terminal-active.png',
    )!;
    expect(image).toBeDefined();
    const original = readFileSync(image.source);
    let previous = baseline;
    for (let iteration = 0; iteration < 5; iteration++) {
      const started = performance.now();
      writeFileSync(image.source, fixturePng(iteration % 2 === 0 ? 'surface' : 'rig'));
      await waitReady(preview, previous.revision);
      const current = await preview.capture({ filename: `iteration-${iteration}.png`, ...SIZE });
      pairs.push({
        source: 'access-console.gltf + terminal-active.png (watch)',
        coldSessionMs: preview.coldStartMs,
        warmReloadCaptureMs: performance.now() - started,
        fingerprint: current.fingerprint,
      });
      expect(current.fingerprint).not.toBe(previous.fingerprint);
      expect(current.output.sha256).not.toBe(previous.output.sha256);
      expect(current.recipe.camera.position).toEqual([2.5, 1.8, 3]);
      expect(current.recipe.camera.target).toEqual([0, 0.65, 0]);
      expect(current.recipe.clip).toBe('activate');
      expect(current.recipe.time).toBe(0.4);
      expect(current.stats.library.modelInstances).toBe(1);
      expect(current.stats.library.audioBytes).toBe(0);
      expect(current.stats.gpu.geometries).toBeLessThanOrEqual(baseline.stats.gpu.geometries);
      expect(current.stats.gpu.textures).toBeLessThanOrEqual(baseline.stats.gpu.textures);
      previous = current;
    }
    const invalid = fixturePng();
    invalid[invalid.indexOf(Buffer.from('IDAT')) + 4] = 0;
    writeFileSync(image.source, invalid);
    const failed = await waitFailed(preview, previous.revision);
    expect(failed.lastGoodRevision).toBe(previous.revision);
    await expect(
      preview.capture({ filename: 'must-not-be-stale.png', revision: failed.revision }),
    ).rejects.toThrow();
    expect(existsSync(join(evidence, 'must-not-be-stale.png.preview.json'))).toBe(false);
    writeFileSync(image.source, original);
    await waitReady(preview, failed.revision);
    const recovery = await preview.capture({ filename: 'iteration-repaired.png', ...SIZE });
    expect(recovery.fingerprint).toBe(baseline.fingerprint);
    expect(recovery.output.sha256).toBe(baseline.output.sha256);
    const model = readFileSync(source);
    writeFileSync(
      source,
      '{"asset":{"version":"2.0"},"buffers":[{"uri":"missing.bin","byteLength":16}]}',
    );
    const absent = await waitFailed(preview, recovery.revision);
    await expect(
      preview.capture({ filename: 'missing-buffer.png', revision: absent.revision }),
    ).rejects.toThrow();
    expect(existsSync(join(evidence, 'missing-buffer.png'))).toBe(false);
    writeFileSync(source, model);
    await waitReady(preview, absent.revision);
    pixels(await preview.capture({ filename: 'repaired-buffer.png', ...SIZE }));
    await expect(
      preview.capture({ filename: 'old-revision.png', revision: baseline.revision }),
    ).rejects.toThrow('Requested revision');
  });

  it('captures cinematic materials with the production pipeline and bounds GPU resources across reloads', async () => {
    const dir = join(temporary, 'cinematic-material');
    const fixture = writePresentationFixture(dir);
    fixture.manifest.quality = 'high';
    fixture.manifest.pipeline = {
      toneMapping: 'aces',
      exposure: 1,
      bloom: { strength: 0.1, radius: 0.2, threshold: 1 },
      ambientOcclusion: { radius: 4, minDistance: 0.002, maxDistance: 0.03 },
    };
    fixture.manifest.environment = { reflections: { texture: 'surface', intensity: 0.4 } };
    fixture.manifest.assets = [
      ...fixture.manifest.assets!,
      {
        id: 'data',
        kind: 'texture',
        colorSpace: 'linear',
        src: 'surface.png',
        provenance: fixture.manifest.assets!.find((asset) => asset.id === 'surface')!.provenance,
      },
    ];
    fixture.manifest.materials = [
      ...(fixture.manifest.materials ?? []),
      {
        id: 'metal',
        shading: 'standard',
        map: 'surface',
        roughnessMap: 'data',
        metalnessMap: 'data',
        aoMap: 'data',
        metalness: 0.6,
      },
    ];
    const source = join(dir, 'sample.presentation.json');
    writeFileSync(source, JSON.stringify(fixture.manifest));
    const preview = await start({ source, selection: { kind: 'material', id: 'metal' } });
    const first = await preview.capture({ filename: 'cinematic-material.png', ...SIZE });
    expect(first.recipe.pipeline).toMatchObject({
      quality: 'high',
      settings: { toneMapping: 'aces' },
    });
    expect(first.stats.pipeline).toMatchObject({
      width: 640,
      height: 480,
      outputTransforms: 1,
      reflections: true,
    });
    pixels(first);
    for (let i = 0; i < 2; i++) {
      await preview.reload();
      const next = await preview.capture({
        filename: `cinematic-material-${i}.png`,
        ...SIZE,
        settings: { projection: i === 0 ? 'orthographic' : 'perspective' },
      });
      expect(next.stats.gpu).toEqual(first.stats.gpu);
      pixels(next);
    }
    await expect(
      preview.capture({ filename: 'over-budget.png', width: 3840, height: 2160 }),
    ).rejects.toThrow(/pixel budget/);
    expect((await preview.state()).status).toBe('ready');
    pixels(await preview.capture({ filename: 'after-budget-refusal.png', ...SIZE }));
  }, 180_000);

  it('shows the original engineer atlas, its declared frame, and a production material sample', async () => {
    const source = copyAsset(ENGINEER, join(temporary, 'atlas'));
    const descriptor = join(dirname(source), 'study.presentation.json');
    const manifest: PresentationManifest = {
      aegis: 'presentation/1',
      assets: [
        {
          id: 'engineer',
          kind: 'texture',
          src: 'engineer.svg',
          provenance: {
            author: 'Aegis / original Coyote Gap art',
            license: 'MIT',
            source: 'source/generate.mjs; provenance.json',
          },
          frames: { idle: [0, 0, 0.125, 0.5], jump: [0, 0.5, 0.125, 1] },
        },
      ],
      materials: [{ id: 'atlas-material', shading: 'standard', map: 'engineer', roughness: 0.65 }],
    };
    writeFileSync(descriptor, JSON.stringify(manifest));
    const preview = await start({
      source: descriptor,
      selection: { kind: 'texture', id: 'engineer', frame: 'idle' },
      settings: { background: '#d6dee8' },
    });
    const idle = await preview.capture({ filename: 'engineer-idle.png', ...SIZE });
    expect(idle.stats.bounds.size[0]).toBeCloseTo(0.8333333333333334, 6);
    expect(idle.dependencies[0]?.provenance.status).toBe('declared');
    pixels(idle);
    await preview.reload({ kind: 'texture', id: 'engineer', frame: 'jump' });
    const jump = await preview.capture({ filename: 'engineer-jump.png', ...SIZE });
    expect(jump.output.sha256).not.toBe(idle.output.sha256);
    pixels(jump);
    await preview.reload({ kind: 'material', id: 'atlas-material' });
    const material = await preview.capture({
      filename: 'engineer-material.png',
      ...SIZE,
      settings: { view: 'three-quarter' },
    });
    expect(material.rendered.kind).toBe('material');
    expect(material.stats.triangles).toBeGreaterThan(1000);
    expect(material.stats.library.audioBytes).toBe(0);
    pixels(material);
    const deck = await start({
      source: join(ROOT, 'poc', 'previews', 'asset-studies.presentation.json'),
      assetRoot: ROOT,
      selection: { kind: 'material', id: 'deck' },
    });
    const surface = await deck.capture({ filename: 'deck-material.png', ...SIZE });
    expect(surface.rendered).toEqual({ kind: 'material', id: 'deck' });
    expect(surface.stats.textures).toBe(2);
    expect(surface.dependencies.map((dependency) => dependency.path)).toEqual([
      'games/fps/assets/generated/deck-albedo.png',
      'games/fps/assets/generated/deck-normal.png',
    ]);
    pixels(surface);
  });

  it('loads the original Kestrel and rifle, measures warm captures, and bounds repeated instance/GPU ownership', async () => {
    for (const filename of ['kestrel-security.glb', 'vaultline-rifle.glb']) {
      const source = copyAsset(join(FPS, filename), join(temporary, basename(filename, '.glb')));
      const preview = await start({ source });
      const cold = await preview.capture({
        filename: `${basename(filename, '.glb')}.png`,
        ...SIZE,
      });
      expect(cold.stats.triangles).toBeGreaterThan(100);
      expect(cold.stats.textures).toBeGreaterThan(0);
      expect(cold.source.sha256).toBe(
        prepareAssetPreview({ source: join(FPS, filename) }).document.source.sha256,
      );
      pixels(cold);
      for (let iteration = 0; iteration < 3; iteration++) {
        const began = performance.now();
        await preview.reload();
        const warm = await preview.capture({
          filename: `${basename(filename, '.glb')}-warm-${iteration}.png`,
          ...SIZE,
        });
        pairs.push({
          source: filename,
          coldSessionMs: preview.coldStartMs,
          warmReloadCaptureMs: performance.now() - began,
          fingerprint: warm.fingerprint,
        });
        expect(warm.stats.library.modelInstances).toBe(1);
        expect(warm.stats.library.audioBytes).toBe(0);
        expect(warm.stats.gpu).toEqual(cold.stats.gpu);
        expect(warm.output.sha256).toBe(cold.output.sha256);
      }
      await preview.close();
    }
  });

  it('offers real operator orbit/reset, clip/scrub, resize and local revision-aware capture controls', async () => {
    const source = copyAsset(ISO, join(temporary, 'operator'));
    const preview = await start({ source, settings: { clip: 'walk', time: 0 } });
    const page = await openPage(browser!.port, preview.url, { width: 1100, height: 800 });
    pages.push(page);
    await until<boolean>(page, 'Boolean(globalThis.aegisPreview)', Boolean);
    await evaluate(page, 'globalThis.aegisPreview.ready()');
    const before = await evaluate<PreviewStudioState>(page, 'globalThis.aegisPreview.state()');
    const box = await evaluate<{ x: number; y: number }>(
      page,
      '(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()',
    );
    await mouseMove(page, box.x, box.y);
    await mouseButton(page, true, box.x, box.y);
    await mouseMove(page, box.x + 90, box.y + 30);
    await mouseButton(page, false, box.x + 90, box.y + 30);
    const moved = await evaluate<PreviewStudioState>(page, 'globalThis.aegisPreview.state()');
    expect(moved.recipe!.camera.position).not.toEqual(before.recipe!.camera.position);
    await evaluate(page, 'document.querySelector("canvas").focus()');
    await key(page, 'KeyF', true);
    await key(page, 'KeyF', false);
    const fit = await evaluate<PreviewStudioState>(page, 'globalThis.aegisPreview.state()');
    fit.recipe!.camera.position.forEach((coordinate, i) =>
      expect(coordinate).toBeCloseTo(before.recipe!.camera.position[i]!, 6),
    );
    await evaluate(
      page,
      'document.querySelector("#scrub").value = "0.25"; document.querySelector("#scrub").dispatchEvent(new Event("input"));',
    );
    await until<number>(
      page,
      'globalThis.aegisPreview.state().recipe.time',
      (time) => time === 0.25,
    );
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 680,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await until<number>(
      page,
      'document.querySelector("canvas").width',
      (width) => width >= 640 && width <= 680,
    );
    const layout = await evaluate<{ width: number; available: number; scroll: number }>(
      page,
      '({width: document.querySelector("canvas").width, available: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth})',
    );
    // A narrow page scrolls vertically; its scrollbar is not part of the available canvas width.
    expect(layout.width).toBe(layout.available);
    expect(layout.scroll).toBe(layout.available);
    const network = await evaluate<string[]>(
      page,
      'performance.getEntriesByType("resource").map(entry => entry.name)',
    );
    const isGameRequest = (url: string): boolean => {
      const path = new URL(url).pathname;
      return (
        /^\/vendor\/@aegis\/(?:harness|mode-fps|mode-iso|mode-platformer)\//.test(path) ||
        /^\/vendor\/@aegis\/render-three\/dist\/client\/(?:boot|static-boot)\.js$/.test(path) ||
        /^\/api\/[^/]+\/frame$/.test(path)
      );
    };
    expect(isGameRequest(`${preview.url}vendor/@aegis/render-three/dist/client/boot.js`)).toBe(
      true,
    );
    expect(
      isGameRequest(`${preview.url}vendor/@aegis/render-three/dist/preview/client/boot.js`),
    ).toBe(false);
    expect(network.some(isGameRequest)).toBe(false);
    expect(
      network.every(
        (url) => url.startsWith(preview.url) || url.startsWith('blob:') || url.startsWith('data:'),
      ),
    ).toBe(true);
    await evaluate(
      page,
      `document.querySelector("#filename").value = "operator-capture.png";
      document.querySelector("#width").value = "320"; document.querySelector("#height").value = "240";
      document.querySelector("#capture").click();`,
    );
    await until<string>(page, 'document.querySelector("#capture-result").textContent', (text) =>
      text.startsWith('Saved revision'),
    );
    const saved = readPreviewCapture(join(evidence, 'operator-capture.png.preview.json'));
    expect(saved.output).toMatchObject({ width: 320, height: 240 });
    expect(saved.recipe.time).toBe(0.25);
    pixels(saved);
    const edited = JSON.parse(readFileSync(source, 'utf8')) as {
      animations: { name: string }[];
    };
    const walk = edited.animations.find((animation) => animation.name === 'walk');
    if (walk === undefined) throw new Error('Original operative has no walk clip.');
    walk.name = 'walk-edited';
    writeFileSync(source, JSON.stringify(edited));
    await expect(preview.reload()).rejects.toThrow('Unsupported clip');
    await until<boolean>(page, 'globalThis.aegisPreview.state().recovery !== null', Boolean);
    await evaluate(page, 'document.querySelector("#recover").click()');
    await until<string>(
      page,
      'globalThis.aegisPreview.state().status',
      (value) => value === 'ready',
    );
    const recovered = await evaluate<PreviewStudioState>(page, 'globalThis.aegisPreview.state()');
    expect(recovered.recipe?.clip).toBeNull();
    expect(recovered.recipe?.time).toBe(0);
    expect(recovered.revision).toBeGreaterThan(saved.revision);
    await screenshot(page, join(evidence, 'operator-studio.png'));
  });

  it('runs the built one-shot CLI with a fully cold managed browser and persists PNG plus truthful timings', async () => {
    // All warm API sessions are closed by afterEach. Never run two browser processes together.
    await stopBrowser();
    const file = join(evidence, 'cli-engineer.png');
    const out = execFileSync(
      process.execPath,
      [
        join(ROOT, 'packages', 'cli', 'bin', 'aegis.mjs'),
        'preview',
        ENGINEER,
        '--out',
        file,
        '--width',
        '512',
        '--height',
        '384',
        '--json',
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const report = JSON.parse(out) as PreviewCaptureReport;
    expect(report.aegis).toBe('asset-preview-capture/1');
    expect(report.output).toMatchObject({ path: file, width: 512, height: 384 });
    expect(report.timings.browserStartMs).toBeGreaterThan(0);
    expect(report.timings.sessionColdStartMs).toBeGreaterThan(report.timings.browserStartMs!);
    expect(report.timings.lastReloadMs).toBeNull();
    expect(report.freshness.matchesSource).toBe(true);
    expect(report.source.sha256).toBe(
      prepareAssetPreview({ source: ENGINEER }).document.source.sha256,
    );
    expect(readPreviewCapture(report.output.sidecar)).toEqual(report);
    pixels(report);
  }, 120_000);
});
