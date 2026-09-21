import { BrowserServiceError } from '../errors.js';
import { localAssetUrl } from '../io.js';
import { OfflinePackStore } from './packs.js';
import type { OfflinePackRef } from './packs.js';
import { INSTALLATION_HEADER, INSTALLATION_PROTOCOL } from './network.js';

export interface OfflineRoutes {
  /** Explicit revision pins are part of the worker build, not mutable latest-version guesses. */
  packs: readonly OfflinePackRef[];
  shell: string;
  allowNetwork?: boolean;
  /** Opt out only for intentionally read-only installations that cannot download updates. */
  allowInstallationNetwork?: boolean;
  onError(error: unknown): void;
}

export function createOfflineFetchHandler(
  store: OfflinePackStore,
  options: OfflineRoutes,
): (request: Request) => Promise<Response> {
  const base = new URL(store.options.baseUrl);
  const shell = localAssetUrl(options.shell, base.href);
  const refs = structuredClone(options.packs);
  return async (request) => {
    const url = new URL(request.url);
    if (
      url.origin !== base.origin ||
      request.method !== 'GET' ||
      !url.pathname.startsWith(base.pathname)
    )
      return new Response(null, { status: 403 });
    const lookup =
      request.mode === 'navigate'
        ? url.pathname === base.pathname || url.pathname === shell.pathname
          ? new Request(shell.href)
          : url.pathname.endsWith('/')
            ? new Request(new URL('index.html', url).href)
            : request
        : request;
    try {
      if (request.headers.has(INSTALLATION_HEADER)) {
        if (
          request.headers.get(INSTALLATION_HEADER) !== INSTALLATION_PROTOCOL ||
          options.allowInstallationNetwork === false ||
          request.mode === 'navigate'
        )
          return new Response(null, { status: 403 });
        const headers = new Headers(request.headers);
        headers.delete(INSTALLATION_HEADER);
        return await (store.options.fetch ?? globalThis.fetch)(
          new Request(request, {
            headers,
            redirect: 'error',
            credentials: 'same-origin',
            cache: 'no-store',
          }),
        );
      }
      for (const ref of refs) {
        const result = await store.response(ref, lookup);
        if (result) return result;
      }
      if (options.allowNetwork)
        return await (store.options.fetch ?? globalThis.fetch)(request, {
          redirect: 'error',
          credentials: 'same-origin',
        });
      throw new BrowserServiceError('asset', 'Request is not in the installed resource graph.');
    } catch (cause) {
      options.onError(cause);
      return new Response(null, { status: 503 });
    }
  };
}

export interface OfflineWorkerScope {
  addEventListener(
    type: 'fetch',
    listener: (event: { request: Request; respondWith(response: Promise<Response>): void }) => void,
  ): void;
  removeEventListener(
    type: 'fetch',
    listener: (event: { request: Request; respondWith(response: Promise<Response>): void }) => void,
  ): void;
}

/** Bundle this PUBLIC entry into a same-origin worker. It never skipWaits or forces reload. */
export function attachOfflineWorker(
  scope: OfflineWorkerScope,
  store: OfflinePackStore,
  routes: OfflineRoutes,
): () => void {
  const handle = createOfflineFetchHandler(store, routes);
  const listener = (event: {
    request: Request;
    respondWith(response: Promise<Response>): void;
  }): void => {
    event.respondWith(handle(event.request));
  };
  scope.addEventListener('fetch', listener);
  return () => scope.removeEventListener('fetch', listener);
}

export async function registerOfflineWorker(
  script: string,
  baseUrl: string,
  container: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker,
): Promise<ServiceWorkerRegistration> {
  if (!container)
    throw new BrowserServiceError(
      'unavailable',
      'Service workers require a supported secure browser context.',
    );
  const base = new URL(baseUrl);
  const url = localAssetUrl(script, baseUrl);
  if (!base.pathname.endsWith('/') || !url.pathname.startsWith(base.pathname))
    throw new BrowserServiceError(
      'asset',
      'Worker must be deployed inside the application base path.',
    );
  return container.register(url.href, { type: 'module', scope: base.href, updateViaCache: 'none' });
}
