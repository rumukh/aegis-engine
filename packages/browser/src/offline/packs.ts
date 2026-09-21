import {
  BrowserServiceError,
  browserError,
  isRecord,
  requireId,
  requireInteger,
} from '../errors.js';
import { localAssetUrl, readBoundedResponse, RequestPool } from '../io.js';
import { parseBoundedJson } from '../save/codec.js';
import { createInstallationRequest } from './network.js';

export interface OfflineResource {
  id: string;
  src: string;
  bytes: number;
  sha256: string;
  kind: 'shell' | 'script' | 'image' | 'audio' | 'font' | 'locale' | 'data' | 'style';
}
export interface OfflinePack {
  id: string;
  revision: string;
  resources: readonly OfflineResource[];
}
export interface OfflinePackRef {
  id: string;
  revision: string;
}
export interface PackStatus {
  status: 'installing' | 'ready' | 'unavailable' | 'failed';
  pack: OfflinePackRef;
  completed: number;
  total: number;
  error?: BrowserServiceError;
}
export interface OfflineOptions {
  namespace: string;
  baseUrl: string;
  caches?: CacheStorage;
  fetch?: typeof fetch;
  crypto?: Crypto;
  locks?: Pick<LockManager, 'request'>;
  maxRequests?: number;
  maxFileBytes?: number;
  maxPackBytes?: number;
  onStatus?(status: PackStatus): void;
}
interface InstalledRecord {
  manifest: OfflinePack;
  cacheName: string;
}

export function validateOfflinePack(
  input: unknown,
  baseUrl: string,
  maxFile = 32 * 1024 * 1024,
  maxPack = 64 * 1024 * 1024,
): OfflinePack {
  if (
    !isRecord(input) ||
    !Array.isArray(input.resources) ||
    !input.resources.length ||
    input.resources.length > 4096
  )
    throw new BrowserServiceError(
      'invalid-data',
      'Offline pack needs a bounded nonempty resource graph.',
    );
  requireId(input.id);
  requireId(input.revision);
  const base = new URL(baseUrl);
  if (!base.pathname.endsWith('/'))
    throw new BrowserServiceError('invalid-data', 'Offline base URL must end with a slash.');
  const ids = new Set<string>();
  const urls = new Set<string>();
  const resources: OfflineResource[] = [];
  let total = 0;
  for (const item of input.resources) {
    if (!isRecord(item)) throw new BrowserServiceError('invalid-data', 'Invalid offline resource.');
    requireId(item.id);
    requireInteger(item.bytes, 1, 'resource bytes');
    if (
      typeof item.src !== 'string' ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new BrowserServiceError(
        'invalid-data',
        'Offline resource requires a SHA-256 digest and declared kind.',
      );
    const kind = item.kind;
    if (
      kind !== 'shell' &&
      kind !== 'script' &&
      kind !== 'image' &&
      kind !== 'audio' &&
      kind !== 'font' &&
      kind !== 'locale' &&
      kind !== 'data' &&
      kind !== 'style'
    )
      throw new BrowserServiceError('invalid-data', 'Offline resource has an unknown kind.');
    const url = localAssetUrl(item.src, baseUrl);
    if (
      !url.pathname.startsWith(base.pathname) ||
      url.search ||
      ids.has(item.id) ||
      urls.has(url.href)
    )
      throw new BrowserServiceError(
        'asset',
        'Offline resources must be unique and within the deployment base path.',
      );
    ids.add(item.id);
    urls.add(url.href);
    total += item.bytes;
    if (item.bytes > maxFile || total > maxPack)
      throw new BrowserServiceError('limit', 'Offline pack exceeds byte budgets.');
    resources.push({ id: item.id, src: item.src, bytes: item.bytes, sha256: item.sha256, kind });
  }
  return { id: input.id, revision: input.revision, resources };
}

export async function sha256(
  bytes: ArrayBuffer,
  crypto: Pick<Crypto, 'subtle'> = globalThis.crypto,
): Promise<string> {
  if (!crypto?.subtle)
    throw new BrowserServiceError('unavailable', 'Secure-context digest support is unavailable.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/** Cache catalog publication is the commit marker; staging caches never count as installed. */
export class OfflinePackStore {
  private readonly storage: CacheStorage | undefined;
  private readonly crypto: Crypto;
  private readonly pool: RequestPool;
  private readonly holds = new Map<string, number>();
  private readonly lifecycle = new Map<string, 'activating' | 'removing'>();
  private readonly installs = new Map<string, { graph: string; promise: Promise<void> }>();
  private readonly catalogName: string;
  private readonly prefix: string;
  private readonly maxFile: number;
  private readonly maxPack: number;
  private active?: OfflinePackRef;

  constructor(readonly options: OfflineOptions) {
    requireId(options.namespace, 'offline namespace');
    localAssetUrl('.', options.baseUrl);
    this.storage = options.caches ?? globalThis.caches;
    this.crypto = options.crypto ?? globalThis.crypto;
    this.pool = new RequestPool(options.maxRequests ?? 4);
    this.prefix = `aegis:${options.namespace}:`;
    this.catalogName = `${this.prefix}catalog`;
    this.maxFile = options.maxFileBytes ?? 32 * 1024 * 1024;
    this.maxPack = options.maxPackBytes ?? 64 * 1024 * 1024;
  }
  private key(ref: OfflinePackRef): string {
    requireId(ref.id);
    requireId(ref.revision);
    return new URL(
      `.aegis/${this.options.namespace}/${ref.id}/${ref.revision}`,
      this.options.baseUrl,
    ).href;
  }
  private caches(): CacheStorage {
    if (!this.storage) throw new BrowserServiceError('unavailable', 'CacheStorage is unavailable.');
    return this.storage;
  }
  private async revisionLock<T>(
    key: string,
    mode: LockMode,
    ifAvailable: boolean,
    work: () => Promise<T>,
  ): Promise<T> {
    const locks = this.options.locks ?? globalThis.navigator?.locks;
    if (!locks)
      throw new BrowserServiceError('unavailable', 'Pack lifecycle operations require Web Locks.');
    return await locks.request(
      `${this.prefix}revision:${key}`,
      { mode, ifAvailable },
      async (lock) => {
        if (!lock)
          throw new BrowserServiceError(
            'blocked',
            'The content revision is in use by another operation.',
          );
        return work();
      },
    );
  }
  private async record(ref: OfflinePackRef): Promise<InstalledRecord | undefined> {
    const cache = await this.caches().open(this.catalogName);
    const response = await cache.match(this.key(ref));
    if (!response) return undefined;
    const value = parseBoundedJson(await response.text(), 2 * 1024 * 1024);
    if (
      !isRecord(value) ||
      typeof value.cacheName !== 'string' ||
      !value.cacheName.startsWith(`${this.prefix}pack:`)
    )
      throw new BrowserServiceError('invalid-data', 'Offline catalog is corrupt.');
    const manifest = validateOfflinePack(
      value.manifest,
      this.options.baseUrl,
      this.maxFile,
      this.maxPack,
    );
    if (manifest.id !== ref.id || manifest.revision !== ref.revision)
      throw new BrowserServiceError('invalid-data', 'Offline catalog identity mismatch.');
    return { manifest, cacheName: value.cacheName };
  }
  private async verify(resource: OfflineResource, response: Response): Promise<ArrayBuffer> {
    const bytes = await readBoundedResponse(response, resource.bytes);
    if (
      bytes.byteLength !== resource.bytes ||
      (await sha256(bytes, this.crypto)) !== resource.sha256
    )
      throw new BrowserServiceError('asset', 'Offline resource size or digest mismatch.');
    return bytes;
  }

  async inspect(ref: OfflinePackRef): Promise<OfflinePack | undefined> {
    const record = await this.record(ref);
    if (!record) return undefined;
    if (!(await this.caches().has(record.cacheName)))
      throw new BrowserServiceError('asset', 'An installed pack was evicted.');
    const cache = await this.caches().open(record.cacheName);
    await Promise.all(
      record.manifest.resources.map((resource) =>
        this.pool.run(async () => {
          const response = await cache.match(
            localAssetUrl(resource.src, this.options.baseUrl).href,
          );
          if (!response)
            throw new BrowserServiceError('asset', 'An installed resource is missing.');
          await this.verify(resource, response);
        }),
      ),
    );
    return record.manifest;
  }

  async list(): Promise<OfflinePackRef[]> {
    const catalog = await this.caches().open(this.catalogName);
    const refs: OfflinePackRef[] = [];
    for (const request of await catalog.keys()) {
      const segments = new URL(request.url).pathname.split('/');
      const revision = segments.pop()!;
      const id = segments.pop()!;
      const ref = { id, revision };
      if (await this.inspect(ref)) refs.push(ref);
    }
    return refs;
  }

  install(input: OfflinePack, signal?: AbortSignal): Promise<void> {
    const manifest = validateOfflinePack(input, this.options.baseUrl, this.maxFile, this.maxPack);
    const key = this.key(manifest);
    const graph = JSON.stringify(manifest);
    const pending = this.installs.get(key);
    if (pending) {
      if (pending.graph !== graph)
        return Promise.reject(
          new BrowserServiceError('conflict', 'One revision cannot name two resource graphs.'),
        );
      return pending.promise;
    }
    const locks = this.options.locks ?? globalThis.navigator?.locks;
    if (!locks) {
      const error = new BrowserServiceError(
        'unavailable',
        'Offline installation requires Web Locks for cross-tab atomic publication.',
      );
      this.options.onStatus?.({
        status: 'unavailable',
        pack: manifest,
        completed: 0,
        total: manifest.resources.length,
        error,
      });
      return Promise.reject(error);
    }
    const operation = this.revisionLock(key, 'exclusive', false, () =>
      this.installPack(manifest, signal),
    ).finally(() => {
      this.installs.delete(key);
    });
    this.installs.set(key, { graph, promise: operation });
    return operation;
  }
  private async installPack(manifest: OfflinePack, signal?: AbortSignal): Promise<void> {
    let staging: string | undefined;
    let completed = 0;
    const publish = (status: PackStatus['status'], error?: BrowserServiceError): void =>
      this.options.onStatus?.({
        status,
        pack: { id: manifest.id, revision: manifest.revision },
        completed,
        total: manifest.resources.length,
        ...(error ? { error } : {}),
      });
    try {
      const existing = await this.record(manifest);
      if (existing) {
        if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest))
          throw new BrowserServiceError(
            'conflict',
            'Installed revision has a different resource graph.',
          );
        await this.inspect(manifest);
        completed = manifest.resources.length;
        publish('ready');
        return;
      }
      if (!this.crypto?.randomUUID)
        throw new BrowserServiceError(
          'unavailable',
          'Secure-context installation support is unavailable.',
        );
      staging = `${this.prefix}pack:${manifest.id}:${manifest.revision}:${this.crypto.randomUUID()}`;
      const cache = await this.caches().open(staging);
      publish('installing');
      const abort = new AbortController();
      const forward = (): void => abort.abort();
      signal?.addEventListener('abort', forward, { once: true });
      if (signal?.aborted) abort.abort();
      try {
        const outcomes = await Promise.allSettled(
          manifest.resources.map((resource) =>
            this.pool.run(async () => {
              if (abort.signal.aborted)
                throw new BrowserServiceError('cancelled', 'Offline installation was interrupted.');
              try {
                const url = localAssetUrl(resource.src, this.options.baseUrl);
                const response = await (this.options.fetch ?? globalThis.fetch)(
                  createInstallationRequest(url.href, this.options.baseUrl, abort.signal),
                );
                const bytes = await this.verify(resource, response.clone());
                if (abort.signal.aborted)
                  throw new BrowserServiceError(
                    'cancelled',
                    'Offline installation was interrupted.',
                  );
                const headers = new Headers(response.headers);
                headers.delete('content-encoding');
                headers.set('content-length', String(bytes.byteLength));
                await cache.put(url.href, new Response(bytes, { headers }));
                completed++;
                publish('installing');
              } catch (cause) {
                abort.abort();
                throw cause;
              }
            }),
          ),
        );
        const failed = outcomes.find((outcome) => outcome.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        if (abort.signal.aborted)
          throw new BrowserServiceError('cancelled', 'Offline installation was interrupted.');
      } finally {
        signal?.removeEventListener('abort', forward);
      }
      const catalog = await this.caches().open(this.catalogName);
      const record: InstalledRecord = { manifest, cacheName: staging };
      await catalog.put(
        this.key(manifest),
        new Response(JSON.stringify(record), { headers: { 'content-type': 'application/json' } }),
      );
      staging = undefined;
      publish('ready');
    } catch (cause) {
      let error = signal?.aborted
        ? new BrowserServiceError('cancelled', 'Offline installation was interrupted.', { cause })
        : browserError(cause, 'storage');
      if (staging) {
        try {
          await this.caches().delete(staging);
        } catch (cleanup) {
          error = new BrowserServiceError('storage', 'Installation and staging cleanup failed.', {
            cause: new AggregateError([cause, cleanup]),
          });
        }
      }
      publish(error.code === 'unavailable' ? 'unavailable' : 'failed', error);
      throw error;
    }
  }

  /** Retain all revisions referenced by active sessions/saves before explicit removal. */
  retain(ref: OfflinePackRef): () => void {
    const key = this.key(ref);
    if (this.lifecycle.get(key) === 'removing')
      throw new BrowserServiceError(
        'blocked',
        'Cannot retain a content revision while removal is pending.',
      );
    this.holds.set(key, (this.holds.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.holds.get(key)! - 1;
      if (count) this.holds.set(key, count);
      else this.holds.delete(key);
    };
  }
  async activate(
    ref: OfflinePackRef,
    accepts: (pack: OfflinePack) => boolean,
    safeBoundary: boolean,
  ): Promise<void> {
    if (!safeBoundary)
      throw new BrowserServiceError(
        'blocked',
        'Pack activation requires a consumer-declared safe boundary.',
      );
    const key = this.key(ref);
    if (this.lifecycle.has(key))
      throw new BrowserServiceError(
        'blocked',
        'The content revision has a pending lifecycle operation.',
      );
    this.lifecycle.set(key, 'activating');
    try {
      await this.revisionLock(key, 'shared', false, async () => {
        const manifest = await this.inspect(ref);
        if (!manifest || !accepts(manifest))
          throw new BrowserServiceError(
            'incompatible',
            'Installed content is incompatible with the current save.',
          );
        this.active = { ...ref };
      });
    } finally {
      this.lifecycle.delete(key);
    }
  }
  activePack(): OfflinePackRef | undefined {
    return this.active ? { ...this.active } : undefined;
  }

  async remove(ref: OfflinePackRef, confirmation: OfflinePackRef): Promise<void> {
    const key = this.key(ref);
    if (key !== this.key(confirmation))
      throw new BrowserServiceError(
        'confirmation',
        'Removal requires the exact pack/revision confirmation.',
      );
    if (
      this.lifecycle.has(key) ||
      this.holds.has(key) ||
      (this.active && key === this.key(this.active))
    )
      throw new BrowserServiceError(
        'blocked',
        'An active or retained content revision cannot be removed.',
      );
    this.lifecycle.set(key, 'removing');
    try {
      await this.revisionLock(key, 'exclusive', true, async () => {
        const record = await this.record(ref);
        if (!record) throw new BrowserServiceError('asset', 'Pack is not installed.');
        const catalog = await this.caches().open(this.catalogName);
        await catalog.delete(key);
        await this.caches().delete(record.cacheName);
      });
    } finally {
      this.lifecycle.delete(key);
    }
  }

  async response(ref: OfflinePackRef, request: Request): Promise<Response | undefined> {
    const record = await this.record(ref);
    if (!record) return undefined;
    const resource = record.manifest.resources.find(
      (item) => localAssetUrl(item.src, this.options.baseUrl).href === request.url,
    );
    if (!resource) return undefined;
    const response = await (await this.caches().open(record.cacheName)).match(request.url);
    if (!response) throw new BrowserServiceError('asset', 'Installed resource was evicted.');
    await this.verify(resource, response.clone());
    return response;
  }
}
