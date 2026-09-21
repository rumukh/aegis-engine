import { failure, requireValue } from '@aegis/runtime';
import type { RuntimeHost } from '@aegis/runtime';

export function createCommandController<S, A, V, C>(
  host: RuntimeHost<S, A, V, C>,
  onError: (error: unknown) => void,
) {
  let generation = 0;
  let disposed = false;
  let failed = false;
  let continuation: Promise<void> | undefined;
  const ready = (): boolean => {
    const state = host.getStatus();
    return (
      !disposed &&
      !failed &&
      !state.disposed &&
      !state.busy &&
      state.pendingAction !== null &&
      state.pauseReasons.length === 0 &&
      state.checkpoint !== 'failed' &&
      state.checkpoint !== 'pending'
    );
  };
  const continueAccepted = (): Promise<void> => {
    if (continuation) return continuation;
    if (!ready()) return Promise.resolve();
    continuation = Promise.resolve()
      .then(async () => {
        if (!ready()) return;
        const result = await host.continuePending();
        if (!result.ok) failed = true;
        requireValue(result);
      })
      .finally(() => {
        continuation = undefined;
      });
    return continuation;
  };
  const unsubscribeView = host.subscribe((_view, reason) => {
    generation++;
    if (reason === 'restore') {
      failed = false;
    }
  });
  const unsubscribeStatus = host.subscribeStatus(() => {
    void continueAccepted().catch(onError);
  });
  void continueAccepted().catch(onError);
  return {
    capture(): (action: A) => Promise<void> {
      const revision = host.getStatus().revision;
      const epoch = generation;
      return async (action) => {
        if (disposed || epoch !== generation) {
          requireValue(failure('stale-action', 'This control belongs to a replaced session.'));
        }
        requireValue(await host.dispatch(action, { expectedRevision: revision }));
      };
    },
    async retry(): Promise<void> {
      failed = false;
      requireValue(await host.retryCheckpoint());
      await continueAccepted();
    },
    async resume(reason: string): Promise<void> {
      failed = false;
      host.resume(reason);
      await continueAccepted();
    },
    continueAccepted,
    dispose(): void {
      disposed = true;
      generation++;
      unsubscribeStatus();
      unsubscribeView();
    },
  };
}
