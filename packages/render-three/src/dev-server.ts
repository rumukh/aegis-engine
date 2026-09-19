/**
 * The browser dev server: the one place a human gets pixels.
 *
 * It is a plain `node:http` server with no framework and no bundler. Responsibilities:
 *
 * 1. **Serve pages** — a landing page and one play page per game (see `./pages.ts`).
 * 2. **Serve modules** — the workspace's built `dist/` output and `three`'s ESM build under
 *    `/vendor`, resolved by the page's import map.
 * 3. **Run the simulation** — one {@link LiveSession} per opened game, stepped on a *fixed*
 *    timestep via the accumulator in `./loop.ts`. Wall-clock enters here and nowhere else.
 * 4. **Exchange a frame** — `POST /api/<id>/frame` takes the human's input, advances the fixed
 *    steps that the elapsed wall-clock has earned, and returns the world as a JSON snapshot.
 *
 * The server carries no game logic: everything gameplay comes from the composed
 * {@link GameDefinition.plugin}. It never renders anything either — that is the page's job.
 * @packageDocumentation
 */
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { DiagnosticError } from '@aegis/core';
import type { Diagnostic, GameEvent } from '@aegis/core';
import { createLiveSession } from './session.js';
import type { LiveSession } from './session.js';
import { findRepoRoot } from './catalog.js';
import type { GameDefinition } from './catalog.js';
import { renderIndexPage, renderPlayPage } from './pages.js';
import { MAX_CATCHUP_SECONDS, systemClock } from './loop.js';
import type { Clock } from './loop.js';
import {
  preparePresentation,
  presentationMimeType,
  readPreparedPresentationFile,
} from './presentation/files.js';
import type { PreparedPresentation } from './presentation/files.js';
import { isAssetPath } from './presentation/diagnostics.js';
import { resolveVendorPath } from './vendor.js';
import { FrameClients, validFrameClient } from './frame-clients.js';
import type { FrameClientState, FrameInputStatus } from './frame-clients.js';
import type {
  ControlRequest,
  EventLine,
  EventLog,
  FrameRequest,
  FrameResponse,
} from './protocol.js';

export { resolveVendorPath } from './vendor.js';

/** Options for {@link startDevServer}. */
export interface DevServerOptions {
  /** The catalogue to serve. Must not be empty. */
  games: readonly GameDefinition[];
  /** TCP port. `0` binds an ephemeral port (used by the tests). Defaults to `5173`. */
  port?: number;
  /** Host interface to bind. Defaults to `127.0.0.1`. */
  host?: string;
  /** Repository root used to resolve `/vendor` requests. Defaults to auto-detection. */
  repoRoot?: string;
  /** Wall clock used by the fixed-step accumulator. Injectable for tests. */
  clock?: Clock;
  /** Optional deployment prefix, e.g. `/preview/aegis/`. Normalized on startup. */
  basePath?: string;
}

/** A running dev server. */
export interface DevServer {
  /** Origin plus the normalized deployment prefix, without a trailing slash. */
  readonly url: string;
  /** The port actually bound. */
  readonly port: number;
  /** The catalogue being served. */
  readonly games: readonly GameDefinition[];
  /** Nonfatal preflight notes, including names that require mounted-world confirmation. */
  readonly diagnostics?: readonly Diagnostic[];
  /** The live session for `gameId`, if one has been opened. */
  session(gameId: string): LiveSession | undefined;
  /** Stop the server and release the port. */
  close(): Promise<void>;
}

/**
 * Longest wall-clock gap fed to the accumulator, in seconds. Caps catch-up after a stall.
 *
 * Derived from the accumulator's own budget rather than chosen here, because the two used to be
 * separate numbers that disagreed — see {@link MAX_CATCHUP_SECONDS}.
 */
const MAX_FRAME_SECONDS = MAX_CATCHUP_SECONDS;
/** Maximum accepted request body, in bytes. */
const MAX_BODY_BYTES = 1 << 20;

/** Content types for the handful of extensions `/vendor` can serve. */
const MIME: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
};

/** Per-game runtime state the server owns. */
interface GameRuntime {
  game: GameDefinition;
  session: LiveSession;
  lastFrameAt: number | undefined;
  eventCursor: number;
  clients: FrameClients;
  generation: number;
  presentation?: PreparedPresentation;
}

/** Normalize a deployment prefix without accepting URL escapes or filesystem traversal. */
export function normalizeBasePath(value = ''): string {
  const path = value
    .split('/')
    .filter((part) => part !== '')
    .join('/');
  if (path === '') return '';
  if (!isAssetPath(path))
    throw new Error('[aegis:render-three] basePath must contain only portable local URL segments');
  return `/${path}`;
}

/** Send a JSON body. */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(text);
}

/** Send an HTML body. */
function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html);
}

/** Read a JSON request body, rejecting anything oversized or malformed. */
async function readJsonBody<T>(request: IncomingMessage): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Flatten recorded events into the HUD feed shape. */
function toEventLines(events: readonly GameEvent[], presentation = false, offset = 0): EventLine[] {
  return events.map((event, index) => ({
    type: event.type,
    tick: event.tick,
    ...(presentation ? { data: event.data, sequence: offset + index } : {}),
  }));
}

/** Start the dev server. Resolves once it is listening. */
export function startDevServer(options: DevServerOptions): Promise<DevServer> {
  if (options.games.length === 0) {
    throw new Error('[aegis:render-three] startDevServer: at least one game is required');
  }
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const clock = options.clock ?? systemClock;
  const host = options.host ?? '127.0.0.1';
  const basePath = normalizeBasePath(options.basePath);
  const ids = new Set<string>();
  const presentations = new Map<string, PreparedPresentation>();
  const diagnostics: Diagnostic[] = [];
  for (const game of options.games) {
    if (!/^[A-Za-z0-9_-]+$/.test(game.id) || ids.has(game.id.toLowerCase()))
      throw new Error(
        `[aegis:render-three] duplicate or invalid game id "${game.id}"; use unique letters, digits, "_" and "-"`,
      );
    ids.add(game.id.toLowerCase());
    if (game.presentation !== undefined) {
      const prepared = preparePresentation(game.presentation, game.scene);
      presentations.set(game.id, prepared);
      for (const diagnostic of prepared.diagnostics ?? [])
        diagnostics.push({
          ...diagnostic,
          data: { ...diagnostic.data, gameId: game.id },
        });
    }
  }
  for (const diagnostic of diagnostics)
    console.warn(
      `[aegis:render-three] ${diagnostic.data?.gameId} ${diagnostic.code}: ${diagnostic.message}\n  fix: ${diagnostic.fix}`,
    );
  const byId = new Map(options.games.map((game) => [game.id, game]));
  const runtimes = new Map<string, GameRuntime>();

  const runtimeFor = (gameId: string, primeLegacyClock = true): GameRuntime | undefined => {
    const existing = runtimes.get(gameId);
    if (existing !== undefined) return existing;
    const game = byId.get(gameId);
    if (game === undefined) return undefined;
    const presentation = presentations.get(game.id);
    const created: GameRuntime = {
      game,
      session: createLiveSession({
        scene: game.scene,
        plugin: game.plugin,
        ...(game.seed !== undefined ? { seed: game.seed } : {}),
        ...(game.tickRate !== undefined ? { tickRate: game.tickRate } : {}),
      }),
      // Asset loading may follow API inspection or scripted steps as well as opening HTML.
      // Only /frame starts a presentation clock; legacy API priming remains unchanged.
      lastFrameAt: primeLegacyClock && presentation === undefined ? clock() : undefined,
      eventCursor: 0,
      clients: new FrameClients(),
      generation: 0,
      presentation,
    };
    runtimes.set(gameId, created);
    return created;
  };

  /**
   * Build the response body for the current state of a runtime.
   *
   * `drainEvents` is deliberately opt-in: the cursor belongs to the **page's** frame channel, so
   * only `/frame` may advance it. A `state` read or a `control` command that consumed events
   * would silently empty the on-screen feed — which is exactly what happened when the screenshot
   * capture began driving the session through `control`, leaving the photograph with no evidence
   * of the run it had just performed.
   *
   * `withHash` is opt-in for a measured reason: see {@link FrameResponse.hash}. The per-frame
   * channel cannot afford it and does not read it.
   */
  const frameBody = (
    runtime: GameRuntime,
    steps: number,
    options: {
      drainEvents?: boolean;
      withHash?: boolean;
      withEventHistory?: boolean;
      client?: FrameClientState;
      inputStatus?: FrameInputStatus;
    } = {},
  ): FrameResponse => {
    let fresh: readonly GameEvent[] = [];
    const history =
      options.drainEvents === true || options.withEventHistory === true
        ? runtime.session.world.events.history()
        : [];
    const cursor = options.client ?? runtime;
    const offset = cursor.eventCursor;
    if (options.drainEvents === true) {
      fresh = history.slice(cursor.eventCursor);
      cursor.eventCursor = history.length;
    }
    return {
      tick: runtime.session.tick,
      steps,
      paused: runtime.session.paused,
      ...(options.inputStatus === undefined ? {} : { inputStatus: options.inputStatus }),
      ...(options.withHash === true ? { hash: runtime.session.hash() } : {}),
      snapshot: runtime.session.snapshot(),
      events: toEventLines(fresh, runtime.presentation !== undefined, offset),
      ...(runtime.presentation === undefined && options.client === undefined
        ? {}
        : { generation: runtime.generation }),
      ...(options.withEventHistory === true ? { eventHistory: toEventLines(history, true) } : {}),
    };
  };

  /**
   * Turn a thrown value into something a reader can act on.
   *
   * Exported because it is the whole content of the 500 path and a 500 that cannot be provoked in
   * a test is a 500 nobody has ever read.
   */
  const describeFailure = (
    error: unknown,
    method: string,
    path: string,
  ): { error: string; method: string; path: string; stack?: string } => {
    const message =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : `non-Error thrown: ${String(error)}`;
    return {
      error: message,
      method,
      path,
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    };
  };

  /**
   * The 500 path, which until now discarded the only thing that mattered.
   *
   * It read `.catch(() => sendJson(response, 500, { error: 'internal error' }))`. The thrown value
   * was bound to nothing and printed nowhere, so a request that failed produced a body naming no
   * cause, no method and no path, and **nothing at all on stderr**.
   *
   * That is not a hypothetical cost. `windows-latest` run 30371420409 logged
   * `Failed to load resource: the server responded with a status of 500 (Internal Server Error)`
   * against `/play/platformer` and `/play/iso`, on a page that reached `readyState: complete` with
   * `aegis: undefined` — i.e. the boot never finished. The 500 is the most specific evidence in
   * that entire run and it was unreadable: the message says a request failed and refuses to say
   * which, or why. Three CI round trips were spent reading other things.
   *
   * The reason is worth naming because it recurs: an error handler is the one path nobody
   * exercises, so a handler that destroys its input looks exactly like a handler that works. It is
   * the same defect as a test that cannot fail, moved into production code.
   *
   * Also written to stderr, not only into the response body, because the body reaches the *page* —
   * and on CI the page's console is summarised, truncated and sometimes (as above) never read at
   * all, whereas the server's stderr lands in the job log verbatim.
   */
  const server: Server = createServer((request, response) => {
    const method = request.method ?? '(no method)';
    const path = request.url ?? '(no url)';
    void handle(request, response).catch((error: unknown) => {
      const detail = describeFailure(error, method, path);
      console.error(
        `[aegis:dev-server] ${method} ${path} failed: ${detail.error}` +
          (detail.stack !== undefined ? `\n${detail.stack}` : ''),
      );
      if (!response.headersSent) sendJson(response, 500, detail);
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${host}`);
    let path = url.pathname;
    if (basePath !== '') {
      if (path === basePath && request.method === 'GET') {
        response.writeHead(308, { location: `${basePath}/${url.search}` });
        response.end();
        return;
      }
      if (!path.startsWith(`${basePath}/`)) {
        sendJson(response, 404, { error: `not found: ${path}` });
        return;
      }
      path = path.slice(basePath.length);
    }

    if (path === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      sendHtml(response, 200, renderIndexPage(options.games));
      return;
    }

    const play = /^\/play\/([A-Za-z0-9_-]+)(\/(?:index\.html)?)?$/.exec(path);
    if (request.method === 'GET' && play !== null) {
      const game = byId.get(play[1] as string);
      if (game === undefined) {
        sendHtml(response, 404, renderIndexPage(options.games));
        return;
      }
      if (play[2] !== '/') {
        response.writeHead(308, { location: `${basePath}/play/${game.id}/${url.search}` });
        response.end();
        return;
      }
      // Opening the page creates the session, so a screenshot run never races the first frame.
      runtimeFor(game.id, false);
      const prepared = presentations.get(game.id);
      sendHtml(
        response,
        200,
        renderPlayPage(
          game,
          prepared === undefined
            ? undefined
            : {
                manifest: prepared.manifest,
                baseUrl: `../../assets/${game.id}/`,
                files: prepared.files.map((file) => file.path),
              },
        ),
      );
      return;
    }

    const asset = /^\/assets\/([A-Za-z0-9_-]+)\/(.+)$/.exec(path);
    if (asset !== null) {
      const file = presentations
        .get(asset[1] as string)
        ?.files.find((entry) => entry.path === asset[2]);
      if (file === undefined) {
        sendJson(response, 404, { error: `no prepared asset: ${path}` });
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: `method ${request.method} not allowed on ${path}` });
        return;
      }
      let bytes: Buffer;
      try {
        bytes = readPreparedPresentationFile(file);
      } catch (error) {
        if (!(error instanceof DiagnosticError)) throw error;
        sendJson(response, 409, { error: error.message, diagnostics: error.diagnostics });
        return;
      }
      response.writeHead(200, {
        'content-type': presentationMimeType(file.path),
        'content-length': bytes.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
      return;
    }

    if (request.method === 'GET' && path.startsWith('/vendor/')) {
      const file = resolveVendorPath(repoRoot, path);
      if (file === undefined) {
        sendJson(response, 404, { error: `no such module: ${path}` });
        return;
      }
      response.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(file).pipe(response);
      return;
    }

    const api = /^\/api\/([A-Za-z0-9_-]+)\/(frame|state|events|control)$/.exec(path);
    if (api !== null) {
      const runtime = runtimeFor(api[1] as string);
      if (runtime === undefined) {
        sendJson(response, 404, { error: `unknown game "${api[1]}"` });
        return;
      }
      const endpoint = api[2];

      if (endpoint === 'state' && request.method === 'GET') {
        sendJson(response, 200, frameBody(runtime, 0, { withHash: true }));
        return;
      }

      if (endpoint === 'events' && request.method === 'GET') {
        // The full log, deliberately *not* cursor-based: the page drains the cursor on every
        // frame, so an observer that shared it would race the page and see an arbitrary suffix.
        const body: EventLog = {
          tick: runtime.session.tick,
          events: toEventLines(
            runtime.session.world.events.history(),
            runtime.presentation !== undefined,
          ),
          ...(runtime.presentation === undefined ? {} : { generation: runtime.generation }),
        };
        sendJson(response, 200, body);
        return;
      }

      if (endpoint === 'frame' && request.method === 'POST') {
        const body = await readJsonBody<FrameRequest>(request);
        if (
          body?.input !== undefined &&
          (body.input === null ||
            typeof body.input !== 'object' ||
            !Number.isSafeInteger(body.input.seq) ||
            body.input.seq < 0)
        ) {
          sendJson(response, 400, { error: 'input.seq must be a nonnegative safe integer.' });
          return;
        }
        if (
          body?.presentationGeneration !== undefined &&
          body.presentationGeneration !== null &&
          (!Number.isSafeInteger(body.presentationGeneration) || body.presentationGeneration < 0)
        ) {
          sendJson(response, 400, {
            error: 'presentationGeneration must be null or a nonnegative safe integer.',
          });
          return;
        }
        const now = clock();
        let client: FrameClientState | undefined;
        let inputStatus: FrameInputStatus | undefined;
        if (body?.client !== undefined) {
          if (
            !validFrameClient(body.client) ||
            !Number.isSafeInteger(body.input?.seq) ||
            body.input.seq < 0
          ) {
            sendJson(response, 400, {
              error:
                'client requires a bounded page id, boolean claim, observed generation and nonnegative safe input.seq.',
            });
            return;
          }
          client = runtime.clients.client(body.client.id, now, runtime.session.input);
          if (client === undefined) {
            sendJson(response, 429, {
              error:
                'This game has 32 recent browser clients. Close unused views and retry after idle clients expire.',
            });
            return;
          }
          inputStatus = runtime.clients.submit(
            runtime.session.input,
            client,
            body.client,
            body.input,
            runtime.generation,
            now,
          );
        } else if (body?.input !== undefined) {
          const status = runtime.clients.submitLegacy(runtime.session.input, body.input, now);
          if (!status.accepted) inputStatus = status;
        } else runtime.clients.expire(now, runtime.session.input);
        // Wall-clock in, whole fixed ticks out. The simulation never sees a variable dt.
        const elapsed =
          runtime.lastFrameAt === undefined
            ? 0
            : Math.min(Math.max(now - runtime.lastFrameAt, 0), MAX_FRAME_SECONDS);
        runtime.lastFrameAt = now;
        const steps = runtime.session.advance(elapsed);
        sendJson(
          response,
          200,
          frameBody(runtime, steps, {
            drainEvents: true,
            ...(client === undefined ? {} : { client }),
            ...(inputStatus === undefined ? {} : { inputStatus }),
            withEventHistory:
              runtime.presentation !== undefined &&
              body?.presentationGeneration !== undefined &&
              body.presentationGeneration !== runtime.generation,
          }),
        );
        return;
      }

      if (endpoint === 'control' && request.method === 'POST') {
        const body = await readJsonBody<ControlRequest>(request);
        const command = body?.command;
        if (command === 'pause') runtime.session.paused = true;
        else if (command === 'resume') runtime.session.paused = false;
        else if (command === 'toggle') runtime.session.paused = !runtime.session.paused;
        else if (command === 'step') {
          // A bounded batch: replaying a whole input script one HTTP round trip per tick would
          // take thousands of requests, and the ticks between two input changes are identical.
          const requested = body?.ticks ?? 1;
          const ticks = Number.isInteger(requested) ? Math.max(0, Math.min(requested, 10_000)) : 1;
          for (let i = 0; i < ticks; i++) runtime.session.step();
        } else if (command === 'restart') {
          runtime.session.restart();
          runtime.clients.reset();
          runtime.eventCursor = 0;
          runtime.generation++;
          if (runtime.presentation !== undefined) runtime.lastFrameAt = undefined;
        }
        if (runtime.lastFrameAt !== undefined || runtime.presentation === undefined)
          runtime.lastFrameAt = clock();
        sendJson(response, 200, frameBody(runtime, 0, { withHash: true }));
        return;
      }

      sendJson(response, 405, { error: `method ${request.method} not allowed on ${path}` });
      return;
    }

    sendJson(response, 404, { error: `not found: ${path}` });
  }

  return new Promise<DevServer>((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(options.port ?? 5173, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolveServer({
        url: `http://${host}:${port}${basePath}`,
        port,
        games: options.games,
        ...(diagnostics.length === 0 ? {} : { diagnostics }),
        session(gameId: string): LiveSession | undefined {
          return runtimes.get(gameId)?.session;
        },
        close(): Promise<void> {
          return new Promise((done, fail) => {
            server.closeAllConnections();
            server.close((error) => (error ? fail(error) : done()));
          });
        },
      });
    });
  });
}
