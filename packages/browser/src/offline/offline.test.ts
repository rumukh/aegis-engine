import { describe, expect, it } from 'vitest';
import { OfflinePackStore, validateOfflinePack } from './packs.js';
import { createInstallationRequest } from './network.js';
import { createOfflineFetchHandler } from './worker.js';
import { readBoundedResponse, RequestPool } from '../io.js';

describe('offline resource boundaries', () => {
  const resource = {
    id: 'shell',
    src: 'index.html',
    bytes: 10,
    sha256: 'a'.repeat(64),
    kind: 'shell',
  };
  it('rejects outbound, redirected-base, duplicate, unbounded and mismatched graph declarations', () => {
    const valid = { id: 'lab', revision: 'r1', resources: [resource] };
    expect(validateOfflinePack(valid, 'https://example.test/nested/app/').resources[0]?.src).toBe(
      'index.html',
    );
    for (const resources of [
      [{ ...resource, src: 'https://other.test/asset' }],
      [{ ...resource, src: '../outside' }],
      [resource, resource],
      [{ ...resource, bytes: 33 * 1024 * 1024 }],
      [{ ...resource, sha256: 'missing' }],
    ])
      expect(() =>
        validateOfflinePack({ ...valid, resources }, 'https://example.test/nested/app/'),
      ).toThrow();
  });
  it('bounds streamed response bodies even when content-length is absent', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(20));
          controller.close();
        },
      }),
    );
    await expect(readBoundedResponse(response, 10)).rejects.toMatchObject({ code: 'limit' });
  });
  it('bounds concurrent requests and drains failed slots rather than deadlocking', async () => {
    const pool = new RequestPool(2);
    let active = 0;
    let peak = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_value, index) =>
        pool.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active--;
          if (index === 3) throw new Error('failed request');
          return index;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(results.filter((value) => value.status === 'rejected')).toHaveLength(1);
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(9);
  });

  it('keeps explicit installation network requests separate from pinned gameplay and rejects route escapes', async () => {
    const network: Request[] = [];
    class PinnedStore extends OfflinePackStore {
      override async response(): Promise<Response> {
        return new Response('pinned-r1');
      }
    }
    const baseUrl = 'https://example.test/nested/app/';
    const store = new PinnedStore({
      namespace: 'protocol',
      baseUrl,
      fetch: async (input, init) => {
        network.push(new Request(input, init));
        return new Response('origin-r2');
      },
    });
    const errors: unknown[] = [];
    const options = {
      packs: [{ id: 'p', revision: 'r1' }],
      shell: 'index.html',
      onError: (error: unknown) => errors.push(error),
    };
    const route = createOfflineFetchHandler(store, options);
    expect(await (await route(new Request(`${baseUrl}data.json`))).text()).toBe('pinned-r1');
    expect(network).toHaveLength(0);
    const install = createInstallationRequest('data.json', baseUrl);
    expect(await (await route(install)).text()).toBe('origin-r2');
    expect(network).toHaveLength(1);
    expect(network[0]?.headers.has('X-Aegis-Offline-Install')).toBe(false);
    expect(network[0]).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      credentials: 'same-origin',
    });
    expect(
      (await route(new Request('https://other.test/data.json', { headers: install.headers })))
        .status,
    ).toBe(403);
    expect(
      (
        await route(
          new Request(`${baseUrl}data.json`, { method: 'POST', headers: install.headers }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await createOfflineFetchHandler(store, { ...options, allowInstallationNetwork: false })(
          install,
        )
      ).status,
    ).toBe(403);
    expect(network).toHaveLength(1);
    expect(() => createInstallationRequest('../outside.json', baseUrl)).toThrow(/base path/);
    expect(errors).toEqual([]);
  });
});
