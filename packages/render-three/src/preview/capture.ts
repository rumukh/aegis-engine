import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { DiagnosticError } from '@aegis/core';
import type { Diagnostic } from '@aegis/core';
import { closeAllPages, evaluate, launchBrowser, openPage, until } from '../browser.js';
import type { CdpSession, LaunchedBrowser } from '../browser.js';
import { PreviewCode, previewDiagnostics, previewError } from './diagnostics.js';
import { startAssetPreviewServer, validateCaptureRequest } from './server.js';
import type { AssetPreviewServer, AssetPreviewServerOptions } from './server.js';
import { sha256 } from './source.js';
import { previewOutputPaths } from './output.js';
import type {
  PreviewCaptureReport,
  PreviewCaptureRequest,
  PreviewFrame,
  PreviewSelection,
  PreviewSettings,
  PreviewStudioState,
} from './types.js';

export interface AssetPreviewOptions extends AssetPreviewServerOptions {
  headed?: boolean;
  /** An explicitly borrowed browser. This session closes only its own page, not that browser. */
  browser?: LaunchedBrowser;
}

export interface AssetPreview {
  readonly server: AssetPreviewServer;
  readonly url: string;
  readonly token: string;
  readonly coldStartMs: number;
  state(): Promise<PreviewStudioState>;
  reload(selection?: PreviewSelection): Promise<PreviewStudioState>;
  configure(settings: PreviewSettings): Promise<PreviewStudioState>;
  capture(request: PreviewCaptureRequest): Promise<PreviewCaptureReport>;
  close(): Promise<void>;
}

type ClientMethod =
  'state' | 'ready' | 'reload' | 'configure' | 'captureFrame' | 'capabilities' | 'dispose';

async function invoke<T>(
  cdp: CdpSession,
  method: ClientMethod,
  args: readonly unknown[] = [],
): Promise<T> {
  const result = await evaluate<
    { ok: true; value: T } | { ok: false; diagnostics: readonly Diagnostic[] }
  >(
    cdp,
    `(async () => {
      try { return { ok: true, value: await globalThis.aegisPreview[${JSON.stringify(method)}](...${JSON.stringify(args)}) }; }
      catch (error) { return { ok: false, diagnostics: error.diagnostics ?? [{
        code: '${PreviewCode.Browser}', severity: 'error', location: { path: 'browser' },
        message: String(error), fix: 'Repair the asset or settings and reload the current revision.'
      }] }; }
    })()`,
  );
  if (!result.ok) throw new DiagnosticError(result.diagnostics);
  return result.value;
}

/** Parse dimensions from an actual encoded PNG, never from requested settings alone. */
export function previewPngSize(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw previewError(
      PreviewCode.Output,
      'png',
      'The browser returned invalid PNG bytes.',
      'Check that the renderer and PNG encoder completed before publishing a capture.',
    );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function stopOwnedBrowser(browser: LaunchedBrowser): Promise<void> {
  const child = browser.process;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((done, fail) => {
      const timer = setTimeout(
        () =>
          fail(
            previewError(
              PreviewCode.Browser,
              'browser',
              `Owned browser PID ${child.pid} did not exit after termination.`,
              'Stop only this reported process; do not kill unrelated browser processes.',
            ),
          ),
        10_000,
      );
      child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        fail(error);
      });
    });
    child.kill();
    await exited;
  }
  rmSync(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

/** A warm asset-only browser, server, and bounded output writer with one explicit lifetime. */
export async function startAssetPreview(options: AssetPreviewOptions): Promise<AssetPreview> {
  const started = performance.now();
  const server = await startAssetPreviewServer(options);
  let browser: LaunchedBrowser | undefined = options.browser;
  let cdp: CdpSession | undefined;
  let targetId: string | undefined;
  let clientCreated = false;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const owned = options.browser === undefined;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await queue;
    const failures: unknown[] = [];
    if (cdp !== undefined) {
      if (clientCreated) {
        try {
          await invoke(cdp, 'dispose');
        } catch (error) {
          failures.push(error);
        }
      }
      cdp.close();
    }
    if (browser !== undefined) {
      try {
        if (owned) await closeAllPages(browser.port);
        else if (targetId !== undefined) {
          const response = await fetch(`http://127.0.0.1:${browser.port}/json/close/${targetId}`, {
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok)
            throw new Error(`Could not close preview target ${targetId}: ${response.status}`);
        }
      } catch (error) {
        failures.push(error);
      }
      if (owned) {
        try {
          await stopOwnedBrowser(browser);
        } catch (error) {
          failures.push(error);
        }
      }
    }
    try {
      await server.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'Asset preview cleanup failed; see individual errors.');
  };
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    if (closed)
      return Promise.reject(
        previewError(
          PreviewCode.Revision,
          'preview',
          'This preview session is closed.',
          'Start a new session before capturing.',
        ),
      );
    const result = queue.then(work);
    // Keep the queue usable after a refused request; its caller still receives the rejection.
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  try {
    const initial = server.state();
    if (initial.status !== 'prepared') throw new DiagnosticError(initial.diagnostics);
    const browserStart = performance.now();
    browser ??= await launchBrowser({
      headed: options.headed,
      viewport: { width: 1280, height: 900 },
    });
    const browserStartMs = owned ? performance.now() - browserStart : null;
    cdp = await openPage(browser.port, server.url, { width: 1280, height: 900 });
    const page = cdp;
    targetId = (await page.send<{ targetInfo: { targetId: string } }>('Target.getTargetInfo'))
      .targetInfo.targetId;
    await until<boolean>(
      page,
      'Boolean(globalThis.aegisPreview || globalThis.aegisPreviewFailure)',
      (ready) => ready,
    );
    const failure = await evaluate<readonly Diagnostic[] | null>(
      page,
      'globalThis.aegisPreviewFailure ?? null',
    );
    if (failure !== null) throw new DiagnosticError(failure);
    clientCreated = true;
    await invoke(page, 'ready', [initial.revision]);
    const coldStartMs = performance.now() - started;
    const capabilities = await invoke<{ browser: string; renderer: string }>(page, 'capabilities');
    let lastReloadMs: number | null = null;
    const studioState = (): Promise<PreviewStudioState> => serialize(() => invoke(page, 'state'));
    const configure = (settings: PreviewSettings): Promise<PreviewStudioState> =>
      serialize(async () => {
        server.current(server.state().revision);
        return invoke(page, 'configure', [settings]);
      });
    const capture = (input: PreviewCaptureRequest): Promise<PreviewCaptureReport> =>
      serialize(async () => {
        const captureStart = performance.now();
        const request = validateCaptureRequest(input);
        const revision = request.revision ?? server.state().revision;
        const closure = server.current(revision);
        const output = previewOutputPaths(server, request.filename, revision);
        if (request.settings !== undefined) await invoke(page, 'configure', [request.settings]);
        await invoke(page, 'ready', [revision]);
        const frame = await invoke<PreviewFrame>(page, 'captureFrame', [
          revision,
          request.width,
          request.height,
        ]);
        server.current(revision);
        if (frame.revision !== revision || frame.fingerprint !== closure.document.fingerprint)
          throw previewError(
            PreviewCode.Revision,
            'capture',
            'The rendered revision does not match the current prepared closure.',
            'Reload, wait for readiness, and request the current revision.',
          );
        const prefix = 'data:image/png;base64,';
        if (!frame.dataUrl.startsWith(prefix))
          throw previewError(
            PreviewCode.Output,
            'png',
            'The preview did not return PNG pixels.',
            'Repair the browser encoder before retrying.',
          );
        const bytes = Buffer.from(frame.dataUrl.slice(prefix.length), 'base64');
        const dimensions = previewPngSize(bytes);
        if (dimensions.width !== request.width || dimensions.height !== request.height)
          throw previewError(
            PreviewCode.Output,
            'dimensions',
            `Encoded PNG is ${dimensions.width}x${dimensions.height}, not ${request.width}x${request.height}.`,
            'Retry with supported exact pixel dimensions.',
          );
        const checkedAt = new Date().toISOString();
        const captureMs = performance.now() - captureStart;
        const suffix = `.preview-${randomBytes(8).toString('hex')}.tmp`;
        const temporaryPng = output.file + suffix;
        const temporaryJson = output.sidecar + suffix;
        try {
          const writeStart = performance.now();
          writeFileSync(temporaryPng, bytes, { flag: 'wx' });
          server.current(revision);
          // A manifest is the commit marker. Never leave an old success beside newly written bytes.
          rmSync(output.sidecar, { force: true });
          renameSync(temporaryPng, output.file);
          const pngWriteMs = performance.now() - writeStart;
          const report: PreviewCaptureReport = {
            aegis: 'asset-preview-capture/1',
            revision,
            fingerprint: frame.fingerprint,
            source: { ...closure.document.source, path: closure.sourcePath },
            dependencies: closure.document.dependencies,
            freshness: {
              matchesSource: true,
              checkedAt,
              policy: 'checked-before-and-after-capture',
            },
            rendered: frame.recipe.selection,
            recipe: frame.recipe,
            stats: frame.stats,
            output: {
              path: output.file,
              sidecar: output.sidecar,
              ...dimensions,
              bytes: bytes.length,
              sha256: sha256(bytes),
            },
            timings: {
              sessionColdStartMs: coldStartMs,
              browserStartMs,
              prepareMs: closure.document.prepareMs,
              loadMs: frame.loadMs,
              renderMs: frame.renderMs,
              encodeMs: frame.encodeMs,
              captureMs,
              pngWriteMs,
              totalMs: performance.now() - captureStart,
              lastReloadMs,
            },
            host: { platform: platform(), arch: arch(), node: process.version, ...capabilities },
            scope: 'asset-only; no gameplay validation',
            pixelDeterminism: 'not-guaranteed-across-GPUs',
          };
          writeFileSync(temporaryJson, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
          renameSync(temporaryJson, output.sidecar);
          return report;
        } catch (error) {
          throw new DiagnosticError(previewDiagnostics(error, PreviewCode.Output));
        } finally {
          rmSync(temporaryPng, { force: true });
          rmSync(temporaryJson, { force: true });
        }
      });
    const result: AssetPreview = {
      server,
      url: server.url,
      token: server.token,
      coldStartMs,
      state: studioState,
      configure,
      capture,
      reload: (selection) =>
        serialize(async () => {
          const before = performance.now();
          const state = await invoke<PreviewStudioState>(
            page,
            'reload',
            selection === undefined ? [] : [selection],
          );
          lastReloadMs = performance.now() - before;
          return state;
        }),
      close,
    };
    server.attachAutomation({ capture, configure, state: studioState });
    return result;
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Asset preview startup and cleanup failed.');
    }
    throw new DiagnosticError(previewDiagnostics(error, PreviewCode.Browser));
  }
}

/** Read a persisted report and prove that its recorded PNG still accompanies it. */
export function readPreviewCapture(sidecar: string): PreviewCaptureReport {
  const report = JSON.parse(readFileSync(sidecar, 'utf8')) as PreviewCaptureReport;
  if (report.aegis !== 'asset-preview-capture/1')
    throw previewError(
      PreviewCode.Output,
      'sidecar',
      'Unsupported capture report version.',
      'Read an asset-preview-capture/1 sidecar.',
    );
  const png = readFileSync(report.output.path);
  const size = previewPngSize(png);
  if (
    sha256(png) !== report.output.sha256 ||
    size.width !== report.output.width ||
    size.height !== report.output.height
  )
    throw previewError(
      PreviewCode.Output,
      'sidecar',
      'The PNG no longer matches this capture report.',
      'Keep each PNG with the sidecar from the same capture.',
    );
  return report;
}
