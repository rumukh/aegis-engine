import { isRuntimeSnapshot, success } from '@aegis/runtime';
import type { Checkpoint, CheckpointWriter, Outcome, RuntimeSnapshot } from '@aegis/runtime';
import { BrowserServiceError, browserError } from '../errors.js';
import type { SaveDraft, SaveService } from './service.js';

export type CheckpointMetadata<Resume> = Omit<SaveDraft<RuntimeSnapshot, Resume>, 'state'>;

/**
 * The runtime owns the durability barrier. A failed checkpoint retry acknowledges the
 * retained write, rather than creating a second save or rerunning a logical action.
 */
export function createSaveCheckpoint<Resume>(
  service: SaveService<RuntimeSnapshot, Resume>,
  metadata: (checkpoint: Checkpoint) => CheckpointMetadata<Resume>,
): CheckpointWriter {
  let acknowledged: { identity: string; revision: number; storageRevision: number } | undefined;
  let failed: { identity: string; operation: symbol } | undefined;
  let active: { identity: string; promise: Promise<Outcome<void>> } | undefined;
  let epoch = service.epoch();
  const reject = (cause: unknown): Outcome<void> => {
    const error = browserError(cause, 'storage');
    return {
      ok: false,
      error: {
        code: error.code,
        messageKey: error.messageKey,
        diagnostics: [{ code: error.code, message: error.message }],
      },
    };
  };
  return (checkpoint) => {
    if (epoch !== service.epoch()) {
      epoch = service.epoch();
      acknowledged = undefined;
      failed = undefined;
    }
    if (
      !isRuntimeSnapshot(checkpoint.snapshot) ||
      checkpoint.snapshot.revision !== checkpoint.revision
    )
      return Promise.resolve(
        reject(
          new BrowserServiceError('invalid-data', 'Checkpoint revision or snapshot is invalid.'),
        ),
      );
    const identity = JSON.stringify([checkpoint.revision, checkpoint.hash, checkpoint.snapshot]);
    if (active)
      return active.identity === identity
        ? active.promise
        : Promise.resolve(
            reject(
              new BrowserServiceError(
                'blocked',
                'A different checkpoint is still awaiting durability.',
              ),
            ),
          );
    if (
      acknowledged?.identity === identity &&
      service.status().persistedRevision === acknowledged.storageRevision
    )
      return Promise.resolve(success(undefined));
    if (
      acknowledged &&
      checkpoint.revision <= acknowledged.revision &&
      checkpoint.kind !== 'restore'
    )
      return Promise.resolve(
        reject(
          new BrowserServiceError('conflict', 'Checkpoint revision is stale or changed identity.'),
        ),
      );
    if (failed && failed.identity !== identity)
      return Promise.resolve(
        reject(
          new BrowserServiceError(
            'blocked',
            'Retry the exact failed checkpoint before further progress.',
          ),
        ),
      );
    const operationId = failed?.operation ?? Symbol('runtime-checkpoint');
    const operation = async (): Promise<Outcome<void>> => {
      try {
        const declared = metadata(checkpoint);
        if (
          declared.contentRevision !== checkpoint.snapshot.content.revision ||
          declared.schemaVersion !== checkpoint.snapshot.stateVersion
        )
          throw new BrowserServiceError(
            'incompatible',
            'Checkpoint metadata must name the effective snapshot content and state schema.',
          );
        const storageRevision =
          failed?.identity === identity
            ? await service.retry(operationId)
            : await service.save({ ...declared, state: checkpoint.snapshot }, operationId);
        acknowledged = { identity, revision: checkpoint.revision, storageRevision };
        failed = undefined;
        return success(undefined);
      } catch (cause) {
        if (service.ownsFailedWrite(operationId)) failed = { identity, operation: operationId };
        else if (['failed', 'conflict', 'unavailable'].includes(service.status().status))
          return reject(
            new BrowserServiceError(
              'blocked',
              'The failed save belongs to a different operation; recover it explicitly.',
            ),
          );
        return reject(cause);
      } finally {
        active = undefined;
      }
    };
    const promise = Promise.resolve().then(operation);
    active = { identity, promise };
    return promise;
  };
}
