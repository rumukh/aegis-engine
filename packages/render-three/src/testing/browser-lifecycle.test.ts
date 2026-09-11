import { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchedBrowser } from '../browser.js';
import { CdpSession } from '../browser.js';
import { closeOwnedBrowser, leavePage } from './browser-lifecycle.js';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  close: vi.fn(),
  until: vi.fn(),
}));
vi.mock('../browser.js', () => ({
  CdpSession: {
    connect: vi.fn(async () => ({ send: mocks.send, close: mocks.close })),
  },
  until: mocks.until,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockReset();
  mocks.until.mockResolvedValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            webSocketDebuggerUrl: 'ws://127.0.0.1/browser',
          }),
        ),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

class ProcessFixture extends ChildProcess {
  override exitCode: number | null = null;
}

function browser() {
  return {
    process: new ProcessFixture(),
    port: 12345,
    profile: 'owned-test-profile',
  } satisfies LaunchedBrowser;
}

describe('owned browser test lifetimes', () => {
  it('requires browser-level close and a clean process exit, not empty target enumeration', async () => {
    const own = browser();
    const kill = vi.spyOn(own.process, 'kill');
    mocks.send.mockImplementation(async () => {
      own.process.exitCode = 0;
      own.process.emit('exit', 0, null);
      return {};
    });
    await closeOwnedBrowser(own);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/json/version',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('Browser.close');
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
    expect(own.process.listenerCount('exit')).toBe(0);
    expect(own.process.listenerCount('error')).toBe(0);
  });

  it('does not turn a failed shutdown request into success after owned-process cleanup', async () => {
    const own = browser();
    mocks.send.mockRejectedValue(new Error('browser endpoint failed'));
    const kill = vi.spyOn(own.process, 'kill').mockImplementation(() => {
      own.process.exitCode = 1;
      own.process.emit('exit', 1, null);
      return true;
    });
    await expect(closeOwnedBrowser(own)).rejects.toThrow('browser endpoint failed');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(own.process.listenerCount('exit')).toBe(0);
  });

  it('refuses an already crashed browser rather than reporting a successful teardown', async () => {
    const own = browser();
    own.process.exitCode = 2;
    await expect(closeOwnedBrowser(own)).rejects.toThrow('exited unexpectedly: 2');
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('leaves the game document and confirms its globals are gone before disconnecting', async () => {
    mocks.send.mockResolvedValue({});
    const cdp = await CdpSession.connect('ws://test/page');
    await leavePage(cdp);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('Page.navigate', { url: 'about:blank' });
    expect(mocks.until).toHaveBeenCalledWith(
      cdp,
      "location.href === 'about:blank' && globalThis.aegis === undefined",
      expect.any(Function),
    );
    expect(mocks.close.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.until.mock.invocationCallOrder[0]!,
    );
  });

  it('still disconnects and surfaces a page that cannot navigate away', async () => {
    mocks.send.mockResolvedValue({ errorText: 'navigation refused' });
    const cdp = await CdpSession.connect('ws://test/page');
    await expect(leavePage(cdp)).rejects.toThrow('navigation refused');
    expect(mocks.until).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
