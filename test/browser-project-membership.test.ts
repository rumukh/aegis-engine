import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every test file that launches a browser must be in the root config's `BROWSER_TEST_FILES`.
 *
 * That list is not a preference. It is the whole of the fix for the only failure this repository's
 * CI has produced repeatedly: thirteen consecutive red `windows-latest` legs, all seven of their
 * failures inside `browser-playability.test.ts`, none of them a statement about the product. The
 * file's own CPU sampler printed the cause — *"this process held a CPU only 0% of the window — it
 * was NOT SCHEDULED, so the box is oversubscribed by something outside this process"* — and
 * *outside this process* was the other seventy files of this suite, plus the Chromium and
 * SwiftShader processes vitest's pool cannot see and therefore cannot account for. Naming the file
 * in a project of its own is what stops those from being scheduled against each other.
 *
 * A hardcoded list is exactly as good as the thing that notices when it goes stale, and nothing
 * else would. A third browser test added to `packages/render-three/src/` would be discovered by
 * the `suite` project's globs, run green on a 16-core development box, and reintroduce the
 * contention on `windows-latest` alone — the failure this repository has already spent thirteen
 * runs and one `AGENTS.md` §9 row on. There is no error at the moment of the edit, and the
 * regression arrives on the leg the author is least likely to be watching.
 *
 * The scan is over source text rather than over an import graph because that is the property that
 * matters: a file that *mentions* `launchBrowser(` is a file that will start a browser when it
 * runs, whatever it imported to get there.
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * This file, which is excluded from its own scan because it necessarily contains what it searches
 * for — both in the scan itself and in the prose above explaining why the scan exists.
 *
 * Derived from `import.meta.url` rather than written down, so the exclusion cannot grow. A literal
 * list of "files exempt from the browser check" is the one edit that would quietly reintroduce the
 * failure this guard exists to prevent, and this shape makes that edit impossible to express.
 */
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url)).replaceAll('\\', '/');

/** The directories the root config globs for tests, minus the browser files' own home. */
const TEST_ROOTS = ['packages', 'games', 'test'];

/** Directories that are build output or dependencies, and so are not anybody's source. */
const NOT_SOURCE = new Set(['node_modules', 'dist', '.git']);

/** Every `*.test.ts` / `*.spec.ts` under a root, as repo-relative POSIX paths. */
function testFilesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (NOT_SOURCE.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(test|spec)\.ts$/.test(entry.name))
        found.push(relative(REPO_ROOT, full).replaceAll('\\', '/'));
    }
  };
  walk(join(REPO_ROOT, root));
  return found;
}

/**
 * Reads the declared list out of the config source.
 *
 * Reading the declaration rather than importing the config keeps this guard honest about *what the
 * file says*: an import would hand back whatever vitest resolved, which is the same value by a
 * route that cannot distinguish a list from a list-shaped accident.
 */
function declaredBrowserTestFiles(source: string): string[] {
  const block = /const BROWSER_TEST_FILES = \[([^\]]*)\]/.exec(source)?.[1];
  if (block === undefined) {
    throw new Error(
      'vitest.config.ts no longer declares BROWSER_TEST_FILES. If the browser tests have been ' +
        'merged back into the main pass, delete this guard and AGENTS.md §9 row 7 together — ' +
        'do not leave a guard reading a name that is gone.',
    );
  }
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('the browser tests are isolated from the rest of the suite', () => {
  const configSource = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8').replaceAll(
    '\r\n',
    '\n',
  );
  const declared = declaredBrowserTestFiles(configSource);
  const everyTestFile = TEST_ROOTS.flatMap(testFilesUnder);
  const launchesABrowser = everyTestFile
    .filter((path) => path !== SELF)
    .filter((path) => readFileSync(join(REPO_ROOT, path), 'utf8').includes('launchBrowser('))
    .sort();

  it('found a corpus to check (anti-vacuity)', () => {
    // Without this, every assertion below is satisfied by a walker that returned nothing — the
    // failure this repository has hit more often than any other. The floors are deliberately far
    // below today's counts (72 files, 2 of them browser files) so this arm reports a broken
    // instrument, not a changed suite.
    expect(everyTestFile.length).toBeGreaterThan(50);
    expect(launchesABrowser.length).toBeGreaterThan(1);
    expect(declared.length).toBeGreaterThan(1);
    // The self-exclusion must be excluding something real: if this file stopped being found by
    // the walker, the arm above would be scanning a corpus that silently omits a directory.
    expect(everyTestFile).toContain(SELF);
  });

  it('names every browser-launching test file, and nothing else', () => {
    expect(
      launchesABrowser,
      'A test file calls launchBrowser( but is not in BROWSER_TEST_FILES in vitest.config.ts, so ' +
        'vitest will schedule it beside the other ~70 files of this suite. On a 4-vCPU runner ' +
        'that is the exact contention that made thirteen consecutive windows-latest legs red — ' +
        'and it will run green here and on ubuntu-latest, so nothing else will tell you. Add it ' +
        'to that list.',
    ).toEqual([...declared].sort());
  });

  it('the scan can answer both ways', () => {
    // Control. A reader that reported "contains launchBrowser(" for every input would satisfy the
    // arm above while proving nothing, and one that reported it for none would satisfy it too.
    const notABrowserTest = join(REPO_ROOT, 'test', 'vitest-timeouts.test.ts');
    expect(readFileSync(notABrowserTest, 'utf8')).not.toContain('launchBrowser(');
    expect(launchesABrowser.length).toBeLessThan(everyTestFile.length);
  });

  it('gives the browser project a pass of its own, in a group of its own', () => {
    // The list is inert without the settings that act on it, and each is one deletion away from a
    // config that still declares the list and no longer separates anything.
    expect(configSource).toMatch(/name: 'browser'/);
    expect(configSource).toMatch(/sequence: \{ groupOrder: 1 \}/);
    // ...and the other project must both exist and run first, or "a group of its own" is a group
    // containing everything.
    expect(configSource).toMatch(/name: 'suite'/);
    expect(configSource).toMatch(/sequence: \{ groupOrder: 0 \}/);
    expect(configSource).toContain('...defaultExclude, ...BROWSER_TEST_FILES');
  });

  it('serializes the browser files against each other, by a setting that projects honour', () => {
    // Separating the browser files from the suite and then running them against *each other* is a
    // half-fix that reports as a whole one, and it is what the first green run of this split
    // actually did: the two files ran 20–80s and 29–46s, overlapping for seventeen seconds, while
    // every other file had finished by 20s. The cause was `fileParallelism: false`, which reads
    // exactly like the setting for this and is listed in vitest's `NonProjectOptions` — root-level
    // only, ignored here. This arm pins the setting that projects actually honour, and refuses the
    // one that looks like it.
    expect(configSource).toMatch(/forks: \{ singleFork: true \}/);
    expect(configSource).toMatch(/threads: \{ singleThread: true \}/);
    expect(
      /^\s*fileParallelism:/m.test(configSource),
      "fileParallelism is in vitest's NonProjectOptions: setting it inside a project does " +
        'nothing, and setting it at root level would serialize all 70 other files too. Use ' +
        'poolOptions.forks.singleFork on the browser project.',
    ).toBe(false);
  });
});
