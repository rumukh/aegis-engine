import { BrowserServiceError } from './errors.js';

/** Schemes that can never be declared as a secure application scheme. */
const UNSAFE_SCHEMES = new Set([
  'http:',
  'https:',
  'file:',
  'data:',
  'blob:',
  'javascript:',
  'about:',
  'ftp:',
  'ws:',
  'wss:',
]);

/**
 * Validate explicitly declared secure custom application schemes (for example Electron's
 * `protocol.handle('app', ...)`), so `app://host/` can host assets (DESKTOP-02).
 */
export function checkSchemes(schemes: readonly string[] | undefined): readonly string[] {
  for (const scheme of schemes ?? [])
    if (
      typeof scheme !== 'string' ||
      !/^[a-z][a-z0-9+.-]*:$/.test(scheme) ||
      UNSAFE_SCHEMES.has(scheme)
    )
      throw new BrowserServiceError(
        'invalid-data',
        'Custom schemes must be declared like "app:" and cannot be http(s), file, data, blob or javascript.',
      );
  return schemes ?? [];
}

/**
 * Reject redirects as well as cross-origin URLs; child-safe services never follow an outbound hop.
 * `schemes` admits declared secure custom application schemes: their URLs must keep the base's
 * scheme and host exactly (custom schemes have an opaque origin, so origins cannot be compared).
 */
export function localAssetUrl(path: string, base: string, schemes: readonly string[] = []): URL {
  const root = new URL(base);
  const url = new URL(path, root);
  const custom = schemes.includes(root.protocol) && !UNSAFE_SCHEMES.has(root.protocol);
  const sameOrigin = custom
    ? url.protocol === root.protocol && url.host === root.host && root.host !== ''
    : url.origin === root.origin;
  if (
    !(['http:', 'https:'].includes(root.protocol) || custom) ||
    !sameOrigin ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new BrowserServiceError(
      'asset',
      'Assets require same-origin HTTP(S) URLs without credentials or fragments.',
    );
  return url;
}

export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<ArrayBuffer> {
  if (!response.ok || response.type === 'opaque' || response.redirected)
    throw new BrowserServiceError('asset', 'Asset response is unavailable, opaque or redirected.');
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > maxBytes)
    throw new BrowserServiceError('limit', 'Asset exceeds its byte budget.');
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes)
      throw new BrowserServiceError('limit', 'Asset exceeds its byte budget.');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new BrowserServiceError('limit', 'Asset exceeds its byte budget.');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output.buffer;
}

export class RequestPool {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
      throw new BrowserServiceError(
        'invalid-data',
        'Request concurrency must be between 1 and 32.',
      );
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
