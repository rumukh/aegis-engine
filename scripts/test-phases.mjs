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

/**
 * The marker that makes a spec a browser spec.
 *
 * Written as a concatenation because this classifier is applied to files that discuss it —
 * `test/browser-specs-run-solo.test.ts` is itself in the corpus, and a literal here would
 * travel into any file that quotes this one. `browser-diagnostics.test.ts`'s containment guard
 * was caught matching its own detector string the same way (landing #20).
 */
export const BROWSER_MARKER = 'launchBrowser' + '(';

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
  const found = corpus.filter((path) => read(path).includes(BROWSER_MARKER));
  if (found.length === 0) {
    throw new Error(
      `[test-phases] no spec contains ${BROWSER_MARKER} — the classifier found nothing, which ` +
        `would silently return every browser test to the shared phase. Either the marker changed ` +
        `or the corpus is empty; both are defects, and neither may be treated as "no browser tests".`,
    );
  }
  return found;
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
 * @returns {TestPhase[]} in the order they must run
 */
export function testPhases(root, read) {
  const solo = browserSpecs(root, read);
  return [
    {
      name: 'shared',
      why: 'everything that does not drive a browser, in parallel',
      report: '.vitest-report.json',
      args: solo.flatMap((path) => ['--exclude', path]),
      minFiles: 50,
      minTests: 800,
    },
    {
      name: 'solo',
      why: `${String(solo.length)} browser spec(s), one at a time, with the machine to themselves`,
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
    },
  ];
}
