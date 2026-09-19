import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CdpDisconnectedError, CdpProtocolError } from './browser.js';
import type { CdpEventObserver } from './browser.js';
import { navigateAndWait } from './browser-navigation.js';

class Connection {
  readonly observers = new Set<CdpEventObserver>();
  send = vi.fn(async (method: string, _params?: object, _timeout?: number): Promise<unknown> =>
    method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main', loaderId: 'old' } } } : {},
  );
  observe(observer: CdpEventObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }
  emit(method: string, params: Record<string, unknown>): void {
    for (const observer of this.observers) observer.event(method, params);
  }
  disconnect(): CdpDisconnectedError {
    const error = new CdpDisconnectedError('target really closed');
    for (const observer of this.observers) observer.disconnected(error);
    this.observers.clear();
    return error;
  }
}

function context(cdp: Connection, frameId = 'main', isDefault = true, id = 7): void {
  cdp.emit('Runtime.executionContextCreated', { context: { id, auxData: { frameId, isDefault } } });
}
function committed(cdp: Connection, frameId = 'main', loaderId = 'new'): void {
  cdp.emit('Page.frameNavigated', {
    frame: { id: frameId, loaderId, url: 'http://local/reloaded' },
  });
}
function loaded(cdp: Connection, frameId = 'main', loaderId = 'new'): void {
  cdp.emit('Page.lifecycleEvent', { frameId, loaderId, name: 'load' });
}
function navigation(cdp: Connection, frameId = 'main', loaderId = 'new'): void {
  committed(cdp, frameId, loaderId);
  context(cdp, frameId);
  loaded(cdp, frameId, loaderId);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('explicit navigation boundary', () => {
  it('arms before a synchronous trigger and requires the new main document and its context', async () => {
    const cdp = new Connection();
    const result = await navigateAndWait(cdp, async () => {
      expect(cdp.observers.size).toBe(1);
      navigation(cdp);
    });
    expect(result).toEqual({
      frameId: 'main',
      loaderId: 'new',
      url: 'http://local/reloaded',
      executionContextId: 7,
    });
    expect(cdp.send.mock.calls.map(([method]) => method)).toEqual([
      'Page.enable',
      'Runtime.enable',
      'Page.setLifecycleEventsEnabled',
      'Page.getFrameTree',
    ]);
    expect(cdp.send.mock.calls.every(([, , budget]) => budget === 30_000)).toBe(true);
    expect(cdp.observers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['none', 'same-loader', 'iframe'] as const)(
    'rejects %s rather than treating it as a new main navigation',
    async (mode) => {
      const cdp = new Connection();
      const started = deferred();
      const operation = navigateAndWait(
        cdp,
        async () => {
          if (mode === 'same-loader') navigation(cdp, 'main', 'old');
          if (mode === 'iframe') navigation(cdp, 'child', 'new');
          started.resolve();
        },
        { timeoutMs: 1000 },
      );
      const rejected = expect(operation).rejects.toThrow(
        'Navigation did not complete within 1000ms',
      );
      await started.promise;
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(cdp.observers.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not use an old/isolated context or one cleared after the new document committed', async () => {
    const cdp = new Connection();
    const started = deferred();
    let settled = false;
    const operation = navigateAndWait(cdp, async () => {
      context(cdp);
      committed(cdp);
      context(cdp, 'child');
      context(cdp, 'main', false);
      context(cdp, 'main', true, 8);
      cdp.emit('Runtime.executionContextsCleared', {});
      loaded(cdp);
      started.resolve();
    });
    void operation.then(() => {
      settled = true;
    });
    await started.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    context(cdp, 'main', true, 9);
    expect((await operation).executionContextId).toBe(9);
  });

  it('allows the new default context between lifecycle init and frame commit', async () => {
    const cdp = new Connection();
    const operation = navigateAndWait(cdp, async () => {
      cdp.emit('Page.lifecycleEvent', { frameId: 'main', loaderId: 'new', name: 'init' });
      context(cdp);
      committed(cdp);
      loaded(cdp);
    });
    expect((await operation).loaderId).toBe('new');
    expect(cdp.observers.size).toBe(0);
  });

  it('propagates a genuine disconnect even after load while the trigger reply is pending', async () => {
    const cdp = new Connection();
    const started = deferred();
    const reply = deferred();
    const operation = navigateAndWait(cdp, async () => {
      navigation(cdp);
      started.resolve();
      await reply.promise;
    });
    await started.promise;
    const error = cdp.disconnect();
    await expect(operation).rejects.toBe(error);
    reply.resolve();
    expect(cdp.observers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    'cancels and cleans the waiter (abort before setup: %s)',
    async (before) => {
      const cdp = new Connection();
      const started = deferred();
      const controller = new AbortController();
      const reason = new Error('cancelled deliberately');
      if (before) controller.abort(reason);
      const trigger = vi.fn(async () => {
        started.resolve();
      });
      const operation = navigateAndWait(cdp, trigger, { signal: controller.signal });
      if (!before) {
        await started.promise;
        controller.abort(reason);
      }
      await expect(operation).rejects.toBe(reason);
      expect(cdp.observers.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      if (before) expect(trigger).not.toHaveBeenCalled();
    },
  );

  it('bounds setup itself and never triggers a navigation after the budget expires', async () => {
    const cdp = new Connection();
    const setup = deferred();
    cdp.send.mockImplementation(async () => {
      await setup.promise;
      return {};
    });
    const trigger = vi.fn(async () => {});
    const operation = navigateAndWait(cdp, trigger, { timeoutMs: 1000 });
    const rejected = expect(operation).rejects.toThrow('within 1000ms');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    setup.resolve();
    await Promise.resolve();
    expect(trigger).not.toHaveBeenCalled();
    expect(cdp.observers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts only the known pointer-reply race after full new-document proof and reports it', async () => {
    const cdp = new Connection();
    const operation = navigateAndWait(cdp, async () => {
      navigation(cdp);
      throw new CdpProtocolError(
        'Input.dispatchMouseEvent',
        'Inspected target navigated or closed',
        -32000,
      );
    });
    expect(await operation).toMatchObject({
      loaderId: 'new',
      replacedTriggerReply: {
        method: 'Input.dispatchMouseEvent',
        code: -32000,
        message: 'Inspected target navigated or closed',
      },
    });
  });

  it('does not accept that ambiguous pointer reply without navigation proof', async () => {
    const cdp = new Connection();
    const started = deferred();
    const operation = navigateAndWait(
      cdp,
      async () => {
        started.resolve();
        throw new CdpProtocolError(
          'Input.dispatchMouseEvent',
          'Inspected target navigated or closed',
          -32000,
        );
      },
      { timeoutMs: 1000 },
    );
    const rejected = expect(operation).rejects.toThrow('within 1000ms');
    await started.promise;
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(cdp.observers.size).toBe(0);
  });

  it.each([
    ['Runtime.evaluate', 'Inspected target navigated or closed', -32000],
    ['Input.dispatchMouseEvent', 'Inspected target navigated or closed', -32601],
    ['Input.dispatchMouseEvent', 'Unrelated failure', -32000],
  ] as const)('keeps other protocol errors fatal: %s %s %s', async (method, message, code) => {
    const cdp = new Connection();
    const error = new CdpProtocolError(method, message, code);
    await expect(
      navigateAndWait(cdp, async () => {
        navigation(cdp);
        throw error;
      }),
    ).rejects.toBe(error);
    expect(error.message).toContain(method);
    expect(error.message).toContain(String(code));
    expect(cdp.observers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, Infinity, 30_001])(
    'refuses invalid or extended budgets: %s',
    async (timeoutMs) => {
      const cdp = new Connection();
      await expect(navigateAndWait(cdp, async () => {}, { timeoutMs })).rejects.toThrow(
        /at most 30000ms/,
      );
      expect(cdp.send).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
