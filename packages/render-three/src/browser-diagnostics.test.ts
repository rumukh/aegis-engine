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
import { describe, expect, it } from 'vitest';

import { closeAllPages, evaluate, launchBrowser, openPage, until } from './browser.js';

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
});
