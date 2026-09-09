import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePresentationFixture } from '../testing/presentation-fixture.js';
import { previewOutputPaths } from './output.js';
import { startAssetPreviewServer } from './server.js';
import type { AssetPreviewServer } from './server.js';

let root: string;
let server: AssetPreviewServer | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aegis-preview-output-'));
  writePresentationFixture(root);
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('capture output integrity before a browser or file write', () => {
  it('refuses a source PNG and any glTF dependency as capture output', async () => {
    const source = join(root, 'rig.gltf');
    const image = readFileSync(join(root, 'rig.png'));
    server = await startAssetPreviewServer({ source, outputDir: root });
    expect(() => previewOutputPaths(server!, 'rig.png', 1)).toThrow('cannot replace or alias');
    expect(readFileSync(join(root, 'rig.png'))).toEqual(image);
    await server.close();
    server = await startAssetPreviewServer({ source: join(root, 'rig.png'), outputDir: root });
    expect(() => previewOutputPaths(server!, 'rig.png', 1)).toThrow('cannot replace or alias');
  });

  it('refuses a sidecar that would overwrite the presentation descriptor itself', async () => {
    const source = join(root, 'capture.png.preview.json');
    const text = JSON.stringify({
      aegis: 'presentation/1',
      materials: [{ id: 'sample', shading: 'standard' }],
    });
    writeFileSync(source, text);
    server = await startAssetPreviewServer({ source, outputDir: root });
    expect(() => previewOutputPaths(server!, 'capture.png', 1)).toThrow('cannot replace or alias');
    expect(readFileSync(source, 'utf8')).toBe(text);
    expect(existsSync(join(root, 'capture.png'))).toBe(false);
  });

  it('refuses existing hard-link aliases and permits a different bounded basename', async () => {
    const source = join(root, 'rig.gltf');
    linkSync(source, join(root, 'alias.png'));
    linkSync(join(root, 'rig.png'), join(root, 'sidecar.png.preview.json'));
    server = await startAssetPreviewServer({ source, outputDir: root });
    expect(() => previewOutputPaths(server!, 'alias.png', 1)).toThrow('cannot replace or alias');
    expect(() => previewOutputPaths(server!, 'sidecar.png', 1)).toThrow('cannot replace or alias');
    expect(previewOutputPaths(server, 'safe.png', 1)).toEqual({
      file: join(root, 'safe.png'),
      sidecar: join(root, 'safe.png.preview.json'),
    });
  });

  it('does not manufacture revisions from capture outputs or unchanged source bytes in a watched source directory', async () => {
    const source = join(root, 'rig.gltf');
    server = await startAssetPreviewServer({ source, watch: true, outputDir: root });
    const original = server.state();
    const paths = previewOutputPaths(server, 'safe.png', original.revision);
    writeFileSync(paths.file, readFileSync(join(root, 'rig.png')));
    writeFileSync(paths.sidecar, '{"aegis":"asset-preview-capture/1"}');
    writeFileSync(source, readFileSync(source));
    await new Promise((done) => setTimeout(done, 220));
    expect(server.state()).toEqual(original);
  });
});
