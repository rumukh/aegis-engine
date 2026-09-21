import { BrowserServiceError } from './errors.js';

/** Reject redirects as well as cross-origin URLs; child-safe services never follow an outbound hop. */
export function localAssetUrl(path: string, base: string): URL {
  const root = new URL(base);
  const url = new URL(path, root);
  if (
    !['http:', 'https:'].includes(root.protocol) ||
    url.origin !== root.origin ||
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
