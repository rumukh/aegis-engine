import { CdpDisconnectedError, CdpProtocolError, NAVIGATION_TIMEOUT_MS } from './browser.js';
import type { CdpEventObserver } from './browser.js';

export interface NavigationConnection {
  send(method: string, params?: object, timeoutMs?: number): Promise<unknown>;
  observe(observer: CdpEventObserver): () => void;
}

export interface NavigationResult {
  frameId: string;
  loaderId: string;
  url: string;
  executionContextId: number;
  replacedTriggerReply?: { method: string; code: number; message: string };
}

export interface NavigationOptions {
  /** One budget up to 30s for setup, trigger and navigation, shared with caller readiness. */
  timeoutMs?: number;
  /** Cancels the waiter, not a navigation the browser has already started. */
  signal?: AbortSignal;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointerReplyReplacedByNavigation(
  error: unknown,
): error is CdpProtocolError & { code: -32000 } {
  return (
    error instanceof CdpProtocolError &&
    error.method === 'Input.dispatchMouseEvent' &&
    error.code === -32000 &&
    error.protocolMessage === 'Inspected target navigated or closed'
  );
}

/**
 * Arm before an explicit reload/click; require a different main-document loader, its load event
 * and a default execution context created for that document. No Runtime.evaluate polling or retry.
 */
export function navigateAndWait(
  cdp: NavigationConnection,
  trigger: () => Promise<unknown>,
  options: NavigationOptions = {},
): Promise<NavigationResult> {
  const timeoutMs = options.timeoutMs ?? NAVIGATION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > NAVIGATION_TIMEOUT_MS)
    return Promise.reject(
      new Error(
        `[cdp] Navigation timeout must be positive and at most ${NAVIGATION_TIMEOUT_MS}ms.`,
      ),
    );
  return new Promise<NavigationResult>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let dispose = (): void => {};
    let finished = false;
    let frameId: string | undefined;
    let oldLoader: string | undefined;
    let loaderId: string | undefined;
    let url: string | undefined;
    let contextId: number | undefined;
    let loaded = false;
    let triggerDone = false;
    let replacedReply: (CdpProtocolError & { code: -32000 }) | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', aborted);
      dispose();
    };
    const fail = (error: unknown): void => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const timedOut = (): Error =>
      new Error(
        `[cdp] Navigation did not complete within ${timeoutMs}ms: ${JSON.stringify({
          frameId,
          oldLoader,
          loaderId,
          loaded,
          contextId,
          triggerDone,
        })}`,
        replacedReply === undefined ? undefined : { cause: replacedReply },
      );
    const timer = setTimeout(() => fail(timedOut()), timeoutMs);
    const aborted = (): void =>
      fail(options.signal?.reason ?? new Error('[cdp] Navigation cancelled.'));
    const complete = (): void => {
      if (
        finished ||
        !triggerDone ||
        !loaded ||
        frameId === undefined ||
        loaderId === undefined ||
        url === undefined ||
        contextId === undefined
      )
        return;
      finished = true;
      cleanup();
      resolve({
        frameId,
        loaderId,
        url,
        executionContextId: contextId,
        ...(replacedReply === undefined
          ? {}
          : {
              replacedTriggerReply: {
                method: replacedReply.method,
                code: replacedReply.code,
                message: replacedReply.protocolMessage,
              },
            }),
      });
    };
    const nextLoader = (value: unknown): void => {
      if (typeof value !== 'string' || value === oldLoader || value === loaderId) return;
      loaderId = value;
      url = undefined;
      contextId = undefined;
      loaded = false;
    };
    const observer: CdpEventObserver = {
      disconnected: fail,
      event(method, params): void {
        if (finished) return;
        if (method === 'Inspector.detached' || method === 'Inspector.targetCrashed') {
          fail(new CdpDisconnectedError(`[cdp] ${method} while awaiting navigation.`));
          return;
        }
        if (method === 'Page.frameNavigated') {
          const frame = params['frame'];
          if (record(frame) && frame['id'] === frameId && frame['loaderId'] !== oldLoader) {
            nextLoader(frame['loaderId']);
            if (typeof frame['url'] === 'string') url = frame['url'];
          }
        } else if (method === 'Page.lifecycleEvent' && params['frameId'] === frameId) {
          if (params['name'] === 'init') nextLoader(params['loaderId']);
          if (
            params['name'] === 'load' &&
            loaderId !== undefined &&
            params['loaderId'] === loaderId
          )
            loaded = true;
        } else if (method === 'Runtime.executionContextsCleared') {
          contextId = undefined;
        } else if (
          method === 'Runtime.executionContextDestroyed' &&
          params['executionContextId'] === contextId
        ) {
          contextId = undefined;
        } else if (method === 'Runtime.executionContextCreated' && loaderId !== undefined) {
          const context = params['context'];
          const auxiliary = record(context) ? context['auxData'] : undefined;
          if (
            record(context) &&
            record(auxiliary) &&
            auxiliary['frameId'] === frameId &&
            auxiliary['isDefault'] === true &&
            typeof context['id'] === 'number' &&
            Number.isSafeInteger(context['id'])
          )
            contextId = context['id'];
        }
        complete();
      },
    };
    const send = (method: string, params?: object): Promise<unknown> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Promise.reject(timedOut());
      return cdp.send(method, params, remaining);
    };
    const setup = async (): Promise<void> => {
      if (options.signal?.aborted === true) {
        aborted();
        return;
      }
      options.signal?.addEventListener('abort', aborted, { once: true });
      for (const [method, params] of [
        ['Page.enable', undefined],
        ['Runtime.enable', undefined],
        ['Page.setLifecycleEventsEnabled', { enabled: true }],
      ] as const) {
        await send(method, params);
        if (finished) return;
      }
      const tree = await send('Page.getFrameTree');
      if (finished) return;
      const frameTree = record(tree) ? tree['frameTree'] : undefined;
      const frame = record(frameTree) ? frameTree['frame'] : undefined;
      if (
        !record(frame) ||
        typeof frame['id'] !== 'string' ||
        typeof frame['loaderId'] !== 'string'
      )
        throw new Error('[cdp] Page.getFrameTree did not provide the main frame and loader IDs.');
      frameId = frame['id'];
      oldLoader = frame['loaderId'];
      dispose = cdp.observe(observer);
      if (finished) {
        dispose();
        return;
      }
      try {
        await trigger();
      } catch (error) {
        if (!pointerReplyReplacedByNavigation(error)) throw error;
        replacedReply = error;
      }
      triggerDone = true;
      complete();
    };
    void setup().catch(fail);
  });
}
