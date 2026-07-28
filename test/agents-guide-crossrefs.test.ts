/**
 * Every `AGENTS.md` citation in the source tree must point at something that exists.
 *
 * `AGENTS.md` §9 is a numbered table of rough edges, and source comments cite its rows to explain
 * why a regression test exists. Those citations used to name a **row number**. A row number is an
 * index into a list that nothing validates, so deleting a row silently invalidates every citation
 * below it — which is exactly what happened: one commit removed a row that measured false, and
 * four correct citations in four files became wrong at once, with nothing red and nothing to
 * notice. The section that warns about one source copied into many channels acquired an unguarded
 * index into itself.
 *
 * Renumbering the citations would only postpone it to the next edit, so a citation now quotes a
 * distinctive fragment of the row's own **title**. A title survives insertion, deletion and
 * reordering; if the row it names is genuinely removed, this test goes red and a human decides
 * whether the citing test still has a subject. That is the correct outcome — a dangling citation
 * is a question, not a formatting error.
 *
 * ## What is checked
 *
 * 1. Every cited section (`§1.5`, `§6.4`, `§9`) resolves to a heading in `AGENTS.md`.
 * 2. Every quoted fragment (`§9, "names its plugin as a string"`) appears in exactly **one** §9
 *    row. Zero means the row moved or went; more than one means the fragment is too weak to
 *    identify anything, which is the same failure a stale number has.
 * 3. No citation uses the bare `§9 #6` row-number form at all. This is the rule that matters:
 *    the other two only catch a citation that has already broken, while this one removes the
 *    mechanism.
 *
 * ## Why the anti-vacuity floors are here
 *
 * Every check above is a `for` loop over a corpus this file discovers for itself. A walker with a
 * wrong root, a regex that stopped matching, or a heading format that changed would produce an
 * empty corpus — and an empty corpus passes every one of them. That reads as "all citations are
 * valid" and means "no citations were examined". So the corpus sizes are asserted first, and the
 * checks below are only meaningful because those assertions ran.
 */
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

/** Working-tree files are CRLF here; every pattern below is written against `\n`. */
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/**
 * `read`, for a file that came out of a corpus rather than out of a constant.
 *
 * `sourceFiles()` is a snapshot of a mutable working tree and the read happens after it. A file
 * that has vanished in between is not repository source: it is another test's untracked probe.
 * This is measured, not hypothetical, and it runs in **both** directions —
 * `packages/harness/src/golden-hash.invariant.test.ts` plants `zz-walker-probe.ts` inside
 * `packages/`, which this corpus covers, and this file plants `zz-crossrefs-probe.ts` inside
 * `packages/harness/src/`, which its corpus covers. Neither can
 * stop: each probe is untracked *on purpose*, to pin that `--others` keeps uncommitted source in
 * scope, and a probe planted somewhere the guard does not look would prove nothing.
 *
 * So the collision cannot be removed by moving the probes, only by accepting that the snapshot can
 * age. Skipping a vanished file is not a weakening — a file that does not exist contains no
 * citation. What stops this from hiding a corpus that collapsed to nothing is the floor in
 * 'the corpus reaches real source…', which is asserted against the enumeration and not against
 * what survived the read.
 *
 * The tolerance is deliberately narrow. Only ENOENT is skipped; any other read error still throws,
 * because "I could not read this file" and "this file is not there any more" are different facts
 * and only the second one is safe to ignore.
 */
function readCorpusFile(p: string): string | undefined {
  try {
    return read(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

const guide = read(join(root, 'AGENTS.md'));

const SOURCE_ROOTS = ['packages', 'games', 'test', 'scripts', 'poc'];

/**
 * The corpus comes from git, not from a filesystem walk, and that is a correctness decision rather
 * than a tidy-up.
 *
 * A recursive `readdirSync` cannot tell an authored source file from a copy some other test made
 * ninety milliseconds ago and is about to delete. `packages/harness/src/module-instances.test.ts`
 * copies the built harness into `packages/harness/.tmp/harness-copy-<random>/` and removes it in
 * `afterAll`; this walker recursed into it and died mid-run:
 *
 *     ENOENT: no such file or directory, open '...packages/harness/.tmp/harness-copy-GDXFxB/
 *     verification.js'
 *
 * Nine unrelated cases were lost with it. That is the third sighting of this defect class in this
 * repository, after `packages/cli`'s fixture directories took down two other files, and the
 * previous two repairs were both "add the new directory to a skip list" — which works until the
 * next test invents a scratch directory nobody has heard of.
 *
 * `--cached --others --exclude-standard` is tracked files plus untracked files that git is not
 * ignoring. Scratch directories are ignored (`.gitignore` line 8 is `.tmp/`), so they are excluded
 * by the repository's own declaration instead of by a list maintained here, and no future one can
 * reintroduce the race. `--others` matters: a source file written but not yet committed is still a
 * source file, and dropping it would turn this guard into something that only checks history.
 */
function sourceFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return listed
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        /\.(ts|mts|cts|js|mjs|cjs)$/.test(line) &&
        SOURCE_ROOTS.some((dir) => line.startsWith(`${dir}/`)),
    )
    .map((line) => join(root, line));
}

/** Section ids declared by headings: `## 9. Rough edges` and `### 1.5 Setup` both count. */
function declaredSections(): Set<string> {
  const ids = new Set<string>();
  for (const line of guide.split('\n')) {
    const m = /^#{1,4} (\d+(?:\.\d+)*)\.? /.exec(line);
    const id = m?.[1];
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/**
 * The bolded lead of each `| n | **Title.** …` row in the §9 table. Matching against the whole
 * row would let a citation "resolve" against prose in the *work around it by…* column, which is
 * not a name for anything.
 */
function rowTitles(): string[] {
  const titles: string[] = [];
  for (const line of guide.split('\n')) {
    const m = /^\|\s*\d+\s*\|\s*\*\*(.+?)\*\*/.exec(line);
    const title = m?.[1];
    if (title !== undefined) titles.push(title);
  }
  return titles;
}

interface Citation {
  file: string;
  line: number;
  section: string;
  /** Text immediately following the section id, where a `#n` or a `"fragment"` would appear. */
  tail: string;
}

const CITATION = /`?AGENTS\.md`?[^\n§]{0,40}§\s*(\d+(?:\.\d+)*)/g;

function citations(): Citation[] {
  const found: Citation[] = [];
  for (const file of sourceFiles()) {
    const text = readCorpusFile(file);
    if (text === undefined) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(CITATION)) {
        const section = m[1];
        if (section === undefined) continue;
        found.push({
          file: file.slice(root.length + 1).replace(/\\/g, '/'),
          line: i + 1,
          section,
          tail: line.slice((m.index ?? 0) + m[0].length),
        });
      }
    });
  }
  return found;
}

const SECTIONS = declaredSections();
const TITLES = rowTitles();
const CITED = citations();

/** A quoted fragment on the same line as the citation, e.g. `§9, "names its plugin as a string"`. */
function quotedFragment(tail: string): string | undefined {
  return /^\s*,\s*"([^"]+)"/.exec(tail)?.[1];
}

/** The retired form: a bare row index, e.g. `§9 #6`. */
function rowNumber(tail: string): string | undefined {
  return /^\s*#(\d+)/.exec(tail)?.[1];
}

describe('AGENTS.md citations resolve', () => {
  it('the corpora are non-empty, so the checks below examined something', () => {
    // Floors, not exact counts: exact counts would redden on every unrelated edit, which trains
    // people to update the number without reading why it moved.
    expect(SECTIONS.size, 'no numbered headings parsed out of AGENTS.md').toBeGreaterThan(20);
    expect(TITLES.length, 'no §9 rough-edge rows parsed out of AGENTS.md').toBeGreaterThanOrEqual(
      5,
    );
    expect(CITED.length, 'no AGENTS.md citations found in the source tree').toBeGreaterThanOrEqual(
      6,
    );
  });

  it('every cited section exists', () => {
    const dangling = CITED.filter((c) => !SECTIONS.has(c.section)).map(
      (c) => `${c.file}:${c.line} cites §${c.section}, which is not a heading in AGENTS.md`,
    );
    expect(dangling).toEqual([]);
  });

  it('every quoted row fragment names exactly one row', () => {
    const problems: string[] = [];
    for (const c of CITED) {
      const fragment = quotedFragment(c.tail);
      if (fragment === undefined) continue;
      const hits = TITLES.filter((t) => t.includes(fragment));
      if (hits.length !== 1) {
        problems.push(
          `${c.file}:${c.line} quotes "${fragment}", which matches ${hits.length} §9 rows ` +
            `(want exactly 1). Either the row changed, or the fragment is too weak to name one.`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('no citation uses a bare row number', () => {
    const numeric = CITED.filter((c) => rowNumber(c.tail) !== undefined).map(
      (c) =>
        `${c.file}:${c.line} cites §${c.section} #${rowNumber(c.tail)} by number. Quote a ` +
        `fragment of the row's title instead — a number silently retargets when a row is removed.`,
    );
    expect(numeric).toEqual([]);
  });
});

describe('the guard can actually fail', () => {
  // Without these, every assertion above is a loop that a broken parser satisfies by iterating
  // nothing. Each control drives the same predicate the real check uses.

  it('rejects a section that does not exist', () => {
    expect(SECTIONS.has('9')).toBe(true);
    expect(SECTIONS.has('99.99')).toBe(false);
  });

  it('rejects a fragment that names no row', () => {
    // Stated as a throw rather than a `!`: if the table is empty this control is examining
    // nothing, and the run should say so out loud instead of failing on an index.
    const first = TITLES[0];
    if (first === undefined)
      throw new Error('the §9 table has no rows, so this control cannot run');
    const real = first.slice(0, 24);
    expect(TITLES.filter((t) => t.includes(real))).toHaveLength(1);
    expect(TITLES.filter((t) => t.includes('a rough edge nobody wrote down'))).toHaveLength(0);
  });

  it('recognises the retired row-number form', () => {
    expect(rowNumber(' #6: the scaffolded test')).toBe('6');
    expect(rowNumber(', "names its plugin as a string")')).toBeUndefined();
  });

  it('reads a quoted fragment only when one is actually there', () => {
    expect(quotedFragment(', "names its plugin as a string")')).toBe(
      'names its plugin as a string',
    );
    expect(quotedFragment(' makes the general argument')).toBeUndefined();
  });

  it('survives a corpus file that another suite deletes mid-run, and only that', () => {
    // Same argument as `packages/harness/src/golden-hash.invariant.test.ts`'s copy of this case,
    // and it is deliberately not shared code: each guard owns its own corpus reader, so each has
    // to show its own swallow is narrow. Two arms plus an anti-vacuity arm, driven directly
    // because a race cannot be watched fail on demand.
    const vanished = join(root, 'packages', 'harness', 'src', 'zz-vanished-probe.ts');
    expect(readCorpusFile(vanished)).toBeUndefined();

    // Any other read failure must still throw, or an unreadable corpus would look like an empty
    // one — which is this repository's most-repeated defect, not a thing to install on purpose.
    expect(() => readCorpusFile(join(root, 'packages'))).toThrow(/EISDIR/);

    // And a file that is there must still be read, or `toBeUndefined()` above would be satisfied
    // by a reader that returns undefined for everything.
    const present = join(root, 'test', 'zz-present-probe.ts');
    writeFileSync(present, 'export const zzPresentProbe = 1;\n', 'utf8');
    try {
      expect(readCorpusFile(present)).toContain('zzPresentProbe');
    } finally {
      rmSync(present, { force: true });
    }
  });

  it('the corpus reaches real source, skips node_modules, and skips ignored scratch', () => {
    // Three claims, and the third is the one this instrument was rebuilt for. A guard that
    // "found nothing" would satisfy the exclusion claims trivially, so the inclusion claims are
    // asserted in the same case: a corpus that collapses takes them down with it.
    const ignoredDir = join(root, 'packages', 'harness', '.tmp', 'zz-crossrefs-probe');
    const ignoredFile = join(ignoredDir, 'verification.ts');
    const untrackedFile = join(root, 'packages', 'harness', 'src', 'zz-crossrefs-probe.ts');
    try {
      mkdirSync(ignoredDir, { recursive: true });
      // A bare numeric citation: were this picked up, check 3 above would redden on a file that
      // no one committed and that is about to delete itself. The literal is split so that this
      // line is not itself a citation — the corpus includes this file, and writing the marker
      // whole here reddens check 3 for real. (It did, the first time this control was run.)
      writeFileSync(ignoredFile, '// AGENTS' + '.md \u00a79 #3\n', 'utf8');
      writeFileSync(untrackedFile, '// no citation here\n', 'utf8');

      const files = sourceFiles().map((f) => f.slice(root.length + 1).replace(/\\/g, '/'));
      expect(files.length).toBeGreaterThan(50);
      expect(files.filter((f) => f.includes('node_modules'))).toEqual([]);
      // Ignored scratch is out — by the repository's ignore rules, not by a list kept here.
      expect(files.filter((f) => f.includes('/.tmp/'))).toEqual([]);
      // Uncommitted source is in, or this guard would only ever check history.
      expect(files).toContain('packages/harness/src/zz-crossrefs-probe.ts');
      // And the real corpus is still there alongside the probes.
      expect(files).toContain('test/agents-guide-crossrefs.test.ts');
    } finally {
      rmSync(ignoredDir, { recursive: true, force: true });
      rmSync(untrackedFile, { force: true });
    }
  });
});
