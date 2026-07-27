/**
 * Screenshot capture: proof that a human can actually play the games in the catalogue.
 *
 * A test suite cannot tell you whether a scene is legible, so this drives the real dev server in
 * a real browser with real key and mouse events and saves a PNG per game. It speaks the Chrome
 * DevTools Protocol over Node's built-in `WebSocket` against whichever Chromium-family browser is
 * installed, so it adds no dependency (ADR-0005: three.js stays the only third-party runtime
 * dependency).
 *
 * Two properties this is built around, both learned the hard way:
 *
 * 1. **It replays the game's own `.input` script**, compiled to browser events by
 *    `./script-input.ts`. The previous version carried hand-written key timings, which drifted
 *    the moment a level was retuned — and were never stable anyway, since hand-tuned wall-clock
 *    sleeps race a live browser. An enumeration is only as good as the enumeration; there is now
 *    no enumeration to be wrong about, because the source of truth is the same file the
 *    acceptance test runs.
 * 2. **It refuses to ship a failed playthrough.** The old run counted dead entities and printed
 *    them, then wrote the PNG anyway — so a screenshot of a corpse falling out of the world
 *    became the committed evidence that the game is playable. Reporting a problem is not the
 *    same as declining to ship it, so the observation is now a gate: no win event, or a dead
 *    player, fails the capture.
 *
 * Usage: `node poc/capture.mjs [--out <dir>] [--headed]`.
 * @packageDocumentation
 */
import { join, resolve } from 'node:path';
import { DiagnosticError } from '@aegis/core';
import { parseInputScript } from '@aegis/harness';
import type { InputScript } from '@aegis/harness';
import { findRepoRoot } from './catalog.js';
import type { GameAcceptance, GameDefinition } from './catalog.js';
import { startDevServer } from './dev-server.js';
import { compileDomInput } from './script-input.js';
import type { DomInputPlan } from './script-input.js';
import type { ControlCommand, ControlRequest, EventLine, EventLog } from './protocol.js';
import {
  click,
  evaluate,
  key,
  launchBrowser,
  mouseButton,
  mouseMove,
  openPage,
  screenshot,
  sleep,
  until,
} from './browser.js';
import type { CdpSession } from './browser.js';

/** Capture viewport, in CSS pixels. */
const VIEWPORT = { width: 1280, height: 720 };

/** Wait until the page has booted and drawn its first frame. */
async function waitForBoot(cdp: CdpSession): Promise<void> {
  await until<number>(cdp, 'globalThis.aegis ? globalThis.aegis.tick() : -1', (t) => t >= 0);
}

/**
 * Wait until input collected *after this call* has reached the server.
 *
 * This is the whole reason the replay is exact. Dispatching a key and immediately asking the
 * simulation to step would race the page's animation frame: the packet in flight was collected
 * before the key existed. `aegis.sync()` settles only on an exchange whose `collector.take()` ran
 * afterwards, so "the key is down" is a fact before the tick it applies to is simulated.
 */
async function syncInput(cdp: CdpSession): Promise<void> {
  await evaluate<null>(cdp, 'globalThis.aegis.sync().then(() => null)');
}
/**
 * The horizontal/vertical extent a plan's mouse walk covers, relative to its start.
 *
 * Under pointer lock the page reads `movementX`/`movementY`, which the browser derives from
 * consecutive absolute positions. So a look delta *is* a displacement: the cursor cannot be
 * re-centred between deltas (that re-centring would itself be read as look, cancelling the turn —
 * which is exactly why the first attempt at this never turned to face the panel). The cursor
 * therefore walks, and the walk has to fit inside the viewport.
 */
export function mouseWalkExtent(plan: DomInputPlan): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let x = 0;
  let y = 0;
  const extent = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  for (const segment of plan.segments) {
    if (segment.mouse === undefined) continue;
    x += segment.mouse.dx;
    y += segment.mouse.dy;
    extent.minX = Math.min(extent.minX, x);
    extent.maxX = Math.max(extent.maxX, x);
    extent.minY = Math.min(extent.minY, y);
    extent.maxY = Math.max(extent.maxY, y);
  }
  return extent;
}

/** Where the cursor must start for a plan's whole mouse walk to stay on screen. */
function mouseStart(plan: DomInputPlan): { x: number; y: number } {
  const extent = mouseWalkExtent(plan);
  const margin = 8;
  const spanX = extent.maxX - extent.minX;
  const spanY = extent.maxY - extent.minY;
  if (spanX > VIEWPORT.width - 2 * margin || spanY > VIEWPORT.height - 2 * margin) {
    throw new Error(
      `[aegis:render-three] the script's look sweep needs ${spanX}x${spanY} px of mouse travel, ` +
        `which does not fit a ${VIEWPORT.width}x${VIEWPORT.height} capture viewport. Raise the ` +
        "viewport, or the mode's lookDegreesPerPixel so the same turn costs fewer pixels.",
    );
  }
  return { x: margin - extent.minX, y: margin - extent.minY };
}

/** POST a session-control command to the dev server. */
async function control(
  serverUrl: string,
  id: string,
  command: ControlCommand,
  ticks?: number,
): Promise<void> {
  const body: ControlRequest = ticks === undefined ? { command } : { command, ticks };
  const response = await fetch(`${serverUrl}/api/${id}/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`control ${command} failed: ${response.status}`);
}

/**
 * Replay a compiled input plan into the page as real browser events, tick by tick.
 *
 * The session is **paused** and advanced explicitly, so each segment's input is in the server's
 * hands before the ticks it applies to are simulated. That is what makes the replay reproducible:
 * the previous capture hand-tuned wall-clock sleeps against a live simulation and was a coin flip
 * — the same commit died in two runs out of three.
 *
 * The live input path is unchanged and fully exercised: key and mouse events go through the
 * page's collector, the binding table, an HTTP packet and `LiveInput` exactly as a human's do.
 * Only the *trigger* for advancing time differs, and the accumulator that normally provides it is
 * covered by `loop.test.ts` and `session.test.ts`.
 */
async function replayPlan(
  cdp: CdpSession,
  serverUrl: string,
  id: string,
  plan: DomInputPlan,
  cursor: { x: number; y: number },
  upToTick = plan.totalTicks,
): Promise<void> {
  await control(serverUrl, id, 'pause');

  for (const segment of plan.segments) {
    if (segment.tick >= upToTick) break;
    for (const code of segment.keyUp) await key(cdp, code, false);
    for (const code of segment.keyDown) await key(cdp, code, true);
    if (segment.buttonDown) await mouseButton(cdp, true, cursor.x, cursor.y);
    if (segment.buttonUp) await mouseButton(cdp, false, cursor.x, cursor.y);

    if (segment.mouse !== undefined) {
      cursor.x += segment.mouse.dx;
      cursor.y += segment.mouse.dy;
      await mouseMove(cdp, cursor.x, cursor.y);
    }

    if (segment.click !== undefined) {
      // Settle an exchange first, so the mirror holds the snapshot the previous segment's `step`r
      // produced. Projecting before that measures a world the page has not fetched yet — the same
      // staleness as an unsynced camera, one layer up, and equally invisible on an idle machine.
      await syncInput(cdp);
      const at = await evaluate<{ x: number; y: number } | null>(
        cdp,
        `globalThis.aegis.project(${segment.click.x}, 0, ${segment.click.y})`,
      );
      if (at === null) {
        throw new Error(
          `[aegis:render-three] cell (${segment.click.x}, ${segment.click.y}) is off screen at ` +
            `tick ${segment.tick}; the script's click cannot be reproduced by a real click.`,
        );
      }
      await click(cdp, at.x, at.y);
    }

    await syncInput(cdp);
    // A partial run stops exactly on `upToTick`, so the frame photographed is the one asked for.
    await control(serverUrl, id, 'step', Math.min(segment.ticks, upToTick - segment.tick));
  }

  // Release anything still held, so the final frame is not mid-input.
  for (const code of new Set(plan.segments.flatMap((s) => s.keyDown))) {
    await key(cdp, code, false);
  }
  await syncInput(cdp);
  // Let the page fetch and draw the final state before anything is photographed.
  await until<number>(cdp, 'globalThis.aegis.tick()', (t) => t >= upToTick);
  await sleep(250);
}
/** What a capture observed about one game. */
export interface CaptureResult {
  /** Catalogue id. */
  id: string;
  /** The PNG written. */
  file: string;
  /** Tick the run finished on. */
  tick: number;
  /** Whether the game's win event was emitted. */
  won: boolean;
  /** Names of entities that ended the run dead. */
  dead: readonly string[];
  /** Reasons the capture is not a valid playthrough. Empty means it is. */
  failures: readonly string[];
}

/**
 * Check the run actually succeeded.
 *
 * The previous capture *reported* a dead player and carried on writing the PNG, which is how a
 * screenshot of a corpse falling out of the world became the committed evidence that a human can
 * play the game. Reporting is not refusing: this turns the same observation into a gate.
 */
async function inspectRun(
  cdp: CdpSession,
  serverUrl: string,
  game: GameDefinition,
): Promise<{ won: boolean; photoTick?: number; dead: string[]; failures: string[] }> {
  const log = (await (await fetch(`${serverUrl}/api/${game.id}/events`)).json()) as EventLog;
  const dead = await evaluate<string[]>(
    cdp,
    'globalThis.aegis.world.snapshot().entities' +
      '.filter((e) => e.components.Dead).map((e) => e.name ?? e.id)',
  );
  return { ...judgeRun(log.events, dead, game.acceptance), dead };
}

/**
 * Decide, from a finished run's own event log, whether it is shippable and which tick to keep.
 *
 * Split out of {@link inspectRun} so the rule can be exercised without launching a browser:
 * above this line is I/O, in here is the judgement. A rule that can only be reached by starting
 * Chrome is a rule nobody re-checks.
 */
export function judgeRun(
  events: readonly EventLine[],
  dead: readonly string[],
  acceptance: GameAcceptance | undefined,
): { won: boolean; photoTick?: number; failures: string[] } {
  const failures: string[] = [];
  if (acceptance === undefined) return { won: false, failures };

  const win = events.find((event) => event.type === acceptance.winEvent);
  if (win === undefined) {
    failures.push(`"${acceptance.winEvent}" was never emitted — the playthrough did not complete`);
  }
  if (dead.includes(acceptance.playerName)) {
    failures.push(`the player entity "${acceptance.playerName}" ended the run dead`);
  }

  // The frame to keep. An absent `photoEvent` means "the win tick", which is a default. A *named*
  // `photoEvent` that never fired is a defect rather than a preference: the catalogue asserts a
  // specific moment is the one worth photographing, so quietly photographing a different one
  // publishes a screenshot nobody chose. This used to fall back without a word — renaming Sector
  // Breach's `photoEvent` moved its frame from tick 177 to tick 241 and still exited 0. It is also
  // the same shape of mistake this package refuses everywhere else: `script-input.ts` makes an
  // unmappable input a hard error rather than a silent drop.
  let photo = win;
  if (acceptance.photoEvent !== undefined) {
    const named = events.find((event) => event.type === acceptance.photoEvent);
    if (named === undefined) {
      failures.push(
        `"${acceptance.photoEvent}" was named as the frame to photograph but was never emitted` +
          ` — the screenshot would silently be of "${acceptance.winEvent}" instead`,
      );
    } else {
      photo = named;
    }
  }
  return {
    won: win !== undefined,
    ...(photo !== undefined ? { photoTick: photo.tick } : {}),
    failures,
  };
}
/** Put the session back at a paused tick 0 with a clean input source and a repositioned cursor. */
async function resetToStart(
  cdp: CdpSession,
  serverUrl: string,
  game: GameDefinition,
  plan: DomInputPlan,
  cursor: { x: number; y: number },
): Promise<void> {
  await control(serverUrl, game.id, 'pause');
  if (game.bindings.pointer === 'lock') {
    // Moving the locked cursor is itself read as look, so it happens before the restart that
    // discards it.
    Object.assign(cursor, mouseStart(plan));
    await mouseMove(cdp, cursor.x, cursor.y);
    await syncInput(cdp);
  }
  await control(serverUrl, game.id, 'restart');
  await until<number>(cdp, 'globalThis.aegis.tick()', (t) => t === 0);
}

/** Play one game by replaying its own script, then photograph and inspect the result. */
async function captureGame(
  cdp: CdpSession,
  serverUrl: string,
  game: GameDefinition,
  outDir: string,
): Promise<CaptureResult> {
  await waitForBoot(cdp);

  if (game.script === undefined) {
    throw new Error(
      `[aegis:render-three] game "${game.id}" has no input script. The capture replays the ` +
        "game's own .input file so it cannot drift; wire it in the catalogue.",
    );
  }

  const parsed = parseInputScript(game.script);
  if (!parsed.ok || parsed.value === undefined) throw new DiagnosticError(parsed.diagnostics);
  const ticks = game.scriptTicks ?? scriptSpan(parsed.value);
  const plan = compileDomInput(parsed.value.frames(ticks), game.bindings);

  // Freeze time *before* anything else. Opening the page starts a live session, so by the time
  // the first command is dispatched the simulation has already run for however long the browser
  // took to boot — which silently offset the whole replay and drowned the player in the lava.
  await control(serverUrl, game.id, 'pause');

  const cursor = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  if (game.bindings.pointer === 'lock') {
    // Pointer lock needs a real user click, and that click also fires the bound button action.
    await click(cdp, cursor.x, cursor.y);
    await sleep(250);
    const locked = await evaluate<boolean>(cdp, 'document.pointerLockElement !== null');
    if (!locked) {
      throw new Error(
        '[aegis:render-three] pointer lock did not engage, so no mouse-look would reach the ' +
          'simulation. Failing rather than capturing a run that silently never turned.',
      );
    }
  }
  await resetToStart(cdp, serverUrl, game, plan, cursor);

  // Pass 1: the whole playthrough, which is what the gate judges.
  await replayPlan(cdp, serverUrl, game.id, plan, cursor);
  const { won, photoTick, dead, failures } = await inspectRun(cdp, serverUrl, game);

  // Pass 2: photograph the moment of victory rather than wherever the script happened to stop.
  // The tick is *derived from the run*, so it cannot drift the way a hand-picked one would — and
  // a failed run is photographed where it failed, which is the useful frame for diagnosis.
  if (won && photoTick !== undefined && photoTick < plan.totalTicks) {
    await resetToStart(cdp, serverUrl, game, plan, cursor);
    await replayPlan(cdp, serverUrl, game.id, plan, cursor, photoTick + 1);
  }

  const file = join(outDir, `${game.id}.png`);
  await screenshot(cdp, file);
  const tick = await evaluate<number>(cdp, 'globalThis.aegis.tick()');
  return { id: game.id, file, tick, won, dead, failures };
}

/**
 * The last tick any command in a script refers to.
 *
 * `TickSpan` is inclusive-start / exclusive-end and `@t` parses to `{ start: t, end: t + 1 }`, so
 * the script's length is the largest `end` (or `tick + 1`) across its commands.
 */
export function scriptSpan(script: InputScript): number {
  let end = 1;
  for (const command of script.commands) {
    const shape = command as { tick?: number; span?: { start: number; end: number } };
    if (typeof shape.tick === 'number') end = Math.max(end, shape.tick + 1);
    if (shape.span !== undefined) end = Math.max(end, shape.span.end);
  }
  return end;
}

/**
 * Capture every game in `games`.
 *
 * Throws if any run failed its acceptance check, **after** writing every PNG — a failed frame is
 * the most useful thing to look at when diagnosing why, so it is still saved; it just no longer
 * passes for success.
 */
export async function capture(
  games: readonly GameDefinition[],
  argv: readonly string[] = process.argv.slice(2),
): Promise<CaptureResult[]> {
  const outIndex = argv.indexOf('--out');
  const repoRoot = findRepoRoot();
  const outDir =
    outIndex >= 0 && argv[outIndex + 1] !== undefined
      ? resolve(argv[outIndex + 1] as string)
      : join(repoRoot, 'packages', 'render-three', 'screenshots');
  const headed = argv.includes('--headed');

  const server = await startDevServer({ games, port: 0 });
  const browser = await launchBrowser({ headed, viewport: VIEWPORT });
  const results: CaptureResult[] = [];

  try {
    for (const game of games) {
      const cdp = await openPage(browser.port, `${server.url}/play/${game.id}`);
      try {
        const result = await captureGame(cdp, server.url, game, outDir);
        results.push(result);
        const verdict = result.failures.length === 0 ? 'OK  ' : 'FAIL';
        const extra = result.dead.length > 0 ? `  dead: ${result.dead.join(', ')}` : '';
        console.log(
          `  ${verdict} ${result.id.padEnd(11)} tick ${String(result.tick).padEnd(5)} ` +
            `${result.won ? 'won' : 'NOT WON'}${extra}`,
        );
        for (const failure of result.failures) console.log(`         ${failure}`);
      } finally {
        cdp.close();
      }
    }
  } finally {
    browser.process.kill();
    await server.close();
  }

  const failed = results.filter((result) => result.failures.length > 0);
  if (failed.length > 0) {
    throw new Error(
      `[aegis:render-three] ${failed.length} of ${results.length} captures did not complete ` +
        `their playthrough: ${failed.map((r) => r.id).join(', ')}. The PNGs were written for ` +
        'diagnosis, but they are not evidence that a human can play these games.',
    );
  }
  return results;
}
