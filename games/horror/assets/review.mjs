import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2),
  options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--driver', '--out'].includes(args[i]) || !args[i + 1])
    throw new Error(
      'Usage: node games\\horror\\assets\\review.mjs --driver <built hardware-capable browser.js> --out <review directory>',
    );
  options.set(args[i], resolve(args[i + 1]));
}
if (!options.has('--driver') || !options.has('--out'))
  throw new Error('Explicit driver and output paths are required');
const driverPath = options.get('--driver');
if (!(await readFile(driverPath, 'utf8')).includes('graphics'))
  throw new Error(
    'Browser driver does not declare hardware graphics selection. Build the updated renderer; do not silently use SwiftShader for large asset reviews.',
  );
const driver = await import(pathToFileURL(driverPath).href);
const { startAssetPreview } = await import(
  pathToFileURL(join(dirname(driverPath), 'preview', 'capture.js')).href
);
const output = options.get('--out');
await mkdir(output, { recursive: true });
const browser = await driver.launchBrowser({
  graphics: 'hardware',
  viewport: { width: 1280, height: 900 },
});
process.stdout.write(
  `${JSON.stringify({ browserPid: browser.process.pid, profile: browser.profile, port: browser.port, graphicsRequested: 'hardware' })}\n`,
);
const reports = [];
let reviewFailure;
try {
  const studies = [
    [
      'responder.glb',
      [
        {
          filename: 'responder-idle.png',
          width: 1000,
          height: 1200,
          settings: { view: 'three-quarter', lighting: 'neutral', clip: 'Idle', time: 0 },
        },
        {
          filename: 'responder-stalk-left.png',
          width: 1000,
          height: 1200,
          settings: { clip: 'Stalk', time: 0 },
        },
        {
          filename: 'responder-stalk-right.png',
          width: 1000,
          height: 1200,
          settings: { clip: 'Stalk', time: 1.1 },
        },
        {
          filename: 'responder-lunge.png',
          width: 1000,
          height: 1200,
          settings: { clip: 'Lunge', time: 0.65 },
        },
        {
          filename: 'responder-front.png',
          width: 1100,
          height: 1400,
          settings: { view: 'front', clip: 'Idle', time: 0 },
        },
        {
          filename: 'responder-side.png',
          width: 1100,
          height: 1400,
          settings: { view: 'right', clip: 'Idle', time: 0 },
        },
        {
          filename: 'responder-material-detail.png',
          width: 1400,
          height: 1200,
          settings: {
            camera: { position: [0.6, 1.5, 1.02], target: [0, 1.42, 0.03] },
            clip: 'Idle',
            time: 0,
            lighting: 'neutral',
          },
        },
      ],
    ],
    [
      'power-console.glb',
      [
        {
          filename: 'console-front.png',
          width: 1000,
          height: 1000,
          settings: { view: 'three-quarter', lighting: 'warm' },
        },
      ],
    ],
    [
      'arrival-terminal.glb',
      [
        {
          filename: 'wall-terminal.png',
          width: 1200,
          height: 900,
          settings: { view: 'three-quarter', lighting: 'neutral' },
        },
      ],
    ],
    [
      'pressure-door.glb',
      [
        {
          filename: 'door-closed.png',
          width: 1200,
          height: 1000,
          settings: { view: 'front', lighting: 'neutral', clip: 'Open', time: 0 },
        },
        {
          filename: 'door-open.png',
          width: 1200,
          height: 1000,
          settings: { clip: 'Open', time: Math.fround(0.7) },
        },
      ],
    ],
    [
      'orbital-exterior.glb',
      [
        {
          filename: 'orbital-reveal.png',
          width: 1600,
          height: 1000,
          settings: {
            camera: { position: [15, 1.62, 37], target: [7, 4, 700] },
            lighting: 'neutral',
            background: '#030509',
          },
        },
      ],
    ],
    [
      'facility.glb',
      [
        {
          filename: 'facility-ingress.png',
          width: 1600,
          height: 900,
          settings: {
            camera: { position: [15, 1.62, 3], target: [16, 1.62, 12] },
            lighting: 'warm',
          },
        },
        {
          filename: 'facility-medical.png',
          width: 1600,
          height: 900,
          settings: {
            camera: { position: [26, 1.62, 10], target: [29, 1.6, 14] },
            lighting: 'neutral',
          },
        },
        {
          filename: 'facility-power.png',
          width: 1600,
          height: 900,
          settings: { camera: { position: [3, 1.62, 26], target: [1, 1.7, 29] }, lighting: 'warm' },
        },
      ],
    ],
  ];
  for (const study of studies) {
    if (study.length !== 2 || !Array.isArray(study[1]))
      throw new Error('Malformed asset study: expected one model and one capture list');
    const [file, captures] = study;
    const preview = await startAssetPreview({
      source: join(here, 'generated', file),
      outputDir: output,
      browser,
    });
    process.stdout.write(`${JSON.stringify({ ready: file, url: preview.url })}\n`);
    try {
      for (const request of captures) {
        const report = await preview.capture(request);
        if (/SwiftShader|llvmpipe/i.test(report.host.renderer))
          throw new Error(`Hardware requested but software renderer used: ${report.host.renderer}`);
        reports.push(report);
        process.stdout.write(
          `${JSON.stringify({ image: request.filename, renderer: report.host.renderer, pose: report.stats.poseSampleHash, triangles: report.stats.triangles })}\n`,
        );
      }
    } finally {
      await preview.close();
    }
  }
  if (reports.length !== studies.reduce((sum, [, captures]) => sum + captures.length, 0))
    throw new Error('An authored review capture did not execute');
  await writeFile(join(output, 'asset-review.json'), `${JSON.stringify(reports, null, 2)}\n`);
} catch (error) {
  reviewFailure = error;
}
try {
  try {
    try {
      await driver.closeAllPages(browser.port);
    } finally {
      browser.process.kill();
      await new Promise((done, fail) => {
        if (browser.process.exitCode !== null || browser.process.signalCode !== null) done();
        else {
          const timer = setTimeout(
            () => fail(new Error(`Owned review browser ${browser.process.pid} did not exit`)),
            10000,
          );
          browser.process.once('exit', () => {
            clearTimeout(timer);
            done();
          });
        }
      });
      await rm(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  } catch (cleanupError) {
    reviewFailure = reviewFailure
      ? new AggregateError(
          [reviewFailure, cleanupError],
          'Asset review and owned browser cleanup failed',
        )
      : cleanupError;
  }
} catch (error) {
  reviewFailure = reviewFailure
    ? new AggregateError([reviewFailure, error], 'Asset review cleanup failed')
    : error;
}
if (reviewFailure) throw reviewFailure;
