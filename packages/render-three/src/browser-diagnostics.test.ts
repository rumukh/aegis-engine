/**
 * A timeout must say why the page never answered.
 *
 * `until()` waits for an expression to become true and, when it does not, reports what it was
 * waiting for. That is only half of an explanation, and on this project's first cross-OS CI run it
 * turned out to be the wrong half: eight browser cases failed on `windows-latest` with
 * `timed out waiting for globalThis.aegis ? globalThis.aegis.tick() : -1` and nothing else, while
 * the same commit passed on `ubuntu-latest`. The message could not distinguish a page that died on
 * load from a page that was alive and simply never reached the state being awaited — two failures
 * with nothing in common except their symptom.
 *
 * The cause was one line: {@link CdpSession} discarded every CDP message without an `id`, which is
 * every *event*, which is where `Runtime.exceptionThrown` and `Log.entryAdded` arrive. The page was
 * reporting its own failure down the socket the whole time and the session was throwing it away.
 *
 * These two cases are the reason to believe the repair. A collector that silently collects nothing
 * is the same defect in a new place, and it would be invisible precisely when it matters — on a
 * machine none of us can attach a debugger to.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CdpSession,
  DEFAULT_UNTIL_TIMEOUT_MS,
  FOCUS_TIMEOUT_MS,
  LAG_SAMPLE_INTERVAL_MS,
  LATE_OVERSHOOT_MS,
  LAUNCH_TIMEOUT_MS,
  NAVIGATION_TIMEOUT_MS,
  ROUND_TRIP_HISTORY,
  STALL_LAG_MS,
  SYSTEM_CPU_SAMPLE_EVERY,
  SYSTEM_QUIET_RATIO,
  SYSTEM_SATURATED_RATIO,
  TRANSPORT_TIMEOUT_MS,
  WITNESS_DISPARITY_RATIO,
  WITNESS_EMIT_INTERVAL_MS,
  WITNESS_QUIET_LAG_MS,
  WITNESS_SHARED_RATIO,
  PAINT_FRAMES_FLOOR,
  PAINT_TIMEOUT_MS,
  classifyEvent,
  describeDeadline,
  describeWitness,
  maxLagSince,
  paintVerdict,
  startEventLoopLagMonitor,
  startExternalLagWitness,
  stopExternalLagWitness,
  waitForPaint,
  witnessSince,
  closeAllPages,
  evaluate,
  launchBrowser,
  openPage,
  sleep,
  until,
} from './browser.js';

describe('a browser timeout explains itself', () => {
  it('names the page-side error when the page threw', async () => {
    const browser = await launchBrowser();
    try {
      const cdp = await openPage(browser.port, 'about:blank');
      // An uncaught asynchronous throw: it reaches CDP as `Runtime.exceptionThrown` and does not
      // fail the `evaluate` that scheduled it, which is how a real boot failure behaves.
      await evaluate(cdp, 'setTimeout(() => { throw new Error("aegis-probe-boom"); }, 0); 1');
      const failure = await until(cdp, 'globalThis.neverDefined === true', (v) => v === true, 2_000)
        .then(() => undefined)
        .catch((error: unknown) => (error as Error).message);

      expect(failure, 'the wait must have timed out at all').toBeDefined();
      expect(failure).toContain('aegis-probe-boom');
      expect(failure).toContain('uncaught in page');
      cdp.close();
    } finally {
      await closeAllPages(browser.port);
      browser.process.kill();
    }
  }, 120_000);

  it('says so explicitly when the page is healthy and the condition simply never came true', async () => {
    const browser = await launchBrowser();
    try {
      const cdp = await openPage(browser.port, 'about:blank');
      const failure = await until(cdp, 'globalThis.neverDefined === true', (v) => v === true, 2_000)
        .then(() => undefined)
        .catch((error: unknown) => (error as Error).message);

      // The other verdict. Without this arm, a collector that reported "the page threw" for
      // everything would pass the case above and mislead every reader of a real failure.
      expect(failure, 'the wait must have timed out at all').toBeDefined();
      expect(failure).toContain('reported no error');
      expect(failure).not.toContain('uncaught in page');
      cdp.close();
    } finally {
      await closeAllPages(browser.port);
      browser.process.kill();
    }
  }, 120_000);

  // Both cases above open `about:blank` and inject their error *after* the CDP domains are
  // enabled, so between them they prove only that the collector works for errors that happen
  // after `openPage` returns. The failure they were written for happens during page *load*.
  //
  // `openPage` now creates the target blank and navigates it once `Log.enable` has been sent, so
  // the collector is live before the real document starts loading. That ordering is the reason
  // this case can be relied on; it used to depend on Chrome replaying entries it had buffered
  // before the WebSocket existed, which is a fact about Chrome rather than about this code, and
  // it is the difference between "no error" meaning "nothing went wrong" and "nothing was
  // listening".
  //
  // Measured, one variable and two states: the 404 below is reported with the URL supplied at
  // creation AND with the page opened blank and navigated afterwards. Pinned here so that a
  // future change to `openPage`'s ordering reddens, instead of quietly restoring a mute timeout.
  it('names a module that failed to load, though the page never threw', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><script type="module" src="/absent.js"></script><body>x');
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const address = server.address() as AddressInfo;
    const browser = await launchBrowser();
    try {
      const cdp = await openPage(browser.port, `http://127.0.0.1:${address.port}/`);
      // Precondition, not politeness. The assertion below is about what the collector RECORDED,
      // so the 404 has to have happened before the wait times out -- otherwise a slow machine
      // makes this test measure the clock instead of the collector, which is the load-fragile
      // green this repository treats as worse than a red. Waiting on the page's own load state
      // is structural: CDP delivers events and command replies over one ordered socket, so a
      // `readyState === 'complete'` reply cannot overtake a `Log.entryAdded` emitted before it.
      const settled = await until<string>(
        cdp,
        'document.readyState',
        (s) => s === 'complete',
        60_000,
      );
      expect(settled, 'the page must have finished loading before this measures anything').toBe(
        'complete',
      );
      const failure = await until(cdp, 'globalThis.neverDefined === true', (v) => v === true, 2_000)
        .then(() => undefined)
        .catch((error: unknown) => (error as Error).message);

      expect(failure, 'the wait must have timed out at all').toBeDefined();
      // A page whose module 404s throws nothing. Without this the timeout would say only that the
      // condition never came true, which is the least useful true statement available.
      expect(failure).toContain('404');
      expect(failure).not.toContain('The page reported no error');
      cdp.close();
    } finally {
      await closeAllPages(browser.port);
      browser.process.kill();
      server.close();
    }
    // 120s: this case launches a browser (measured at 13s under full-suite load), waits for a
    // real page load, and only then spends its 2s timeout. 60s was enough on an idle machine,
    // which is precisely the property that makes a budget useless.
  }, 120_000);

  it('makes the page state itself state, so a mute timeout still carries measurements', async () => {
    const browser = await launchBrowser();
    try {
      const cdp = await openPage(browser.port, 'about:blank');
      // Same precondition as the 404 case: `readyState: complete` is one of the values asserted
      // below, so the page must actually have reached it rather than been caught mid-load.
      await until<string>(cdp, 'document.readyState', (s) => s === 'complete', 60_000);
      const failure =
        (await until(cdp, 'globalThis.neverDefined === true', (v) => v === true, 2_000)
          .then(() => undefined)
          .catch((error: unknown) => (error as Error).message)) ?? '';

      // Each of these is a fact that distinguishes one cause of a silent failure from another:
      // where the page actually is, whether it finished loading, whether the app object exists,
      // and whether a WebGL context can be created at all. On `about:blank` the expected answers
      // are known, which is what makes this a control rather than a transcript.
      expect(failure).toContain('href: about:blank');
      expect(failure).toContain('readyState: complete');
      expect(failure).toContain('aegis: undefined');
      expect(failure).toMatch(/webgl2: (true|false)/);
      cdp.close();
    } finally {
      await closeAllPages(browser.port);
      browser.process.kill();
    }
    // 120s, for the same reason as the case above: browser launch plus a real page load sits in
    // front of the 2s wait this case is actually about.
  }, 120_000);
});

describe('openPage actually opens the page', () => {
  // The assertion nobody wrote, which is why three CI runs and eight failing cases were spent on
  // a timeout that only ever said what was being awaited. On `windows-latest` a page asked for a
  // real URL sat on about:blank with `scripts: []` and `resources: []` -- it had not navigated,
  // so nothing loaded, so nothing failed, so there was no error to report. Every downstream test
  // then waited sixty seconds for application state that could never arrive.
  //
  // This is the cheapest possible check and it is the difference between a named failure and a
  // mute one: after openPage returns, the page must BE where it was sent.
  it('has actually navigated by the time it returns, not merely been asked to', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>arrived</title><body>arrived');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/`;
    const browser = await launchBrowser();
    try {
      const cdp = await openPage(browser.port, url);
      // `openPage`'s contract is that the navigation has *happened* by the time it returns, so
      // this is asserted at the moment it returns and not after any further waiting.
      expect(await evaluate<string>(cdp, 'String(location.href)')).toBe(url);
      // The title is a different claim and needs a different moment. A document that has committed
      // its navigation may still be parsing, so `document.title` can legitimately be '' here — it
      // was, once the compositing flags shifted the timing, and the previous run passed only
      // because the parse happened to win the race. Waiting on the document's own readiness signal
      // is structural; a longer sleep would just be a bound inside a band.
      await until<string>(cdp, 'document.readyState', (s) => s === 'complete', 60_000);
      // Anti-vacuity: "not about:blank" would also be satisfied by an error page. The document has
      // to be the one the server sent.
      expect(await evaluate<string>(cdp, 'document.title')).toBe('arrived');
      cdp.close();
    } finally {
      await closeAllPages(browser.port);
      browser.process.kill();
      server.close();
    }
  }, 120_000);

  it('still supports about:blank, which is what the control pages use', async () => {
    const browser = await launchBrowser();
    try {
      const cdp = await openPage(browser.port, 'about:blank');
      expect(await evaluate<string>(cdp, 'String(location.href)')).toBe('about:blank');
      cdp.close();
    } finally {
      await closeAllPages(browser.port);
      browser.process.kill();
    }
  }, 120_000);

  /**
   * A command that is accepted and never answered must fail as itself, not as somebody else's
   * silence.
   *
   * `until()` bounds a *condition* and checks its deadline between polls, so it can only check it
   * if each poll returns. Before this deadline existed, one unanswered `Runtime.evaluate` left
   * `until` waiting forever, its own diagnostic unreachable, and the case died at vitest's per-test
   * timeout with nothing printed. Eight cases failed exactly that way on `windows-latest` in run
   * 30340124068, in a file whose blank-page control was passing at 3861 fps in the same run.
   *
   * The hang is produced through the real transport rather than by stubbing the socket: a
   * `Runtime.evaluate` that awaits a promise nobody resolves is a command Chrome genuinely never
   * answers, so this exercises the same path a real hang takes.
   */
  it('fails as a hung transport rather than as an anonymous timeout', async () => {
    const browser = await launchBrowser();
    try {
      const cdp = await openPage(browser.port, 'about:blank');

      // The control comes first and shares the short deadline: if 3s rejected everything, the
      // assertion below would pass while proving only that the timeout is indiscriminate.
      const alive = await cdp.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: '6 * 7', returnByValue: true },
        3_000,
      );
      expect(alive.result.value).toBe(42);

      const hung = cdp.send(
        'Runtime.evaluate',
        { expression: 'new Promise(() => {})', awaitPromise: true },
        3_000,
      );
      await expect(hung).rejects.toThrow(/no reply to Runtime\.evaluate/);
      // The message must name the *method* and report the elapsed time, because those are the two
      // things a reader needs and the two things a mute budget timeout cannot supply. It must NOT
      // assert which of "dead transport" or "starved browser" it is: an earlier draft claimed
      // "hung transport, not a slow page" — which was measured wrong when a merely-starved
      // `Page.navigate` exceeded the deadline on a loaded box and was reported as a hang. Asserted
      // here so the over-claim cannot come back.
      await expect(hung).rejects.toThrow(/after \d+ms/);
      await expect(hung).rejects.not.toThrow(/is a hung transport, not a slow page/);

      // And it must carry the quantity that DOES separate them. This session has completed
      // commands — `openPage`'s four, plus the `6 * 7` control above — so the band must be present
      // and must not claim the session never worked. Without this pair the band could be reported
      // as empty on a perfectly healthy session and nobody would notice, which is the same
      // "no data reads as no problem" defect one level down.
      await expect(hung).rejects.toThrow(/successful round trip\(s\) on this session/);
      await expect(hung).rejects.not.toThrow(/it did not degrade, it never worked/);
      expect(cdp.roundTrips.length).toBeGreaterThan(0);

      // Nothing is blocking this process, so the deadline fired when it was asked to and the
      // browser really is the thing that went quiet. This is the arm that gives the `late` verdict
      // its meaning: without a case that reads `on time`, "look at THIS side of the socket" would
      // be satisfiable by a classifier that says it every time.
      await expect(hung).rejects.toThrow(/the loop kept up throughout/);
      await expect(hung).rejects.toThrow(/Look at the browser/);
      await expect(hung).rejects.not.toThrow(/LATE/);
      await expect(hung).rejects.not.toThrow(/does NOT mean this process ran throughout/);

      // And the session is still usable afterwards — a deadline that poisoned the socket would
      // turn one unanswered command into a cascade of unrelated failures.
      const afterwards = await cdp.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: '1 + 1', returnByValue: true },
        3_000,
      );
      expect(afterwards.result.value).toBe(2);

      cdp.close();
    } finally {
      await closeAllPages(browser.port);
      browser.process.kill();
    }
  }, 120_000);

  /**
   * The shape run 30347429388 actually produced, and the one an empty band would have hidden.
   *
   * Two of that run's eight windows failures were `no reply to Page.enable (id 1)` — the *first*
   * command of a freshly created session. A latency band is the right instrument for starvation,
   * but on a session that has never completed anything it has no samples, and "no samples" rendered
   * as an empty list reads as "nothing to report". That is this project's most-repeated defect, so
   * the empty case is a sentence rather than a blank.
   *
   * Driven through `CdpSession.connect`, which attaches the socket and sends nothing — so a session
   * with zero completed commands is produced deterministically rather than by racing a real hang.
   * The paired arm is the point: the same method must say something *different* once a single
   * command has succeeded, or the sentence would be unconditional and would prove nothing.
   */
  it('says a session never worked, rather than reporting an empty latency band', async () => {
    const browser = await launchBrowser();
    try {
      const created = (await (
        await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' })
      ).json()) as { webSocketDebuggerUrl: string };
      const virgin = await CdpSession.connect(created.webSocketDebuggerUrl);

      expect(virgin.roundTrips).toHaveLength(0);
      expect(virgin.describeTransport()).toMatch(/it did not degrade, it never worked/);
      expect(virgin.describeTransport()).not.toMatch(/successful round trip/);

      // One real command, and the same method must now describe a band instead. Without this arm
      // the assertion above is satisfied by a `describeTransport` that always says "never worked".
      await virgin.send('Runtime.enable');
      expect(virgin.roundTrips.length).toBeGreaterThan(0);
      expect(virgin.describeTransport()).toMatch(/1 successful round trip\(s\)/);
      expect(virgin.describeTransport()).not.toMatch(/never worked/);

      // Bounded, so a render-loop page issuing thousands cannot turn a diagnostic into a heap.
      expect(ROUND_TRIP_HISTORY).toBeGreaterThan(0);
      for (let i = 0; i < ROUND_TRIP_HISTORY + 5; i += 1) {
        await virgin.send('Runtime.evaluate', { expression: '1', returnByValue: true });
      }
      expect(virgin.roundTrips).toHaveLength(ROUND_TRIP_HISTORY);

      virgin.close();
    } finally {
      await closeAllPages(browser.port);
      browser.process.kill();
    }
  }, 120_000);
  // The precondition `openPage` was relying on without ever stating, which is why breaking it cost
  // a gate rather than a line of output. Creating a target with `/json/new?<url>` activates the
  // tab; creating it blank and navigating does not, and an unfocused document is refused pointer
  // lock by Chrome with `WrongDocumentError`. Nothing said so, so `poc/capture.mjs` failed on fps
  // -- three PoCs deep, in a different package, with a message about mouse-look.
  //
  // This case was intermittently red, and the mechanism is not the obvious one. It is NOT two
  // browsers contending for one OS foreground: measured with four brought up concurrently, all
  // four held focus simultaneously. `Page.bringToFront` is acknowledged by the browser process
  // while `document.hasFocus()` is answered by the renderer, and under load those moments are up
  // to 213ms apart -- so the sample was early, not contended. Polling is what separates the two
  // explanations: the loser of a contest stays false, and this converged on its own.
  //
  // So `openPage` now waits for focus to arrive rather than for the command to be accepted, and
  // this assertion is unchanged because it was never wrong -- it was the only thing reporting the
  // gap. Only one page in a browser can hold focus, so what `openPage` guarantees is that the page
  // was focused when it returned, not forever: a caller that opens a second page moves focus to it
  // and is not breaking a rule.
  //
  // It is NOT a live production hazard, which was checked rather than assumed -- in both
  // directions. `client/input.ts` holds the only `requestPointerLock` in the repository, reached
  // from `capture.ts` only after `waitForBoot`, measured on the real fps page at 860/1166/1002ms.
  // That is ~800ms of margin over the 213ms lag, not the "37ms" an earlier version of this comment
  // claimed -- that number compared the sleep *after* the click instead of the boot *before* it.
  // The margin is incidental rather than designed, which is why the wait belongs in `openPage`
  // even though nothing is broken today.
  it('hands back a focused page, which is what capabilities like pointer lock require', async () => {
    const browser = await launchBrowser();
    try {
      const cdp = await openPage(browser.port, 'about:blank');
      // Awaited rather than sampled at the instant `openPage` returns, and the difference is a
      // measured race rather than caution. `Page.bringToFront` is answered by the *browser*
      // process; `document.hasFocus()` is the *renderer's* observation of the resulting focus
      // event. Two processes, so the reply can precede the observation. This case was failing 1
      // run in 2 on an unloaded workstation, on a tree that had not touched navigation — and it
      // failed at HEAD too, so it was never attributable to whatever commit happened to be under
      // it. Same shape as the `<title>` race one case above: a claim asserted at an instant that
      // is not the instant it becomes true.
      //
      // Contention was the obvious explanation and it is wrong. Measured with a second browser
      // window up: both browsers reported `hasFocus=true` simultaneously, so nothing is stealing
      // anything. Polled from the moment `openPage` returned, focus was observed at 20ms alone and
      // 101ms contended -- fast, and not instant, which is the entire defect.
      //
      // This does not weaken the claim. If `Page.bringToFront` is removed, focus never arrives and
      // this times out; that red was watched. What it stops asserting is a coincidence of
      // scheduling. 10s is a hang bound, ~100x the observed arrival, not a performance assertion.
      await until<boolean>(cdp, 'document.hasFocus()', (v) => v === true, 10_000);
      // Anti-vacuity for the wait above: `hasFocus` on a page that was never rendered at all
      // would be a fact about nothing. A visible document is the state in which focus is meaningful.
      expect(await evaluate<string>(cdp, 'document.visibilityState')).toBe('visible');
      cdp.close();
    } finally {
      await closeAllPages(browser.port);
      browser.process.kill();
    }
  }, 120_000);

  // The case above, run in the condition that made it flaky. Opening pages while other browsers
  // are coming up is what two parallel test files do to each other, and it is the load that pushed
  // focus propagation past the moment `openPage` used to return.
  //
  // Asserted on every page rather than on the set: the failure being guarded is one page missing
  // focus, so a check that tolerated "most of them" would pass in the exact state that broke fps.
  // Ports are OS-allocated, so this cannot collide with the sibling file that also launches
  // browsers -- which is the trap the literals used to set.
  it('holds that guarantee when several browsers are coming up at once', async () => {
    const browsers = await Promise.all([launchBrowser(), launchBrowser(), launchBrowser()]);
    try {
      // Distinct ports, asserted rather than assumed: if allocation ever handed out a duplicate,
      // the focus result below would be about fewer browsers than it claims.
      expect(new Set(browsers.map((browser) => browser.port)).size).toBe(3);
      const focused = await Promise.all(
        browsers.map(async (browser) => {
          const cdp = await openPage(browser.port, 'about:blank');
          const state = await evaluate<boolean>(cdp, 'document.hasFocus()');
          cdp.close();
          return state;
        }),
      );
      expect(focused).toEqual([true, true, true]);
    } finally {
      for (const browser of browsers) {
        await closeAllPages(browser.port);
        browser.process.kill();
      }
    }
  }, 120_000);
});

describe('closing pages is verified, not merely requested', () => {
  // `closeAllPages` used to issue a close per target and sleep 150ms. That asserts nothing:
  // `/json/close` *asks* Chrome to tear a renderer down, and a page whose main thread never yields
  // does not necessarily stop when asked. The cost of not checking lands on the innocent successor
  // -- in run 30347429388 two cases failed on `Page.enable (id 1)`, the first command of a freshly
  // created session, which is what a browser looks like when it is still busy with the target
  // somebody believed was closed.
  //
  // The throw path is driven against a stub DevTools endpoint rather than a real browser, because
  // a page that refuses to die is exactly the thing that cannot be produced on demand. The stub is
  // honest about what it is: it answers `/json/list` with one page forever and accepts every
  // close, which is the observable behaviour of a wedged renderer.
  it('names the pages that were asked to close and did not', async () => {
    let closesReceived = 0;
    const stub = createServer((request, response) => {
      if (request.url?.startsWith('/json/close/')) closesReceived += 1;
      response.setHeader('content-type', 'application/json');
      response.end(
        request.url === '/json/list'
          ? JSON.stringify([{ id: 'wedged', type: 'page' }])
          : JSON.stringify({}),
      );
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as AddressInfo).port;
    try {
      await expect(closeAllPages(port, 300)).rejects.toThrow(
        /1 page target\(s\) were asked to close and are still open after 300ms/,
      );
      // The close must actually have been attempted, or "still open" would be trivially true and
      // this case would pass against a function that did nothing at all.
      expect(closesReceived).toBeGreaterThan(0);
      // The message has to say why the failure matters here rather than where it surfaces, since
      // the whole defect is that it surfaces somewhere else.
      await expect(closeAllPages(port, 300)).rejects.toThrow(/whichever case ran next/);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }, 30_000);

  it('returns without throwing once the pages are actually gone, so the guard is not vacuous', async () => {
    // The accepting arm. Without it, every assertion above is satisfied by a function that refuses
    // unconditionally -- which would be a "guard" that makes every caller fail.
    let listed = [{ id: 'closing', type: 'page' }];
    const stub = createServer((request, response) => {
      if (request.url?.startsWith('/json/close/')) listed = [];
      response.setHeader('content-type', 'application/json');
      response.end(request.url === '/json/list' ? JSON.stringify(listed) : JSON.stringify({}));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as AddressInfo).port;
    try {
      await expect(closeAllPages(port, 5_000)).resolves.toBeUndefined();
      expect(listed).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }, 30_000);
});

describe('the CDP event classifier', () => {
  // A browser cannot be made to emit a warning-level Log entry on demand, so the warning path --
  // the one that matters, because Chrome reports "software WebGL has been deprecated" at warning
  // level and then hands back a null context -- is driven directly. Filtering warnings out was the
  // previous behaviour, and it is indistinguishable from a healthy page at the point of failure.
  const entry = (level: string, text: string) => ({ entry: { level, text } });

  it('keeps errors and warnings apart instead of discarding the warnings', () => {
    expect(classifyEvent('Log.entryAdded', entry('error', 'boom'))).toEqual({
      level: 'error',
      text: 'browser log: boom',
    });
    expect(classifyEvent('Log.entryAdded', entry('warning', 'software WebGL'))).toEqual({
      level: 'warning',
      text: 'browser warning: software WebGL',
    });
  });

  it('still drops the levels that are genuinely noise, or the timeout becomes a transcript', () => {
    expect(classifyEvent('Log.entryAdded', entry('info', 'chatter'))).toBeUndefined();
    expect(classifyEvent('Log.entryAdded', entry('verbose', 'chatter'))).toBeUndefined();
    // The arm that keeps the two above honest: a classifier that returned undefined for
    // everything would satisfy them both.
    expect(classifyEvent('Inspector.targetCrashed', undefined)).toEqual({
      level: 'error',
      text: 'the page crashed',
    });
  });
});

describe('the paint precondition', () => {
  // `waitForPaint` exists because `windows-latest` does not paint for the first ~10-60s of a job,
  // and nine cases in `browser-playability.test.ts` assumed it did. Seven of them then failed at
  // their budgets with nothing to say (run 30359389307).
  //
  // The decision it makes cannot be driven from a browser. Nothing makes Chrome composite on demand
  // and nothing makes it stop; the state that matters -- alive, executing, not being drawn -- is
  // reachable only by getting lucky with a runner, and a path nobody can exercise is a path nobody
  // can trust. So it is extracted and driven directly, exactly as `classifyEvent` was above.
  //
  // The distinction the second counter buys is the entire diagnosis and it is what makes this more
  // than a retry: zero frames with a live timer is a page that is running and not composited, which
  // waiting fixes; zero frames with a dead timer is a page that is not executing, which waiting does
  // not fix and which must not be reported as though it were the same fault. Frames alone cannot
  // tell those apart -- which is why the original instrument, which counted only frames, produced a
  // number that read as a verdict on the launch flags for two landings.
  it('separates a page that is not drawn from a page that is not running', () => {
    expect(paintVerdict(0, 187)).toBe('warming');
    expect(paintVerdict(0, 0)).toBe('not-executing');
    // The arm without which both of the above are satisfied by a function that never says
    // 'painting': the healthy reading, taken from a real warm windows-latest cell (run 30362144330,
    // cell O.6 -- 192 frames against ~187 timer ticks in the same 3s window).
    expect(paintVerdict(192, 187)).toBe('painting');
  });

  it('puts its threshold where a stalled page cannot clear it, and states the boundary', () => {
    // The floor is a real decision and it is asserted at the boundary rather than in the middle,
    // because an off-by-one here is the difference between waiting for a warm-up and declaring one.
    expect(paintVerdict(PAINT_FRAMES_FLOOR, 100)).toBe('painting');
    expect(paintVerdict(PAINT_FRAMES_FLOOR - 1, 100)).toBe('warming');
    // The cold readings that produced the defect: run 30362542986 polled 3 frames at 7.7s (not yet
    // painting) and 82 at 9.7s (painting). Both must be classified as they were measured, or the
    // threshold is tuned against nothing.
    expect(paintVerdict(3, 187)).toBe('warming');
    expect(paintVerdict(82, 187)).toBe('painting');
    // A page that is not executing must never be reported as running-but-not-drawn on the strength
    // of its frame count alone. Stated because 'warming' is the verdict that causes a wait, and
    // waiting on a page that is not executing spends 90s on a fault waiting cannot repair.
    expect(paintVerdict(PAINT_FRAMES_FLOOR - 1, 0)).toBe('not-executing');
  });

  it('names both counters when it gives up, against a real page and a real browser', async () => {
    // The end-to-end arm. The two above prove the decision; this proves the loop reaches it, reads
    // real counters from a real renderer, and produces a failure a person can act on -- the property
    // that was missing when eight cases timed out saying only that a condition was not met.
    //
    // **The first version of this case forced the failure with a 0ms deadline and did not fail.**
    // The loop sleeps a full second before its first poll, by which time this box is painting, and
    // the paint check precedes the deadline check -- so it returned `{ms: 1036, frames: 25}` and the
    // control went red. That reasoning was written into a comment as though it were a measurement.
    // It is recorded because the repair is strictly better than the thing it replaces: instead of
    // starving the loop of time, take away the page's ability to paint, which is what actually
    // happens on a cold `windows-latest` and which exercises the branch that matters.
    const browser = await launchBrowser();
    try {
      const cdp = await openPage(browser.port, 'about:blank');
      try {
        // A page that runs and is never drawn -- the `windows-latest` cold state reproduced rather
        // than simulated. `requestAnimationFrame` accepts the callback and never calls it; every
        // other clock is untouched, so the timer keeps counting and the two counters disagree
        // exactly as they did in run 30362144330 (0 frames against ~187 ticks).
        await evaluate<null>(cdp, 'globalThis.requestAnimationFrame = () => 0; null');
        await expect(waitForPaint(cdp, 2_000)).rejects.toThrow(
          /never started painting: 0 animation frames in the last second/,
        );
        // The interpretation, not just the count. This is the branch that says waiting is the right
        // response, and it is the one a reader of a CI log needs to be able to tell from the other.
        // Calling `waitForPaint` a second time here is deliberate: it is what found that the first
        // version could not be called twice at all.
        await expect(waitForPaint(cdp, 2_000)).rejects.toThrow(
          /timer fired \d+ times over the same period, so the page is executing and is not being composited/,
        );
        // And the page's own self-description, so a failure on a runner nobody can attach to still
        // says what the page was.
        await expect(waitForPaint(cdp, 2_000)).rejects.toThrow(/The page describes itself as/);
      } finally {
        cdp.close();
      }
    } finally {
      browser.process.kill();
    }
  }, 120_000);

  it('says the page is not executing when it is not, rather than blaming compositing', async () => {
    // The other branch, end to end. It matters because the two faults have different fixes and only
    // one of them is repaired by waiting: a page that is alive and undrawn warms up, a page that is
    // not running never will. An instrument that reported both as "not painting" would send the next
    // reader of a windows log looking at compositing for a fault that is not there -- which is the
    // whole history of this file.
    const browser = await launchBrowser();
    try {
      const cdp = await openPage(browser.port, 'about:blank');
      try {
        await evaluate<null>(
          cdp,
          `globalThis.requestAnimationFrame = () => 0;
           globalThis.setTimeout = () => 0;
           null`,
        );
        await expect(waitForPaint(cdp, 2_000)).rejects.toThrow(
          /timer did not fire either, so the page is not executing at all/,
        );
      } finally {
        cdp.close();
      }
    } finally {
      browser.process.kill();
    }
  }, 120_000);

  it('returns promptly on a page that is painting, so the wait is not a delay', async () => {
    // The positive arm, load-bearing in the same way the accepting arm of the test auditor is:
    // without it every assertion above is satisfied by a `waitForPaint` that always throws, and the
    // paint precondition would be a 90s tax on every healthy run rather than a deadline that costs
    // nothing when the condition already holds.
    const browser = await launchBrowser();
    try {
      const cdp = await openPage(browser.port, 'about:blank');
      try {
        const paint = await waitForPaint(cdp);
        expect(paint.frames).toBeGreaterThanOrEqual(PAINT_FRAMES_FLOOR);
        expect(paint.ms).toBeLessThan(PAINT_TIMEOUT_MS);
        // Printed rather than asserted at one poll: this box paints immediately, but a cold period
        // here would be a finding about this machine rather than a flake, and the only way anyone
        // learns of it is if the number is in the log on a pass.
        console.log(
          `[paint] ready after ${paint.ms}ms in ${paint.polls} poll(s): ` +
            `${paint.frames} frames, ${paint.timerTicks} timer ticks`,
        );
      } finally {
        cdp.close();
      }
    } finally {
      browser.process.kill();
    }
  }, 120_000);
});

/**
 * The transport timeout message spent three landings asserting something its own numbers refuted.
 *
 * It opened *"The browser accepted the command and did not answer within the transport deadline"*
 * and then reported, in the same sentence, `after 53484ms` against a 30000ms deadline. Two more
 * failures in run 30364502178 overshot by 17.0s and 5.8s. A `setTimeout(30000)` that fires 23
 * seconds late is not evidence about a browser: it is evidence that this Node process was not
 * scheduled, or was inside something synchronous, for 23 seconds — during which the reply may have
 * been sitting on the socket unread.
 *
 * All three were read as browser-side wedges, by me, because the taxonomy the message offered —
 * cliff, climb, empty — describes only the far side of the socket and there was nothing in it that
 * could describe the near side. The overshoot was printed in every one of those failures and read
 * by nobody, which is why the verdict is now *computed*: a shape that is computed gets looked at,
 * and a shape that is merely printed does not.
 */
describe('a transport deadline says which side of the socket stopped', () => {
  /**
   * Block this process for `ms`, on purpose.
   *
   * `await` would not do: the whole subject here is a loop that is *not* running, and a sleeping
   * loop is a perfectly healthy one. Only a synchronous spin reproduces the condition.
   */
  const block = (ms: number): void => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* deliberately holding the event loop, which is the quantity under test */
    }
  };

  const idle = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

  /**
   * A witness reading with everything except `maxMs` fixed, so the threshold arms below vary
   * exactly one quantity. Spelled out rather than reused from a real run, because a fixture taken
   * from the implementation shares its ancestry with the thing it is checking.
   */
  const BAND = { ticks: 200, expected: 600, buckets: 8, newestAgeMs: 0, cpuRatio: 0.01 };

  it('calls a deadline that fired when it was asked to a browser that did not answer', () => {
    const verdict = describeDeadline(30_000, 30_000, { maxMs: 3, samples: 400, expected: 400 });
    expect(verdict.verdict).toBe('on-time');
    expect(verdict.text).toMatch(/the loop kept up throughout/);
    expect(verdict.text).toMatch(/Look at the browser/);
    // The retraction, pinned. This is the arm that must stay green for the `late` arm below to
    // mean anything: a classifier that never blames the browser would satisfy every negative
    // assertion in this block while having deleted the distinction entirely.
    expect(verdict.text).not.toMatch(/LATE/);
  });

  it('calls a deadline that fired seconds late a Node process that was not running', () => {
    // The measured figure from run 30364502178: `Runtime.evaluate (id 10)`, 53484ms elapsed.
    const verdict = describeDeadline(53_484, 30_000, { maxMs: 21_900, samples: 640 });
    expect(verdict.verdict).toBe('late');
    expect(verdict.text).toMatch(/23484ms LATE/);
    expect(verdict.text).toMatch(/21900ms over 640 sample\(s\)/);
    expect(verdict.text).toMatch(/look at THIS side of the socket first/);
    // And it must NOT say the browser did not answer. This is the retraction of the exact sentence
    // that mis-attributed three CI failures, asserted here so a later edit cannot restore it —
    // the same device as `rejects.not.toThrow(/is a hung transport, not a slow page/)` above, for
    // the same reason: an over-claim that has been deleted once will come back unless something
    // goes red when it does.
    expect(verdict.text).not.toMatch(/did not answer/);
    expect(verdict.text).not.toMatch(/Look at the browser/);
  });

  it('does not let the verdict turn on a single millisecond either side of the threshold', () => {
    // Both sides of `LATE_OVERSHOOT_MS` are driven, because a boundary nobody tests is a boundary
    // that gets written with the wrong comparison and stays that way. `>` not `>=`: exactly the
    // threshold is still on time.
    expect(
      describeDeadline(30_000 + LATE_OVERSHOOT_MS, 30_000, { maxMs: 0, samples: 1 }).verdict,
    ).toBe('on-time');
    expect(
      describeDeadline(30_000 + LATE_OVERSHOOT_MS + 1, 30_000, { maxMs: 0, samples: 1 }).verdict,
    ).toBe('late');
    // A deadline that fired early — a clock that stepped backwards, which is not hypothetical on a
    // virtualised runner — must not read as `late`.
    expect(describeDeadline(29_000, 30_000, { maxMs: 0, samples: 1 }).verdict).toBe('on-time');
  });

  it('renders a maximum over no samples differently from a maximum of zero', () => {
    // These two are the same number and opposite claims: `0ms over 0 sample(s)` is an instrument
    // that never ran, and `0ms over 400 sample(s)` is a loop that was never starved. Folding the
    // count away would render "I did not measure" as "I measured nothing wrong", which is this
    // repository's most-repeated defect and the reason `maxLagSince` returns a pair.
    const unmeasured = describeDeadline(60_000, 30_000, { maxMs: 0, samples: 0 });
    const healthy = describeDeadline(60_000, 30_000, { maxMs: 0, samples: 400 });
    expect(unmeasured.text).toMatch(/0ms over 0 sample\(s\)/);
    expect(healthy.text).toMatch(/0ms over 400 sample\(s\)/);
    expect(unmeasured.text).not.toBe(healthy.text);
  });

  it('measures a blocked event loop as lag, and an idle one as nearly none', async () => {
    startEventLoopLagMonitor();

    const idleFrom = Date.now();
    await idle(600);
    const whileIdle = maxLagSince(idleFrom);

    const blockMs = 1_200;
    const blockedFrom = Date.now();
    await idle(100);
    block(blockMs);
    await idle(100);
    const whileBlocked = maxLagSince(blockedFrom);

    // The sampler ran at all. Without this the two assertions below are satisfied by an instrument
    // that produced nothing, which is exactly the shape being guarded against.
    expect(whileIdle.samples).toBeGreaterThan(0);
    expect(whileBlocked.samples).toBeGreaterThan(0);

    // A 1200ms synchronous block cannot be observed as less than about 1150ms of lag by a 50ms
    // sampler. The floor is deliberately well under it so this is a measurement of the block and
    // not of the sampler's own precision.
    expect(whileBlocked.maxMs).toBeGreaterThan(800);

    // The differential is the control, and it has to be a differential in the arithmetic and not
    // only in the wording. An earlier form asserted `whileIdle.maxMs < whileBlocked.maxMs / 4`,
    // which reads as a ratio but is a constant: `whileBlocked.maxMs` is pinned near `blockMs` by
    // the block itself on every box, so the right-hand side is ~300ms however loaded the machine
    // is, while the left-hand side grows without bound as the box fills. That is exactly the
    // "bound inside a band" the paragraph above refuses -- and it was measured red at 309 against
    // 297.25 under contention, with no defect present.
    //
    // Subtraction is the form that survives, because both windows ride the same background noise
    // and the block is the only variable between them. On a quiet box: 1200 - 5. Under twelve
    // spinning cores: 1189 - 309. The difference is the block in both, which is the claim.
    expect(whileBlocked.maxMs - whileIdle.maxMs).toBeGreaterThan(blockMs / 2);

    // A window that has not happened yet contains no samples. This is what makes the per-command
    // figure honest: the lag reported by a timeout is the lag *since that command was sent*, not
    // the worst this process has ever seen, so an unrelated block ten minutes earlier cannot be
    // presented as evidence about this command.
    const future = maxLagSince(Date.now() + 60_000);
    expect(future.maxMs).toBe(0);
    expect(future.samples).toBe(0);
    // ...and with nothing to divide, the CPU share is *unknown* rather than zero. Zero would read
    // as "this process was never scheduled", which is the opposite of "I did not measure".
    expect(future.cpuRatio).toBeUndefined();

    // The denominator is derived from the WINDOW, not from the samples: it is what the sampler
    // *owed*, which is the only thing that makes a sample count evidence. Asserted differentially
    // rather than absolutely — a longer window owes proportionally more — because an absolute count
    // would be a bound inside the band of whatever else the box is doing.
    const shortWindow = maxLagSince(Date.now() - 500);
    const longWindow = maxLagSince(Date.now() - 5_000);
    expect(shortWindow.expected).toBeGreaterThan(5);
    expect(longWindow.expected).toBeGreaterThan(shortWindow.expected * 5);
  });

  it('separates a process that is not running from one that is running flat out', async () => {
    // This is the fork nothing else in this file can resolve, and the reason `cpuRatio` exists.
    // "The event loop lagged 30 seconds" is consistent with two opposite causes -- something
    // synchronous in *our* process, or an oversubscribed box that never scheduled us -- and they
    // have opposite fixes. Run 30371952350 could not be attributed for exactly this reason.
    startEventLoopLagMonitor();

    const idleFrom = Date.now();
    await idle(700);
    const whileIdle = maxLagSince(idleFrom);

    const busyFrom = Date.now();
    await idle(50);
    block(700);
    await idle(50);
    const whileBusy = maxLagSince(busyFrom);

    // Anti-vacuity: both windows were actually sampled, and both have two endpoints to divide.
    expect(whileIdle.samples).toBeGreaterThan(1);
    expect(whileBusy.samples).toBeGreaterThan(1);
    expect(whileIdle.cpuRatio).toBeDefined();
    expect(whileBusy.cpuRatio).toBeDefined();

    // A spin loop holds a CPU for essentially the whole of its window. An `await setTimeout` does
    // not. The claim is the *separation*, not either absolute value: an absolute floor on the busy
    // window would be a bound inside a band on a contended box, which is the error this project
    // has retired three times.
    expect(whileBusy.cpuRatio ?? 0).toBeGreaterThan((whileIdle.cpuRatio ?? 0) + 0.3);

    // And the two verdicts read differently, which is the whole point of measuring it.
    expect(
      describeDeadline(30_000, 30_000, { maxMs: 5_000, samples: 3, cpuRatio: 0.98 }).text,
    ).toMatch(/it was RUNNING/);
    expect(
      describeDeadline(30_000, 30_000, { maxMs: 5_000, samples: 3, cpuRatio: 0.02 }).text,
    ).toMatch(/NOT SCHEDULED/);
    expect(describeDeadline(30_000, 30_000, { maxMs: 5_000, samples: 3 }).text).toMatch(
      /CPU share unknown/,
    );
  });

  it('refuses to call a loop that stopped "scheduled throughout" just because the deadline was long', () => {
    // The measured contradiction, from `windows-latest` run 30371952350, `Runtime.evaluate (id 49)`:
    // 30152ms elapsed against a 30000ms deadline -- 152ms over, so `on-time` under the old rule --
    // printed beside `30102ms over 2 sample(s)` of its own event-loop lag. Both cannot be true.
    //
    // A 30s deadline absorbs a block shorter than itself: the timer and the 50ms sampler both come
    // due when the block ends, and only the sampler shows how long it was. The overshoot is
    // therefore the WEAK detector, and reading it as the strong one inverted the attribution on two
    // of that run's three failures.
    const verdict = describeDeadline(30_152, 30_000, { maxMs: 30_102, samples: 2, expected: 603 });
    expect(verdict.verdict).toBe('stalled');
    expect(verdict.text).toMatch(/does NOT mean this process ran throughout/);
    expect(verdict.text).toMatch(/30102ms over 2 sample\(s\) of ~603 due/);
    expect(verdict.text).toMatch(/look at THIS side of the socket first/i);
    // The retracted sentence, pinned so it cannot come back.
    expect(verdict.text).not.toMatch(/being scheduled throughout/);
    expect(verdict.text).not.toMatch(/Look at the browser/);
  });

  it('still blames the browser when the loop really did keep up, and still says LATE when it did not', () => {
    // Without this arm, `stalled` could be produced by a classifier that has simply stopped
    // answering `on-time` -- which would satisfy every assertion in the case above while deleting
    // the distinction it exists to draw. All three verdicts must be reachable from one instrument.
    expect(
      describeDeadline(30_000, 30_000, { maxMs: STALL_LAG_MS, samples: 600, expected: 600 })
        .verdict,
    ).toBe('on-time');
    expect(
      describeDeadline(30_000, 30_000, { maxMs: STALL_LAG_MS + 1, samples: 600, expected: 600 })
        .verdict,
    ).toBe('stalled');
    // `late` outranks `stalled`: an overshoot is direct evidence about this command, where the lag
    // is evidence about the process. A run that is both gets the stronger statement.
    expect(
      describeDeadline(77_467, 30_000, { maxMs: 54_512, samples: 5, expected: 1_549 }).verdict,
    ).toBe('late');
  });

  it('does not infer BLOCKED from the gate failure pair merely because the sibling was quiet', () => {
    const witness = { ...BAND, maxMs: 207 };
    expect(witness.maxMs).toBeLessThan(WITNESS_QUIET_LAG_MS);
    expect(describeWitness(1_999, witness)).toMatch(
      /neither BLOCKED nor machine-wide starvation is established/,
    );
    expect(describeWitness(11_950, witness)).toMatch(/BLOCKED rather than starved of CPU/);
  });

  it('tells a BLOCKED process apart from a box that could not schedule anything', async () => {
    // The fork `cpuRatio` could not resolve, and the one this whole CI investigation has turned on.
    // `0% CPU` is equally true of a process the OS refused to run and of a process sitting inside a
    // blocking syscall, and those have OPPOSITE fixes: reduce the demand on the box, or remove the
    // blocking call. Runs 30377421271, 30381542084 and 30390018561 all reported `0% -- NOT
    // SCHEDULED` and none of them could say which, because nothing in this process can observe
    // another one. A sibling Node process on the same box can, and nothing else can.
    // The old 2s stimulus required a sibling below 200ms despite a 1000ms quiet floor.
    // The gate measured 1999ms vs 207ms: legitimately quiet, but not a 10x disparity.
    const blockMs = 12_000;
    expect(blockMs - LAG_SAMPLE_INTERVAL_MS).toBeGreaterThan(
      WITNESS_QUIET_LAG_MS * WITNESS_DISPARITY_RATIO,
    );
    startExternalLagWitness();
    try {
      // The parent's own sampler, without which `maxLagSince` answers over zero samples. The first
      // draft omitted this and the anti-vacuity arm below caught it: `parent.samples` was 0, so the
      // disparity ratio would have been computed from a parent that had measured nothing. An arm
      // asserting the instrument ran is not a formality here — it is the whole difference between
      // "the parent stalled and the witness did not" and "the parent was never watched".
      startEventLoopLagMonitor();
      // Long enough for several emit intervals to land, so both windows below have buckets.
      await idle(WITNESS_EMIT_INTERVAL_MS * 5);

      const blockedFrom = Date.now();
      await idle(100);
      // THE ISOLATING ARM: this process stops dead while the box stays free. That is precisely the
      // shape being diagnosed, reproduced rather than simulated -- the witness is a real second
      // process, scheduled by the real OS, and it either keeps time or it does not.
      block(blockMs);
      await idle(WITNESS_EMIT_INTERVAL_MS * 4);

      const parent = maxLagSince(blockedFrom);
      const witness = witnessSince(blockedFrom);

      // Anti-vacuity, and it is not a formality: a witness that failed to spawn reports `undefined`,
      // and every assertion below would otherwise be vacuously satisfiable by a missing instrument.
      expect(witness).toBeDefined();
      expect(witness?.buckets ?? 0).toBeGreaterThan(0);
      expect(witness?.ticks ?? 0).toBeGreaterThan(0);
      expect(parent.samples).toBeGreaterThan(0);

      // The parent really did stall. Without this the disparity below could be produced by a healthy
      // parent rather than by a healthy witness. Stated against WITNESS_QUIET_LAG_MS rather than a
      // literal 1000, because that constant is the floor `describeWitness` answers first: if the
      // parent did not clear it, the verdict below is "neither was starved" and this case would be
      // asserting a disparity the function never reached.
      expect(parent.maxMs).toBeGreaterThanOrEqual(WITNESS_QUIET_LAG_MS);

      // Establish the isolating arm across the classifier's entire quiet band. A genuinely starved
      // witness is still a failed precondition, never a retry or a weaker attribution threshold.
      expect(
        witness?.maxMs ?? Infinity,
        `The isolating witness was not quiet: ${JSON.stringify({ parent, witness })}`,
      ).toBeLessThan(WITNESS_QUIET_LAG_MS);
      expect(parent.maxMs).toBeGreaterThan((witness?.maxMs ?? 0) * WITNESS_DISPARITY_RATIO);

      // AND the testimony actually reaches into the stall. Without this the disparity below is not
      // evidence the sibling kept time — it is evidence the parent stopped listening, which is the
      // censored-testimony defect. Asserted as a PRECONDITION here rather than left to the classifier,
      // because a case that silently drifted into the coverage branch would go red on the wording
      // assertions below and read as a regression in the disparity logic.
      expect(witness?.newestAgeMs ?? Infinity).toBeLessThan(parent.maxMs);

      // The verdict says so in words, and says the actionable half: look at THIS side.
      const text = describeWitness(parent.maxMs, witness);
      expect(text).toMatch(/THE BOX COULD SCHEDULE WORK/);
      expect(text).toMatch(/BLOCKED rather than starved of CPU/);

      // The witness reports its own CPU share so the claim that it costs nothing is checkable in
      // every log rather than taken on trust. A witness burning real CPU has become part of the load
      // it exists to measure.
      expect(witness?.cpuRatio).toBeDefined();
      expect(witness?.cpuRatio ?? 1).toBeLessThan(0.25);

      // Printed, not merely asserted. A pass that prints nothing leaves the disparity unknown to
      // everyone reading the log, which is how three deadlines in this file came to sit inside their
      // own quantity's band for four landings.
      console.log(
        `[witness] parent lagged ${parent.maxMs}ms over ${parent.samples} of ~${parent.expected} ` +
          `sample(s) while a sibling process on the same box lagged ${witness?.maxMs}ms over ` +
          `${witness?.ticks} of ~${witness?.expected} reading(s), using ` +
          `${Math.round((witness?.cpuRatio ?? 0) * 100)}% CPU — ratio ` +
          `${Math.round(parent.maxMs / Math.max(witness?.maxMs ?? 1, 1))}x`,
      );
    } finally {
      stopExternalLagWitness();
    }
  }, 30_000);

  it('says nothing at all when there is no witness, rather than reporting a healthy zero', () => {
    // The empty-instrument shape, in the one place it would invert the conclusion. A witness that
    // never spawned has observed no lag; rendering that as `0ms` would read as "the sibling kept
    // perfect time", i.e. as the strongest possible evidence for BLOCKED -- manufactured out of the
    // instrument's own absence. This repository has hit that shape six times and this is the first
    // instrument where the missing reading and the healthy reading are the same number.
    stopExternalLagWitness();
    expect(witnessSince(Date.now() - 60_000)).toBeUndefined();

    const text = describeWitness(74_823, undefined);
    expect(text).toMatch(/No external witness reported/);
    expect(text).toMatch(/absence of evidence, not evidence the box was healthy/);
    // It must not reach either verdict on no data.
    expect(text).not.toMatch(/THE BOX COULD SCHEDULE WORK/);
    expect(text).not.toMatch(/comparable to this process/);
  });

  it('calls machine-wide starvation when the sibling starved too, and neither in between', () => {
    // Without this arm `describeWitness` could be a function that says BLOCKED whenever it is
    // handed any data at all, which would satisfy the isolating case above while deleting the
    // distinction it exists to draw. Both verdicts must be reachable from one instrument, and the
    // band between them must be a stated "neither" rather than a coin flip on a boundary.
    // NOTE the fragment. The "neither established" prose contains the words "machine-wide
    // starvation" inside `nor machine-wide starvation is established`, so a substring assertion on
    // that phrase is red or green for reasons unrelated to the verdict — the same defect that made
    // `not.toContain('due')` match `come due` in landing #24. Each branch is pinned on wording only
    // it has.
    const shared = describeWitness(10_000, {
      maxMs: 9_000,
      ticks: 40,
      expected: 600,
      buckets: 3,
      newestAgeMs: 0,
      cpuRatio: 0.01,
    });
    expect(shared).toMatch(/comparable to this process/);
    expect(shared).toMatch(/the lever is the demand on the box/);
    expect(shared).not.toMatch(/THE BOX COULD SCHEDULE WORK/);

    // RETARGETED. At its original arguments (parent 10000, sibling 2000) this probe now reaches the
    // branch below, because a sibling lagging 2000ms is itself over the quiet floor and that is
    // machine-wide starvation whatever the ratio says. Re-aimed at the band it was written to
    // measure — a sibling comfortably UNDER the floor, at a ratio between the two thresholds — with
    // the parent exactly on the floor so it still clears it.
    const neither = describeWitness(WITNESS_QUIET_LAG_MS, { ...BAND, maxMs: 200 });
    expect(neither).toMatch(/neither BLOCKED nor machine-wide starvation is established/);
    expect(neither).not.toMatch(/THE BOX COULD SCHEDULE WORK/);

    // The branch that reads the sibling's ABSOLUTE figure rather than the ratio. This is the arm
    // the old classifier got wrong: run 30396379326 printed "THE BOX COULD SCHEDULE WORK, so this
    // process was BLOCKED" over a sibling that had itself lagged 13806ms — a sentence contradicted
    // by the number in the same line. A box that cannot schedule a process whose only job is to
    // read a clock is starved, and the disparity on top of that cannot say which of two starved
    // processes was ALSO blocked.
    const bothStarved = describeWitness(10_000, { ...BAND, maxMs: 2_000 });
    expect(bothStarved).toMatch(/MACHINE-WIDE STARVATION IS ESTABLISHED/);
    expect(bothStarved).toMatch(/cannot say which of them was also blocked/);
    expect(bothStarved).not.toMatch(/THE BOX COULD SCHEDULE WORK/);

    // Both thresholds are driven from both sides, because a boundary nobody tests is a boundary
    // that gets written with the wrong comparison and stays that way. `>=` for the disparity, `<=`
    // for the shared verdict: exactly on either threshold, the verdict is reached.
    //
    // TWO sibling values, not one, and both DERIVED from WITNESS_QUIET_LAG_MS rather than written
    // as literals. The disparity arms need a sibling UNDER the floor (or the absolute branch
    // pre-empts the ratio); the shared arms need one ON OR OVER it (or the ratio never reaches that
    // branch at all). A single value cannot satisfy both, which is exactly why the previous single
    // `W = 1_000` stopped exercising half of these arms the moment a branch was added upstream.
    //
    // This is the SECOND time these arms have been retargeted by an upstream branch, so the
    // preconditions are now asserted rather than reasoned: an arm that cannot fire is not a
    // control, and nothing else in this file would notice if a constant change made them silently
    // unreachable again.
    const D = WITNESS_QUIET_LAG_MS / 5;
    const S = WITNESS_QUIET_LAG_MS;
    expect(D).toBeLessThan(WITNESS_QUIET_LAG_MS);
    expect(WITNESS_DISPARITY_RATIO * D - D).toBeGreaterThanOrEqual(WITNESS_QUIET_LAG_MS);
    expect(S).toBeGreaterThanOrEqual(WITNESS_QUIET_LAG_MS);

    expect(describeWitness(WITNESS_DISPARITY_RATIO * D, { ...BAND, maxMs: D })).toMatch(
      /THE BOX COULD SCHEDULE WORK/,
    );
    expect(describeWitness(WITNESS_DISPARITY_RATIO * D - D, { ...BAND, maxMs: D })).not.toMatch(
      /THE BOX COULD SCHEDULE WORK/,
    );
    expect(describeWitness(WITNESS_SHARED_RATIO * S, { ...BAND, maxMs: S })).toMatch(
      /comparable to this process/,
    );
    expect(describeWitness(WITNESS_SHARED_RATIO * S + S, { ...BAND, maxMs: S })).not.toMatch(
      /comparable to this process/,
    );

    // THE QUIET FLOOR, both sides. Found by running the instrument rather than by writing it: wired
    // into the playability spec, it announced "machine-wide starvation" over a run whose parent had
    // lagged 23ms, because 37ms against 23ms is arithmetically the shared branch. A ratio is
    // scale-free by construction, so it cannot be allowed to answer alone.
    const quiet = describeWitness(WITNESS_QUIET_LAG_MS - 1, { ...BAND, maxMs: 20 });
    expect(quiet).toMatch(/NEITHER process was starved/);
    expect(quiet).not.toMatch(/THE BOX COULD SCHEDULE WORK/);
    expect(quiet).not.toMatch(/comparable to this process/);
    // One millisecond the other side of it, the same shape reaches a verdict — so the floor is what
    // decided, and not some other property of these arguments.
    expect(describeWitness(WITNESS_QUIET_LAG_MS, { ...BAND, maxMs: 20 })).toMatch(
      /THE BOX COULD SCHEDULE WORK/,
    );
  });

  it('refuses to attribute when the testimony stops short of the stall it would describe', () => {
    // THE CENSORED-TESTIMONY DEFECT, as a classifier arm. `expected` is derived from the wall
    // window; `maxMs`, `ticks` and `buckets` come only from reports this process has RECEIVED on
    // the child's stdout. A blocked event loop runs no 'data' handler, so a verdict built while the
    // loop is still catching up is built over testimony truncated by the very stall it describes —
    // and the truncation is not neutral. It removes exactly the late readings, which is what makes
    // the sibling look punctual and the parent look BLOCKED. Run 30396379326's per-command BLOCKED
    // verdict is that artifact.
    //
    // The predicate is a comparison of two MEASURED quantities — the age of the freshest reading
    // against the length of the stall — and not a millisecond constant. Four absolute thresholds
    // have been retired in this package for sitting inside their own band; this would have been the
    // fifth, and it is the one field where an unlucky value inverts the conclusion rather than
    // merely loosening it.
    const censored = describeWitness(30_000, { ...BAND, maxMs: 20, newestAgeMs: 30_000 });
    expect(censored).toMatch(/NO ATTRIBUTION IS POSSIBLE/);
    expect(censored).toMatch(/STOPS SHORT OF THE STALL/);
    // The whole point: these are exactly the arguments that used to produce BLOCKED, on the
    // strength of a sibling whose punctuality had not in fact been observed over the stall.
    expect(censored).not.toMatch(/THE BOX COULD SCHEDULE WORK/);
    expect(censored).not.toMatch(/MACHINE-WIDE STARVATION IS ESTABLISHED/);

    // One millisecond the other side of it, the SAME shape reaches the verdict again — so the
    // coverage check is what decided, and not some other property of these arguments. Without this
    // arm the branch above would be satisfied by a function that had stopped attributing at all.
    expect(describeWitness(30_000, { ...BAND, maxMs: 20, newestAgeMs: 29_999 })).toMatch(
      /THE BOX COULD SCHEDULE WORK/,
    );
  });

  it('drains the sibling reports a blocked loop could not read before it judges them', async () => {
    // The MECHANISM behind the branch above, measured rather than argued. libuv runs the timers
    // phase BEFORE the poll phase, so a deadline that fires at the end of a stall builds its
    // message while every byte the witness wrote during that stall is still unread in the pipe.
    // `send()`'s message construction is therefore deferred to setImmediate — the CHECK phase,
    // after this iteration's poll phase has drained it.
    //
    // This is a direct reading of the quantity underneath the fix, not a sample of its outcome:
    // the age of the freshest received reading, at the two moments a verdict could be built.
    startExternalLagWitness();
    startEventLoopLagMonitor();
    await idle(WITNESS_EMIT_INTERVAL_MS * 5);

    const from = Date.now();
    await idle(WITNESS_EMIT_INTERVAL_MS * 2);
    // Anti-vacuity: a witness that failed to spawn reports `undefined`, and both readings below
    // would then be vacuously "equal" at nothing.
    expect(witnessSince(from)).toBeDefined();

    const measured = await new Promise<{ atTimer: number; atImmediate: number }>((done) => {
      setTimeout(() => {
        // The stall itself. Reproduced, not simulated: the child keeps writing throughout and this
        // process cannot read a byte of it.
        block(1_500);
        const atTimer = witnessSince(from)?.newestAgeMs ?? Number.NaN;
        // The timers phase is where the old verdict was built. The check phase is where it is built
        // now, and the poll phase in between is the entire difference.
        setImmediate(() => done({ atTimer, atImmediate: witnessSince(from)?.newestAgeMs ?? NaN }));
      }, 10);
    });

    expect(Number.isNaN(measured.atTimer)).toBe(false);
    expect(Number.isNaN(measured.atImmediate)).toBe(false);

    // STRUCTURAL, not a band: no report can have been read during the block, so the freshest
    // reading's timestamp is necessarily at or before the block started, and its age at the end of
    // the block is therefore at least the block's length. A machine 100x slower satisfies this;
    // one 100x faster does too.
    expect(measured.atTimer).toBeGreaterThanOrEqual(1_500);
    // And one poll phase later the pipe has been drained, so the freshest reading is fresh again.
    expect(measured.atImmediate).toBeLessThan(measured.atTimer);
    // The child emits every WITNESS_EMIT_INTERVAL_MS, so after a drain the newest reading is at
    // most one emit interval old plus scheduling slop. 4x is the headroom convention this file
    // already uses for a quantity whose floor is structural and whose ceiling is not.
    expect(measured.atImmediate).toBeLessThan(WITNESS_EMIT_INTERVAL_MS * 4);

    console.log(
      `[witness] freshest reading was ${measured.atTimer}ms old in the timers phase at the end of ` +
        `a 1500ms block, and ${measured.atImmediate}ms old one poll phase later — the pipe had ` +
        `${measured.atTimer - measured.atImmediate}ms of testimony in it that a verdict built in ` +
        `the timers phase could not see`,
    );

    stopExternalLagWitness();
  }, 30_000);

  it('does not hold this process open — the witness must not outlive its parent', async () => {
    // FOUND BY THE GATE, NOT BY A TEST. `node poc/capture.mjs` wrote all three PNGs in 15 seconds
    // and then sat alive for 2 hours 17 minutes. It had not hung doing work; it hung at exit.
    //
    // `child.unref()` unrefs the child's PROCESS handle. A `stdio: 'pipe'` stream is a SEPARATE
    // referenced libuv handle in the parent, so a fully unref'd child still holds its parent's
    // event loop open through the pipe. `CdpSession.connect()` starts the witness for EVERY
    // consumer of this module — the capture and the dev server included — while exactly one caller
    // (`browser-playability.test.ts`'s afterAll) ever calls stopExternalLagWitness(). A diagnostic
    // that changes whether the program terminates is not passive, whatever its CPU cost.
    //
    // `npm run verify` passed at 73 files / 1038 tests with the defect present, because vitest tears
    // its workers down. eslint and tsc cannot see process lifetime. Nothing in the gate could see
    // this except the one instrument that runs a program to completion.
    stopExternalLagWitness();

    const tally = (xs: readonly string[]): Map<string, number> => {
      const t = new Map<string, number>();
      for (const x of xs) t.set(x, (t.get(x) ?? 0) + 1);
      return t;
    };
    const addedBy = (fn: () => void): Map<string, number> => {
      const before = tally(process.getActiveResourcesInfo());
      fn();
      const after = tally(process.getActiveResourcesInfo());
      const added = new Map<string, number>();
      for (const [k, v] of after) {
        const d = v - (before.get(k) ?? 0);
        if (d > 0) added.set(k, d);
      }
      return added;
    };

    // `getActiveResourcesInfo()` lists only resources that are KEEPING THE EVENT LOOP ALIVE, which
    // is the property itself rather than a proxy for it.
    const startedAt = Date.now();
    const added = addedBy(() => startExternalLagWitness());
    expect([...added.keys()]).not.toContain('PipeWrap');
    expect([...added.keys()]).not.toContain('ChildProcess');

    // ANTI-VACUITY 1 — the witness must genuinely have started. A `startExternalLagWitness()` that
    // silently did nothing adds no handles either, and would satisfy every assertion above while
    // measuring an absence. Testimony arriving is the marker that it ran.
    await new Promise((resolve) => setTimeout(resolve, WITNESS_EMIT_INTERVAL_MS * 5));
    expect(witnessSince(startedAt)).toBeDefined();

    // ANTI-VACUITY 2 — the instrument must be able to SEE a referenced pipe on this platform.
    // Without this arm, `getActiveResourcesInfo()` returning nothing useful reads exactly like a
    // clean result. Measured: with the unref removed, the witness itself adds `PipeWrap: 1`.
    //
    // It has to be a DIFFERENTIAL through the same helper the real claim uses. Written first as
    // `tally(...).get('PipeWrap') > 0`, it passed even with the control child given no pipe at
    // all — vitest holds pipes of its own, so that form asserted "this process has a pipe
    // somewhere" and was satisfied by resources nothing here created. A control that cannot fail
    // is not a control, and the mutation harness is the only reason that was noticed.
    let control: ChildProcess | undefined;
    try {
      const controlAdded = addedBy(() => {
        control = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        control.unref(); // process handle only — deliberately leaving the pipe referenced
      });
      expect([...controlAdded.keys()]).toContain('PipeWrap');
    } finally {
      control?.kill();
    }

    stopExternalLagWitness();
  });

  it('reports the sampler\u2019s own miss rate, because 2 of 600 is not "a small sample"', () => {
    // `30102ms over 2 sample(s)` reads as a handful of readings. `2 sample(s) of ~603 due` reads as
    // an instrument that was itself starved -- which is the finding. The denominator is the whole
    // difference between those two sentences.
    const starved = describeDeadline(30_152, 30_000, { maxMs: 30_102, samples: 2, expected: 603 });
    expect(starved.text).toContain('of ~603 due');
    // And when a caller cannot supply it, the text must not invent one.
    const withoutDenominator = describeDeadline(30_152, 30_000, { maxMs: 30_102, samples: 2 });
    expect(withoutDenominator.text).toContain('over 2 sample(s)');
    // The denominator fragment specifically, not the word "due" — the stalled prose contains "come
    // due" in its explanation, and a substring assertion loose enough to match that would be red
    // for a reason unrelated to what it claims to check.
    expect(withoutDenominator.text).not.toContain('of ~');
  });

  it('separates an oversubscribed box from a quiet one, which "NOT SCHEDULED" alone cannot', () => {
    // The retracted claim, verbatim from the code this replaces:
    //
    //   "it was NOT SCHEDULED, so the box is oversubscribed by something outside this process"
    //
    // `cpuRatio` is `process.cpuUsage()` over wall time. It is a statement about THIS process and is
    // silent about every other one, so everything after "so" was an inference printed in the same
    // typeface as the measurement beside it. It was then carried into three landings and two CI
    // verdicts (`windows-latest` runs 30377421271 and 30380984122), where every browser failure read
    // `0%` and was written up as an oversubscribed runner without the box ever being measured.
    //
    // The branches have opposite next steps, which is why the distinction is worth an instrument:
    // saturated means reduce the browser's demand, quiet means CPU contention was never the
    // mechanism and the next instrument is elsewhere entirely.
    const stalled = { maxMs: 30_000, samples: 2, expected: 603, cpuRatio: 0 };

    const saturated = describeDeadline(30_152, 30_000, { ...stalled, systemRatio: 0.97 });
    expect(saturated.text).toMatch(/every core together was 97% busy/);
    expect(saturated.text).toMatch(/NOT SCHEDULED on a saturated box/);
    expect(saturated.text).toMatch(/WHO saturated it is not established by this field/);

    const quiet = describeDeadline(30_152, 30_000, { ...stalled, systemRatio: 0.12 });
    expect(quiet.text).toMatch(/every core together was only 12% busy/);
    expect(quiet.text).toMatch(/OVERSUBSCRIPTION IS REFUTED/);
    expect(quiet.text).toMatch(/I\/O, a lock, a synchronous filesystem call, or the socket/);

    const neither = describeDeadline(30_152, 30_000, { ...stalled, systemRatio: 0.7 });
    expect(neither.text).toMatch(/neither branch is established/);

    // And with no reading at all it must say so rather than fall back to the old assertion. An
    // unmeasured quantity that renders as a claim is the defect this whole case exists to close.
    const unmeasured = describeDeadline(30_152, 30_000, stalled);
    expect(unmeasured.text).toMatch(/UNMEASURED over this window, so do not assume it/);
    expect(unmeasured.text).not.toMatch(/box is oversubscribed/);

    // The retracted sentence, pinned in every branch so it cannot return by any path.
    for (const verdict of [saturated, quiet, neither, unmeasured]) {
      expect(verdict.text).not.toMatch(/NOT SCHEDULED, so the box is oversubscribed/);
      // And the SECOND retraction, which the first repair missed. Gating "the box is oversubscribed"
      // on a real box reading left "by something outside this process" standing in the saturated
      // branch -- a claim about ATTRIBUTION, which `systemRatio` cannot support either, because
      // `os.cpus()` counts the browser and dev server this suite starts too. `windows-latest` run
      // 30390018561 then measured the box at 6% before anything of ours exists and 100% during the
      // run, so it was false as well as unsupported. A half-repaired sentence is the harder defect:
      // the branch condition was fixed, the wording was not, and the docstring above quoted the
      // whole sentence as retired while the code below still emitted half of it.
      expect(verdict.text).not.toMatch(/oversubscribed by something outside/);
    }
  });

  it('puts the saturated and quiet thresholds where a boundary cannot decide the verdict', () => {
    // Driven both ways at each threshold. Without this the two constants could drift to meet, and a
    // fork whose branches touch is a coin flip with a comment attached -- the failure this project
    // has retired three separate bounds for.
    const at = (systemRatio: number): string =>
      describeDeadline(30_152, 30_000, {
        maxMs: 30_000,
        samples: 2,
        expected: 603,
        cpuRatio: 0,
        systemRatio,
      }).text;
    expect(at(SYSTEM_SATURATED_RATIO)).toMatch(/NOT SCHEDULED on a saturated box/);
    expect(at(SYSTEM_SATURATED_RATIO - 0.01)).toMatch(/neither branch is established/);
    expect(at(SYSTEM_QUIET_RATIO)).toMatch(/OVERSUBSCRIPTION IS REFUTED/);
    expect(at(SYSTEM_QUIET_RATIO + 0.01)).toMatch(/neither branch is established/);
    expect(SYSTEM_SATURATED_RATIO).toBeGreaterThan(SYSTEM_QUIET_RATIO + 0.2);
  });

  it('measures the box and not merely this process, on whatever OS this is running on', async () => {
    // THE control that makes every `systemRatio` reading above believable, and it has to run against
    // the real `os.cpus()` on the real platform. A counter that never advanced would return
    // `undefined` or a flat 0 and be read as "the box was idle" -- which is the REFUTED branch, the
    // one that would send the next person to instrument I/O for a problem that was CPU all along.
    // An instrument reporting nothing must never be indistinguishable from an instrument reporting
    // nothing wrong, and here the two would have had opposite meanings.
    startEventLoopLagMonitor();
    const cores = cpus().length;
    // Long enough to be spanned by at least two system-carrying samples, which are taken one in
    // every `SYSTEM_CPU_SAMPLE_EVERY` lag samples rather than on every one -- `os.cpus()` costs
    // ~736us against ~1.3us for `process.cpuUsage()`, so sampling it at the lag cadence would burn
    // ~1.5% of a core inside the instrument whose subject is CPU starvation.
    const window = SYSTEM_CPU_SAMPLE_EVERY * 50 * 5;

    // ARM 1 -- this process saturates exactly one core.
    const busyFrom = Date.now();
    const spinUntil = busyFrom + window;
    while (Date.now() < spinUntil) {
      /* deliberately synchronous: one core, fully held, for the whole window */
    }
    const busy = maxLagSince(busyFrom);
    const busyAt = Date.now();

    // ARM 2 -- this process does nothing at all over a window of the same length.
    //
    // The `await sleep(0)` is load-bearing and is the finding of this case, not a nicety. The spin
    // above took no samples at all -- that is the point of arm 1 -- so without a yield the newest
    // reading in the history predates the spin, becomes arm 2's anchor, and drags the whole 2.5s of
    // spin inside arm 2's ratio window: measured, this arm read `cpuRatio` 0.40 for a window in
    // which this process did nothing whatever. The dilution is real, it is unbounded by the sampler
    // cadence, and it is pinned separately by the case below rather than hidden here.
    await sleep(LAG_SAMPLE_INTERVAL_MS * 3);
    const idleFrom = Date.now();
    await sleep(window);
    const idle = maxLagSince(idleFrom);

    // The counters advanced. Everything else here is downstream of this.
    expect(busy.systemRatio).toBeDefined();
    expect(idle.systemRatio).toBeDefined();

    // And arm 1 really is the starved shape, not a healthy window that happens to work: a
    // synchronous spin runs no timers, so the sampler misses most of what it was due. This is the
    // assertion that makes the one above mean something -- `systemRatio` being defined over a
    // *quiet* window would not have caught the design that returned `undefined` over a stalled one.
    expect(busy.expected).toBeGreaterThan(20);
    expect(busy.samples).toBeLessThan(busy.expected / 2);

    // What follows is scaled by the window the ratios ACTUALLY cover, which is not the window that
    // was asked for. `ratioFromMs` reports where it really begins, and here it is measured rather
    // than assumed: the spin takes no samples, so the anchor is whatever the sampler managed before
    // it, and under load that has been observed 1.7s back. An earlier draft asserted a flat
    // `cpuRatio > 0.8` and a mutation control caught it reading 0.588 for a perfectly healthy spin
    // -- a bound sitting inside its own quantity's band, which is the error this project keeps
    // retiring. `spinShare` is the fraction of the covered window that really was spin; the
    // assertions below are stated against it, so they mean the same thing however diluted the
    // window is.
    const spinShare = window / (busyAt - (busy.ratioFromMs ?? busyFrom));
    // ...and a floor on the coverage itself, because a `ratioFromMs` reporting something ancient
    // would drive `spinShare` to zero and make every assertion below trivially satisfiable.
    expect(spinShare).toBeGreaterThan(0.2);
    expect(spinShare).toBeLessThanOrEqual(1);

    // Holding one core of `cores` for the spin puts at least `spinShare / cores` of the box's total
    // capacity in the busy column, whatever else the machine is doing -- ambient load can only add.
    // That makes this floor independent of how contended the runner is, which an arm comparing the
    // two windows to each other would not be. The 0.8 is slack for sampling granularity at the two
    // ends, not a tuned number.
    expect(busy.systemRatio ?? 0).toBeGreaterThanOrEqual((spinShare * 0.8) / cores);

    // `cpuRatio` moves with what this process actually did -- stated as a DIFFERENCE between the two
    // arms rather than as a floor on either. A floor here is a bound inside a band: on a saturated
    // box a spin loop is preempted and genuinely does not get a whole core, measured 72% where a
    // quiet box reads 89%, so any absolute threshold is really a claim about the runner. The
    // difference is structural -- spinning uses more CPU than sleeping, on every machine.
    expect((busy.cpuRatio ?? 0) - (idle.cpuRatio ?? 0)).toBeGreaterThan(0.3);

    // And the two ratios are different quantities, not one value plumbed to two names -- but WHICH
    // arm demonstrates that depends on the box, so the claim is stated over both rather than pinned
    // to whichever one happens to work here. On a quiet machine arm 1 separates them (this process
    // ~90% of a core against the box at ~6% of capacity). On a saturated one arm 1 cannot: measured
    // 72% against 95%, closer together than any threshold could tell apart -- and arm 2 separates
    // them instead, at process 0% against box 57%. A single value plumbed to two names would move
    // the two together in BOTH arms, so requiring a material gap in at least one is the claim
    // itself, not a weakened version of it. An earlier draft asserted `systemRatio < cpuRatio` on
    // arm 1 alone and went red on a loaded box for no defect at all.
    const ratioGap = Math.max(
      Math.abs((busy.cpuRatio ?? 0) - (busy.systemRatio ?? 0)),
      Math.abs((idle.cpuRatio ?? 0) - (idle.systemRatio ?? 0)),
    );
    expect(ratioGap).toBeGreaterThan(0.15);

    // Arm 2 produces the combination the new branch exists for: this process not on a CPU at all,
    // with the box's own load measured independently of it. Reaching that state from the real
    // sampler is what proves the REFUTED branch is a measurement rather than a sentence.
    expect(idle.cpuRatio ?? 1).toBeLessThan(0.2);
    console.log(
      `[cpu] ${cores} core(s) · spinning one: process ${Math.round((busy.cpuRatio ?? 0) * 100)}% / ` +
        `box ${Math.round((busy.systemRatio ?? 0) * 100)}% over a window ${Math.round(spinShare * 100)}% spin · idle: process ` +
        `${Math.round((idle.cpuRatio ?? 0) * 100)}% / box ${Math.round((idle.systemRatio ?? 0) * 100)}%`,
    );
    // Deliberately NO numeric budget. This case launches no browser, so it pays none of the
    // launch + navigate + commit floor, and the containment guard below reads every budget in this
    // file out of its own source and requires it to clear that floor. A budget here would be a
    // 30-second literal failing a 90-second floor for a case that cannot spend it.
  });

  it('says how far before the window its ratios really begin, because that is unbounded', async () => {
    // Anchoring both ratios to the last reading BEFORE the window is what makes them answerable at
    // all over a stalled window -- a blocked loop takes no samples while it is blocked, so two
    // in-window endpoints do not exist. The price is that the anchor is only as fresh as the last
    // sample the sampler managed to take, so a stall immediately before the window pushes the
    // window's real start back by the length of that stall. The doc comment first claimed a flat
    // 50ms/500ms bound; this case is the control that refuted it, and it exists so that the
    // dilution is a reported quantity rather than a surprise in someone's attribution.
    startEventLoopLagMonitor();

    // Healthy: the loop has been turning, so the anchor is one sampler interval old at most and the
    // ratio window is essentially the window that was asked for. Without this arm a `ratioFromMs`
    // hardwired to something ancient would satisfy the arm below, and the pair would measure
    // nothing.
    //
    // The allowance is measured, not assumed, and that is this arm's whole correction. Its own
    // docblock says a stall immediately before the window pushes the window's real start back by
    // the length of that stall -- and then an earlier form asserted a flat 1000ms anyway, which
    // contradicted the very dilution this case exists to report. On a loaded box the sampler is
    // descheduled along with everything else, so the anchor legitimately ages past any constant:
    // measured 762ms here under twelve spinning cores, and 1106ms against the flat bound on
    // another box, both with no defect present. What is bounded instead is two sampling periods
    // PLUS the worst stall actually observed either side of the window boundary.
    const settleFrom = Date.now();
    await sleep(LAG_SAMPLE_INTERVAL_MS * 8);
    const beforeWindow = maxLagSince(settleFrom);
    const freshFrom = Date.now();
    await sleep(LAG_SAMPLE_INTERVAL_MS * 8);
    const fresh = maxLagSince(freshFrom);
    expect(fresh.ratioFromMs).toBeDefined();
    // Anti-vacuity: the allowance is only honest while it stays far below the age a hardwired
    // anchor would show. A stall big enough to make this bound meaningless is itself the finding.
    const stallAllowance = Math.max(beforeWindow.maxMs, fresh.maxMs);
    expect(stallAllowance).toBeLessThan(SYSTEM_CPU_SAMPLE_EVERY * LAG_SAMPLE_INTERVAL_MS * 4);
    expect(freshFrom - (fresh.ratioFromMs ?? 0)).toBeLessThan(
      SYSTEM_CPU_SAMPLE_EVERY * LAG_SAMPLE_INTERVAL_MS * 2 + stallAllowance,
    );

    // Starved: a synchronous block, then a window opened with no yield in between. Every sample the
    // anchor could have been is on the far side of the block.
    const blockMs = 1_200;
    block(blockMs);
    const staleFrom = Date.now();
    await sleep(LAG_SAMPLE_INTERVAL_MS * 4);
    const stale = maxLagSince(staleFrom);

    // The claim is NOT that the ratio is wrong -- it is that the instrument says how much of its
    // answer is about the period before the question. Half the block is a floor well inside the
    // measurement rather than a bound on it.
    expect(stale.ratioFromMs).toBeDefined();
    expect(staleFrom - (stale.ratioFromMs ?? 0)).toBeGreaterThan(blockMs / 2);
    console.log(
      `[cpu] ratio window starts ${freshFrom - (fresh.ratioFromMs ?? 0)}ms before a healthy window ` +
        `(allowed ${SYSTEM_CPU_SAMPLE_EVERY * LAG_SAMPLE_INTERVAL_MS * 2} + ${stallAllowance}ms of measured stall) ` +
        `and ${staleFrom - (stale.ratioFromMs ?? 0)}ms before one opened straight after a ${blockMs}ms block`,
    );
  });

  /**
   * The whole defect, end to end, through a real browser.
   *
   * The command here is not hung — `6 * 7` is answered by Chrome in single-digit milliseconds. What
   * is broken is this side: the process is blocked solidly past the deadline, so the reply arrives
   * and is never read, and the timer fires long after it was due. That is the situation the old
   * message described as *"the browser accepted the command and did not answer"*, and it is the
   * reason three `windows-latest` failures were investigated as browser wedges.
   *
   * Deliberately not a stubbed clock. A fake timer would prove the classifier's arithmetic, which
   * the pure cases above already do; only a real block proves that a *real* reply on a *real*
   * socket goes unread and produces this verdict.
   */
  it('reports LATE when the reply arrived and this process was not running to read it', async () => {
    const browser = await launchBrowser();
    try {
      const cdp = await openPage(browser.port, 'about:blank');

      // The control, and it is the same one the hung-transport case uses for the same reason: if
      // this deadline rejected everything, the assertion below would pass while proving only that
      // 1500ms is too short for any command at all.
      const alive = await cdp.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: '6 * 7', returnByValue: true },
        1_500,
      );
      expect(alive.result.value).toBe(42);

      const answerable = cdp.send(
        'Runtime.evaluate',
        { expression: '6 * 7', returnByValue: true },
        1_500,
      );
      // Chrome answers this within milliseconds. Nothing here reads it, because nothing here is
      // running: libuv runs the timers phase before the poll phase, so when the block ends the
      // deadline fires first and the reply is discarded as unmatched.
      block(4_000);

      await expect(answerable).rejects.toThrow(/fired \d+ms LATE/);
      await expect(answerable).rejects.toThrow(/was not running/);
      await expect(answerable).rejects.not.toThrow(/did not answer/);

      // THE DEFERRAL, controlled at its call site rather than only at its mechanism.
      //
      // The witness clause in this message is built by `send()`'s timeout callback. libuv runs the
      // timers phase BEFORE the poll phase, so a callback that runs synchronously there reads a
      // witness history missing every report the child wrote during the 4000ms block. `send()`
      // therefore defers to `setImmediate`, one phase later, after poll has drained the pipe.
      //
      // WHAT THE CENSORSHIP ACTUALLY LOOKS LIKE HERE WAS MEASURED, NOT REASONED. The first version
      // of this arm asserted the message does not say its testimony `STOPS SHORT OF THE STALL`, on
      // the reasoning that the freshest reading would be ~4000ms old against a ~4000ms stall. Run
      // with the `setImmediate` removed, that arm stayed GREEN — because the window opens at
      // `startedAt` and the block begins immediately, so the parent reads NOT ONE report inside it.
      // `witnessSince` returns `undefined` rather than a stale history, and `describeWitness` takes
      // its first branch, never the coverage branch. Censorship here is total, not partial:
      //
      //   deferred    "a sibling Node process on the same box lagged 18ms over 66 of ~80
      //                reading(s) in 15 report(s) ... THE BOX COULD SCHEDULE WORK"
      //   synchronous "No external witness reported over this window, so BLOCKED and NOT SCHEDULED
      //                cannot be told apart here"
      //
      // So the arm asserts the regime this case really produces: testimony survived at all. Both
      // lines below were watched red with the deferral removed. The `STOPS SHORT` pin was dropped
      // rather than kept, because it was measured unable to fail here; the partial-truncation
      // regime is covered by the drain case above (1500ms block: freshest reading 1640ms old in the
      // timers phase, 17ms one poll later) and by the coverage-branch case that names it directly.
      await expect(answerable).rejects.toThrow(/a sibling Node process on the same box lagged/);
      await expect(answerable).rejects.not.toThrow(/No external witness reported/);

      // The session survives it, and the very next command succeeds — which is the strongest form
      // of "the browser was never the problem" available: the far side was healthy throughout.
      const afterwards = await cdp.send<{ result: { value: number } }>(
        'Runtime.evaluate',
        { expression: '1 + 1', returnByValue: true },
        3_000,
      );
      expect(afterwards.result.value).toBe(2);

      cdp.close();
    } finally {
      await closeAllPages(browser.port);
      browser.process.kill();
    }
  }, 120_000);
});

/**
 * Every case in this file launches a browser and opens a page before it does anything of its own,
 * and both of those carry deadlines that live in another module. A vitest budget is the outermost
 * deadline on the path: if it is smaller than the sum of the deadlines inside it, none of them can
 * fire, the case dies at the budget, and it dies *mutely* — which is precisely the failure this
 * whole file exists to make impossible.
 *
 * That is not hypothetical here. Two cases in this file were written with a 60s budget containing
 * 30s (browser launch) + 30s (navigate reply) + 30s (navigation commit) = 90s of deadlines before
 * their own waits were counted at all, and during this change set's gate both died at 60s having
 * said nothing. The sibling guard in `browser-playability.test.ts` did not catch it because it
 * audited only its own file, so the arithmetic was right in one place and absent in the other.
 *
 * The budgets are read out of this file's own source rather than mirrored into a table, for the
 * reason stated on `DEFAULT_UNTIL_TIMEOUT_MS`: a copy is a shared mutable index with no instrument.
 * Reading the source also closes the *class* rather than the two instances — a case added next
 * month is audited without anyone remembering to add it here.
 */
describe('every budget in this file must contain the deadlines every case pays', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'browser-diagnostics.test.ts'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  /** `launchBrowser` -> `openPage` (`Page.navigate` reply, the commit wait, then the focus wait). */
  const FLOOR_MS =
    LAUNCH_TIMEOUT_MS + TRANSPORT_TIMEOUT_MS + NAVIGATION_TIMEOUT_MS + FOCUS_TIMEOUT_MS;

  /**
   * Each `it(...)` in this file, with its own budget and its own body.
   *
   * This used to be three global counts — budgets, `launchBrowser` occurrences, `openPage`
   * occurrences — plus an exact `launches === budgets.length` premise. That premise was true when
   * it was written and it is not a property of the file: it broke the moment a budgeted case was
   * added that does not launch a browser (the `closeAllPages` controls above drive a stub HTTP
   * endpoint). The old form would have forced those cases to carry a 120s budget they can never
   * use, purely to keep a count balanced — padding a number to satisfy a guard, which is how a
   * guard stops meaning anything.
   *
   * So the association is measured instead of assumed: a case that launches a browser pays the
   * floor, and a case that does not, does not. The inner `}` of a nested closure is indented more
   * than two spaces, so `^ {2}\}` can only be the case's own.
   */
  const cases = [...source.matchAll(/^ {2}it\(([\s\S]*?)^ {2}\}(?:, (\d[\d_]*))?\);$/gm)].map(
    (match) => {
      const body = match[1] ?? '';
      return {
        body,
        // The case's own title, so a red names the case instead of leaving a reader to search the
        // file for whichever `it(` lost its budget. `body` begins immediately after `it(`, so the
        // first quoted run is the title.
        title: /^\s*(['"`])([\s\S]*?)\1/.exec(body)?.[2] ?? '(untitled)',
        budgetMs: match[2] === undefined ? undefined : Number(match[2].replace(/_/g, '')),
      };
    },
  );
  /**
   * The two markers, assembled from pieces so that the guard's own cases are not matched by the
   * guard's own detector.
   *
   * The corpus is this file, and these cases mention both call shapes in order to look for them —
   * so written as plain literals the detector matched itself, classified its own two cases as
   * browser cases, found them budgetless and went red. Measured, not foreseen: it is what the
   * first run of this rewrite reported.
   *
   * Splitting is safe rather than merely clever, because the failure is one-directional. If a
   * later edit reintroduces either literal here, these cases are classified as browser cases,
   * carry no budget, and the guard goes **red**. A self-match can cost a false alarm; it can
   * never produce a false green, which is the only direction that matters.
   *
   * The launch marker is `launchBrowser(` and not `launchBrowser({`. It was the latter, which
   * matched every call in the file it was written against and then matched **one of nine** after
   * the port literals were removed and the options object with them — and the guard said so,
   * `expected 1 to be greater than or equal to 8`, rather than quietly auditing a single case.
   * That is the anti-vacuity floor earning its place: the detector broke and the break was loud.
   */
  const LAUNCH_CALL = 'launchBrowser' + '(';
  const OPEN_CALL = 'openPage' + '(';

  const browserCases = cases.filter((c) => c.body.includes(LAUNCH_CALL));
  const budgets = cases.flatMap((c) => (c.budgetMs === undefined ? [] : [c.budgetMs]));

  it('has actually found the budgets, the launches and the page opens', () => {
    // Anti-vacuity, and it is the whole reason the check below means anything: a regex that stopped
    // matching would leave an empty list, and an empty list satisfies "every budget is big enough"
    // while auditing nothing. This is the failure mode this repository has hit more often than any
    // other, so the corpus is asserted before it is used.
    expect(cases.length).toBeGreaterThanOrEqual(12);
    expect(budgets.length).toBeGreaterThanOrEqual(8);
    expect(browserCases.length).toBeGreaterThanOrEqual(8);
    // The titles are what a red will name, so they are asserted rather than assumed. A broken title
    // regex would leave every message reading `case "(untitled)"` — still a red for the right
    // reason, but one that has stopped telling the reader which case, which is most of its value.
    expect(cases.filter((c) => c.title === '(untitled)')).toEqual([]);
    // The load-bearing premise, now stated per case rather than as a count: every case that
    // launches a browser declares a budget. A browser case with no budget silently takes vitest's
    // default, which is the shape that produced eight mute timeouts in run 30340124068.
    //
    // The count form this replaces — `launches >= budgets.length`, `opens >= budgets.length` —
    // needed a paragraph to explain why it was `>=` rather than `===`: one case deliberately
    // launches three browsers to reproduce the concurrency that made the focus race visible. Per
    // case, that stops being a special case at all. It is one browser case carrying one budget,
    // and it is admitted by the same rule as every other. The reason its floor is not tripled
    // still matters and is kept: its three launches run in `Promise.all`, so three hung launches
    // expire *together* at `LAUNCH_TIMEOUT_MS` rather than in series. A case that launched three
    // sequentially would need a budget of its own, and this guard would not catch that — stated
    // here because a limit a guard does not cover should be written down, not discovered.
    for (const browserCase of browserCases) {
      expect(
        browserCase.budgetMs,
        `case "${browserCase.title}" launches a browser and declares no budget`,
      ).toBeDefined();
    }
    // What must never happen is an open without a launch — a case borrowing a browser whose launch
    // nobody budgeted for. Checked within each case rather than by comparing two file-wide totals,
    // which could balance while being wrong in both directions at once.
    for (const testCase of cases) {
      if (testCase.body.includes(OPEN_CALL)) {
        expect(testCase.body).toContain(LAUNCH_CALL);
      }
    }
    expect(LAUNCH_TIMEOUT_MS + TRANSPORT_TIMEOUT_MS).toBeLessThan(FLOOR_MS);
  });

  it('gives every budgeted case room for the launch and the navigation it cannot avoid', () => {
    for (const browserCase of browserCases) {
      expect(
        browserCase.budgetMs,
        `case "${browserCase.title}" has a budget smaller than the deadlines it cannot avoid`,
      ).toBeGreaterThan(FLOOR_MS);
    }
    // Printed, not merely asserted, so a reader can see how much room is actually left rather than
    // learning only that some unstated inequality held.
    console.log(
      `[budgets] floor ${FLOOR_MS}ms (launch ${LAUNCH_TIMEOUT_MS} + reply ${TRANSPORT_TIMEOUT_MS} + ` +
        `commit ${NAVIGATION_TIMEOUT_MS} + focus ${FOCUS_TIMEOUT_MS}); browser-case budgets ` +
        `${browserCases.map((c) => c.budgetMs).join(', ')}; ` +
        `non-browser budgets ${cases
          .filter((c) => c.budgetMs !== undefined && !c.body.includes(LAUNCH_CALL))
          .map((c) => c.budgetMs)
          .join(', ')}`,
    );
  });

  it('the floor can actually fail — driven both ways with the numbers that produced the defect', () => {
    // Without this arm the check above is satisfied by a predicate that returns true for anything.
    // 60_000 is not an invented example: it is the budget both repaired cases really carried, and
    // 92_000 is the sum they really contained.
    const contains = (budget: number, floor: number): boolean => budget > floor;
    expect(contains(120_000, FLOOR_MS)).toBe(true);
    expect(contains(60_000, FLOOR_MS)).toBe(false);
    expect(FLOOR_MS).toBeGreaterThan(60_000);
  });

  it('keeps the transport deadline below the condition deadline, so a hang is still named', () => {
    // Ordering, not size. `until()` can only check its own deadline if each poll returns, so the
    // transport deadline has to be the one that fires first; if it were the larger of the two, a
    // hung command would once again outlive the condition wait and the failure would go back to
    // being anonymous. This is the property the whole change set turns on, so it is pinned.
    expect(TRANSPORT_TIMEOUT_MS).toBeLessThan(DEFAULT_UNTIL_TIMEOUT_MS);
  });
});
