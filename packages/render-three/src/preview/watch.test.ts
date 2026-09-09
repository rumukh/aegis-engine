import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { WatchEventType } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAssetPreviewServer } from './server.js';
import type { AssetPreviewServer } from './server.js';

const observed = vi.hoisted(() => ({
  calls: [] as { directory: string; recursive: boolean; closed: boolean }[],
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    watch(
      directory: string,
      options: { recursive: boolean },
      listener: (event: WatchEventType, filename: string | null) => void,
    ) {
      const call = { directory, recursive: options.recursive, closed: false };
      observed.calls.push(call);
      const watcher = fs.watch(directory, options, listener);
      watcher.on('close', () => {
        call.closed = true;
      });
      return watcher;
    },
  };
});

let root: string;
let a: string;
let b: string;
let links: string;
let junction: string;
let source: string;
let server: AssetPreviewServer | undefined;
const svg = (color: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/></svg>`;

beforeEach(() => {
  observed.calls.length = 0;
  root = mkdtempSync(join(tmpdir(), 'aegis-preview-rebind-'));
  a = join(root, 'A');
  b = join(root, 'B');
  links = join(root, 'links');
  for (const directory of [a, b, links]) mkdirSync(directory);
  junction = join(links, 'asset-root');
  source = join(junction, 'source.svg');
  writeFileSync(join(a, 'source.svg'), svg('#ff4444'));
  writeFileSync(join(b, 'source.svg'), svg('#4488ff'));
  symlinkSync(a, junction, 'junction');
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await vi.waitFor(() => expect(observed.calls.every((call) => call.closed)).toBe(true));
  rmSync(root, { recursive: true, force: true });
});

async function advanced(after: number, target: string): Promise<number> {
  await vi.waitFor(
    () => {
      const state = server!.state();
      expect(state.status).toBe('prepared');
      expect(state.revision).toBeGreaterThan(after);
      expect(server!.current(state.revision).sourceRealPath).toBe(realpathSync(target));
    },
    { timeout: 5000, interval: 20 },
  );
  return server!.state().revision;
}

describe('logical asset roots and native watch lifetimes', () => {
  it.each([false, true])(
    'detects a junction retarget and subsequent edits to its new target (manual reload: %s)',
    async (manual) => {
      server = await startAssetPreviewServer({ source, watch: true });
      const first = server.state();
      // Positive control: this same source and instrumentation observe an ordinary edit.
      writeFileSync(join(a, 'source.svg'), svg('#ff9944'));
      const editedA = await advanced(first.revision, join(a, 'source.svg'));
      expect(server.state().document!.fingerprint).not.toBe(first.document!.fingerprint);

      rmSync(junction, { recursive: true });
      symlinkSync(b, junction, 'junction');
      if (manual) expect(server.reload().status).toBe('prepared');
      const retargeted = await advanced(editedA, join(b, 'source.svg'));
      writeFileSync(join(b, 'source.svg'), svg('#44ff99'));
      const editedB = await advanced(retargeted, join(b, 'source.svg'));
      const response = await fetch(`${server.url}assets/r${editedB}/source.svg`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(svg('#44ff99'));

      // Old native handles and unrelated logical siblings no longer advance this preview.
      writeFileSync(join(a, 'source.svg'), svg('#ffffff'));
      writeFileSync(join(links, 'unrelated.txt'), 'not a source');
      await new Promise((done) => setTimeout(done, 180));
      expect(server.state().revision).toBe(editedB);
      const recursive = observed.calls.filter((call) => call.recursive);
      expect(recursive.some((call) => call.directory === realpathSync(a))).toBe(true);
      expect(recursive.some((call) => call.directory === realpathSync(b) && !call.closed)).toBe(
        true,
      );
      expect(
        recursive.filter((call) => call.directory === realpathSync(a)).every((call) => call.closed),
      ).toBe(true);
      expect(
        recursive.some(
          (call) => call.directory === realpathSync(links) || call.directory === realpathSync(root),
        ),
      ).toBe(false);
      expect(
        observed.calls.some((call) => call.directory === realpathSync(links) && !call.recursive),
      ).toBe(true);
    },
  );

  it('keeps a narrow logical-parent watch through a missing target and recovers after repair', async () => {
    server = await startAssetPreviewServer({ source, watch: true });
    const first = server.state().revision;
    rmSync(junction, { recursive: true });
    await vi.waitFor(() => expect(server!.state().status).toBe('failed'), {
      timeout: 5000,
      interval: 20,
    });
    const failed = server.state().revision;
    expect(failed).toBeGreaterThan(first);
    symlinkSync(b, junction, 'junction');
    const repaired = await advanced(failed, join(b, 'source.svg'));
    writeFileSync(join(b, 'source.svg'), svg('#ccaa22'));
    await advanced(repaired, join(b, 'source.svg'));
  });

  it('rebinds a replaced directory handle even when its path and initial bytes are unchanged', async () => {
    server = await startAssetPreviewServer({ source, watch: true });
    const first = server.state().revision;
    renameSync(a, join(root, 'retired-A'));
    mkdirSync(a);
    writeFileSync(join(a, 'source.svg'), svg('#ff4444'));
    await new Promise((done) => setTimeout(done, 180));
    expect(server.state().revision).toBe(first);
    writeFileSync(join(a, 'source.svg'), svg('#6688aa'));
    await advanced(first, join(a, 'source.svg'));
  });

  it('rebinds an explicit descriptor asset-root junction, not just direct-file sources', async () => {
    const descriptor = join(root, 'study.presentation.json');
    writeFileSync(
      descriptor,
      JSON.stringify({
        aegis: 'presentation/1',
        assets: [
          {
            id: 'image',
            kind: 'texture',
            src: 'source.svg',
            provenance: { author: 'Aegis test', license: 'MIT', source: 'watch.test.ts' },
          },
        ],
      }),
    );
    server = await startAssetPreviewServer({
      source: descriptor,
      assetRoot: junction,
      watch: true,
    });
    const first = server.state().document!.fingerprint;
    rmSync(junction, { recursive: true });
    symlinkSync(b, junction, 'junction');
    await vi.waitFor(
      () => {
        expect(server!.state().status).toBe('prepared');
        expect(server!.state().document!.fingerprint).not.toBe(first);
      },
      { timeout: 5000, interval: 20 },
    );
    const retargeted = server.state().revision;
    writeFileSync(join(b, 'source.svg'), svg('#ffee66'));
    await advanced(retargeted, descriptor);
  });
});
