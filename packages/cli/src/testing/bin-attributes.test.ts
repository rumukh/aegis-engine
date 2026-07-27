/**
 * Anything npm will bin-link must be **LF in the working tree**, on every platform.
 *
 * `npm ci` rewrites a bin target's shebang line to end with LF when it links it. On a checkout with
 * `core.autocrlf=true` — this project's Windows workstations, and `windows-latest` runners by
 * default — git has already smudged the file to CRLF, so after the install line 1 ends LF and the
 * rest end CRLF. `.prettierrc.json` sets `"endOfLine": "auto"`, which infers one expected ending per
 * file, so the mixed file fails `prettier --check` and `npm run verify` exits 1 at the lint step —
 * **only on Windows**, which splits the CI matrix in the one way that is indistinguishable from a
 * real cross-OS determinism finding.
 *
 * `.gitattributes` fixes it by forcing LF for bin directories. This asserts the *general* property
 * rather than that one file: **every path any workspace declares as a `bin` must resolve
 * `eol=lf`**. The expectation is derived from the mechanism — "npm rewrites shebangs, so the file
 * must already be LF" — not recorded from today's behaviour, so a bin target added next year gets a
 * red here instead of a Windows-only CI mystery.
 *
 * Two controls, because this is exactly the shape of test that goes quietly vacuous:
 *
 * 1. **The corpus must be non-empty.** `main` currently declares *zero* bin targets, so a test
 *    written against it would pass by finding nothing to check. The count is asserted and printed.
 * 2. **`git check-attr` must discriminate.** If it answered `lf` for everything, agreement with it
 *    would prove nothing about the rule, so a path that is deliberately *not* a bin target must
 *    come back with a different answer.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Repository root — this file sits at `packages/cli/src/testing/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

interface Manifest {
  workspaces?: string[];
  bin?: string | Record<string, string>;
}

/** Read a `package.json`, or `undefined` if there is none. */
function manifestAt(dir: string): Manifest | undefined {
  const path = join(dir, 'package.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Manifest) : undefined;
}

/**
 * Every workspace directory, expanded from the root manifest's globs.
 *
 * Only the `dir/*` shape this repository uses is expanded — deliberately, rather than pulling in a
 * glob library: an unsupported pattern must make the corpus *shrink*, which control 1 then catches,
 * instead of being silently skipped.
 */
function workspaceDirs(): string[] {
  const root = manifestAt(REPO_ROOT);
  const dirs: string[] = [];
  for (const pattern of root?.workspaces ?? []) {
    if (!pattern.endsWith('/*')) continue;
    const parent = join(REPO_ROOT, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(parent, entry.name));
    }
  }
  return dirs;
}

/** One declared executable: the workspace that declares it and its repo-relative path. */
interface BinTarget {
  workspace: string;
  name: string;
  path: string;
}

/** Every `bin` entry declared by any workspace, as repo-relative POSIX paths. */
function binTargets(): BinTarget[] {
  const targets: BinTarget[] = [];
  for (const dir of workspaceDirs()) {
    const manifest = manifestAt(dir);
    const bin = manifest?.bin;
    if (bin === undefined) continue;
    const entries = typeof bin === 'string' ? { [dir]: bin } : bin;
    for (const [name, target] of Object.entries(entries)) {
      targets.push({
        workspace: relative(REPO_ROOT, dir).split('\\').join('/'),
        name,
        path: relative(REPO_ROOT, resolve(dir, target)).split('\\').join('/'),
      });
    }
  }
  return targets;
}

/** The `eol` attribute git resolves for `path`, e.g. `lf` or `unspecified`. */
function eolAttribute(path: string): string {
  const out = execFileSync('git', ['check-attr', 'eol', '--', path], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return (out.trim().split(': ').pop() ?? '').trim();
}

const targets = binTargets();

describe('every declared bin target is LF in the working tree', () => {
  it('found bin targets to check at all', () => {
    // Control 1. Without this the suite passes by enumerating nothing — and `main` really does
    // declare zero bin targets today, so that is not a hypothetical.
    expect(
      targets.length,
      'no workspace declares a "bin", so every assertion below checks nothing. If a bin was ' +
        'removed on purpose, delete this file; if the enumeration broke, fix it.',
    ).toBeGreaterThan(0);
  });

  it('git check-attr discriminates, so agreement with it means something', () => {
    // Control 2. If check-attr answered `lf` for every path, the assertions below would agree with
    // it for reasons that have nothing to do with .gitattributes.
    expect(eolAttribute('packages/cli/src/index.ts')).not.toBe('lf');
    expect(eolAttribute('package.json')).not.toBe('lf');
  });

  it.each(targets.map((t) => ({ label: `${t.workspace} bin "${t.name}" -> ${t.path}`, ...t })))(
    '$label',
    ({ path, workspace, name }) => {
      expect(
        existsSync(join(REPO_ROOT, path)),
        `${workspace} declares bin "${name}" -> ${path}, which does not exist in a checkout. ` +
          `npm only links a bin whose target is already on disk.`,
      ).toBe(true);

      expect(
        eolAttribute(path),
        `${path} is bin-linked by npm, which rewrites its shebang line to LF on install. Without ` +
          `eol=lf the working-tree copy is CRLF, the install leaves it mixed, and ` +
          `prettier --check fails on Windows only. Add a rule covering it to .gitattributes.`,
      ).toBe('lf');
    },
  );
});
