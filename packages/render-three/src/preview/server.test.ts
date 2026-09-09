import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixturePng, writePresentationFixture } from '../testing/presentation-fixture.js';
import { startAssetPreviewServer } from './server.js';
import type { AssetPreviewServer } from './server.js';

let root: string;
let source: string;
let server: AssetPreviewServer | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aegis-preview-host-'));
  writePresentationFixture(root);
  source = join(root, 'rig.gltf');
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function post(path: string, body: unknown, token = server!.token): Promise<Response> {
  return fetch(`${server!.url}api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aegis-preview-token': token },
    body: JSON.stringify(body),
  });
}

describe('loopback asset-only host (no browser)', () => {
  it('serves its dedicated page and checked assets but no game routes or arbitrary files', async () => {
    writeFileSync(join(root, 'secret.txt'), 'not declared');
    server = await startAssetPreviewServer({ source });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const html = await (await fetch(server.url)).text();
    expect(html).toContain('Asset studio');
    expect(html).toContain('/preview/client/boot.js');
    expect(html).not.toContain("from '@aegis/render-three/client/boot'");
    expect((await fetch(`${server.url}api/frame`)).status).toBe(404);
    const asset = await fetch(`${server.url}assets/r1/rig.png`);
    expect(asset.status).toBe(200);
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(readFileSync(join(root, 'rig.png')));
    expect((await fetch(`${server.url}assets/r1/secret.txt`)).status).toBe(403);
    expect((await fetch(`${server.url}vendor/@aegis/cli/package.json`)).status).toBe(404);
    expect((await fetch(`${server.url}vendor/@aegis/harness/dist/index.js`)).status).toBe(404);
    expect(
      (await fetch(`${server.url}vendor/three/examples/jsm/controls/OrbitControls.js`)).status,
    ).toBe(200);
  });

  it('requires same-origin access and a capability token for mutations', async () => {
    server = await startAssetPreviewServer({ source });
    expect((await post('reload', {}, 'wrong')).status).toBe(403);
    const foreign = await fetch(`${server.url}api/reload`, {
      method: 'POST',
      headers: {
        origin: 'https://example.invalid',
        'content-type': 'application/json',
        'x-aegis-preview-token': server.token,
      },
      body: '{}',
    });
    expect(foreign.status).toBe(403);
    // Fetch may replace Host. Exercise the actual wire header rather than that client's policy.
    const rebound = await new Promise<number | undefined>((done, fail) => {
      const request = httpRequest(
        `${server!.url}api/state`,
        { headers: { host: 'rebound.invalid' } },
        (response) => {
          response.resume();
          done(response.statusCode);
        },
      );
      request.on('error', fail);
      request.end();
    });
    expect(rebound).toBe(403);
    expect((await post('reload', { source: 'C:\\private\\secret.glb' })).status).toBe(422);
    expect(server.state().revision).toBe(1);
    const response = await post('reload', {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 2, status: 'prepared' });
  });

  it('refuses unbounded capture names and settings before the browser or file writer', async () => {
    server = await startAssetPreviewServer({ source, outputDir: join(root, 'captures') });
    const capture = vi.fn(async () => {
      throw new Error('No invalid request may reach capture.');
    });
    server.attachAutomation({
      capture,
      state: async () => {
        throw new Error('unused');
      },
      configure: async () => {
        throw new Error('unused');
      },
    });
    for (const filename of [
      '../escape.png',
      'C:\\escape.png',
      'sub\\escape.png',
      'CON.png',
      'image.jpg',
    ]) {
      const response = await post('capture', { filename, revision: 1 });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ diagnostics: [{ code: 'AEG-PREVIEW-0006' }] });
    }
    expect((await post('capture', { filename: 'valid.png' })).status).toBe(409);
    expect((await post('capture', { filename: 'valid.png', revision: 1, width: 0 })).status).toBe(
      422,
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it('has no writable capture endpoint without an explicit startup output directory', async () => {
    server = await startAssetPreviewServer({ source });
    const response = await post('capture', { filename: 'capture.png', revision: 1 });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ diagnostics: [{ code: 'AEG-PREVIEW-0006' }] });
  });

  it('rejects changed checked bytes even without watch, then exposes only the new closure', async () => {
    server = await startAssetPreviewServer({ source });
    const first = server.state().document!;
    writeFileSync(join(root, 'rig.png'), fixturePng());
    const stale = await fetch(`${server.url}assets/r1/rig.png`);
    expect(stale.status).toBe(409);
    expect(server.state().revision).toBe(2);
    expect(server.state().document!.fingerprint).not.toBe(first.fingerprint);
    const current = await fetch(`${server.url}assets/r2/rig.png`);
    expect(current.status).toBe(200);
    expect(Buffer.from(await current.arrayBuffer())).toEqual(fixturePng());
    expect((await post('fresh', { revision: 1 })).status).toBe(409);
    expect((await post('fresh', { revision: 2 })).status).toBe(200);
  });

  it('watches changed dependencies, refuses a missing new buffer, and recovers when it is repaired', async () => {
    server = await startAssetPreviewServer({ source, watch: true, outputDir: root });
    const first = server.state().document!.fingerprint;
    writeFileSync(join(root, 'rig.png'), fixturePng());
    await vi.waitFor(
      () => {
        expect(server!.state().status).toBe('prepared');
        expect(server!.state().document!.fingerprint).not.toBe(first);
      },
      { timeout: 5000, interval: 20 },
    );
    const model = JSON.parse(readFileSync(source, 'utf8')) as {
      buffers: { uri: string; byteLength: number }[];
    };
    const buffer = Buffer.from(model.buffers[0]!.uri.split(',')[1]!, 'base64');
    model.buffers[0]!.uri = 'new-buffer.bin';
    writeFileSync(source, JSON.stringify(model));
    await vi.waitFor(() => expect(server!.state().status).toBe('failed'), {
      timeout: 5000,
      interval: 20,
    });
    const failed = server.state();
    expect(failed.document).toBeNull();
    expect(failed.diagnostics[0]?.code).toBe('AEG-RENDER-0004');
    expect(() => server!.current(failed.revision)).toThrow('current revision');
    writeFileSync(join(root, 'new-buffer.bin'), buffer);
    await vi.waitFor(() => expect(server!.state().status).toBe('prepared'), {
      timeout: 5000,
      interval: 20,
    });
    expect(server.state().revision).toBeGreaterThan(failed.revision);
    expect(server.state().document!.dependencies.map((entry) => entry.path)).toEqual([
      'new-buffer.bin',
      'rig.gltf',
      'rig.png',
    ]);
  });

  it('keeps invalid revisions failed and closes all streams, watchers, and its port', async () => {
    server = await startAssetPreviewServer({ source, watch: true });
    const events = await fetch(`${server.url}api/events`);
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"revision":1');
    writeFileSync(source, '{}');
    server.reload();
    expect(server.state()).toMatchObject({
      revision: 2,
      status: 'failed',
      lastPreparedRevision: 1,
      document: null,
    });
    const url = server.url;
    await reader.cancel();
    await server.close();
    expect(server.state().status).toBe('closed');
    await expect(fetch(url)).rejects.toThrow();
  });

  it('invalidates a renamed dependency directory even when no individual file event is delivered', async () => {
    const images = join(root, 'images');
    const moved = join(root, 'moved-images');
    mkdirSync(images);
    renameSync(join(root, 'rig.png'), join(images, 'rig.png'));
    const model = JSON.parse(readFileSync(source, 'utf8')) as { images: { uri: string }[] };
    model.images[0]!.uri = 'images/rig.png';
    writeFileSync(source, JSON.stringify(model));
    server = await startAssetPreviewServer({ source, watch: true });
    renameSync(images, moved);
    await vi.waitFor(() => expect(server!.state().status).toBe('failed'), {
      timeout: 5000,
      interval: 20,
    });
    renameSync(moved, images);
    await vi.waitFor(() => expect(server!.state().status).toBe('prepared'), {
      timeout: 5000,
      interval: 20,
    });
    expect(server.state().revision).toBeGreaterThan(1);
  });
});
