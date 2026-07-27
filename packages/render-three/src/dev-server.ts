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
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { GameEvent } from '@aegis/core';
import { createLiveSession } from './session.js';
import type { LiveSession } from './session.js';
import { findRepoRoot } from './catalog.js';
import type { GameDefinition } from './catalog.js';
import { renderIndexPage, renderPlayPage } from './pages.js';
import { systemClock } from './loop.js';
import type { Clock } from './loop.js';
import type {
  ControlRequest,
  EventLine,
  EventLog,
  FrameRequest,
  FrameResponse,
} from './protocol.js';

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
}

/** A running dev server. */
export interface DevServer {
  /** The URL it is listening on. */
  readonly url: string;
  /** The port actually bound. */
  readonly port: number;
  /** The catalogue being served. */
  readonly games: readonly GameDefinition[];
  /** The live session for `gameId`, if one has been opened. */
  session(gameId: string): LiveSession | undefined;
  /** Stop the server and release the port. */
  close(): Promise<void>;
}

/**
 * Longest wall-clock gap fed to the accumulator, in seconds. Caps catch-up after a stall.
 *
 * This is the *only* place time is deliberately dropped. It must therefore be at least as tight
 * as the accumulator's own step cap, or the two disagree and the loop silently discards time it
 * was handed — see {@link maxStepsFor}.
 */
const MAX_FRAME_SECONDS = 0.25;
/** Maximum accepted request body, in bytes. */
const MAX_BODY_BYTES = 1 << 20;
/** Default fixed ticks per second, matching {@link createLiveSession}'s own default. */
const DEFAULT_TICK_RATE = 60;

/**
 * Steps the accumulator must be allowed to run so that {@link MAX_FRAME_SECONDS} is the only
 * limit on catch-up.
 *
 * `createFixedStepLoop` defaults to 8 steps per frame and **discards** the remainder
 * (`loop.ts`: `if (accumulator >= dt) accumulator = 0`). At 60Hz that is 133ms of simulated time,
 * while this server hands it up to 250ms — so any displayed frame slower than 133ms lost the
 * difference and the game ran in slow motion, with no error and no event. Measured on
 * `/play/fps` in a headless browser at ~6.5fps: **42.5 simulated ticks per wall-clock second
 * against a 60Hz simulation**, i.e. the game played at 71% speed. Deriving the cap from the same
 * constant removes the disagreement by construction.
 */
export function maxStepsFor(tickRate: number): number {
  return Math.max(1, Math.ceil(MAX_FRAME_SECONDS * tickRate));
}

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
  lastFrameAt: number;
  eventCursor: number;
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

/**
 * Resolve a `/vendor/...` path to a file on disk, or `undefined` if it escapes the allowed roots.
 * `/vendor/three/*` maps to the installed package; `/vendor/@aegis/<pkg>/*` to `packages/<pkg>`.
 */
export function resolveVendorPath(repoRoot: string, urlPath: string): string | undefined {
  const relative = decodeURIComponent(urlPath.replace(/^\/vendor\//, ''));
  if (relative === '' || relative.includes('\0')) return undefined;

  const parts = normalize(relative)
    .split(/[\\/]/)
    .filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) return undefined;

  let root: string;
  let rest: string[];
  if (parts[0] === 'three') {
    root = join(repoRoot, 'node_modules', 'three');
    rest = parts.slice(1);
  } else if (parts[0] === '@aegis' && parts[1] !== undefined) {
    root = join(repoRoot, 'packages', parts[1]);
    rest = parts.slice(2);
  } else {
    return undefined;
  }

  const target = resolve(root, ...rest);
  const rootWithSep = resolve(root) + sep;
  if (!target.startsWith(rootWithSep)) return undefined;
  if (!existsSync(target) || !statSync(target).isFile()) return undefined;
  return target;
}

/** Flatten recorded events into the HUD feed shape. */
function toEventLines(events: readonly GameEvent[]): EventLine[] {
  return events.map((event) => ({ type: event.type, tick: event.tick }));
}

/** Start the dev server. Resolves once it is listening. */
export function startDevServer(options: DevServerOptions): Promise<DevServer> {
  if (options.games.length === 0) {
    throw new Error('[aegis:render-three] startDevServer: at least one game is required');
  }
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const clock = options.clock ?? systemClock;
  const host = options.host ?? '127.0.0.1';
  const byId = new Map(options.games.map((game) => [game.id, game]));
  const runtimes = new Map<string, GameRuntime>();

  const runtimeFor = (gameId: string): GameRuntime | undefined => {
    const existing = runtimes.get(gameId);
    if (existing !== undefined) return existing;
    const game = byId.get(gameId);
    if (game === undefined) return undefined;
    const created: GameRuntime = {
      game,
      session: createLiveSession({
        scene: game.scene,
        plugin: game.plugin,
        ...(game.seed !== undefined ? { seed: game.seed } : {}),
        ...(game.tickRate !== undefined ? { tickRate: game.tickRate } : {}),
        maxStepsPerFrame: maxStepsFor(game.tickRate ?? DEFAULT_TICK_RATE),
      }),
      lastFrameAt: clock(),
      eventCursor: 0,
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
    options: { drainEvents?: boolean; withHash?: boolean } = {},
  ): FrameResponse => {
    let fresh: readonly GameEvent[] = [];
    if (options.drainEvents === true) {
      const history = runtime.session.world.events.history();
      fresh = history.slice(runtime.eventCursor);
      runtime.eventCursor = history.length;
    }
    return {
      tick: runtime.session.tick,
      steps,
      paused: runtime.session.paused,
      ...(options.withHash === true ? { hash: runtime.session.hash() } : {}),
      snapshot: runtime.session.snapshot(),
      events: toEventLines(fresh),
    };
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${host}`);
    const path = url.pathname;

    if (path === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      sendHtml(response, 200, renderIndexPage(options.games));
      return;
    }

    if (request.method === 'GET' && path.startsWith('/play/')) {
      const game = byId.get(path.slice('/play/'.length));
      if (game === undefined) {
        sendHtml(response, 404, renderIndexPage(options.games));
        return;
      }
      // Opening the page creates the session, so a screenshot run never races the first frame.
      runtimeFor(game.id);
      sendHtml(response, 200, renderPlayPage(game));
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
          events: toEventLines(runtime.session.world.events.history()),
        };
        sendJson(response, 200, body);
        return;
      }

      if (endpoint === 'frame' && request.method === 'POST') {
        const body = await readJsonBody<FrameRequest>(request);
        if (body?.input !== undefined) runtime.session.input.submit(body.input);
        // Wall-clock in, whole fixed ticks out. The simulation never sees a variable dt.
        const now = clock();
        const elapsed = Math.min(Math.max(now - runtime.lastFrameAt, 0), MAX_FRAME_SECONDS);
        runtime.lastFrameAt = now;
        const steps = runtime.session.advance(elapsed);
        sendJson(response, 200, frameBody(runtime, steps, { drainEvents: true }));
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
          runtime.eventCursor = 0;
        }
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
        url: `http://${host}:${port}`,
        port,
        games: options.games,
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
