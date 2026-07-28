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
/**
 * Deadline on a single CDP command's *reply*, in milliseconds.
 *
 * Declared here rather than as a literal default on {@link CdpSession.send} because it is one of
 * the deadlines a per-test budget has to contain, and a number that only exists inside a function
 * signature cannot be included in anyone's arithmetic. See the doc comment on `send` for what it
 * is and — more importantly — for what it is measured *not* able to tell you.
 */
export const TRANSPORT_TIMEOUT_MS = 30_000;

export class CdpSession {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, { ok: (value: unknown) => void; fail: (e: Error) => void }>();
  readonly #diagnostics: string[] = [];
  readonly #warnings: string[] = [];
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message: string };
      };
      // CDP multiplexes command replies (which carry `id`) and events (which carry `method`) down
      // one socket. Events used to be dropped here, which meant a page that threw on load was
      // indistinguishable from a page that loaded fine and simply never satisfied the condition
      // being waited on — the timeout said only what was awaited, never why it never arrived.
      if (message.method !== undefined) {
        this.#record(message.method, message.params);
        return;
      }
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

  /** Page-side failures, in arrival order. The only place a browser-side error is reported. */
  get diagnostics(): readonly string[] {
    return this.#diagnostics;
  }

  /**
   * Page-side *warnings*, in arrival order. Kept separate and surfaced only when a timeout has no
   * errors to report, because the failure that motivated this is a warning: Chrome emits
   * "Automatic fallback to software WebGL has been deprecated" at `warning` level and then hands
   * back a null context, so a page can fail to start with nothing at `error` level at all.
   */
  get warnings(): readonly string[] {
    return this.#warnings;
  }

  #record(method: string, params: Record<string, unknown> | undefined): void {
    const event = classifyEvent(method, params);
    if (event === undefined) return;
    // Bounded: a page in a render loop can throw once per frame, and a thousand copies of one
    // message is not more informative than the first few.
    const into = event.level === 'error' ? this.#diagnostics : this.#warnings;
    if (into.length < 20) into.push(event.text);
  }

  /**
   * Send a CDP command and await its result, with a deadline on the *transport itself*.
   *
   * The deadline is not defensive tidiness; it is the difference between an instrument that can
   * report and one that cannot. `until()` bounds how long a *condition* may take, and it checks
   * its deadline between polls — so it can only ever check it if each poll returns. A command that
   * is accepted and never answered leaves `await evaluate(...)` pending forever, `until` never
   * reaches its own deadline line, and the whole thing dies at vitest's per-test timeout with no
   * message at all.
   *
   * That is exactly what run 30340124068 produced on `windows-latest`: eight cases, every one of
   * them `Test timed out in 90000ms`, and **not one line of diagnostic output** — no boot time, no
   * page description, though the machinery to print both had been landed in the two preceding
   * commits specifically so that a timeout would explain itself. The blank-page control in the
   * same file passed at 3861 fps, so the browser was alive and answering. Whatever stops answering
   * does so once an application page is involved, and the previous design guaranteed it would stay
   * anonymous.
   *
   * 30s: every command this file sends is either a protocol round trip or a `Runtime.evaluate` of
   * a small expression. Measured on this box, a launch-plus-`openPage` round trip costs 0.7-4.8s
   * (four samples alone, four under full-suite parallelism), so 30s is roughly 6x the worst routine
   * observation. It is a hang detector, not a performance bound.
   *
   * It is NOT, however, able to tell a dead transport from a browser too starved to answer, and an
   * earlier version of the message asserted that it was. That claim was measured false during this
   * change set's own gate: on a box whose 16 logical CPUs were pinned at 100% by an unrelated
   * runaway process, a `Page.navigate` exceeded 30s and was reported as a hang. The message now
   * reports the elapsed time and the measured band and leaves the reading to the reader. The number
   * stays where it is, because it has to remain smaller than the budgets containing it for the
   * failure to be *named* at all, and a named failure with an honest message beats a mute one.
   */
  send<T = Record<string, unknown>>(
    method: string,
    params: object = {},
    timeoutMs = TRANSPORT_TIMEOUT_MS,
  ): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((ok, fail) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        fail(
          new Error(
            `[cdp] no reply to ${method} (id ${id}) after ${Date.now() - startedAt}ms. The browser ` +
              `accepted the command and did not answer within the transport deadline, so every ` +
              `deadline waiting on this reply was unreachable and would have expired mutely. ` +
              `This does not distinguish a dead transport from a browser too starved to answer: ` +
              `measured, a protocol round trip on this code path costs 0.7-4.8s, so read the ` +
              `elapsed figure above against that band before concluding which one you have.`,
          ),
        );
      }, timeoutMs);
      // Unref so a pending command can never by itself hold the process open; the rejection above
      // is what callers see, and a stray timer outliving the run would be its own defect.
      timer.unref?.();
      this.#pending.set(id, {
        ok: (value) => {
          clearTimeout(timer);
          (ok as (value: unknown) => void)(value);
        },
        fail: (e) => {
          clearTimeout(timer);
          fail(e);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Close the socket. */
  close(): void {
    this.#socket.close();
  }
}

/**
 * Render the CDP events that mean "the page is broken or complaining", and ignore the rest.
 *
 * Deliberately narrow at `error` level: the point is to explain a timeout, and a transcript of
 * every network and lifecycle event would bury the one line that matters. Warnings are classified
 * too but kept in their own bucket, because they are usually noise — except when there is nothing
 * else, which is the case this exists for.
 */
export function classifyEvent(
  method: string,
  params: Record<string, unknown> | undefined,
): { level: 'error' | 'warning'; text: string } | undefined {
  if (params === undefined)
    return method === 'Inspector.targetCrashed'
      ? { level: 'error', text: 'the page crashed' }
      : undefined;
  if (method === 'Runtime.exceptionThrown') {
    const details = params['exceptionDetails'] as
      { text?: string; exception?: { description?: string } } | undefined;
    const described = details?.exception?.description ?? details?.text;
    return described === undefined
      ? undefined
      : { level: 'error', text: `uncaught in page: ${described}` };
  }
  if (method === 'Log.entryAdded') {
    const entry = params['entry'] as { level?: string; text?: string } | undefined;
    if (entry?.text === undefined) return undefined;
    if (entry.level === 'error') return { level: 'error', text: `browser log: ${entry.text}` };
    if (entry.level === 'warning')
      return { level: 'warning', text: `browser warning: ${entry.text}` };
    return undefined;
  }
  if (method === 'Inspector.targetCrashed') return { level: 'error', text: 'the page crashed' };
  return undefined;
}

/**
 * Ask the page to describe itself, for use when a wait has timed out.
 *
 * A timeout with no page-side error is the least informative failure this harness can produce, and
 * it is the one `windows-latest` produces: run 30328777305 failed eight cases with
 * "the page reported no error" at a 60s deadline, three times the boot time the same tests measure
 * on this machine, which refutes slow-boot as the cause. Every remaining explanation -- the page
 * never navigated, its modules never arrived, WebGL is unavailable so the renderer never
 * constructed, the app booted but never reached the awaited state -- is a *different fact about
 * the page*, and none of them can be distinguished from a message that only says what was awaited.
 *
 * So this reports the facts rather than guessing between them. It is deliberately one round trip
 * that answers all of the above at once, because the machine that exhibits the fault is a CI
 * runner with a ~25 minute turnaround and iterating one hypothesis per run is not affordable.
 */
export async function describePage(cdp: CdpSession): Promise<string> {
  const probe = `(() => {
    const out = {};
    const attempt = (name, f) => { try { out[name] = f(); } catch (e) { out[name] = 'threw: ' + e; } };
    attempt('href', () => String(location.href));
    attempt('readyState', () => document.readyState);
    attempt('title', () => document.title);
    attempt('bodyChars', () => (document.body ? document.body.innerHTML.length : -1));
    attempt('canvases', () => document.querySelectorAll('canvas').length);
    attempt('aegis', () => typeof globalThis.aegis);
    attempt('scripts', () =>
      Array.from(document.querySelectorAll('script')).map((s) => (s.src || 'inline') + ' [' + (s.type || 'classic') + ']'));
    attempt('webgl2', () => !!document.createElement('canvas').getContext('webgl2'));
    attempt('webgl', () => !!document.createElement('canvas').getContext('webgl'));
    attempt('resources', () =>
      performance.getEntriesByType('resource').map((r) => {
        const leaf = String(r.name).split('/').pop();
        return leaf + ' ' + Math.round(r.duration) + 'ms' + (r.transferSize === 0 ? ' transfer=0' : '');
      }));
    return JSON.stringify(out);
  })()`;
  try {
    const raw = await evaluate<string>(cdp, probe);
    const state = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(state)
      .map(
        ([key, value]) =>
          `    ${key}: ${Array.isArray(value) ? JSON.stringify(value) : String(value)}`,
      )
      .join('\n');
  } catch (error) {
    // The probe failing is itself a finding, and a far stronger one than a timeout: it means the
    // page could not run a trivial expression. Reported rather than swallowed, because an empty
    // diagnostic that reads as "nothing to say" is the exact defect this function exists to close.
    return `    (the page could not describe itself: ${String(error)})`;
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

/**
 * Default deadline for {@link until}, in milliseconds.
 *
 * Exported rather than left as a literal so that callers which have to *contain* it can compute
 * with it. A test budget smaller than the deadlines inside it cannot let any of them fire, and a
 * number copied into a comment in another file is exactly the shared-mutable-index defect this
 * repository has been bitten by before. `browser-playability.test.ts` derives its per-case budgets
 * from this constant and asserts the containment, so raising this reddens that guard rather than
 * silently making eight cases mute again.
 */
export const DEFAULT_UNTIL_TIMEOUT_MS = 60_000;

/**
 * Deadline for the post-`Page.navigate` commit wait inside {@link openPage}, in milliseconds.
 *
 * Exported for the same reason as {@link DEFAULT_UNTIL_TIMEOUT_MS}: every caller of `openPage`
 * pays this before any of its own deadlines start, so a budget that does not include it is wrong.
 */
export const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * Deadline for a freshly spawned browser to expose its DevTools endpoint, in milliseconds.
 *
 * This value is unchanged, but it was a bare literal inside `launchBrowser` and therefore invisible
 * to the containment arithmetic — which is how it came to be the largest deadline on a path whose
 * budget did not count it. Measured on this Windows box: launch costs 1188/1556/1359/1656ms alone
 * and 1637/1982/2658/1983ms under full-suite parallelism, so 30s is roughly 11x the worst routine
 * observation. It has nevertheless been *seen* to expire, once, on a box under external starvation
 * (16 logical CPUs pinned at 100% by a runaway `msedgewebview2` holding ~400 000 CPU-seconds). That
 * excursion is recorded rather than used to size this number: a bound taken from a pathological
 * outlier is as unjustified as one taken from a single quiet reading, and the failure it produces
 * is at least *named* (`browser did not expose a DevTools endpoint`) rather than mute, which is the
 * property this change set exists to establish.
 *
 * What was actually wrong was the containment, not the value: two cases in
 * `browser-diagnostics.test.ts` had a 60s budget containing 30 (this) + 30 (navigate reply) +
 * 30 (navigation commit) + 2 = 92s of deadlines, so under load they died at the budget having said
 * nothing. Exported so both browser test files can compute with it and assert that they contain it.
 */
export const LAUNCH_TIMEOUT_MS = 30_000;

/** Poll `expression` until `accept` returns true, or throw on timeout. */
export async function until<T>(
  cdp: CdpSession,
  expression: string,
  accept: (value: T) => boolean,
  /**
   * 60s, and the number has an argument behind it rather than a feeling.
   *
   * This was 20s, which is comfortable on any development machine and was measured to be
   * *below the boot time of the slowest leg of our own CI matrix*. From run 30326965251,
   * both legs of the same commit:
   *
   *   ubuntu-latest, printed by the tests themselves:  boot 2042ms / 3106ms / 3719ms
   *   windows-latest, whole-suite ratio in that run:   662s vs 119s = 5.6x slower
   *   predicted worst boot on windows:                 3719 x 5.6 = 20.8s  >  20s deadline
   *
   * And that is exactly what happened: every case that has to boot the application page failed
   * on windows with this message, while the one case that does not boot anything — the blank-page
   * control — passed. A deadline a healthy machine misses is not a deadline, it is a slow-machine
   * detector, and it fails in the most expensive direction: it reddens on the machine you trust
   * least and blames whatever commit happened to land.
   *
   * 60s is 2.9x the measured windows figure, so a machine three times slower than windows-latest
   * still boots inside it, and it stays well under the 120s root `testTimeout` that catches a
   * genuine hang. It costs nothing when the page boots — `until` returns as soon as the condition
   * holds — and it is only ever spent when something is actually wrong.
   */
  timeoutMs = DEFAULT_UNTIL_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evaluate<T>(cdp, expression);
    if (accept(value)) return value;
    if (Date.now() > deadline) {
      // The failures a mute timeout cannot tell apart: a page that died, a page that is alive and
      // never satisfied the condition, a page that never navigated, and a page whose renderer
      // could not be created. They have completely different causes and completely different
      // fixes, so the message states which one happened rather than only what was awaited.
      const seen = cdp.diagnostics;
      const warned = cdp.warnings;
      const parts: string[] = [];
      if (seen.length > 0) parts.push(`The page reported:\n  ${seen.join('\n  ')}`);
      else parts.push('The page reported no error.');
      // Only when there are no errors: a warning is noise beside a real exception, and the sole
      // reason it is here is that Chrome reports "software WebGL has been deprecated" at warning
      // level and then returns a null context, which presents as a page that fails silently.
      if (seen.length === 0 && warned.length > 0)
        parts.push(`It did warn:\n  ${warned.join('\n  ')}`);
      parts.push(`The page describes itself as:\n${await describePage(cdp)}`);
      throw new Error(
        `timed out waiting for ${expression} after ${timeoutMs}ms. ${parts.join(' ')}`,
      );
    }
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
  /**
   * Let animation frames run as fast as the page can produce them, instead of at the compositor's
   * pace.
   *
   * Headless Chrome paces `requestAnimationFrame` to a virtual display, and on this project's
   * machine that is ~30fps *for a page doing nothing at all* — measured, blank page, 30.0fps and
   * a p95 frame gap of 60.1ms. Any frame-time budget measured under that cap is a measurement of
   * the cap. Uncapped, the same blank page runs at 508fps with a p95 gap of 10.9ms, which leaves
   * room for the page's own cost to be what the number reflects.
   *
   * Only measurement should use this. The screenshot capture deliberately does not: it wants the
   * ordinary pacing a human gets, and it drives time explicitly anyway.
   */
  uncapFrameRate?: boolean;
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
    // A headless window that Chrome believes nobody can see is a window Chrome stops drawing --
    // and when compositing stops, `requestAnimationFrame` stops with it. The page stays alive,
    // timers keep firing, nothing throws; there are simply no frames.
    //
    // Measured on windows-latest, run 30335228246, by this file's own anti-vacuity control:
    //
    //     control (blank page): 0 fps, median gap 0.0ms, p95 0.0ms
    //
    // Zero callbacks in a three-second window on a page doing nothing, while ubuntu-latest passed
    // the same commit. `CalculateNativeWinOcclusion` is Windows-only, which is the shape of the
    // split; the other three cover the neighbouring throttles that produce the same symptom, so
    // that a still-zero reading rules out the whole family rather than one member of it.
    //
    // Unconditional rather than platform-gated on purpose: a branch only one CI leg ever executes
    // is a branch nobody can debug from a local machine, and none of these can *reduce* the frame
    // rate anywhere -- they only remove throttling.
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    ...(options.uncapFrameRate === true
      ? [
          '--disable-frame-rate-limit',
          '--disable-gpu-vsync',
          '--run-all-compositor-stages-before-draw',
        ]
      : []),
    'about:blank',
  ];
  if (options.headed !== true) args.unshift('--headless=new');
  const child = spawn(executable, args, { stdio: 'ignore' });

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
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
  // The target is created BLANK and navigated afterwards, deliberately.
  //
  // `/json/new?<url>` asks Chrome to create a target already pointing at a URL. On
  // `windows-latest` it does not: run 30331670032 had a page that had been asked for
  // `http://127.0.0.1:<port>/` describe itself as
  //
  //     href: about:blank   readyState: complete   scripts: []   resources: []   bodyChars: 0
  //
  // Nothing was fetched, so nothing failed, so there was no error to report -- which is why eight
  // browser cases failed there for three runs with "the page reported no error" while ubuntu-latest
  // passed the same commit. Whether that Chrome rejects the percent-encoded query, ignores it, or
  // races the navigation is NOT established, and this does not depend on knowing: navigating
  // explicitly removes the dependence rather than guessing at it.
  //
  // It has a second benefit that was worth having anyway. Creating the target blank means the CDP
  // domains are enabled before the real document starts loading, so load-time failures cannot be
  // missed even by a Chrome that does not replay its buffered log entries.
  const created = (await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json()) as { webSocketDebuggerUrl: string };
  const cdp = await CdpSession.connect(created.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // Browser-level errors — a WebGL context that cannot be created, a module that 404s — are
  // reported through Log, not Runtime, and are exactly the failures a headless CI runner produces
  // that a developer's machine never does.
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (url !== 'about:blank') {
    const navigation = await cdp.send<{ errorText?: string }>('Page.navigate', { url });
    // Chrome reports a refused navigation here rather than throwing. Unchecked, it produces a page
    // that sits on about:blank and a caller that waits for application state that can never come.
    if (navigation.errorText !== undefined && navigation.errorText !== '')
      throw new Error(`[aegis:render-three] navigation to ${url} failed: ${navigation.errorText}`);
    // And the precondition that actually bit us: a navigation can be accepted and still not
    // happen. A page that never left about:blank must say so HERE, where the URL is known, rather
    // than sixty seconds later as an unexplained timeout somewhere else.
    //
    // 30s, and the number is chosen by containment rather than by feel. This interval is a strict
    // sub-interval of the boot wait that every caller performs next -- the document must commit
    // before any application state can exist -- and the worst *whole boot* ever measured on this
    // matrix is 22 826ms (windows, under full-suite load, landing #14). So 30s sits above the worst
    // observation of the interval that contains this one, and it cannot fire before the boot wait
    // would have. It was 60s, which is not wrong so much as unaffordable: three 60s deadlines were
    // stacked inside a 90s vitest budget, so the budget always fired first and the caller died
    // saying nothing. See the deadline table at the head of `browser-playability.test.ts`.
    await until<string>(
      cdp,
      'String(location.href)',
      (href) => href !== 'about:blank',
      NAVIGATION_TIMEOUT_MS,
    ).catch(() => {
      throw new Error(
        `[aegis:render-three] asked the browser to open ${url}, but the page is still on ` +
          'about:blank. The navigation was accepted and never happened.',
      );
    });
  }
  // Creating a target with `/json/new?<url>` activates the new tab as a side effect. Creating it
  // blank and navigating does NOT, and the consequence is invisible until something asks for a
  // capability that requires focus. Measured, one variable, two states:
  //
  //     /json/new?<url>                        hasFocus=true   pointer lock engaged
  //     blank + Page.navigate                  hasFocus=false  pointer lock REFUSED
  //     blank + Page.navigate + bringToFront   hasFocus=true   pointer lock engaged
  //
  // `poc/capture.mjs` failed 2 of 2 on the middle row and passed 2 of 2 on the first, which is how
  // this was attributed rather than guessed at: the fps capture clicks to take pointer lock, and
  // Chrome answers an unfocused document with `WrongDocumentError`. So this line is not defensive
  // tidying -- it restores the one side effect the old creation path was silently relying on.
  await cdp.send('Page.bringToFront');
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
