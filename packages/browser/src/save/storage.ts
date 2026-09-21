import { BrowserServiceError, requireId, requireInteger } from '../errors.js';

export interface SaveKey {
  gameId: string;
  profileId: string;
}
export interface StoredSave {
  revision: number;
  payload: string;
}
export interface SaveHistory {
  current?: StoredSave;
  previous?: StoredSave;
  /** A reset keeps only this CAS tombstone, preventing stale-tab/ABA overwrites. */
  revision?: number;
}
export interface SaveStorage {
  read(key: SaveKey): Promise<SaveHistory>;
  compareAndSwap(key: SaveKey, expected: number, next: StoredSave): Promise<void>;
  reset(key: SaveKey, expected: number, confirmation: SaveKey): Promise<void>;
}

export function saveKey(key: SaveKey): string {
  requireId(key.gameId, 'gameId');
  requireId(key.profileId, 'profileId');
  return JSON.stringify([key.gameId, key.profileId]);
}

export function checkWrite(expected: number, next: StoredSave): void {
  requireInteger(expected, 0, 'expected revision');
  requireInteger(next.revision, 1, 'next revision');
  if (next.revision !== expected + 1 || typeof next.payload !== 'string')
    throw new BrowserServiceError(
      'invalid-data',
      'A save write must advance exactly one revision.',
    );
}

export function storageRevision(history: SaveHistory): number {
  return history.current?.revision ?? history.revision ?? 0;
}

export function confirmReset(key: SaveKey, confirmation: SaveKey): void {
  if (saveKey(key) !== saveKey(confirmation))
    throw new BrowserServiceError(
      'confirmation',
      'Reset requires the exact game/profile confirmation.',
    );
}

/** An instance represents one backing store; share it to model competing clients. */
export class MemorySaveStorage implements SaveStorage {
  private readonly records = new Map<string, SaveHistory>();

  async read(key: SaveKey): Promise<SaveHistory> {
    return structuredClone(this.records.get(saveKey(key)) ?? {});
  }

  async compareAndSwap(key: SaveKey, expected: number, next: StoredSave): Promise<void> {
    checkWrite(expected, next);
    const id = saveKey(key);
    const history = this.records.get(id) ?? {};
    const previous = history.current;
    if (storageRevision(history) !== expected)
      throw new BrowserServiceError('conflict', 'Another writer changed the save.');
    this.records.set(id, { current: { ...next }, ...(previous ? { previous } : {}) });
  }

  async reset(key: SaveKey, expected: number, confirmation: SaveKey): Promise<void> {
    confirmReset(key, confirmation);
    const id = saveKey(key);
    requireInteger(expected, 0, 'expected revision');
    requireInteger(expected + 1, 1, 'reset revision');
    if (storageRevision(this.records.get(id) ?? {}) !== expected)
      throw new BrowserServiceError('conflict', 'Another writer changed the save before reset.');
    this.records.set(id, { revision: expected + 1 });
  }
}
