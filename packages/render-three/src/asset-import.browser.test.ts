import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformerPlugin } from '@aegis/mode-platformer';
import { importModelAsset } from './asset-import.js';
import type { AssetImportResult } from './asset-import.js';
import { startAssetPreview } from './preview/capture.js';
import { startDevServer } from './dev-server.js';
import { exportStaticSite } from './static-site.js';
import { BINDINGS } from './bindings.js';
import { findRepoRoot } from './catalog.js';
import type { PresentationManifest } from './presentation/schema.js';
import { fixtureGltf, fixturePng } from './testing/presentation-fixture.js';
import { PLATFORMER_SCENE } from './testing/scenes.js';
import { launchBrowser } from './browser.js';
import type { LaunchedBrowser } from './browser.js';
import { closeOwnedBrowser } from './testing/browser-lifecycle.js';

let root: string;
let imported: AssetImportResult;
let manifest: PresentationManifest;
let browser: LaunchedBrowser;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'aegis-import-browser-'));
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'rig.gltf'), fixtureGltf());
  writeFileSync(join(source, 'rig.png'), fixturePng('rig'));
  imported = importModelAsset({
    source: join(source, 'rig.gltf'),
    outDir: join(root, 'imported'),
    id: 'imported-rig',
    provenance: {
      author: 'Aegis contributors',
      license: 'MIT',
      source: 'Original textured articulated test fixture',
    },
  });
  manifest = JSON.parse(
    readFileSync(join(imported.outDir, 'asset.presentation.json'), 'utf8'),
  ) as PresentationManifest;
  browser = await launchBrowser();
});
afterAll(async () => {
  if (browser !== undefined) {
    await closeOwnedBrowser(browser);
    rmSync(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  rmSync(root, { recursive: true, force: true });
});

describe('imported package through existing browser and delivery surfaces', () => {
  it('decodes the copied texture and samples actual imported animation in the asset studio', async () => {
    const preview = await startAssetPreview({
      source: join(imported.outDir, 'asset.presentation.json'),
      outputDir: root,
      settings: { clip: 'spin', time: 0 },
      browser,
    });
    try {
      const a = await preview.capture({ filename: 'start.png', width: 320, height: 320 });
      const b = await preview.capture({
        filename: 'bent.png',
        width: 320,
        height: 320,
        settings: { clip: 'spin', time: 0.5 },
      });
      expect(a.stats).toMatchObject({
        meshes: 2,
        triangles: 8,
        textures: 1,
        clips: [{ name: 'spin', duration: 2 }],
      });
      expect(a.stats.library).toMatchObject({ textures: 1, modelInstances: 1 });
      expect(b.stats.poseSampleHash).not.toBe(a.stats.poseSampleHash);
      expect(a.dependencies.map((file) => file.sha256)).toEqual(
        imported.receipt.files.map((file) => file.sha256),
      );
      expect(a.dependencies.every((file) => file.provenance.status === 'declared')).toBe(true);
    } finally {
      await preview.close();
    }
  });

  it('serves and statically packages the exact imported closure, not private metadata', async () => {
    const presentation = { manifest, assetRoot: imported.outDir };
    const definition = {
      id: 'imported',
      title: 'Imported fixture',
      blurb: 'Independent delivery probe',
      objective: 'Inspect the imported model',
      mode: 'platformer' as const,
      scene: PLATFORMER_SCENE,
      bindings: BINDINGS.platformer,
      presentation,
    };
    const server = await startDevServer({
      games: [{ ...definition, plugin: platformerPlugin }],
      port: 0,
      basePath: '/nested/import',
    });
    try {
      for (const file of imported.receipt.files) {
        const response = await fetch(`${server.url}/assets/imported/${file.path}`);
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(
          readFileSync(join(imported.outDir, file.path)),
        );
      }
      expect((await fetch(`${server.url}/assets/imported/import.json`)).status).toBe(404);
    } finally {
      await server.close();
    }
    const outDir = join(root, 'site');
    const site = exportStaticSite({
      repoRoot: findRepoRoot(),
      outDir,
      games: [
        {
          ...definition,
          sceneText: JSON.stringify(PLATFORMER_SCENE),
          pluginModule: '@aegis/mode-platformer',
          pluginExport: 'platformerPlugin',
        },
      ],
    });
    for (const file of imported.receipt.files) {
      const path = `assets/imported/${file.path}`;
      expect(site.files).toContain(path);
      expect(readFileSync(join(outDir, path))).toEqual(
        readFileSync(join(imported.outDir, file.path)),
      );
    }
    expect(site.files).not.toContain('assets/imported/import.json');
    expect(site.files.some((path) => /asset-import|python|TRELLIS/.test(path))).toBe(false);
  });

  it('does not turn a missing imported texture into a primitive or thumbnail', async () => {
    rmSync(join(imported.outDir, 'model', 'rig.png'));
    await expect(
      startAssetPreview({
        source: join(imported.outDir, 'asset.presentation.json'),
        browser,
      }),
    ).rejects.toThrow(/missing|readable/i);
  });
});
