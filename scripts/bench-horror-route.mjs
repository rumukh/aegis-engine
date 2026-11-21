// Real-time replay in the live player. No checkpoint jumping or fast-forwarded control requests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { EMPTY_INPUT_FRAME } from '@aegis/core';
import { parseInputScript } from '@aegis/harness';
import { pocGames } from '../poc/poc-games.mjs';
import { startDevServer } from '../packages/render-three/dist/dev-server.js';
import {
  CdpSession,
  evaluate,
  launchBrowser,
  openPage,
  until,
} from '../packages/render-three/dist/browser.js';
import { navigateAndWait } from '../packages/render-three/dist/browser-navigation.js';
import { closeOwnedBrowser } from '../packages/render-three/dist/testing/browser-lifecycle.js';

const { values } = parseArgs({
  options: {
    device: { type: 'string' },
    renderer: { type: 'string' },
    driver: { type: 'string' },
    quality: { type: 'string', default: 'high' },
    resolution: { type: 'string', default: '2560x1440' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'node scripts/bench-horror-route.mjs --device target|integrated|software --renderer "active GPU substring" --driver "version" --out report.json [--resolution 2560x1440 --quality high]',
  );
  process.exit(0);
}
assert.ok(
  ['target', 'integrated', 'software'].includes(values.device),
  'Supply --device target, integrated or software.',
);
assert.ok(
  values.out && values.driver && values.renderer?.trim(),
  'Supply --out, --driver and a nonempty --renderer identifying the actual active device.',
);
assert.ok(['low', 'standard', 'high', 'photo'].includes(values.quality), 'Invalid quality');
assert.match(values.resolution, /^[1-9]\d{1,3}x[1-9]\d{1,3}$/);
const [width, height] = values.resolution.split('x').map(Number);
if (values.device === 'target')
  assert.ok(
    width === 2560 && height === 1440 && values.quality === 'high',
    'Target qualification is 2560x1440/high.',
  );

// Installed only in the benchmark page. GPU queries never wait; a disjoint invalidates all
// outstanding observations. The measured call includes the normal postprocessing pipeline.
async function instrument() {
  const { PresentationHost } =
    await import('/vendor/@aegis/render-three/dist/client/presentation-host.js');
  const { document, performance, devicePixelRatio } = globalThis;
  const gl = document.querySelector('#stage').getContext('webgl2');
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const api = globalThis.aegis;
  const samples = {
    gaps: [],
    cpuRender: [],
    gpuRender: [],
    disjoint: 0,
    firstTick: null,
    lastTick: 0,
  };
  let lastFrame = null;
  let pending = null;
  const render = PresentationHost.prototype.render;
  PresentationHost.prototype.render = function () {
    const tick = api.tick();
    if (tick >= 8154) return render.call(this);
    const now = performance.now();
    if (lastFrame !== null) samples.gaps.push(now - lastFrame);
    lastFrame = now;
    samples.firstTick ??= tick;
    samples.lastTick = tick;
    if (ext && gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      if (pending) gl.deleteQuery(pending);
      pending = null;
      samples.disjoint++;
    } else if (pending && gl.getQueryParameter(pending, gl.QUERY_RESULT_AVAILABLE)) {
      samples.gpuRender.push(gl.getQueryParameter(pending, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(pending);
      pending = null;
    }
    const query = ext && !pending && samples.cpuRender.length % 20 === 0 ? gl.createQuery() : null;
    if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    const start = performance.now();
    try {
      return render.call(this);
    } finally {
      samples.cpuRender.push(performance.now() - start);
      if (query) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        pending = query;
      }
    }
  };
  globalThis.routeMeasurements = samples;
  return {
    activeRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    backing: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    dpr: devicePixelRatio,
    quality: api.presentation().quality,
    pipeline: api.presentation().pipeline,
    gpuTimerAvailable: !!ext,
  };
}
function distribution(ms) {
  if (!ms.length) return null;
  ms.sort((a, b) => a - b);
  const percentile = (p) => ms[Math.ceil(ms.length * p) - 1];
  return {
    samples: ms.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: ms.at(-1),
  };
}
const game = (await pocGames()).find((g) => g.id === 'horror');
const parsed = parseInputScript(game.script);
assert.ok(parsed.ok && parsed.value, 'The shipped script must compile.');
const frames = parsed.value.frames(game.scriptTicks);
let startedAt = null;
const server = await startDevServer({
  port: 0,
  games: [
    {
      ...game,
      presentation: {
        ...game.presentation,
        manifest: { ...game.presentation.manifest, quality: values.quality },
      },
    },
  ],
  clock: () => (startedAt === null ? 0 : (performance.now() - startedAt) / 1000),
  replayInputs: new Map([
    ['horror', { frameFor: (tick) => frames[tick] ?? { ...EMPTY_INPUT_FRAME, tick } }],
  ]),
});
let browser;
try {
  browser = await launchBrowser({
    viewport: { width, height },
    graphics: values.device === 'software' ? 'software' : 'hardware',
  });
  const version = await (
    await globalThis.fetch(`http://127.0.0.1:${browser.port}/json/version`)
  ).json();
  const control = await CdpSession.connect(version.webSocketDebuggerUrl);
  let devices;
  try {
    devices = (await control.send('SystemInfo.getInfo')).gpu.devices;
  } finally {
    control.close();
  }
  const report = {
    benchmark: 'null-meridian-live-route/1',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
    inputSha256: createHash('sha256').update(game.script.replaceAll('\r\n', '\n')).digest('hex'),
    measuredAt: new Date().toISOString(),
    deviceClass: values.device,
    driverReportedByOperator: values.driver,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model,
    browser: version.Browser,
    devices,
    conditions:
      'Local dev-server transport; real-time fixed-step simulation; shipped input, scene, assets and selected pipeline. Default headless compositor pacing; DPR 1. No simulated ticks skipped.',
    scope:
      'Frame gaps between host renders. CPU wall time in PresentationHost.render (includes submit/wait, not simulation). GPU: disjoint timer around same render every 20 frames when available. Peak used V8 heap of the page sampled about once per second from route start, not process RAM or VRAM.',
    runs: [],
  };
  for (const condition of [
    'cold: new browser profile',
    'warm: same browser/profile/origin, fresh page and world',
  ]) {
    startedAt = null;
    const restarted = await globalThis.fetch(`${server.url}/api/horror/control`, {
      method: 'POST',
      body: JSON.stringify({ command: 'restart' }),
    });
    assert.ok(restarted.ok, 'World restart failed');
    const page = await openPage(browser.port, 'about:blank', { width, height });
    try {
      await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `requestAnimationFrame(function mounted() {
        if (!globalThis.aegis) { requestAnimationFrame(mounted); return; }
        aegis.ready.then(() => globalThis.routeLoadMs = performance.now());
      });`,
      });
      await navigateAndWait(page, () =>
        page.send('Page.navigate', { url: `${server.url}/play/horror/` }),
      );
      const loadMs = await until(page, 'globalThis.routeLoadMs ?? null', (x) => x !== null);
      const setup = await evaluate(page, `(${instrument.toString()})()`);
      assert.ok(
        setup.activeRenderer?.toLowerCase().includes(values.renderer.toLowerCase()),
        `Active renderer does not match: ${setup.activeRenderer}`,
      );
      if (values.device !== 'software')
        assert.doesNotMatch(setup.activeRenderer, /swiftshader|software|llvmpipe|basic render/i);
      if (values.device === 'target') assert.match(setup.activeRenderer, /4070 Ti SUPER/i);
      if (values.device === 'integrated')
        assert.doesNotMatch(setup.activeRenderer, /GeForce|Radeon RX|Arc A\d/i);
      assert.equal(setup.quality, values.quality);
      assert.deepEqual(
        setup.backing,
        [width, height],
        'Backing resolution differs from requested workload.',
      );
      assert.deepEqual(
        [setup.pipeline.width, setup.pipeline.height],
        setup.backing,
        'Cinematic backing differs from the canvas.',
      );
      assert.equal(await evaluate(page, 'aegis.tick()'), 0, 'World must begin at tick 0.');
      startedAt = performance.now();
      let lastProgress = startedAt;
      let previous = -1;
      let heapSamples = 0;
      let peakHeapBytes = 0;
      for (;;) {
        const { usedSize } = await page.send('Runtime.getHeapUsage');
        peakHeapBytes = Math.max(peakHeapBytes, usedSize);
        heapSamples++;
        const tick = await evaluate(page, 'aegis.tick()');
        if (tick >= 8154) break;
        if (tick > previous) {
          lastProgress = performance.now();
          previous = tick;
        }
        assert.ok(performance.now() - lastProgress < 30000, `Simulation stalled at tick ${tick}.`);
        assert.ok(performance.now() - startedAt < 900000, 'Full route exceeded 15 minutes.');
        await delay(1000);
      }
      const measurements = await evaluate(page, 'globalThis.routeMeasurements');
      const { exchangeErrors } = await evaluate(page, 'aegis.timings()');
      assert.equal(exchangeErrors, 0, 'Live delivery dropped an exchange.');
      const events = server.session('horror').world.events.history();
      const wins = events.filter((e) => e.type === 'level.completed').map((e) => e.tick);
      assert.deepEqual(wins, [8153]);
      assert.ok(!events.some((e) => e.type === 'player.died'));
      assert.ok(
        measurements.firstTick === 0 &&
          measurements.lastTick >= 8140 &&
          measurements.gaps.length > 1,
        'Did not observe the full rendered route.',
      );
      const beats = events
        .filter((e) =>
          [
            'horror.power.restored',
            'horror.recorder.recovered',
            'horror.threat.chase',
            'horror.threat.evaded',
            'level.completed',
          ].includes(e.type),
        )
        .map(({ type, tick }) => ({ type, tick }));
      const result = {
        condition,
        loadMs,
        ...setup,
        beats,
        exchangeErrors,
        firstRenderedTick: measurements.firstTick,
        lastPreWinRenderedTick: measurements.lastTick,
        completedTicks: wins,
        routeElapsedMs: measurements.gaps.reduce((sum, n) => sum + n, 0),
        frameGapMs: distribution(measurements.gaps),
        cpuRenderMs: distribution(measurements.cpuRender),
        gpuRenderMs: distribution(measurements.gpuRender),
        gpuDisjoint: measurements.disjoint,
        peakHeapBytes,
        heapSamples,
        vramBytes: null,
        processResidentBytes: null,
      };
      report.runs.push(result);
      await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + '\n');
      console.log(
        `${condition}: ${beats.at(-1).type}@${wins[0]}, ${result.frameGapMs.samples} frames, p95 ${result.frameGapMs.p95.toFixed(1)} ms. ${resolve(values.out)}`,
      );
    } finally {
      await page.send('Page.close');
      page.close();
    }
  }
} finally {
  try {
    if (browser) await closeOwnedBrowser(browser);
  } finally {
    await server.close();
    if (browser)
      await rm(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
