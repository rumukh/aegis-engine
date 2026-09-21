import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { distributionManifest, packSdk, sdkPackages } from '../scripts/pack-sdk.mjs';
import { repositoryRoot } from '../scripts/sdk-tools.mjs';
import { testStandaloneConsumer } from '../scripts/test-standalone-consumer.mjs';
import { runLabs } from '../scripts/run-labs.mjs';

describe('extension distribution', () => {
  it('pins every sibling together without changing source workspace metadata', () => {
    const source = {
      name: '@aegis/runtime',
      version: '0.0.0',
      license: 'MIT',
      private: true,
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      dependencies: { '@aegis/core': '*' },
      devDependencies: { typescript: '*' },
    };
    const manifest = distributionManifest(source, '0.0.0-local.example');
    expect(manifest.dependencies).toEqual({ '@aegis/core': '0.0.0-local.example' });
    expect(manifest.private).toBe(true);
    expect(manifest.devDependencies).toBeUndefined();
    expect(source.dependencies).toEqual({ '@aegis/core': '*' });
    expect(manifest.files).toContain('LICENSE');
    expect(manifest.files).toContain('aegis-build.json');
  });

  it('rejects unreviewed dependencies and missing public type contracts', () => {
    const source = JSON.parse(
      readFileSync(join(repositoryRoot, 'packages', 'core', 'package.json'), 'utf8'),
    );
    expect(() => distributionManifest({ ...source, exports: {} }, '0.0.0')).toThrow('exports');
    expect(() =>
      distributionManifest({ ...source, dependencies: { three: '*' } }, '0.0.0'),
    ).toThrow('outside the packed SDK');
    expect(() =>
      distributionManifest({ ...source, peerDependencies: { undeclared: '*' } }, '0.0.0'),
    ).toThrow('dependency kinds');
  });

  it('rejects a revision that cannot describe the checked-out source', () => {
    expect(() => packSdk({ revision: 'main' })).toThrow('pinned');
    expect(() => packSdk({ revision: '0'.repeat(40) })).toThrow('differs from HEAD');
  });

  it('reproduces bytes and installs, typechecks, bundles and executes outside the workspace', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'aegis-distribution-proof-'));
    try {
      const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }).trim();
      const first = packSdk({ revision, allowDirty: true, outDir: join(temporary, 'first') });
      const second = packSdk({ revision, allowDirty: true, outDir: join(temporary, 'second') });
      expect(first.sourceFiles.length).toBeGreaterThan(20);
      expect(first.packages).toHaveLength(4);
      expect(first.packages.map((item) => item.sha256)).toEqual(
        second.packages.map((item) => item.sha256),
      );
      expect(first.sourceDigest).toBe(second.sourceDigest);
      const result = testStandaloneConsumer({ artifactDir: first.directory });
      expect(result.installed.map((item) => item.name)).toEqual(
        sdkPackages.map((name) => `@aegis/${name}`),
      );
      expect(result.checks).toContain('browser-types');
      expect(result.checks).toContain('headless-types');
      expect(result.checks).toContain('headless-execution');
      expect(result.publicEntries).toContain('@aegis/browser/audio');
      expect(result.browserInputs.length).toBeGreaterThan(4);
      expect(result.browserInputs.every((path) => !path.includes('render-three'))).toBe(true);
      expect(result.trace).toEqual(await runLabs());
      expect(result.trace.kitchen.view.state.events).toEqual([
        'notice:workshop',
        'ready:batch-a',
        'ready:batch-b',
        'arrival:visitor',
        'expiration:reader',
      ]);
      expect(result.trace.story.view.reward).toBe(true);
      expect(result.site.base).toBe('/independent/labs/');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 240_000);
});
