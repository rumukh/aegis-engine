import { BrowserServiceError, browserError, isRecord, requireInteger } from '../errors.js';
import { checkWrite, confirmReset, saveKey, storageRevision } from './storage.js';
import type { SaveHistory, SaveKey, SaveStorage, StoredSave } from './storage.js';

function history(value: unknown): SaveHistory {
  if (value === undefined) return {};
  if (!isRecord(value))
    throw new BrowserServiceError('invalid-data', 'Stored save history is corrupt.');
  const result: SaveHistory = {};
  if (value.revision !== undefined) {
    requireInteger(value.revision, 1, 'reset revision');
    result.revision = value.revision;
  }
  for (const field of ['current', 'previous'] as const) {
    const item = value[field];
    if (item === undefined) continue;
    if (!isRecord(item) || typeof item.payload !== 'string')
      throw new BrowserServiceError('invalid-data', 'Stored save record is corrupt.');
    requireInteger(item.revision, 1, 'stored revision');
    result[field] = { revision: item.revision, payload: item.payload };
  }
  if (result.previous && (!result.current || result.previous.revision >= result.current.revision))
    throw new BrowserServiceError('invalid-data', 'Stored recovery revision is corrupt.');
  if (
    result.revision !== undefined &&
    (result.current !== undefined || result.previous !== undefined)
  )
    throw new BrowserServiceError('invalid-data', 'Reset tombstone must not contain progress.');
  if (!result.current && result.revision === undefined)
    throw new BrowserServiceError('invalid-data', 'Stored save history has no revision.');
  return result;
}

/** One readwrite transaction owns the revision check, previous copy and replacement. */
export class IndexedDbSaveStorage implements SaveStorage {
  private database?: Promise<IDBDatabase>;
  private disposed = false;

  constructor(
    private readonly name = 'aegis-saves',
    private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
  ) {}

  private open(): Promise<IDBDatabase> {
    if (this.disposed)
      return Promise.reject(new BrowserServiceError('disposed', 'Save storage is closed.'));
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      if (!this.factory) {
        reject(new BrowserServiceError('unavailable', 'IndexedDB is unavailable.'));
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = this.factory.open(this.name, 1);
      } catch (cause) {
        reject(browserError(cause, 'unavailable'));
        return;
      }
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore('saves');
      request.onerror = () => reject(browserError(request.error, 'unavailable'));
      request.onblocked = () => {
        blocked = true;
        reject(
          new BrowserServiceError('unavailable', 'IndexedDB upgrade is blocked by another tab.'),
        );
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked || this.disposed) {
          db.close();
          reject(new BrowserServiceError('disposed', 'Save storage closed during open.'));
          return;
        }
        db.onversionchange = () => {
          db.close();
          this.database = undefined;
        };
        resolve(db);
      };
    }).catch((cause: unknown) => {
      this.database = undefined;
      throw cause;
    });
    return this.database;
  }

  private async transaction(
    key: SaveKey,
    mode: IDBTransactionMode,
    update?: (value: SaveHistory, store: IDBObjectStore, id: string) => void,
  ): Promise<SaveHistory> {
    const id = saveKey(key);
    const db = await this.open();
    if (this.disposed) throw new BrowserServiceError('disposed', 'Save storage is closed.');
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction('saves', mode, { durability: 'strict' });
      } catch (cause) {
        reject(browserError(cause, 'storage'));
        return;
      }
      let result: SaveHistory = {};
      let failure: unknown;
      transaction.onabort = () => reject(browserError(failure ?? transaction.error, 'storage'));
      transaction.onerror = () => {
        failure ??= transaction.error;
      };
      transaction.oncomplete = () => resolve(result);
      const store = transaction.objectStore('saves');
      const request = store.get(id);
      request.onsuccess = () => {
        try {
          result = history(request.result);
          update?.(result, store, id);
        } catch (cause) {
          failure = cause;
          transaction.abort();
        }
      };
    });
  }

  read(key: SaveKey): Promise<SaveHistory> {
    return this.transaction(key, 'readonly');
  }

  async compareAndSwap(key: SaveKey, expected: number, next: StoredSave): Promise<void> {
    checkWrite(expected, next);
    await this.transaction(key, 'readwrite', (value, store, id) => {
      if (storageRevision(value) !== expected)
        throw new BrowserServiceError('conflict', 'Another tab changed the save.');
      store.put({ current: next, ...(value.current ? { previous: value.current } : {}) }, id);
    });
  }

  async reset(key: SaveKey, expected: number, confirmation: SaveKey): Promise<void> {
    confirmReset(key, confirmation);
    requireInteger(expected, 0, 'expected revision');
    requireInteger(expected + 1, 1, 'reset revision');
    await this.transaction(key, 'readwrite', (value, store, id) => {
      if (storageRevision(value) !== expected)
        throw new BrowserServiceError('conflict', 'Another tab changed the save before reset.');
      store.put({ revision: expected + 1 }, id);
    });
  }

  async close(): Promise<void> {
    this.disposed = true;
    if (this.database) (await this.database).close();
  }
}
