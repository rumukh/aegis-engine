/**
 * Screenshot capture: proof that a human can actually play these three games.
 *
 * A test suite cannot tell you whether a scene is legible, so this drives the real dev server in
 * a real browser with real key and mouse events and saves a PNG per game. It speaks the Chrome
 * DevTools Protocol over Node's built-in `WebSocket` against whichever Chromium-family browser is
 * installed, so it adds no dependency (ADR-0005: three.js stays the only third-party runtime
 * dependency).
 *
 * Usage: `node packages/render-three/capture.mjs [--out <dir>] [--headed]`.
 * @packageDocumentation
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { findRepoRoot, loadPocGames } from './games.js';
import { startDevServer } from './dev-server.js';

/** Where a Chromium-family browser might live on this machine. */
const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/** Capture viewport, in CSS pixels. */
const VIEWPORT = { width: 1280, height: 720 };

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** The first browser executable that exists on this machine. */
export function findBrowser(): string {
  for (const candidate of BROWSER_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error(
    '[aegis:render-three] no Chromium-family browser found. Install Chrome or Edge, or pass a ' +
      'path via AEGIS_BROWSER.',
  );
}

/** A minimal Chrome DevTools Protocol session over one WebSocket. */
class CdpSession {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, { ok: (value: unknown) => void; fail: (e: Error) => void }>();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const waiter = this.#pending.get(message.id);
      if (waiter === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) waiter.fail(new Error(message.error.message));
      else waiter.ok(message.result);
    });
  }

  /** Connect to a CDP WebSocket endpoint. */
  static connect(url: string): Promise<CdpSession> {
    return new Promise((ok, fail) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => ok(new CdpSession(socket)));
      socket.addEventListener('error', () => fail(new Error(`cannot connect to ${url}`)));
    });
  }

  /** Send a CDP command and await its result. */
  send<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((ok, fail) => {
      this.#pending.set(id, { ok: ok as (value: unknown) => void, fail });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Close the socket. */
  close(): void {
    this.#socket.close();
  }
}

/** One key press, described the way CDP wants it. */
interface Key {
  code: string;
  key: string;
  vk: number;
}

/** The keys the capture script uses. */
const KEYS: Readonly<Record<string, Key>> = {
  KeyW: { code: 'KeyW', key: 'w', vk: 87 },
  KeyA: { code: 'KeyA', key: 'a', vk: 65 },
  KeyD: { code: 'KeyD', key: 'd', vk: 68 },
  Space: { code: 'Space', key: ' ', vk: 32 },
};

/** Hold or release a key in the page. */
async function key(cdp: CdpSession, name: string, down: boolean): Promise<void> {
  const spec = KEYS[name];
  if (spec === undefined) throw new Error(`unmapped key ${name}`);
  await cdp.send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp',
    code: spec.code,
    key: spec.key,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    text: down && spec.key.length === 1 ? spec.key : undefined,
  });
}

/** Click at canvas pixel `(x, y)`. */
async function click(cdp: CdpSession, x: number, y: number): Promise<void> {
  const base = { x, y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
  await sleep(40);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
}

/** Move the mouse by a relative delta (used for pointer-locked look). */
async function mouseMove(cdp: CdpSession, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate<T>(cdp: CdpSession, expression: string): Promise<T> {
  const result = await cdp.send<{ result: { value: T } }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result.value;
}

/** Read a component field of a named entity out of the page's mirror world. */
function entityExpression(name: string, path: string): string {
  return (
    `(() => { const e = globalThis.aegis.world.snapshot().entities` +
    `.find(x => x.name === ${JSON.stringify(name)}); ` +
    `return e ? e.components.${path} : null; })()`
  );
}

/** Poll `expression` until `accept` returns true, or throw on timeout. */
async function until<T>(
  cdp: CdpSession,
  expression: string,
  accept: (value: T) => boolean,
  timeoutMs = 15000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evaluate<T>(cdp, expression);
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
    await sleep(50);
  }
}

/** Wait until the page's mirror world has advanced past `tick`. */
async function waitForTick(cdp: CdpSession, tick: number, timeoutMs = 15000): Promise<number> {
  return until<number>(
    cdp,
    'globalThis.aegis ? globalThis.aegis.tick() : -1',
    (current) => current > tick,
    timeoutMs,
  );
}

/** Save a PNG screenshot of the page. */
async function screenshot(cdp: CdpSession, file: string): Promise<void> {
  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
}

/** Launch a headless browser with the DevTools endpoint open, and resolve its WS URL. */
async function launchBrowser(headed: boolean): Promise<{
  process: ChildProcess;
  port: number;
  profile: string;
}> {
  const executable = process.env['AEGIS_BROWSER'] ?? findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'aegis-capture-'));
  const port = 9333;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    'about:blank',
  ];
  if (!headed) args.unshift('--headless=new');
  const child = spawn(executable, args, { stdio: 'ignore' });

  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('browser did not expose a DevTools endpoint');
    await sleep(200);
  }
  return { process: child, port, profile };
}

/** Open a new page target and attach a CDP session to it. */
async function openPage(port: number, url: string): Promise<CdpSession> {
  const created = (await (
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json()) as { webSocketDebuggerUrl: string };
  const cdp = await CdpSession.connect(created.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return cdp;
}

/** Play each game briefly with real input, then capture it. */
async function captureGame(cdp: CdpSession, id: string): Promise<void> {
  await waitForTick(cdp, 0);
  if (id === 'platformer') await playPlatformer(cdp);
  else if (id === 'fps') await playFps(cdp);
  else await playIso(cdp);
}

/**
 * Coyote Gap: run right and hop continuously. Jump buffering (`jumpBufferTicks`) means a press
 * landing just before touchdown re-launches immediately, so a human tapping Space while holding
 * right chains maximum-distance hops over every spike pit — which is exactly the feel the mode
 * is supposed to have, and a good thing for a screenshot to prove.
 */
async function playPlatformer(cdp: CdpSession): Promise<void> {
  const playerX = entityExpression('player', 'Transform.position.x');
  const playerY = entityExpression('player', 'Transform.position.y');
  await key(cdp, 'KeyD', true);
  const deadline = Date.now() + 7000;
  let reachedGoal = false;
  while (Date.now() < deadline) {
    await key(cdp, 'Space', true);
    await sleep(20);
    await key(cdp, 'Space', false);
    await sleep(30);
    const y = await evaluate<number | null>(cdp, playerY);
    if (y !== null && y < -2) break; // fell in a pit: stop and let the shot show where
    const x = await evaluate<number | null>(cdp, playerX);
    if (x !== null && x > 41) {
      reachedGoal = true;
      break;
    }
  }
  await key(cdp, 'KeyD', false);
  if (reachedGoal) {
    // Back off the goal so the shot frames the last stretch of level, not just the wall.
    await key(cdp, 'KeyA', true);
    await sleep(550);
    await key(cdp, 'KeyA', false);
  }
  await sleep(300);
}

/**
 * Sector Breach: capture the pointer, turn to face the wall panel, shoot the blast door open,
 * turn back and walk up the corridor to the lip of the coolant pit.
 */
async function playFps(cdp: CdpSession): Promise<void> {
  const yaw = entityExpression('player', 'LookState.yawDeg');
  const z = entityExpression('player', 'Transform.position.z');
  // A click both captures the pointer and fires, so the first one is not wasted.
  await click(cdp, VIEWPORT.width / 2, VIEWPORT.height / 2);
  await sleep(200);

  if (await evaluate<boolean>(cdp, 'document.pointerLockElement !== null')) {
    // The panel is due east of spawn: sweep the mouse right until the look state reads ~90 deg.
    await turnTo(cdp, yaw, 90);
    await click(cdp, VIEWPORT.width / 2, VIEWPORT.height / 2);
    await sleep(300);
    // Face north again and walk up the corridor the blast door was sealing.
    await turnTo(cdp, yaw, 0);
  }

  await key(cdp, 'KeyW', true);
  await until<number>(cdp, z, (value) => value !== null && value > 9.6, 12000).catch(
    () => undefined,
  );
  await key(cdp, 'KeyW', false);
  await sleep(300);
}

/**
 * Sweep the (locked) mouse horizontally until the simulated yaw reaches `targetDeg`. Driving off
 * the world's own `LookState` rather than a pixel count keeps this honest: it only succeeds if
 * the look actually reached the simulation.
 */
async function turnTo(cdp: CdpSession, yawExpression: string, targetDeg: number): Promise<void> {
  let cursorX = VIEWPORT.width / 2;
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = await evaluate<number | null>(cdp, yawExpression);
    if (current === null) return;
    const error = targetDeg - current;
    if (Math.abs(error) < 2.5) return;
    const stepPixels = Math.sign(error) * Math.min(Math.abs(error) / 0.14, 24);
    let next = cursorX + stepPixels;
    if (next < 40 || next > VIEWPORT.width - 40) {
      // Re-centre first; the page reads deltas, so this jump is absorbed as one large step.
      cursorX = VIEWPORT.width / 2;
      next = cursorX + stepPixels;
    }
    await mouseMove(cdp, next, VIEWPORT.height / 2);
    cursorX = next;
    await sleep(16);
  }
}

/** The Server Vault: click a floor cell to path there, then click the switch corridor. */
async function playIso(cdp: CdpSession): Promise<void> {
  const cell = entityExpression('operative', 'GridPosition.cellX');
  const target = await evaluate<{ x: number; y: number } | null>(
    cdp,
    'globalThis.aegis.project(1, 0, 5)',
  );
  if (target !== null) await click(cdp, target.x, target.y);
  await sleep(1800);
  const second = await evaluate<{ x: number; y: number } | null>(
    cdp,
    'globalThis.aegis.project(9, 0, 1)',
  );
  if (second !== null) await click(cdp, second.x, second.y);
  await until<number>(cdp, cell, (x) => x !== null && x > 3, 12000).catch(() => undefined);
  await sleep(600);
}

/** Capture all three games and return the files written. */
export async function capture(argv: readonly string[] = process.argv.slice(2)): Promise<string[]> {
  const outIndex = argv.indexOf('--out');
  const repoRoot = findRepoRoot();
  const outDir =
    outIndex >= 0 && argv[outIndex + 1] !== undefined
      ? resolve(argv[outIndex + 1] as string)
      : join(repoRoot, 'packages', 'render-three', 'screenshots');
  const headed = argv.includes('--headed');

  const games = await loadPocGames(repoRoot);
  const server = await startDevServer({ games, port: 0 });
  const browser = await launchBrowser(headed);
  const written: string[] = [];

  try {
    for (const game of games) {
      const cdp = await openPage(browser.port, `${server.url}/play/${game.id}`);
      try {
        await captureGame(cdp, game.id);
        const file = join(outDir, `${game.id}.png`);
        await screenshot(cdp, file);
        const tick = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
        console.log(`  ${game.id.padEnd(11)} tick ${String(tick).padEnd(5)} ${file}`);
        written.push(file);
      } finally {
        cdp.close();
      }
    }
  } finally {
    browser.process.kill();
    await server.close();
  }
  return written;
}

await capture();
