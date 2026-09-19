import { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchedBrowser } from '../browser.js';
import { CdpDisconnectedError } from '../browser.js';
import { closeOwnedBrowser } from './browser-lifecycle.js';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../browser.js', () => ({
  CdpDisconnectedError: class extends Error {},
  CdpSession: {
    connect: vi.fn(async () => ({ send: mocks.send, close: mocks.close })),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockReset();
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
  vi.useRealTimers();
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
  it('accepts an expected close-socket disconnect only alongside a separately observed clean exit', async () => {
    const own = browser();
    const kill = vi.spyOn(own.process, 'kill');
    const events: string[] = [];
    mocks.send.mockImplementation(async () => {
      queueMicrotask(() => {
        own.process.exitCode = 0;
        own.process.emit('exit', 0, null);
      });
      throw new CdpDisconnectedError('socket closed before Browser.close reply');
    });
    await closeOwnedBrowser(own, { onTrace: (event) => events.push(event.phase) });
    expect(events).toContain('close-command-rejected');
    expect(events).toContain('root-exit-delivered');
    expect(events).toContain('graceful-exit-confirmed');
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not accept a disconnect without root exit or call force-kill cleanup graceful', async () => {
    vi.useFakeTimers();
    const own = browser();
    const events: string[] = [];
    mocks.send.mockRejectedValue(new CdpDisconnectedError('socket closed'));
    vi.spyOn(own.process, 'kill').mockImplementation(() => {
      own.process.exitCode = 1;
      own.process.emit('exit', 1, null);
      return true;
    });
    const closed = expect(
      closeOwnedBrowser(own, { onTrace: (event) => events.push(event.phase) }),
    ).rejects.toThrow('did not exit within 10000ms');
    await vi.advanceTimersByTimeAsync(10_010);
    await closed;
    expect(events).toContain('force-kill-requested');
    expect(events).not.toContain('graceful-exit-confirmed');
  });

  it('records late exit delivery without converting a missed deadline into a pass', async () => {
    vi.useFakeTimers();
    const own = browser();
    const kill = vi.spyOn(own.process, 'kill');
    mocks.send.mockResolvedValue({});
    const closed = expect(
      closeOwnedBrowser(own, {
        onTrace: (event) => {
          if (event.phase === 'root-exit-deadline') {
            own.process.exitCode = 0;
            own.process.emit('exit', 0, null);
          }
        },
      }),
    ).rejects.toThrow('delivered exit code after poll: 0');
    await vi.advanceTimersByTimeAsync(10_010);
    await closed;
    expect(kill).not.toHaveBeenCalled();
  });

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

  it('closes each fresh browser through its own endpoint without retaining the previous process', async () => {
    const first = browser();
    const second = { ...browser(), port: 23456 };
    for (const owned of [first, second]) {
      mocks.send.mockImplementationOnce(async () => {
        owned.process.exitCode = 0;
        owned.process.emit('exit', 0, null);
        return {};
      });
      await closeOwnedBrowser(owned);
      expect(owned.process.listenerCount('exit')).toBe(0);
      expect(owned.process.listenerCount('error')).toBe(0);
    }
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:12345/json/version',
      'http://127.0.0.1:23456/json/version',
    ]);
    expect(mocks.send.mock.calls).toEqual([['Browser.close'], ['Browser.close']]);
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it('does not accept a close acknowledgement as proof that the process exited', async () => {
    vi.useFakeTimers();
    const own = browser();
    mocks.send.mockResolvedValue({});
    const kill = vi.spyOn(own.process, 'kill').mockImplementation(() => {
      own.process.exitCode = 1;
      own.process.emit('exit', 1, null);
      return true;
    });
    const closed = expect(closeOwnedBrowser(own)).rejects.toThrow(
      'Owned browser process did not exit within 10000ms.',
    );
    await vi.advanceTimersByTimeAsync(10_001);
    await closed;
    expect(kill).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(own.process.listenerCount('exit')).toBe(0);
    expect(own.process.listenerCount('error')).toBe(0);
  });
});
