import { BrowserServiceError } from '../errors.js';
import { localAssetUrl } from '../io.js';

export const INSTALLATION_HEADER = 'X-Aegis-Offline-Install';
export const INSTALLATION_PROTOCOL = '1';

/**
 * Explicit download/update traffic, distinct from revision-pinned gameplay reads.
 * The worker strips the marker and fetches from its own uncontrolled network context.
 */
export function createInstallationRequest(
  resource: string,
  baseUrl: string,
  signal?: AbortSignal,
): Request {
  const base = new URL(baseUrl);
  const url = localAssetUrl(resource, baseUrl);
  if (!base.pathname.endsWith('/') || !url.pathname.startsWith(base.pathname))
    throw new BrowserServiceError(
      'asset',
      'Installation downloads must remain inside the application base path.',
    );
  return new Request(url.href, {
    headers: { [INSTALLATION_HEADER]: INSTALLATION_PROTOCOL },
    redirect: 'error',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
}
