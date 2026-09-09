import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAssetPreviewServer } from '@aegis/render-three/preview';
import type { AssetPreview, AssetPreviewOptions } from '@aegis/render-three/preview';
import { GLOBAL_FLAGS, parseArgs } from './args.js';
import { main } from './cli.js';
import { COMMANDS } from './commands.js';
import { createPreviewCommand } from './commands/preview.js';
import type { CliIO } from './io.js';
import type { ModeResolver } from './modes.js';

const noModes: ModeResolver = {
  available: () => {
    throw new Error('Preview cannot enumerate game modes.');
  },
  has: () => {
    throw new Error('Preview cannot look up a mode.');
  },
  resolve: () => {
    throw new Error('Preview cannot resolve or initialize a plugin.');
  },
};
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aegis-preview-cli-'));
  writeFileSync(
    join(root, 'specimen.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#99ccff"/></svg>',
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function io(argv: readonly string[]): { io: CliIO; out(): string; err(): string } {
  let out = '';
  let err = '';
  return {
    io: {
      argv,
      cwd: root,
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    out: () => out,
    err: () => err,
  };
}

describe('preview CLI (CPU only; real captures live in preview.browser.test.ts)', () => {
  it('publishes the actual command, selection choices, and versioned formats', async () => {
    const command = COMMANDS.find((entry) => entry.name === 'preview')!;
    expect(command.choices).toEqual({
      view: ['three-quarter', 'front', 'back', 'left', 'right', 'top'],
      projection: ['perspective', 'orthographic'],
      lighting: ['studio', 'neutral', 'warm'],
      shape: ['sphere', 'cube', 'plane'],
    });
    expect(command.formats).toEqual({
      reads: ['glTF/2.0', 'PNG', 'JPEG', 'WebP', 'SVG', 'presentation/1'],
      writes: ['PNG', 'asset-preview-capture/1'],
      stdout: ['text', 'asset-preview-capture/1', 'asset-preview-session/1'],
    });
    const help = io(['preview', '--help']);
    expect(await main(help.io, { modes: noModes })).toBe(0);
    expect(help.out()).toContain('WITHOUT starting a game');
    expect(help.out()).toContain('--serve');
    expect(help.out()).toContain('--out-dir');
  });

  it.each([
    ['--out', 'capture.jpg'],
    ['--out', 'capture.png', '--width', '0'],
    ['--out', 'capture.png', '--height', '1.5'],
    ['--out', 'capture.png', '--view', 'fish-eye'],
    ['--out', 'capture.png', '--camera', '1,2,3'],
    ['--out', 'capture.png', '--time', '-1'],
    ['--out', 'capture.png', '--model', 'hero', '--texture', 'atlas'],
    ['--out', 'capture.png', '--frame', 'idle'],
    ['--out', 'capture.png', '--shape', 'cube'],
    ['--out', 'capture.png', '--port', '70000'],
    ['--out', 'capture.png', '--plugin', 'must-not-import'],
    ['--out', 'capture.png', '--width'],
    [],
  ])('rejects invalid arguments before any browser can start: %j', async (...flags) => {
    const context = io(['preview', 'specimen.svg', ...flags, '--json']);
    const code = await main(context.io, { modes: noModes });
    expect(code).not.toBe(0);
    const error = JSON.parse(context.err());
    expect(error.error?.code ?? error.diagnostics?.[0]?.code).toMatch(/^AEG-(?:CLI|PREVIEW)-/);
    expect(context.out()).toBe('');
  });

  it('returns actionable preflight diagnostics for a missing file, without booting a game or browser', async () => {
    const context = io(['preview', 'missing.glb', '--out', 'capture.png', '--json']);
    expect(await main(context.io, { modes: noModes })).toBe(2);
    expect(JSON.parse(context.err())).toMatchObject({
      diagnostics: [{ code: 'AEG-PREVIEW-0001', severity: 'error' }],
    });
  });

  it('keeps --watch warm, resolves paths from CliIO, and closes the managed session on stop', async () => {
    let received: AssetPreviewOptions | undefined;
    const closed = vi.fn();
    const command = createPreviewCommand({
      async start(options) {
        received = options;
        const server = await startAssetPreviewServer(options);
        const unused = async (): Promise<never> => {
          throw new Error('No browser belongs in this CPU command test.');
        };
        const preview: AssetPreview = {
          server,
          url: server.url,
          token: server.token,
          coldStartMs: 12,
          capture: unused,
          configure: unused,
          state: unused,
          reload: unused,
          close: async () => {
            closed();
            await server.close();
          },
        };
        return preview;
      },
      stopSignal: () => ({ wait: Promise.resolve(), dispose() {} }),
    });
    const args = ['specimen.svg', '--watch', '--out-dir', 'captures', '--json'];
    const context = io(['preview', ...args]);
    expect(
      await command.run({
        args: parseArgs(args, { ...GLOBAL_FLAGS, ...command.flags }),
        io: context.io,
        modes: noModes,
      }),
    ).toBe(0);
    expect(received).toMatchObject({
      source: join(root, 'specimen.svg'),
      outputDir: join(root, 'captures'),
      watch: true,
    });
    expect(JSON.parse(context.out())).toMatchObject({
      aegis: 'asset-preview-session/1',
      revision: 1,
      watch: true,
      capture: null,
    });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('closes a managed one-shot when capture fails, instead of returning a stale success', async () => {
    const closed = vi.fn();
    const capture = vi.fn(async (): Promise<never> => {
      throw new Error('Current revision failed to decode.');
    });
    const command = createPreviewCommand({
      async start(options) {
        const server = await startAssetPreviewServer(options);
        const unused = async (): Promise<never> => {
          throw new Error('unused');
        };
        return {
          server,
          url: server.url,
          token: server.token,
          coldStartMs: 10,
          capture,
          configure: unused,
          state: unused,
          reload: unused,
          close: async () => {
            closed();
            await server.close();
          },
        };
      },
    });
    const args = [
      'specimen.svg',
      '--out',
      join('captures', 'image.png'),
      '--width',
      '640',
      '--height',
      '360',
      '--json',
    ];
    const context = io(['preview', ...args]);
    await expect(
      command.run({
        args: parseArgs(args, { ...GLOBAL_FLAGS, ...command.flags }),
        io: context.io,
        modes: noModes,
      }),
    ).rejects.toThrow('Current revision failed');
    expect(capture).toHaveBeenCalledWith({ filename: 'image.png', width: 640, height: 360 });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(context.out()).toBe('');
  });
});
