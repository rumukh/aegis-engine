import { setImmediate } from 'node:timers';
import { describe, expect, it, vi } from 'vitest';
import { yieldWorkerIO } from './support/yield-worker-io.js';

const nativeImmediate = setImmediate;

describe('cooperative worker I/O boundary', () => {
  it('delivers queued native callbacks before the next synchronous test can monopolize the worker', async () => {
    let delivered = false;
    nativeImmediate(() => {
      delivered = true;
    });
    expect(delivered).toBe(false);
    await yieldWorkerIO();
    expect(delivered).toBe(true);
  });

  it('a resolved promise alone does not provide the native I/O turn (negative control)', async () => {
    let delivered = false;
    nativeImmediate(() => {
      delivered = true;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);
    await yieldWorkerIO();
    expect(delivered).toBe(true);
  });

  it('does not rely on a test advancing or restoring its fake timers', async () => {
    vi.useFakeTimers();
    try {
      let delivered = false;
      nativeImmediate(() => {
        delivered = true;
      });
      await yieldWorkerIO();
      expect(delivered).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
