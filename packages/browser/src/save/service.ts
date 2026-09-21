import { BrowserServiceError, browserError } from '../errors.js';
import { exportSave, importSave, migrateSave } from './codec.js';
import type { SaveEnvelope, SaveMigration, SavePolicy } from './codec.js';
import type { SaveStorage } from './storage.js';
import { storageRevision } from './storage.js';

export interface SaveStatus {
  status: 'idle' | 'pending' | 'saved' | 'unavailable' | 'conflict' | 'failed';
  persistedRevision: number;
  pending: number;
  error?: BrowserServiceError;
}
export type SaveDraft<State, Resume> = Omit<SaveEnvelope<State, Resume>, 'revision'>;

/** No coalescing: every returned acknowledgement represents that exact persisted revision. */
export class SaveService<State, Resume> {
  private revision = 0;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private failure?: BrowserServiceError;
  private failedDraft?: SaveDraft<State, Resume>;
  private failedOperation?: symbol;
  private loaded = false;
  private changing = false;
  private generation = 0;
  private listeners = new Set<(status: SaveStatus) => void>();
  private current: SaveStatus = { status: 'idle', persistedRevision: 0, pending: 0 };

  constructor(
    readonly storage: SaveStorage,
    readonly policy: SavePolicy<State, Resume>,
  ) {}

  status(): SaveStatus {
    return { ...this.current };
  }
  /** Changes whenever the profile is explicitly loaded/reset; invalidates bridge deduplication. */
  epoch(): number {
    return this.generation;
  }
  /** An opaque operation identity binds retries to the write that actually reached storage. */
  ownsFailedWrite(operation: symbol): boolean {
    return this.failedDraft !== undefined && this.failedOperation === operation;
  }
  subscribe(listener: (status: SaveStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(status: SaveStatus['status'], error?: BrowserServiceError): void {
    this.current = {
      status,
      persistedRevision: this.revision,
      pending: this.pending,
      ...(error ? { error } : {}),
    };
    for (const listener of this.listeners) listener(this.status());
  }
  private fail(cause: unknown): BrowserServiceError {
    const error = browserError(cause, 'storage');
    this.failure = error;
    this.publish(
      error.code === 'unavailable'
        ? 'unavailable'
        : error.code === 'conflict'
          ? 'conflict'
          : 'failed',
      error,
    );
    return error;
  }

  async load(
    migrations: readonly SaveMigration[] = [],
  ): Promise<SaveEnvelope<State, Resume> | undefined> {
    if (this.pending || this.changing)
      throw new BrowserServiceError('blocked', 'Cannot load while storage operations are pending.');
    this.changing = true;
    this.generation++;
    try {
      const value = await this.storage.read(this.policy);
      const record = value.current;
      this.revision = storageRevision(value);
      this.loaded = true;
      const envelope = record ? migrateSave(record.payload, this.policy, migrations) : undefined;
      if (envelope && envelope.revision !== record!.revision)
        throw new BrowserServiceError('invalid-data', 'Envelope and stored revision differ.');
      this.failure = undefined;
      this.failedDraft = undefined;
      this.failedOperation = undefined;
      this.publish(record ? 'saved' : 'idle');
      return envelope;
    } catch (cause) {
      throw this.fail(cause);
    } finally {
      this.changing = false;
    }
  }

  /** Reading recovery never silently installs it or destroys the corrupt current record. */
  async recovery(
    migrations: readonly SaveMigration[] = [],
  ): Promise<SaveEnvelope<State, Resume> | undefined> {
    const history = await this.storage.read(this.policy);
    return history.previous
      ? migrateSave(history.previous.payload, this.policy, migrations)
      : undefined;
  }

  save(draft: SaveDraft<State, Resume>, operationId = Symbol('save-write')): Promise<number> {
    if (this.changing)
      return Promise.reject(new BrowserServiceError('blocked', 'A profile load/reset is pending.'));
    if (!this.loaded)
      return Promise.reject(new BrowserServiceError('blocked', 'Load the profile before writing.'));
    if (this.failure) return Promise.reject(this.failure);
    let detached: SaveDraft<State, Resume>;
    try {
      const { revision: _revision, ...value } = importSave(
        exportSave({ ...draft, revision: this.revision + 1 }, this.policy),
        this.policy,
      );
      detached = value;
    } catch (cause) {
      return Promise.reject(this.fail(cause));
    }
    this.pending++;
    this.publish('pending');
    const operation = this.tail
      .then(async () => {
        if (this.failure) throw this.failure;
        const revision = this.revision + 1;
        try {
          const payload = exportSave({ ...detached, revision }, this.policy);
          await this.storage.compareAndSwap(this.policy, this.revision, { revision, payload });
          this.revision = revision;
          return revision;
        } catch (cause) {
          this.failedDraft = detached;
          this.failedOperation = operationId;
          throw this.fail(cause);
        }
      })
      .finally(() => {
        this.pending--;
        if (!this.failure) this.publish(this.pending ? 'pending' : 'saved');
        else this.publish(this.current.status, this.failure);
      });
    // Rejections are returned to every caller; the internal queue must remain drainable.
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async flush(): Promise<number> {
    if (!this.loaded || this.changing)
      throw new BrowserServiceError('blocked', 'The profile is not loaded or is changing.');
    await this.tail;
    if (this.failure) throw this.failure;
    return this.revision;
  }

  /** Retry only the failed checkpoint. Later rejected checkpoints must be resubmitted by the host. */
  async retry(operationId?: symbol): Promise<number> {
    if (this.changing) throw new BrowserServiceError('blocked', 'A profile load/reset is pending.');
    await this.tail;
    if (
      !this.failedDraft ||
      this.failure?.code === 'conflict' ||
      (operationId !== undefined && this.failedOperation !== operationId)
    )
      throw new BrowserServiceError(
        'blocked',
        'No owned retryable checkpoint; foreign failures and conflicts require explicit recovery.',
      );
    const draft = this.failedDraft;
    const failedOperation = this.failedOperation;
    this.failure = undefined;
    this.failedDraft = undefined;
    this.failedOperation = undefined;
    return this.save(draft, failedOperation);
  }

  async reset(confirmation: { gameId: string; profileId: string }): Promise<void> {
    if (this.changing || !this.loaded)
      throw new BrowserServiceError('blocked', 'Cannot reset an unread or changing profile.');
    this.changing = true;
    try {
      await this.tail;
      await this.storage.reset(this.policy, this.revision, confirmation);
      this.revision++;
      this.failure = undefined;
      this.failedDraft = undefined;
      this.failedOperation = undefined;
      this.generation++;
      this.publish('idle');
    } catch (cause) {
      throw this.fail(cause);
    } finally {
      this.changing = false;
    }
  }
}
