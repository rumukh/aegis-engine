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
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  classifyEvent,
  closeAllPages,
  evaluate,
  launchBrowser,
  openPage,
  until,
} from './browser.js';

describe('a browser timeout explains itself', () => {
  it('names the page-side error when the page threw', async () => {
    const browser = await launchBrowser({ port: 9347 });
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
  }, 60_000);

  it('says so explicitly when the page is healthy and the condition simply never came true', async () => {
    const browser = await launchBrowser({ port: 9348 });
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
  }, 60_000);

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
    const browser = await launchBrowser({ port: 9349 });
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
    const browser = await launchBrowser({ port: 9350 });
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
    const browser = await launchBrowser({ port: 9353 });
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
    const browser = await launchBrowser({ port: 9354 });
    try {
      const cdp = await openPage(browser.port, 'about:blank');
      expect(await evaluate<string>(cdp, 'String(location.href)')).toBe('about:blank');
      cdp.close();
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
  // This case was intermittently red on `main`, and the reason is worth recording because the
  // obvious diagnosis is wrong. It is not two browsers contending for one OS foreground: measured
  // with four brought up concurrently, all four held focus at once. `Page.bringToFront` is
  // acknowledged by the browser process while `document.hasFocus()` is answered by the renderer,
  // and under load those moments are up to 213ms apart -- so the sample was early, not contended.
  //
  // The fix therefore belongs in `openPage`, which now waits for focus to arrive rather than for
  // the command to be accepted. This assertion is unchanged, and deliberately so: it was never
  // wrong. It was the only thing reporting a race that `capture.ts` still runs (it clicks for
  // pointer lock and waits 250ms -- a 37ms margin over that lag).
  it('hands back a focused page, which is what capabilities like pointer lock require', async () => {
    const browser = await launchBrowser({ port: 9355 });
    try {
      const cdp = await openPage(browser.port, 'about:blank');
      expect(await evaluate<boolean>(cdp, 'document.hasFocus()')).toBe(true);
      // Anti-vacuity for the assertion above: `hasFocus` on a page that was never rendered at all
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
  it('holds that guarantee when several browsers are coming up at once', async () => {
    const ports = [9356, 9357, 9358];
    const browsers = await Promise.all(ports.map((port) => launchBrowser({ port })));
    try {
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
