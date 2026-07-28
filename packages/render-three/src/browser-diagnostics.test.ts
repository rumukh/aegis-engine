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
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UNTIL_TIMEOUT_MS,
  LAUNCH_TIMEOUT_MS,
  NAVIGATION_TIMEOUT_MS,
  TRANSPORT_TIMEOUT_MS,
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
  }, 120_000);

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
    const browser = await launchBrowser({ port: 9356 });
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
      // assert which of "dead transport" or "starved browser" it is: this instrument cannot tell
      // them apart, and an earlier draft claimed "hung transport, not a slow page" — which was
      // measured wrong when a merely-starved `Page.navigate` exceeded the deadline on a loaded box
      // and was reported as a hang. Asserted here so the over-claim cannot come back.
      await expect(hung).rejects.toThrow(/does not distinguish a dead transport/);
      await expect(hung).rejects.toThrow(/after \d+ms/);
      await expect(hung).rejects.not.toThrow(/is a hung transport, not a slow page/);

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
  // The precondition `openPage` was relying on without ever stating, which is why breaking it cost
  // a gate rather than a line of output. Creating a target with `/json/new?<url>` activates the
  // tab; creating it blank and navigating does not, and an unfocused document is refused pointer
  // lock by Chrome with `WrongDocumentError`. Nothing said so, so `poc/capture.mjs` failed on fps
  // -- three PoCs deep, in a different package, with a message about mouse-look.
  //
  // Asserted here rather than inside `openPage` deliberately: only one page in a browser can hold
  // focus, so a caller that legitimately holds two open would redden on a rule it is not breaking.
  // This case controls that by opening exactly one. And the race below is not a production hazard,
  // which was checked rather than assumed: `client/input.ts:131` is the only `requestPointerLock`
  // in the repository and it fires on a pointer event, seconds after boot -- nothing reads focus
  // at the instant `openPage` returns except this assertion.
  it('hands back a focused page, which is what capabilities like pointer lock require', async () => {
    const browser = await launchBrowser({ port: 9355 });
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

  /** `launchBrowser` -> `openPage` (`Page.navigate` reply, then the commit wait). */
  const FLOOR_MS = LAUNCH_TIMEOUT_MS + TRANSPORT_TIMEOUT_MS + NAVIGATION_TIMEOUT_MS;

  const budgets = [...source.matchAll(/^ {2}\}, (\d[\d_]*)\);$/gm)].map((m) =>
    Number(m[1]!.replace(/_/g, '')),
  );
  const launches = source.match(/launchBrowser\(\{/g)?.length ?? 0;
  const opens = source.match(/openPage\(/g)?.length ?? 0;

  it('has actually found the budgets, the launches and the page opens', () => {
    // Anti-vacuity, and it is the whole reason the check below means anything: a regex that stopped
    // matching would leave an empty list, and an empty list satisfies "every budget is big enough"
    // while auditing nothing. This is the failure mode this repository has hit more often than any
    // other, so the corpus is asserted before it is used.
    expect(budgets.length).toBeGreaterThanOrEqual(8);
    expect(launches).toBeGreaterThanOrEqual(8);
    expect(opens).toBeGreaterThanOrEqual(8);
    // And the premise the floor rests on: every budgeted case pays for a launch and an open. If
    // someone adds a budgeted case that does neither, this stops being true and should be revisited
    // rather than silently over-applied.
    expect(launches).toBe(budgets.length);
    expect(opens).toBe(budgets.length);
  });

  it('gives every budgeted case room for the launch and the navigation it cannot avoid', () => {
    for (const budget of budgets) {
      expect(budget).toBeGreaterThan(FLOOR_MS);
    }
    // Printed, not merely asserted, so a reader can see how much room is actually left rather than
    // learning only that some unstated inequality held.
    // eslint-disable-next-line no-console
    console.log(
      `[budgets] floor ${FLOOR_MS}ms (launch ${LAUNCH_TIMEOUT_MS} + reply ${TRANSPORT_TIMEOUT_MS} + ` +
        `commit ${NAVIGATION_TIMEOUT_MS}); budgets ${budgets.join(', ')}`,
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
