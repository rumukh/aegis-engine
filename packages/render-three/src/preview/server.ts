import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiagnosticError } from '@aegis/core';
import { presentationMimeType, readPreparedPresentationFile } from '../presentation/files.js';
import { isAssetPath } from '../presentation/diagnostics.js';
import { resolveVendorPath } from '../vendor.js';
import { PreviewCode, previewDiagnostics, previewError, record } from './diagnostics.js';
import { renderAssetPreviewPage } from './page.js';
import { assertPreviewFresh, prepareAssetPreview } from './source.js';
import type { PreparedPreview, PreviewSourceOptions } from './source.js';
import { captureDimensions, validatePreviewSettings, validateSelection } from './settings.js';
import { AssetPreviewWatch } from './watch.js';
import type {
  PreviewCaptureReport,
  PreviewCaptureRequest,
  PreviewSelection,
  PreviewServerState,
  PreviewSettings,
  PreviewStudioState,
} from './types.js';

export interface AssetPreviewServerOptions extends PreviewSourceOptions {
  port?: number;
  watch?: boolean;
  repoRoot?: string;
  settings?: PreviewSettings;
  /** Only an explicit startup directory enables host-side capture writes. */
  outputDir?: string;
}

export interface PreviewAutomation {
  capture(request: PreviewCaptureRequest): Promise<PreviewCaptureReport>;
  configure(settings: PreviewSettings): Promise<PreviewStudioState>;
  state(): Promise<PreviewStudioState>;
}

export interface AssetPreviewServer {
  readonly url: string;
  readonly token: string;
  readonly port: number;
  readonly outputDir: string | undefined;
  state(): PreviewServerState;
  reload(selection?: PreviewSelection): PreviewServerState;
  current(revision: number): PreparedPreview;
  /** Set only by a managed, long-lived browser session. No client may supply a file writer. */
  attachAutomation(automation: PreviewAutomation): void;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const data: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    bytes += data.length;
    if (bytes > 16_384)
      throw previewError(
        PreviewCode.Access,
        'body',
        'Preview requests are limited to 16 KiB.',
        'Send bounded settings and a filename, never file contents or paths.',
      );
    chunks.push(data);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw previewError(
      PreviewCode.Settings,
      'body',
      'Malformed JSON request.',
      'Send application/json with the documented preview request fields.',
    );
  }
}

export function validateCaptureRequest(
  input: unknown,
  requireRevision = false,
): PreviewCaptureRequest {
  const r = record(input, ['filename', 'revision', 'width', 'height', 'settings'], 'capture');
  if (
    typeof r.filename !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\.png$/i.test(r.filename) ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(r.filename)
  )
    throw previewError(
      PreviewCode.Output,
      'filename',
      'A capture filename must be a portable PNG basename of at most 100 characters.',
      'Use e.g. "operative-front.png". Directories, traversal, device names and absolute paths are not accepted.',
    );
  if (
    (requireRevision || r.revision !== undefined) &&
    (!Number.isSafeInteger(r.revision) || typeof r.revision !== 'number' || r.revision < 1)
  )
    throw previewError(
      PreviewCode.Revision,
      'revision',
      'A positive current revision is required.',
      'Read /api/state and pass its revision explicitly.',
    );
  if (
    (r.width !== undefined && typeof r.width !== 'number') ||
    (r.height !== undefined && typeof r.height !== 'number')
  )
    throw previewError(
      PreviewCode.Settings,
      'dimensions',
      'Width and height must be numbers.',
      'Send integer pixel dimensions.',
    );
  const size = captureDimensions(r.width, r.height);
  return {
    filename: r.filename,
    ...size,
    ...(typeof r.revision === 'number' ? { revision: r.revision } : {}),
    ...(r.settings === undefined ? {} : { settings: validatePreviewSettings(r.settings) }),
  };
}

/** Loopback-only, asset-only host. It does not import a catalog, scene loader, or live session. */
export async function startAssetPreviewServer(
  options: AssetPreviewServerOptions,
): Promise<AssetPreviewServer> {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  )
    throw previewError(
      PreviewCode.Access,
      'port',
      'Preview port must be an integer in [0, 65535].',
      'Use 0 for an available loopback port.',
    );
  const settings = validatePreviewSettings(options.settings ?? {});
  const repoRoot = options.repoRoot ?? fileURLToPath(new URL('../../../../', import.meta.url));
  const sourceOptions: PreviewSourceOptions = {
    source: resolve(options.source),
    assetRoot: options.assetRoot,
    selection: options.selection,
  };
  const outputDir = options.outputDir === undefined ? undefined : resolve(options.outputDir);
  const token = randomBytes(24).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  let prepared: PreparedPreview | undefined;
  let lastPrepared: PreparedPreview | undefined;
  let state: PreviewServerState = {
    aegis: 'asset-preview-state/1',
    revision: 0,
    status: 'preparing',
    lastPreparedRevision: null,
    document: null,
    diagnostics: [],
  };
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let automation: PreviewAutomation | undefined;
  const streams = new Set<ServerResponse>();
  let watcher: AssetPreviewWatch | undefined;

  const publish = (): void => {
    const event = `data: ${JSON.stringify(state)}\n\n`;
    for (const stream of streams) {
      if (!stream.write(event)) {
        streams.delete(stream);
        stream.end();
      }
    }
  };
  const begin = (): void => {
    prepared = undefined;
    state = {
      ...state,
      revision: state.revision + 1,
      status: 'preparing',
      document: null,
      diagnostics: [],
    };
    publish();
  };
  const finish = (): PreviewServerState => {
    try {
      prepared = prepareAssetPreview(sourceOptions, state.revision);
      lastPrepared = prepared;
      sourceOptions.selection = prepared.document.selection;
      state = {
        ...state,
        status: 'prepared',
        lastPreparedRevision: state.revision,
        document: prepared.document,
        diagnostics: [],
      };
    } catch (error) {
      state = {
        ...state,
        status: 'failed',
        document: null,
        diagnostics: previewDiagnostics(error),
      };
    }
    try {
      watcher?.refresh();
    } catch (error) {
      prepared = undefined;
      state = {
        ...state,
        status: 'failed',
        document: null,
        diagnostics: previewDiagnostics(error, PreviewCode.Input),
      };
    }
    publish();
    return structuredClone(state);
  };
  const reload = (selection?: PreviewSelection): PreviewServerState => {
    if (closed)
      throw previewError(
        PreviewCode.Revision,
        'server',
        'The preview server is closed.',
        'Start a new preview session.',
      );
    if (selection !== undefined) sourceOptions.selection = validateSelection(selection);
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    begin();
    return finish();
  };
  const current = (revision: number): PreparedPreview => {
    if (
      closed ||
      state.status !== 'prepared' ||
      prepared === undefined ||
      revision !== state.revision
    )
      throw previewError(
        PreviewCode.Revision,
        'revision',
        `Requested revision ${revision}; current revision ${state.revision} is ${state.status}.`,
        'Wait for the current revision or repair the source and reload. Never capture a last-good frame as a new revision.',
      );
    try {
      assertPreviewFresh(prepared);
      return prepared;
    } catch (error) {
      reload();
      throw previewError(
        PreviewCode.Revision,
        'revision',
        `Revision ${revision} no longer matches its source: ${previewDiagnostics(error)
          .map((entry) => entry.message)
          .join(' ')}`,
        `Inspect revision ${state.revision} and capture it only after it is ready.`,
      );
    }
  };
  reload();
  let origin = '';
  const requireAccess = (request: IncomingMessage): void => {
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin !== undefined && request.headers.origin !== origin)
    )
      throw previewError(
        PreviewCode.Access,
        'origin',
        'Only this loopback preview origin is accepted.',
        'Use the exact 127.0.0.1 URL printed at startup, not a proxy or remote page.',
      );
  };
  const requireAutomation = (): PreviewAutomation => {
    if (automation === undefined)
      throw previewError(
        PreviewCode.Browser,
        'automation',
        'This host has no managed capture browser.',
        'Use startAssetPreview(), or run aegis preview --serve --out-dir <directory>.',
      );
    return automation;
  };

  const server = createServer((request, response) => {
    const route = async (): Promise<void> => {
      requireAccess(request);
      const url = new URL(request.url ?? '/', origin);
      const path = url.pathname;
      if (request.method === 'GET' && path === '/') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          // glTF buffers and ImageBitmapLoader fetch already-validated embedded data/local blobs.
          'content-security-policy': `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' data: blob:; base-uri 'none'; form-action 'none'`,
        });
        response.end(
          renderAssetPreviewPage(
            basename(sourceOptions.source),
            {
              token,
              settings,
              watch: options.watch === true,
              captureEnabled: outputDir !== undefined,
            },
            nonce,
          ),
        );
        return;
      }
      if (request.method === 'GET' && path === '/api/state') {
        sendJson(response, 200, state);
        return;
      }
      if (request.method === 'GET' && path === '/api/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        streams.add(response);
        response.write(`data: ${JSON.stringify(state)}\n\n`);
        request.once('close', () => streams.delete(response));
        return;
      }
      if (request.method === 'GET' && path.startsWith('/assets/')) {
        const match = /^\/assets\/r([1-9]\d*)\/(.+)$/.exec(path);
        if (match === null || !isAssetPath(match[2] ?? ''))
          throw previewError(
            PreviewCode.Access,
            'asset',
            'Invalid revision asset URL.',
            'Use a URL from the current prepared dependency inventory.',
          );
        const closure = current(Number(match[1]));
        const file = closure.prepared.files.find((entry) => entry.path === match[2]);
        if (file === undefined)
          throw previewError(
            PreviewCode.Access,
            'asset',
            'The file is outside the selected local closure.',
            'Declare the dependency under the local asset root and reload.',
          );
        const bytes = readPreparedPresentationFile(file);
        response.writeHead(200, {
          'content-type': presentationMimeType(file.path),
          'content-length': bytes.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end(bytes);
        return;
      }
      if (request.method === 'GET' && path.startsWith('/vendor/')) {
        // Share the production resolver, but expose only runtime JS needed by this asset-only page.
        const permitted =
          /^\/vendor\/(?:three\/(?:build|examples\/jsm)\/|@aegis\/(?:core|render-three)\/dist\/|@aegis\/browser\/dist\/audio\/nodes\.js$)/.test(
            path,
          ) && extname(path) === '.js';
        const file = permitted ? resolveVendorPath(repoRoot, path) : undefined;
        if (file === undefined) {
          sendJson(response, 404, {
            diagnostics: previewDiagnostics(
              previewError(
                PreviewCode.Input,
                'module',
                'Preview module not found.',
                'Build this checkout once with npm run build. Asset edits do not require a rebuild.',
              ),
            ),
          });
          return;
        }
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        const stream = createReadStream(file);
        stream.on('error', (error) => response.destroy(error));
        stream.pipe(response);
        return;
      }
      if (
        request.method !== 'POST' ||
        !['/api/reload', '/api/capture', '/api/settings', '/api/studio', '/api/fresh'].includes(
          path,
        )
      ) {
        sendJson(response, 404, {
          diagnostics: previewDiagnostics(
            previewError(
              PreviewCode.Access,
              'route',
              'Unknown asset preview route.',
              'Use the documented /api/state, /api/reload, /api/settings, /api/studio, or /api/capture routes.',
            ),
          ),
        });
        return;
      }
      if (
        request.headers['x-aegis-preview-token'] !== token ||
        !request.headers['content-type']?.startsWith('application/json')
      )
        throw previewError(
          PreviewCode.Access,
          'token',
          'Preview mutations require the startup token and application/json.',
          'Send X-Aegis-Preview-Token from this session. The token is never a path or a permission to publish assets.',
        );
      const input = await readJson(request);
      if (path === '/api/reload') {
        const body = record(input, ['selection'], 'reload');
        sendJson(
          response,
          200,
          reload(body.selection === undefined ? undefined : validateSelection(body.selection)),
        );
      } else if (path === '/api/settings') {
        sendJson(
          response,
          200,
          await requireAutomation().configure(validatePreviewSettings(input)),
        );
      } else if (path === '/api/studio') {
        record(input, [], 'studio');
        sendJson(response, 200, await requireAutomation().state());
      } else if (path === '/api/fresh') {
        const body = record(input, ['revision'], 'fresh');
        if (typeof body.revision !== 'number')
          throw previewError(
            PreviewCode.Revision,
            'revision',
            'Expected a revision number.',
            'Pass the current revision.',
          );
        current(body.revision);
        sendJson(response, 200, { revision: state.revision, matchesSource: true });
      } else {
        if (outputDir === undefined)
          throw previewError(
            PreviewCode.Output,
            'outputDir',
            'Host capture writes were not enabled at startup.',
            'Restart with an explicit --out-dir <directory>. Requests may choose only a bounded PNG filename.',
          );
        sendJson(
          response,
          200,
          await requireAutomation().capture(validateCaptureRequest(input, true)),
        );
      }
    };
    void route().catch((error: unknown) => {
      if (response.headersSent)
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      else {
        const diagnostics = previewDiagnostics(error);
        const code = diagnostics[0]?.code;
        sendJson(
          response,
          code === PreviewCode.Access ? 403 : code === PreviewCode.Revision ? 409 : 422,
          { diagnostics, revision: state.revision },
        );
      }
    });
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', fail);
      done();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Preview did not bind a TCP port.');
  origin = `http://127.0.0.1:${address.port}`;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    watcher?.close();
    state = { ...state, status: 'closed', document: null };
    publish();
    for (const stream of streams) stream.end();
    streams.clear();
    server.closeAllConnections();
    await new Promise<void>((done, fail) =>
      server.close((error) => (error === undefined ? done() : fail(error))),
    );
  };
  if (options.watch === true) {
    watcher = new AssetPreviewWatch(
      sourceOptions,
      (changed, binding) => {
        if (closed) return;
        const previous = lastPrepared;
        const known =
          previous === undefined
            ? []
            : [
                previous.sourcePath,
                previous.sourceRealPath,
                ...previous.prepared.files.flatMap((entry) => [
                  entry.source,
                  join(previous.assetRoot, ...entry.path.split('/')),
                ]),
              ];
        if (
          !binding &&
          changed !== null &&
          state.status === 'prepared' &&
          !known.some((entry) => {
            const within = relative(changed, entry);
            return (
              within === '' ||
              (!isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`))
            );
          })
        )
          return;
        if (state.status === 'prepared' && lastPrepared !== undefined) {
          try {
            assertPreviewFresh(lastPrepared);
            if (binding) watcher?.refresh();
            return;
          } catch {
            // A changed or unreadable checked file needs a new preflight, not a timestamp revision.
          }
        }
        if (timer !== undefined) clearTimeout(timer);
        else begin();
        timer = setTimeout(() => {
          timer = undefined;
          finish();
        }, 60);
      },
      (error) => {
        if (closed) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        begin();
        state = {
          ...state,
          status: 'failed',
          diagnostics: previewDiagnostics(error, PreviewCode.Input),
        };
        publish();
      },
    );
    try {
      watcher.refresh();
    } catch (error) {
      await close();
      throw new DiagnosticError(previewDiagnostics(error, PreviewCode.Input));
    }
  }
  return {
    url: `${origin}/`,
    token,
    port: address.port,
    outputDir,
    state: () => structuredClone(state),
    reload,
    current,
    attachAutomation(value) {
      automation = value;
    },
    close,
  };
}
