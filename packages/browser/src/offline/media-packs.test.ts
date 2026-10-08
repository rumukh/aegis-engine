import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OfflinePackStore } from './packs.js';
import type { OfflinePack, PackStatus, SequenceProgress } from './packs.js';
import { createOfflineFetchHandler } from './worker.js';

/** In-memory CacheStorage with an optional byte quota, as the iPadOS limit surfaces it. */
class FakeCache {
  readonly entries = new Map<string, ArrayBuffer>();
  constructor(private readonly owner: FakeCaches) {}
  async match(request: string | Request): Promise<Response | undefined> {
    const bytes = this.entries.get(typeof request === 'string' ? request : request.url);
    return bytes ? new Response(bytes.slice(0)) : undefined;
  }
  async put(request: string | Request, response: Response): Promise<void> {
    const bytes = await response.arrayBuffer();
    if (this.owner.used() + bytes.byteLength > this.owner.quota)
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.entries.set(typeof request === 'string' ? request : request.url, bytes);
  }
  async delete(request: string | Request): Promise<boolean> {
    return this.entries.delete(typeof request === 'string' ? request : request.url);
  }
  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}
class FakeCaches {
  readonly caches = new Map<string, FakeCache>();
  constructor(readonly quota = Infinity) {}
  used(): number {
    let total = 0;
    for (const cache of this.caches.values())
      for (const bytes of cache.entries.values()) total += bytes.byteLength;
    return total;
  }
  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) this.caches.set(name, (cache = new FakeCache(this)));
    return cache;
  }
  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}
const locks = {
  request: (async (_name: string, _options: unknown, work: (lock: unknown) => Promise<unknown>) =>
    work({})) as unknown as LockManager['request'],
};
const base = 'https://example.test/fluffy/';
const MB = 1024 * 1024;

function pack(id: string, sizes: readonly number[]) {
  const bodies = new Map<string, Uint8Array<ArrayBuffer>>();
  const manifest: OfflinePack = {
    id,
    revision: 'r1',
    resources: sizes.map((bytes, i) => {
      const body = new Uint8Array(bytes).fill(i + id.length);
      const src = `media/${id}/${String(i)}.webp`;
      bodies.set(new URL(src, base).href, body);
      return {
        id: `${id}-${String(i)}`,
        src,
        bytes,
        sha256: createHash('sha256').update(body).digest('hex'),
        kind: 'image' as const,
      };
    }),
  };
  return { manifest, bodies };
}

function setup(options: { quota?: number; estimate?: { usage: number; quota: number } } = {}) {
  const prologue = pack('prologue', [MB, MB, MB]);
  const case1 = pack('case01', [2 * MB, 2 * MB, MB]);
  const case2 = pack('case02', [3 * MB, 3 * MB]);
  const bodies = new Map([...prologue.bodies, ...case1.bodies, ...case2.bodies]);
  const fetched: string[] = [];
  const caches = new FakeCaches(options.quota);
  const statuses: PackStatus[] = [];
  const store = new OfflinePackStore({
    namespace: 'fluffy',
    baseUrl: base,
    caches: caches as unknown as CacheStorage,
    locks,
    fetch: (async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url;
      fetched.push(url);
      const body = bodies.get(url);
      return body ? new Response(body) : new Response(null, { status: 404 });
    }) as typeof fetch,
    ...(options.estimate
      ? {
          storage: {
            estimate: async () => ({
              usage: options.estimate!.usage + caches.used(),
              quota: options.estimate!.quota,
            }),
            persisted: async () => false,
            persist: async () => true,
          },
        }
      : { storage: {} }),
    maxPackBytes: 64 * MB,
    onStatus: (status) => statuses.push(status),
  });
  return { store, caches, fetched, statuses, prologue, case1, case2 };
}

describe('incremental media packs (OFFLINE-04)', () => {
  it('estimates storage before installing and reports byte progress per pack (F13)', async () => {
    const t = setup({ estimate: { usage: 2 * MB, quota: 40 * MB } });
    const plan = await t.store.plan([t.prologue.manifest, t.case1.manifest, t.case2.manifest]);
    expect(plan).toMatchObject({
      requiredBytes: 14 * MB,
      available: 38 * MB,
      fits: 'yes',
      persisted: false,
    });
    expect(t.fetched).toEqual([]);
    const progress: SequenceProgress[] = [];
    await t.store.installSequence([t.prologue.manifest, t.case1.manifest], {
      onProgress: (p) => progress.push(p),
    });
    const after = await t.store.plan([t.prologue.manifest, t.case1.manifest, t.case2.manifest]);
    expect(after.packs.map((p) => p.installed)).toEqual([true, true, false]);
    expect(after.requiredBytes).toBe(6 * MB);
    const prologue = progress.filter((p) => p.pack.id === 'prologue').map((p) => p.completedBytes);
    expect(prologue.at(-1)).toBe(3 * MB);
    expect([...prologue].sort((a, b) => a - b)).toEqual(prologue);
    expect(progress.filter((p) => p.pack.id === 'case01').at(-1)).toMatchObject({
      index: 1,
      count: 2,
      completedBytes: 5 * MB,
      totalBytes: 5 * MB,
    });
    expect(t.statuses.at(-1)).toMatchObject({
      status: 'ready',
      completedBytes: 5 * MB,
      totalBytes: 5 * MB,
    });
    expect(await t.store.requestPersistence()).toBe(true);
  });

  it('installs a later pack mid-case without disturbing the active case, and serves both offline (F13)', async () => {
    const t = setup();
    await t.store.installSequence([t.prologue.manifest, t.case1.manifest]);
    await t.store.activate({ id: 'case01', revision: 'r1' }, () => true, true);
    const release = t.store.retain({ id: 'case01', revision: 'r1' });
    const route = createOfflineFetchHandler(t.store, {
      packs: [t.prologue.manifest, t.case1.manifest, t.case2.manifest].map(({ id, revision }) => ({
        id,
        revision,
      })),
      shell: 'index.html',
      onError: () => undefined,
    });
    const media = `${base}media/case01/0.webp`;
    const later = `${base}media/case02/0.webp`;
    // Offline cold start: installed packs serve; the not-yet-installed pack does not.
    const before = t.fetched.length;
    expect((await route(new Request(media))).status).toBe(200);
    expect((await route(new Request(later))).status).toBe(503);
    expect(t.fetched.length).toBe(before);
    // Install case 2 while case 1 is active, reading case 1 media throughout.
    const install = t.store.installSequence([t.case2.manifest]);
    const during = await Promise.all([route(new Request(media)), install]);
    expect(during[0].status).toBe(200);
    expect(t.store.activePack()).toEqual({ id: 'case01', revision: 'r1' });
    expect((await route(new Request(later))).status).toBe(200);
    await expect(
      t.store.remove({ id: 'case01', revision: 'r1' }, { id: 'case01', revision: 'r1' }),
    ).rejects.toMatchObject({
      code: 'blocked',
    });
    release();
  });

  it('refuses a pack that does not fit before downloading, keeping earlier packs installed', async () => {
    const t = setup({ estimate: { usage: 0, quota: 18 * MB } });
    await expect(
      t.store.installSequence([t.prologue.manifest, t.case1.manifest, t.case2.manifest]),
    ).rejects.toMatchObject({ code: 'limit', message: expect.stringContaining('case02') });
    expect(t.fetched.some((url) => url.includes('case02'))).toBe(false);
    const plan = await t.store.plan([t.prologue.manifest, t.case1.manifest, t.case2.manifest]);
    expect(plan.packs.map((p) => p.installed)).toEqual([true, true, false]);
    expect(plan.fits).toBe('no');
  });

  it('maps a quota error during installation to "limit" and removes the staging cache', async () => {
    const t = setup({ quota: 6 * MB });
    await t.store.installSequence([t.prologue.manifest]);
    await expect(t.store.installSequence([t.case1.manifest])).rejects.toMatchObject({
      code: 'limit',
    });
    expect([...t.caches.caches.keys()].filter((name) => name.includes(':pack:case01'))).toEqual([]);
    expect(t.statuses.at(-1)).toMatchObject({ status: 'failed', pack: { id: 'case01' } });
    const plan = await t.store.plan([t.prologue.manifest, t.case1.manifest]);
    expect(plan).toMatchObject({ fits: 'unknown' });
    expect(plan.packs.map((p) => p.installed)).toEqual([true, false]);
  });
});
