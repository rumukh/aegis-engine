import type { ChildProcess } from 'node:child_process';
import { CdpSession, until } from '../browser.js';
import type { LaunchedBrowser } from '../browser.js';

/** Destroy this game's document before reusing the dedicated test browser. */
export async function leavePage(cdp: CdpSession): Promise<void> {
  try {
    const navigation = await cdp.send<{ errorText?: string }>('Page.navigate', {
      url: 'about:blank',
    });
    if (navigation.errorText)
      throw new Error(`Could not leave the owned game page: ${navigation.errorText}`);
    await until(
      cdp,
      "location.href === 'about:blank' && globalThis.aegis === undefined",
      (left) => left === true,
    );
  } finally {
    cdp.close();
  }
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const finish = (code: number | null): void => {
      clearTimeout(timer);
      child.removeListener('error', fail);
      resolve(code);
    };
    const fail = (error: Error): void => {
      clearTimeout(timer);
      child.removeListener('exit', finish);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', finish);
      child.removeListener('error', fail);
      reject(new Error('Owned browser process did not exit within 10000ms.'));
    }, 10_000);
    child.once('exit', finish);
    child.once('error', fail);
  });
}

/** Quit the owned browser and prove process exit, rather than relying on tab-close endpoints. */
export async function closeOwnedBrowser(browser: LaunchedBrowser): Promise<void> {
  let control: CdpSession | undefined;
  let failure: { error: unknown } | undefined;
  try {
    if (browser.process.exitCode !== null || browser.process.signalCode !== null) {
      if (browser.process.exitCode !== 0)
        throw new Error(`Owned browser exited unexpectedly: ${browser.process.exitCode}.`);
      return;
    }
    const response = await fetch(`http://127.0.0.1:${browser.port}/json/version`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok)
      throw new Error(`Owned browser version endpoint returned ${response.status}.`);
    const version = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    if (typeof version.webSocketDebuggerUrl !== 'string')
      throw new Error('Owned browser did not provide its browser-level debugger endpoint.');
    control = await CdpSession.connect(version.webSocketDebuggerUrl);
    const [code] = await Promise.all([exited(browser.process), control.send('Browser.close')]);
    if (code !== 0) throw new Error(`Owned browser did not exit cleanly: ${code}.`);
  } catch (error) {
    failure = { error };
  } finally {
    control?.close();
  }
  if (browser.process.exitCode === null && browser.process.signalCode === null) {
    try {
      const stopped = exited(browser.process);
      browser.process.kill();
      await stopped;
    } catch (cleanup) {
      throw new AggregateError(
        failure === undefined ? [cleanup] : [failure.error, cleanup],
        'Owned browser shutdown and cleanup failed.',
      );
    }
  }
  if (failure !== undefined) throw failure.error;
}
