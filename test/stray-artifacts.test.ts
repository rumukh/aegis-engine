/**
 * No editor or merge leftover may be committed.
 *
 * `packages/render-three/src/bindings.ts.bak` — a 228-line dead copy of a live source file —
 * sat tracked in a branch that passed `npm run verify` cleanly, and would have landed on `main`
 * unnoticed. Nothing in the gate could see it: `eslint` and `tsc` are pointed at `.ts` under
 * known roots, `prettier --check .` does not recognise `.bak` as a language it formats, and the
 * test suite only runs files matching `*.test.ts`. A stale copy of a source file is the exact
 * defect the guide's §9 exists to describe — one source, many channels, no instrument — and here
 * the channel was invisible to every instrument the project owns.
 *
 * The repair is not "delete that file". It is to make the class unlandable, because the reason it
 * survived is structural: every existing check asks "is this file well-formed?" of files it knows
 * about, and none asks "should this file exist at all?".
 *
 * **The corpus is `git ls-files`, deliberately, and not a filesystem walk.** The claim being made
 * is about what is *committed*, not about what happens to be lying in someone's working tree. A
 * walker would redden this suite for a colleague's untracked `notes.bak`, which is not a defect
 * and would train people to ignore the guard — and a guard people route around is worse than no
 * guard, because it still reads as protection. Reading the index also means staging a stray is
 * enough to fail, so it is caught before the commit rather than after.
 *
 * Anti-vacuity matters more here than in most guards. The check is "no member of a corpus has a
 * property", which is satisfied perfectly by an empty corpus — and an empty corpus is exactly
 * what a `git` invocation that failed, ran in the wrong directory, or changed its output format
 * would produce. That failure would present as a permanent, silent pass. So the corpus size is
 * asserted first, and the predicate is separately shown to be capable of both answers.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Suffixes that only ever name a leftover.
 *
 * Each is produced by a tool rather than typed by a person: `.bak` by hand-editing and by some
 * editors, `.orig`/`.rej` by `git merge` and `patch`, `.swp` by vim, and a trailing `~` by emacs
 * and by many Unix editors. None is a source extension in this repository.
 */
const STRAY_SUFFIXES = ['.bak', '.orig', '.rej', '.swp', '~'] as const;

/** Whether a repository-relative path names a leftover rather than a source file. */
function isStray(path: string): boolean {
  return STRAY_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/** Every path in the index, which is what "committed" means for a change being prepared. */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((entry) => entry.length > 0);
}

describe('no editor or merge leftover is committed', () => {
  const tracked = trackedFiles();

  it('sees the repository at all (anti-vacuity)', () => {
    // A floor, not an exact count: an exact count teaches people to update the number instead of
    // asking why it moved. The named files pin that this is *this* repository and that paths are
    // repository-relative with forward slashes, which is what the suffix check assumes.
    expect(tracked.length).toBeGreaterThan(100);
    expect(tracked).toContain('package.json');
    expect(tracked).toContain('packages/render-three/src/bindings.ts');
  });

  it('tracks no stray artifact', () => {
    const strays = tracked.filter(isStray);
    expect(
      strays,
      strays.length === 0
        ? ''
        : `These are committed leftovers, not source:\n  ${strays.join('\n  ')}\n` +
            'Delete them (`git rm`). A stale copy of a live file is invisible to lint, tsc, ' +
            'prettier and the test suite, so nothing else in the gate will ever mention it.',
    ).toEqual([]);
  });

  it('can actually fail: the predicate fires on every suffix it claims to cover', () => {
    // Without this, a typo in STRAY_SUFFIXES would leave the check above passing over a predicate
    // that answers `false` to everything — the same permanent green an empty corpus gives.
    for (const suffix of STRAY_SUFFIXES) {
      expect(isStray(`packages/render-three/src/bindings.ts${suffix}`), suffix).toBe(true);
    }
  });

  it('can actually pass: the predicate clears the real source files it sits beside', () => {
    // The other half. A predicate that answered `true` to everything would also make the check
    // above meaningful-looking, and would redden on the first run — but only once someone
    // committed anything, which is too late to learn it from.
    for (const path of ['packages/render-three/src/bindings.ts', 'package.json', 'AGENTS.md']) {
      expect(isStray(path), path).toBe(false);
    }
  });
});
