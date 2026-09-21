import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from './catalog.js';
import { importMap } from './pages.js';
import { collectModuleGraph, engineModules, staticImportMap } from './static-site.js';

const root = findRepoRoot();
const specifier = '@aegis/browser/audio/nodes';

describe('shared audio primitive browser routes', () => {
  it('maps the declared public primitive entry in dev, preview and nested static pages', () => {
    const metadata = JSON.parse(
      readFileSync(join(root, 'packages', 'browser', 'package.json'), 'utf8'),
    ) as {
      exports: Record<string, { import: string }>;
    };
    expect(metadata.exports['./audio/nodes']?.import).toBe('./dist/audio/nodes.js');
    for (const prefix of ['../../', './']) {
      const dev = JSON.parse(importMap(prefix)) as { imports: Record<string, string> };
      const statik = JSON.parse(staticImportMap(prefix, engineModules(root))) as {
        imports: Record<string, string>;
      };
      const expected = `${prefix}vendor/@aegis/browser/dist/audio/nodes.js`;
      expect(dev.imports[specifier]).toBe(expected);
      expect(statik.imports[specifier]).toBe(expected);
      expect(new URL(expected, 'https://example.test/nested/play/game/').pathname).not.toBe(
        '/vendor/@aegis/browser/dist/audio/nodes.js',
      );
    }
  });

  it('closes the actual legacy audio graph without loading the narration or runtime barrel', () => {
    const graph = collectModuleGraph({
      entries: [join(root, 'packages', 'render-three', 'dist', 'client', 'audio.js')],
      modules: engineModules(root),
    });
    const paths = graph.files.map((file) => file.target);
    expect(paths).toContain('vendor/@aegis/browser/dist/audio/nodes.js');
    expect(paths).not.toContain('vendor/@aegis/browser/dist/audio/narration.js');
    expect(paths.some((path) => path.includes('/runtime/'))).toBe(false);
    expect(graph.deferred).toEqual([]);
  });
});
