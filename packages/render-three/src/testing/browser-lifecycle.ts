import type { ChildProcess } from 'node:child_process';
import { CdpDisconnectedError, CdpSession } from '../browser.js';
import type { LaunchedBrowser } from '../browser.js';

export interface BrowserCloseEvent {
  at: number;
  phase: string;
  pid: number | undefined;
  detail?: unknown;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')
      return false;
    throw error;
  }
}

function exited(
  child: ChildProcess,
  trace: (phase: string, detail?: unknown) => void,
): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let expired = false;
    const finish = (code: number | null): void => {
      trace('root-exit-delivered', {
        code,
        signal: child.signalCode,
        elapsedMs: Date.now() - started,
      });
      if (expired) return;
      clearTimeout(timer);
      child.removeListener('exit', finish);
      child.removeListener('error', fail);
      resolve(code);
    };
    const fail = (error: Error): void => {
      clearTimeout(timer);
      child.removeListener('exit', finish);
      child.removeListener('error', fail);
      reject(error);
    };
    const timer = setTimeout(() => {
      expired = true;
      let osAlive: boolean | null = null;
      try {
        osAlive = child.pid === undefined ? null : alive(child.pid);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      trace('root-exit-deadline', {
        elapsedMs: Date.now() - started,
        osAlive,
        exitCode: child.exitCode,
      });
      // Diagnose queued exit delivery after poll, but never convert a missed deadline into success.
      setImmediate(() => {
        fail(
          new Error(
            `Owned browser process did not exit within 10000ms. PID ${child.pid ?? 'unknown'}; OS alive at deadline: ${osAlive}; delivered exit code after poll: ${child.exitCode}.`,
          ),
        );
      });
    }, 10_000);
    child.once('exit', finish);
    child.once('error', fail);
  });
}

/** End a test's owned browser process; navigation and tab-close acknowledgements are not cleanup. */
export async function closeOwnedBrowser(
  browser: LaunchedBrowser,
  options: {
    inspectProcesses?: boolean;
    onTrace?(event: BrowserCloseEvent): void;
  } = {},
): Promise<void> {
  let control: CdpSession | undefined;
  let failure: { error: unknown } | undefined;
  const events: BrowserCloseEvent[] = [];
  const trace = (phase: string, detail?: unknown): void => {
    const event = { at: Date.now(), phase, pid: browser.process.pid, detail };
    events.push(event);
    options.onTrace?.(event);
  };
  trace('begin', { profile: browser.profile, exitCode: browser.process.exitCode });
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
    const children =
      options.inspectProcesses === true
        ? (
            await control.send<{ processInfo: { id: number; type: string; cpuTime: number }[] }>(
              'SystemInfo.getProcessInfo',
            )
          ).processInfo
        : [];
    if (options.inspectProcesses === true) trace('browser-processes-before-close', children);
    const beganClose = Date.now();
    const stopped = exited(browser.process, trace);
    trace('close-command-sent');
    const command = control.send('Browser.close').then(
      () => trace('close-command-acknowledged'),
      (error: unknown) => {
        trace(
          'close-command-rejected',
          error instanceof Error ? { name: error.name, message: error.message } : String(error),
        );
        if (!(error instanceof CdpDisconnectedError)) throw error;
        // Browser.close may close its own socket before delivering the reply. Only a separately
        // observed clean root exit (below), not the disconnect, is proof of successful shutdown.
      },
    );
    const [code] = await Promise.all([stopped, command]);
    if (code !== 0) throw new Error(`Owned browser did not exit cleanly: ${code}.`);
    let live = children.filter((child) => child.id !== browser.process.pid && alive(child.id));
    while (live.length > 0 && Date.now() - beganClose < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      live = live.filter((child) => alive(child.id));
    }
    if (options.inspectProcesses === true)
      trace('child-process-drain', { elapsedMs: Date.now() - beganClose, live });
    if (live.length > 0)
      throw new Error(
        `Owned browser children did not exit within 10000ms: ${live.map((child) => child.id).join(', ')}.`,
      );
    trace('graceful-exit-confirmed');
  } catch (error) {
    failure = { error };
  } finally {
    control?.close();
  }
  if (browser.process.exitCode === null && browser.process.signalCode === null) {
    try {
      const stopped = exited(browser.process, trace);
      trace('force-kill-requested');
      browser.process.kill();
      await stopped;
    } catch (cleanup) {
      throw new AggregateError(
        failure === undefined ? [cleanup] : [failure.error, cleanup],
        `Owned browser shutdown and cleanup failed. Lifecycle: ${JSON.stringify(events)}`,
      );
    }
  }
  if (failure !== undefined) {
    if (failure.error instanceof Error)
      failure.error.message += ` Lifecycle: ${JSON.stringify(events)}`;
    throw failure.error;
  }
}
