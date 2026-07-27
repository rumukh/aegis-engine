/**
 * A minimal Chrome DevTools Protocol driver: the only way this package reaches a real browser.
 *
 * It speaks CDP over Node's built-in `WebSocket` against whichever Chromium-family browser is
 * installed, so it adds no dependency (ADR-0005: three.js stays the only third-party runtime
 * dependency). It knows nothing about games, scenes or scripts — it launches a browser, opens a
 * page, dispatches real key and mouse events, evaluates expressions and takes screenshots.
 *
 * It lives in its own module because two things need it and they must not drift apart: the
 * screenshot capture, which drives a scripted playthrough, and `browser-playability.test.ts`,
 * which measures what a human's frame budget actually is. A second private copy of a browser
 * driver is exactly the kind of thing that rots quietly in one of its two homes.
 * @packageDocumentation
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

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

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** The first browser executable that exists on this machine. */
export function findBrowser(): string {
  const override = process.env['AEGIS_BROWSER'];
  if (override !== undefined && override !== '') return override;
  for (const candidate of BROWSER_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error(
    '[aegis:render-three] no Chromium-family browser found. Install Chrome or Edge, or pass a ' +
      'path via AEGIS_BROWSER.',
  );
}

/** A minimal Chrome DevTools Protocol session over one WebSocket. */
export class CdpSession {
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

/** Virtual key codes for every key the binding tables can name. */
const VIRTUAL_KEYS: Readonly<Record<string, { key: string; vk: number }>> = {
  KeyA: { key: 'a', vk: 65 },
  KeyD: { key: 'd', vk: 68 },
  KeyS: { key: 's', vk: 83 },
  KeyW: { key: 'w', vk: 87 },
  Space: { key: ' ', vk: 32 },
  ArrowUp: { key: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', vk: 39 },
};

/** Dispatch a real key event into the page. */
export async function key(cdp: CdpSession, code: string, down: boolean): Promise<void> {
  const spec = VIRTUAL_KEYS[code];
  if (spec === undefined) {
    throw new Error(
      `[aegis:render-three] no virtual-key mapping for "${code}". Add it to VIRTUAL_KEYS ` +
        'so the capture can press the key a human would.',
    );
  }
  await cdp.send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp',
    code,
    key: spec.key,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    text: down && spec.key.length === 1 ? spec.key : undefined,
  });
}

/** Dispatch a primary mouse button edge at canvas pixel `(x, y)`. */
export async function mouseButton(
  cdp: CdpSession,
  down: boolean,
  x: number,
  y: number,
): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', {
    type: down ? 'mousePressed' : 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
    buttons: down ? 1 : 0,
  });
}

/** A full click at canvas pixel `(x, y)`. */
export async function click(cdp: CdpSession, x: number, y: number): Promise<void> {
  await mouseButton(cdp, true, x, y);
  await sleep(20);
  await mouseButton(cdp, false, x, y);
}

/** Move the mouse to an absolute canvas position (the page reads the resulting delta). */
export async function mouseMove(cdp: CdpSession, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
}

/** Evaluate an expression in the page and return its JSON value. */
export async function evaluate<T>(cdp: CdpSession, expression: string): Promise<T> {
  const result = await cdp.send<{
    result: { value: T };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`[aegis:render-three] page threw evaluating \`${expression}\`: ${detail}`);
  }
  return result.result.value;
}

/** Poll `expression` until `accept` returns true, or throw on timeout. */
export async function until<T>(
  cdp: CdpSession,
  expression: string,
  accept: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evaluate<T>(cdp, expression);
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
    await sleep(40);
  }
}

/** A launched browser process and the DevTools port it is listening on. */
export interface LaunchedBrowser {
  /** The child process. Kill it when done. */
  process: ChildProcess;
  /** The DevTools port. */
  port: number;
  /** The temporary profile directory. */
  profile: string;
}

/** Options for {@link launchBrowser}. */
export interface LaunchOptions {
  /** Show a real window instead of running headless. */
  headed?: boolean;
  /** DevTools port. Defaults to `9333`. */
  port?: number;
  /** Window size in CSS pixels. Defaults to 1280x720. */
  viewport?: { width: number; height: number };
}

/** Launch a headless browser with the DevTools endpoint open. */
export async function launchBrowser(options: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const executable = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'aegis-capture-'));
  const port = options.port ?? 9333;
  const viewport = options.viewport ?? { width: 1280, height: 720 };
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${viewport.width},${viewport.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    'about:blank',
  ];
  if (options.headed !== true) args.unshift('--headless=new');
  const child = spawn(executable, args, { stdio: 'ignore' });

  const deadline = Date.now() + 30_000;
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
export async function openPage(
  port: number,
  url: string,
  viewport = { width: 1280, height: 720 },
): Promise<CdpSession> {
  const created = (await (
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json()) as { webSocketDebuggerUrl: string };
  const cdp = await CdpSession.connect(created.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return cdp;
}

/** Close every open page target, so one measurement cannot be starved by the previous one. */
export async function closeAllPages(port: number): Promise<void> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    id: string;
    type: string;
  }[];
  for (const target of targets) {
    if (target.type !== 'page') continue;
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
  }
  await sleep(150);
}

/** Save a PNG screenshot of the page. */
export async function screenshot(cdp: CdpSession, file: string): Promise<void> {
  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
}
