/**
 * The one repository-wide invariant the golden-hash lint rule structurally cannot check.
 *
 * `eslint.config.js` bans `hashEquals(<expr>.hash)` outright, and its comment claims something
 * stronger than the rule enforces:
 *
 * > there are zero occurrences of a run's own hash reaching `hashEquals`, by any spelling
 *
 * That claim matters — its whole purpose is that an author blocked by the rule finds no working
 * bypass to copy — and the rule cannot enforce it, because the selector is syntactic and
 * `const h = r.hash; hashEquals(h)` is a different shape. A prose claim about the state of a
 * repository is a test with no runner: true when written, silently rotten later. This is the
 * runner. It failed on `4a98578`, the commit whose comment first made the claim.
 *
 * **It only ever flags what it can prove.** An argument is a violation when it *is* a `.hash`
 * access, or when it is an identifier bound in the same file to an initialiser containing one.
 * Anything it cannot resolve — an imported constant, a computed value — passes. So it has no
 * false positives and a stated blind spot (a golden aliased through another module) rather than
 * an implied guarantee. That is the honest shape for a check whose predecessor was a claim.
 *
 * Lives here because `@aegis/harness` owns `hashEquals`; the tradeoff is that a game's mistake
 * surfaces as a harness test failure. The message names the offending file so that is not
 * misleading.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/** Repository root, resolved from this file rather than the working directory. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const SEARCH_ROOTS = ['packages', 'games'];

/**
 * Every `.ts` file under the searched roots, excluding build output — taken from git rather than
 * from a recursive `readdirSync`.
 *
 * The walk this replaces recursed into whatever happened to be on disk, and other tests put things
 * there: `module-instances.test.ts` in this very package copies the built harness into
 * `packages/harness/.tmp/harness-copy-<random>/` and deletes it in `afterAll`. A walker that
 * enumerates the parent and then reads the child loses the race and dies with ENOENT, taking every
 * case in its file with it — which is how `test/agents-guide-crossrefs.test.ts` failed a gate, and
 * how this file failed one earlier against `packages/cli`'s fixture directories.
 *
 * Both previous repairs added the offending directory to `SKIP_DIRS`. That is a list of the scratch
 * directories somebody has already been bitten by. `--cached --others --exclude-standard` is
 * instead tracked files plus untracked files git is not ignoring: scratch is excluded because the
 * repository declares it scratch, so a directory invented next week is handled without an edit
 * here. `--others` keeps uncommitted source in scope — this invariant has to redden while you are
 * writing the violation, not after you commit it, and the control below plants an untracked file
 * precisely to pin that.
 */
function sourceFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return listed
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        line.endsWith('.ts') &&
        !line.endsWith('.d.ts') &&
        SEARCH_ROOTS.some((root) => line.startsWith(`${root}/`)),
    )
    .map((line) => join(REPO_ROOT, line));
}

/** Whether `node`'s subtree reads a `.hash` property off anything. */
function readsAHash(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'hash') return true;
  return ts.forEachChild(node, readsAHash) === true;
}

/** One `hashEquals(...)` argument that provably carries a run's own hash. */
interface Violation {
  file: string;
  line: number;
  text: string;
  why: string;
}

/**
 * `readFileSync`, for a file that came out of `sourceFiles()` rather than out of a constant.
 *
 * The corpus is a snapshot of a mutable working tree and the read happens after it. A file that has
 * vanished in between is not repository source: it is another test's untracked probe. Measured, in
 * both directions — this file plants `zz-walker-probe.ts` inside `packages/harness/src/`, which
 * `test/agents-guide-crossrefs.test.ts`'s corpus covers, and that file plants
 * `zz-crossrefs-probe.ts` in the same directory, which *this* corpus covers. (`__alias-probe.ts`
 * below is **not** a third: it is a path handed to `ts.createSourceFile` and never written, which
 * was worth checking rather than counting from the variable name.) The second direction is what
 * took this file down mid-gate:
 *
 *     Error: ENOENT: no such file or directory, open
 *       '...\packages\harness\src\zz-crossrefs-probe.ts'
 *
 * Neither probe can move. Each is untracked deliberately, to pin that `--others` keeps uncommitted
 * source in scope, and a probe planted where the guard does not look proves nothing. So this is not
 * the skip-list repair that failed twice before, nor the "plant in your own tree" rule — that rule
 * would have to forbid this file's own probes, which are in its own tree and are the point.
 *
 * Skipping a vanished file is not a weakening: a file that does not exist has no `hashEquals` call
 * to violate anything. What stops it hiding a corpus that collapsed is the floor asserted against
 * the enumeration, which counts what `sourceFiles()` returned rather than what survived the read.
 *
 * Narrow on purpose: only ENOENT is skipped, because "this file is gone" is safe to ignore and
 * "I could not read this file" is not.
 */
function readCorpusFile(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function violationsIn(file: string): Violation[] {
  const text = readCorpusFile(file);
  if (text === undefined) return [];
  if (!text.includes('hashEquals')) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  // Same-file `const x = <init>` bindings, so an aliased hash can be followed one hop.
  const bindings = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const found: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'hashEquals'
    ) {
      const arg = node.arguments[0];
      if (arg) {
        const bound = ts.isIdentifier(arg) ? bindings.get(arg.text) : undefined;
        const why = readsAHash(arg)
          ? 'the argument reads a .hash property'
          : bound && readsAHash(bound)
            ? `the argument is bound to "${bound.getText(source)}", which reads a .hash property`
            : undefined;
        if (why !== undefined) {
          found.push({
            file: relative(REPO_ROOT, file).split('\\').join('/'),
            line: source.getLineAndCharacterOfPosition(arg.getStart(source)).line + 1,
            text: node.getText(source).split('\n')[0]!,
            why,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('golden hashes are pinned, repository-wide', () => {
  it('no hashEquals call is handed a run\u2019s own hash, by any spelling', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50); // the scan actually found the tree

    const violations = files.flatMap(violationsIn);
    const report = violations
      .map((v) => `  ${v.file}:${v.line}  ${v.text}\n      ${v.why}`)
      .join('\n');
    expect(
      violations,
      violations.length === 0
        ? ''
        : `hashEquals must take a pinned literal golden master. A run compared against its own ` +
            `hash can never fail, so these pin nothing:\n${report}\n` +
            `See docs/architecture.md §7 and the golden-hash rule in eslint.config.js.`,
    ).toEqual([]);
  });

  /**
   * The corpus must never include another package's transient scratch directories.
   *
   * This has now bitten twice, in two different directories. First, while the CLI's fixtures were
   * created directly under `packages/cli`, a recursive walk could `readdir` the parent, see a
   * fixture, and `readdir` the child **after** its owning test deleted it:
   *
   * ```
   * Error: ENOENT: no such file or directory, scandir '…/packages/cli/aegis-clitest-02uq7a'
   * ```
   *
   * Then `module-instances.test.ts` — in this package — did the same thing from
   * `packages/harness/.tmp/harness-copy-<random>/`, killing a different repository-wide guard.
   * Both were "add it to the skip list" repairs, and the second one proved the first had not fixed
   * anything: a skip list only ever contains the scratch directories somebody has already lost a
   * gate to. The corpus now comes from git, so anything the repository declares ignorable is out
   * by construction and no future scratch directory has to be foreseen.
   *
   * A race cannot be watched fail on demand, so this control is **deterministic instead of
   * timing-based**, and it carries its own positive half rather than relying on a stashed revert:
   * the same probe file is planted in three locations, and the corpus must contain the one under
   * `packages/` and neither of the two ignored ones. Finding *nothing* would satisfy both exclusion
   * assertions while proving the corpus had collapsed — hence the positive half.
   *
   * The in-tree probe is deliberately never committed, so it also pins `--others`: were the corpus
   * narrowed to tracked files, this guard would stop seeing violations while they were being
   * written and only notice them after they landed.
   */
  it('lists the source tree but not the ignored scratch directories inside it', () => {
    const inTree = join(REPO_ROOT, 'packages', 'harness', 'src', 'zz-walker-probe.ts');
    const scratch = join(REPO_ROOT, 'node_modules', '.aegis-clitest', 'zz-probe-dir');
    const inScratch = join(scratch, 'zz-walker-probe.ts');
    const tmpDir = join(REPO_ROOT, 'packages', 'harness', '.tmp', 'zz-probe-copy');
    const inTmp = join(tmpDir, 'zz-walker-probe.ts');
    const body = 'export const zzWalkerProbe = 1;\n';
    mkdirSync(scratch, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(inTree, body, 'utf8');
    writeFileSync(inScratch, body, 'utf8');
    writeFileSync(inTmp, body, 'utf8');
    try {
      const files = sourceFiles();
      // Anti-vacuity, twice over: the corpus must still be finding the tree at all, and it must be
      // able to find a file of exactly this shape — or "it missed the scratch copies" means nothing.
      expect(files.length).toBeGreaterThan(50);
      expect(
        files.filter((f) => f === inTree),
        'the corpus did not contain a plain .ts file planted in packages/harness/src, so its ' +
          'failure to contain the scratch copies below proves nothing about what it excludes',
      ).toEqual([inTree]);

      expect(
        files.filter((f) => f.includes('.aegis-clitest')),
        'the repository corpus included a live test fixture directory. Those are created and ' +
          'deleted while other suites run, so reading them can ENOENT on a directory that ' +
          'vanished between listing it and opening it.',
      ).toEqual([]);

      expect(
        files.filter((f) => f.includes(`${'.tmp'}`)),
        'the repository corpus included packages/harness/.tmp, where module-instances.test.ts ' +
          'copies the built harness and deletes it in afterAll. Reading it races that delete.',
      ).toEqual([]);
    } finally {
      rmSync(inTree, { force: true });
      rmSync(scratch, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('survives a corpus file that another suite deletes mid-run, and only that', () => {
    // The tolerance in `readCorpusFile` is a swallow, and a swallow has to be shown to be narrow or
    // it is indistinguishable from `catch {}`. Two arms, one variable.
    //
    // Deterministic rather than timing-based: the race cannot be watched on demand, so the quantity
    // underneath it is driven directly instead of sampling the outcome.
    const vanished = join(REPO_ROOT, 'packages', 'harness', 'src', 'zz-vanished-probe.ts');
    expect(violationsIn(vanished)).toEqual([]);

    // …and a read that fails for any other reason must still throw, or this would hide a corpus
    // that had become unreadable rather than one that had shrunk. A directory reads as EISDIR.
    expect(() => violationsIn(join(REPO_ROOT, 'packages'))).toThrow(/EISDIR/);

    // Anti-vacuity for the first arm: a file that *is* there and *does* violate must still be
    // reported, or "returns []" above would be satisfied by a function that always returns [].
    const present = join(REPO_ROOT, 'packages', 'harness', 'src', 'zz-present-probe.ts');
    writeFileSync(
      present,
      'declare const r: { hash: string };\n' +
        'declare const e: { hashEquals(h: string): void };\n' +
        'e.hashEquals(r.hash);\n',
      'utf8',
    );
    try {
      expect(violationsIn(present).length).toBeGreaterThan(0);
    } finally {
      rmSync(present, { force: true });
    }
  });

  it('detects the aliased bypass that the lint rule cannot see', () => {
    // The guard for the guard: this is the exact shape `eslint.config.js` documents as evading
    // its selector, so the test above is only meaningful if this fails.
    const file = join(REPO_ROOT, 'packages', 'harness', 'src', '__alias-probe.ts');
    const probe = ts.createSourceFile(
      file,
      'declare const r: { hash: string };\n' +
        'declare const e: { hashEquals(h: string): void };\n' +
        'const h = r.hash;\n' +
        'e.hashEquals(h);\n',
      ts.ScriptTarget.Latest,
      true,
    );
    // Re-run the same detection against the probe source, without touching the filesystem.
    const bindings = new Map<string, ts.Expression>();
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        bindings.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collect);
    };
    collect(probe);
    let caught = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'hashEquals'
      ) {
        const arg = node.arguments[0]!;
        const bound = ts.isIdentifier(arg) ? bindings.get(arg.text) : undefined;
        if (readsAHash(arg) || (bound && readsAHash(bound))) caught = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(probe);
    expect(caught).toBe(true);
  });
});
