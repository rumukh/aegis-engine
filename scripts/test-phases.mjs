/**
 * Split the suite into the files that may share a machine and the files that may not.
 *
 * WHY THIS EXISTS — measured on `windows-latest`, run 30377421271, tree `39301d9`.
 *
 * Seven cases in `packages/render-three/src/browser-playability.test.ts` failed. The deadline
 * instrument landed for exactly this question printed the answer:
 *
 *   no reply to Runtime.evaluate (id 13) after 34779ms ... the 30000ms deadline fired 4778ms
 *   LATE, and this process's own event loop lagged up to 11885ms over 42 sample(s) of ~696 due
 *   ... this process held a CPU only 0% of the window — it was NOT SCHEDULED
 *
 *   no reply to Runtime.evaluate (id 153) after 40745ms ... lagged up to 40695ms over
 *   2 sample(s) of ~815 due ... held a CPU only 0% of the window — it was NOT SCHEDULED
 *
 * A sampler owing ~700 readings and taking 42 is not a quiet loop; it is a starved one. Both
 * failures report this process getting **no CPU at all** for tens of seconds. That is not a
 * browser wedge and not a synchronous block here — it is oversubscription, and the browser
 * specs are the ones that cannot survive it, because everything they measure is a wall-clock
 * observation of a page that has to be scheduled to be observed.
 *
 * Who was competing was measured too, from the same log: `browser-diagnostics` emitted between
 * 18:28:11 and 18:28:20, inside `browser-playability`'s 18:17:31-18:29:31 window. So the suite
 * was running **two Chromes doing software 3D rasterisation** — hosted runners have no GPU —
 * concurrently, alongside the rest of the worker pool, on a box with a handful of vCPUs.
 *
 * The repair is not a bigger timeout. Every timeout on that path has already been raised once,
 * and a bound raised to cover a starved machine is a bound that no longer detects the fault it
 * was written for. A test that needs a whole box must not share it: the browser specs now run
 * in their own phase with file parallelism off, after everything else has finished.
 *
 * The split is **derived, not declared**. A list of "the browser tests" would go stale the day
 * someone adds a third one, silently, and the symptom would be an intermittent CI red attributed
 * to whatever landed that week. `browserSpecs()` classifies by the property that justifies the
 * split — the file launches a browser — so a new one is placed correctly without anyone
 * remembering. It throws rather than returning an empty set: a classifier that silently finds
 * nothing would put every browser spec back in the shared phase and report a healthy split,
 * which is this repository's oldest defect wearing a passing result's clothes.
 */

import { execFileSync } from 'node:child_process';
import ts from 'typescript';

/**
 * The import binding that makes a spec a browser spec: a file cannot launch a browser without
 * importing the launcher.
 *
 * WHY A BINDING AND NOT A TEXT MATCH. This classifier used to scan for the literal
 * `launchBrowser` followed by an open parenthesis, and a file that merely *discussed* that
 * string was indistinguishable from one that used it — so both this file and
 * `test/browser-specs-run-solo.test.ts` had to write the marker as a concatenation to avoid
 * classifying themselves. That dodge is a per-file act of memory, which is the shape this
 * repository has retired three times already (skip-lists for transient directories, twice, then
 * git-derived corpora). A textual detector cannot be made self-immune, because prose about a
 * property and code with that property are the same bytes.
 *
 * So the detector reads the file's *syntax* instead. A mention inside a comment, a string, or a
 * template literal is not an `ImportDeclaration`, and no amount of quoting turns it into one.
 * Measured over this repository's 73 specs: identical classification to the old text scan (the
 * same two files, zero disagreements), and self-immune on four shapes that defeat a text scan —
 * a line comment naming the call, a block comment containing the import, a template literal
 * holding a whole import statement, and a bare string literal of the binding name.
 *
 * Cost, measured before adoption because an instrument's price is part of its case, and stated
 * whole rather than in the flattering half: 240 ms to load the TypeScript module plus 198 ms to
 * parse all 73 specs — ~440 ms, once per `npm run test`, against a suite that runs for minutes.
 */
export const BROWSER_IMPORT = 'launchBrowser';

/**
 * Does this source import the browser launcher by name?
 *
 * Renamed imports (`launchBrowser as boot`) count — the propertyName is the imported binding and
 * the alias is only what this file calls it. A namespace import (`import * as browser`) does not,
 * and that is a deliberate limitation rather than an oversight: it is exactly the disagreement
 * `test/browser-specs-run-solo.test.ts` exists to catch, because its own scan is textual and
 * would see the call. Two detectors that fail differently are the point of having two.
 *
 * @param {string} path repo-relative, used only for parser diagnostics
 * @param {string} source
 * @returns {boolean}
 */
export function importsBrowserLauncher(path, source) {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === BROWSER_IMPORT) return true;
    }
  }
  return false;
}

/**
 * Native high-resolution clock references in executable syntax, not quoted browser programs.
 * Aliased perf_hooks imports count; conservatively isolate clock reads as well as direct calls.
 * @param {string} path
 * @param {string} source
 * @returns {boolean}
 */
export function usesPerformanceClock(path, source) {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const clocks = new Set(['performance']);
  const namespaces = new Set(['globalThis', 'window']);
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    if (!['node:perf_hooks', 'perf_hooks'].includes(statement.moduleSpecifier.text)) continue;
    const binding = statement.importClause?.namedBindings;
    if (binding !== undefined && ts.isNamespaceImport(binding)) namespaces.add(binding.name.text);
    if (binding !== undefined && ts.isNamedImports(binding)) {
      for (const item of binding.elements) {
        if ((item.propertyName ?? item.name).text === 'performance') clocks.add(item.name.text);
      }
    }
  }
  /** @param {import('typescript').Node} node @returns {boolean} */
  function visit(node) {
    const receiver =
      ts.isPropertyAccessExpression(node) && node.name.text === 'now'
        ? node.expression
        : ts.isElementAccessExpression(node) &&
            ts.isStringLiteral(node.argumentExpression) &&
            node.argumentExpression.text === 'now'
          ? node.expression
          : undefined;
    if (receiver !== undefined) {
      if (ts.isIdentifier(receiver) && clocks.has(receiver.text)) return true;
      if (
        ts.isPropertyAccessExpression(receiver) &&
        receiver.name.text === 'performance' &&
        ts.isIdentifier(receiver.expression) &&
        namespaces.has(receiver.expression.text)
      )
        return true;
    }
    return ts.forEachChild(node, visit) === true;
  }
  return visit(parsed);
}

/**
 * Spec paths, mirroring `vitest.config.ts`'s `include`.
 *
 * Kept honest by `test/browser-specs-run-solo.test.ts`, which asserts the corpus this selects is
 * at least as large as the audit's own file floor — a pattern that drifted out of step with the
 * config would collapse the corpus, and a collapsed corpus is what makes every check below pass
 * while examining nothing.
 */
const SPEC_PATH = /^(?:(?:packages|games)\/[^/]+\/(?:src|test)|test)\/.*\.(?:test|spec)\.ts$/;

/**
 * Every spec file the gate runs, from git rather than from a filesystem walk.
 *
 * `--others` keeps uncommitted specs in scope, so a file is classified while it is being written
 * rather than only after it is committed; `--exclude-standard` keeps `.gitignore`d scratch out.
 * Four separate incidents in this repository came from walkers descending into transient
 * directories another test was creating and deleting, and all four were closed by asking git
 * instead. See AGENTS.md and `test/agents-guide-crossrefs.test.ts`.
 *
 * @param {string} root repository root
 * @returns {string[]} repo-relative, forward-slashed
 */
export function specFiles(root) {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => SPEC_PATH.test(line));
}

/**
 * The specs that launch a real browser, and so must not share the machine.
 *
 * @param {string} root repository root
 * @param {(path: string) => string} read reads a repo-relative file; injectable so the controls
 *   can drive the classifier over a corpus they define instead of over this repository's
 * @param {string[]} [paths] the corpus to classify; defaults to this repository's specs
 * @returns {string[]}
 */
export function browserSpecs(root, read, paths) {
  const corpus = paths ?? specFiles(root);
  const found = corpus.filter((path) => importsBrowserLauncher(path, read(path)));
  if (found.length === 0) {
    throw new Error(
      `[test-phases] no spec imports ${BROWSER_IMPORT} — the classifier found nothing, which ` +
        `would silently return every browser test to the shared phase. Either the launcher was ` +
        `renamed or the corpus is empty; both are defects, and neither may be treated as "no ` +
        `browser tests".`,
    );
  }
  return found;
}

/**
 * Timing acceptance must not compete with this runner's parallel worker pool. The unchanged
 * FPS ratio measured 0.62 alone and 1.03 under the full shared load: its compute control does
 * not cancel every form of contention. This phase still runs on hosted Windows (no browser).
 * @param {string} root
 * @param {(path: string) => string} read
 * @param {string[]} [paths]
 * @returns {string[]}
 */
export function timingSpecs(root, read, paths) {
  return (paths ?? specFiles(root)).filter((path) => {
    const source = read(path);
    return !importsBrowserLauncher(path, source) && usesPerformanceClock(path, source);
  });
}

/**
 * Why the browser phase does not run on a hosted `windows-latest` runner.
 *
 * The full evidence chain, the nine refuted levers and the gap this leaves are in
 * `docs/adr/0010-browser-specs-do-not-run-on-hosted-windows.md`. The one-line version, from both
 * legs of run 30390018561 — same tree, same instrument, same job: **the consequence differs by a
 * factor of ~3250.** ubuntu's event loop lags **23ms** at 88% box load; the same loop lags
 * **74823ms** at 100%. That is not a CPU-scarcity shape, which is why nine attempts to reduce
 * demand all failed to move it.
 *
 * THIS STRING USED TO CLAIM MORE THAN THAT, and the removal is the point of landing #34. It said
 * "with identical page demand on both", resting on the three phase windows agreeing across the
 * legs — but all three windows close on `about:blank`, before the first navigation to a `/play/*`
 * page, so they establish parity for a blank page and nothing about the page whose cost is the
 * whole question. The `rumukh-fix-ci-workflows` session then measured the two separately and found
 * them to disagree: blank paces at 60fps on ubuntu and 64fps on windows, while the fps game page
 * runs its sim at 65.0 and 7.0 ticks/s. The exclusion never needed the demand claim — it rests on
 * the consequence, which is measured — so the claim is dropped rather than defended.
 *
 * Exported so the message is stated once and printed where it is acted on, rather than being a
 * comment nobody sees in a log.
 */
export const SOLO_SKIP_REASON =
  'a hosted windows-latest runner cannot schedule this process alongside a software-rasterising ' +
  'Chrome: the same tree measures a 23ms worst event-loop lag on ubuntu-latest and 74823ms on ' +
  'windows-latest, at 88% and 100% box load respectively. Whether the two legs put the same ' +
  'demand on the box is OPEN and deliberately not claimed here: the three phase windows that ' +
  'agree across the legs all close on about:blank, and no instrument in this repository has yet ' +
  'read which rasteriser answered on either leg. ' +
  'See docs/adr/0010-browser-specs-do-not-run-on-hosted-windows.md — this is an exclusion, not a ' +
  'pass: no hosted job exercises a real browser on Windows, and the landing gate on a Windows ' +
  'workstation is what covers it';

/**
 * Whether this process is running on a hosted CI runner.
 *
 * Injectable rather than reading `process.env` directly, so the guard can drive both answers
 * without mutating the environment of a running test worker.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isHostedCi(env = process.env) {
  return env.CI === 'true' || env.GITHUB_ACTIONS === 'true';
}

/**
 * Whether the browser phase may run here.
 *
 * A pure two-argument predicate rather than an `if` inside {@link testPhases}, for the reason this
 * repository has had to learn several times: a decision expressed as a branch inside a larger
 * function can only be tested through that function, and the arm nobody can reach is the arm
 * nobody controls. Both axes matter and neither alone is sufficient — Windows on a developer's
 * workstation runs these specs and passes, and a hosted Linux runner runs them and passes.
 *
 * @param {string} platform `process.platform`
 * @param {boolean} hosted see {@link isHostedCi}
 * @returns {boolean}
 */
export function soloEnabled(platform, hosted) {
  return !(platform === 'win32' && hosted);
}

/**
 * @typedef {object} TestPhase
 * @property {string} name
 * @property {string} why one line, printed before the phase runs
 * @property {string} report report filename, relative to the repository root
 * @property {string[]} args extra vitest arguments
 * @property {number} minFiles floor on files this phase must report
 * @property {number} minTests floor on tests this phase must report
 */

/**
 * @param {string} root repository root
 * @param {(path: string) => string} read see {@link browserSpecs}
 * @param {string} [platform] `process.platform`; explicit so the guard can drive both answers
 * @param {boolean} [hosted] see {@link isHostedCi}
 * @returns {TestPhase[]} in the order they must run
 */
export function testPhases(root, read, platform = process.platform, hosted = isHostedCi()) {
  // Classified unconditionally, even where the solo phase will not run: the shared phase has to
  // exclude these files either way, and `browserSpecs` throwing on an empty result is the guard
  // against a classifier that silently returns every browser spec to the shared pool. Skipping
  // the call on Windows would skip that check exactly where the split matters most.
  const solo = browserSpecs(root, read);
  const timing = timingSpecs(root, read);
  const phases = [
    {
      name: 'shared',
      why: 'specs without browsers or native timing measurements, in parallel',
      report: '.vitest-report.json',
      args: [...solo, ...timing].flatMap((path) => ['--exclude', path]),
      minFiles: 50,
      minTests: 800,
    },
  ];
  if (timing.length > 0) {
    phases.push({
      name: 'timing',
      why: `${String(timing.length)} Node timing spec(s), without competing shared workers`,
      report: '.vitest-report.timing.json',
      args: [...timing, '--no-file-parallelism'],
      minFiles: timing.length,
      minTests: timing.length,
    });
  }
  if (soloEnabled(platform, hosted)) {
    phases.push({
      name: 'solo',
      why: `${String(solo.length)} browser spec(s), one at a time after the other phases`,
      report: '.vitest-report.solo.json',
      // File parallelism off is the point: the two browser specs were measured overlapping on
      // the runner, each with its own software-rasterising Chrome.
      args: [...solo, '--no-file-parallelism'],
      // Exact, not a floor: this phase was handed an explicit list, so anything other than all
      // of them running is a filter that stopped matching — the silent shape that reported a
      // green windows leg with nine browser tests that never executed (run 30324264768).
      minFiles: solo.length,
      // Deliberately weak, and it does not have to be strong: the audit refuses skips outright,
      // and a browser file whose hook dies reports its cases as skipped rather than as absent.
      minTests: solo.length,
    });
  }
  return phases;
}
