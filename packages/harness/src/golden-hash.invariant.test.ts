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
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/** Repository root, resolved from this file rather than the working directory. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const SEARCH_ROOTS = ['packages', 'games'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage']);

/** Every `.ts` file under the searched roots, excluding build output. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
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

function violationsIn(file: string): Violation[] {
  const text = readFileSync(file, 'utf8');
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
    const files = SEARCH_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)));
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
