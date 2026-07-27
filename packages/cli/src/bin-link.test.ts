/**
 * The `aegis` bin must be linkable on a clean clone (`AGENTS.md` §1.5).
 *
 * npm creates `node_modules/.bin/aegis` during install and **only links a `bin` whose target
 * already exists**. While `bin` pointed at `dist/main.js` — which a clean clone does not have —
 * `npm ci` linked nothing and `npx aegis` failed with `could not determine executable to run`,
 * naming neither this package nor the build. The documented workaround was to run `npm install` a
 * second time.
 *
 * Measured on a detached worktree at the fixing commit, `npm ci` and nothing else:
 *
 * ```
 * before build:  .bin/aegis True   .bin/aegis.cmd True
 * npx aegis --help  ->  "[aegis] this checkout has no build yet: ...", exit 69
 * after `npm run build`, with no second install:
 * npx aegis --help  ->  exit 0
 * npx aegis validate games/platformer/levels/coyote-gap.scene.json  ->  exit 0
 * ```
 *
 * This file guards the property that made that possible — that the declared `bin` target is a
 * committed file — because it is invisible from inside a working checkout, where `dist` exists and
 * everything looks fine. Only a clean clone can tell, and by then it is CI's problem.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Manifest {
  bin?: Record<string, string>;
  files?: string[];
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as Manifest;

describe('the aegis bin survives a clean clone', () => {
  it('declares exactly one bin, named aegis', () => {
    // The precondition: if the field vanished or were renamed, every assertion below would be
    // checking something that is no longer the executable users invoke.
    expect(Object.keys(manifest.bin ?? {})).toEqual(['aegis']);
  });

  it('points at a file that exists in the repository, not at build output', () => {
    const target = manifest.bin!['aegis']!;
    const abs = isAbsolute(target) ? target : join(PACKAGE_ROOT, target);

    expect(
      existsSync(abs),
      `package.json bin.aegis -> ${target}, which does not exist in a checkout. npm only links a ` +
        `bin whose target is already on disk, so a clean clone would get no \`aegis\` command at ` +
        `all and \`npx aegis\` would fail with "could not determine executable to run".`,
    ).toBe(true);

    // The specific regression: pointing back at `dist` passes the existence check on any machine
    // that has built, and fails on every clean clone. That asymmetry is what made it survive.
    expect(
      target.replace(/\\/g, '/').includes('dist/'),
      `bin.aegis -> ${target} is inside dist/, which exists here only because this checkout has ` +
        `been built. Point it at a committed file that forwards to the build.`,
    ).toBe(false);
  });

  it('ships the bin directory, so a packed tarball keeps the executable', () => {
    expect(manifest.files ?? []).toContain('bin');
  });

  it('reports an unbuilt checkout instead of failing to exist', () => {
    const target = manifest.bin!['aegis']!;
    const source = readFileSync(join(PACKAGE_ROOT, target), 'utf8');
    // The value of the shim is entirely in what it says when `dist` is absent — otherwise it has
    // merely moved the confusing failure one layer along.
    expect(source).toContain('npm run build');
    expect(source).toMatch(/^#!/);
  });
});
