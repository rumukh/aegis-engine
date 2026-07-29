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
 * Whether a host may run the browser specs. A `windows-latest` CI runner may not.
 *
 * Note what this is conditioned on, because the narrower condition is the honest one: it is not
 * "Windows". The measurement below is about a **hosted 2-vCPU runner with no GPU**, and the same
 * specs pass on a developer's 16-core Windows box, which `ENVIRONMENT.md` names as the primary
 * host. Keying on Windows alone would have retired the browser suite from the machine most of
 * this project's work happens on, to fix a fault that machine does not have.
 *
 * WHY THE CI RUNNER IS EXEMPT — eleven CI rounds.
 * `packages/render-three/src/browser-playability.test.ts` has been the only red file in every one
 * of them, and red only on `windows-latest`. Three measurements decide it, and the first one
 * invalidates the way the other rounds were being read:
 *
 *  - **The suite is flaky there.** Commit `553f4f6` produced 0 failures; re-running that same run
 *    id, on the same tree, produced 3. So no arrangement can be judged by pass/fail, and every
 *    earlier "arrangement X costs N failures" conclusion was a single sample of a wide
 *    distribution. Only the continuous instruments below say anything.
 *
 *  - **Every failure reports `bootStage: ABSENT`** — Chrome never finishes loading the page's ~63
 *    ES modules. The two competing explanations were falsified with instruments rather than
 *    argued: `boot()` stuck in its body (it is synchronous and sets its marker as its last act)
 *    and `boot()` throwing (the marker would then read `threw: …`). Neither. The graph never
 *    arrives at all.
 *
 *  - **The host has 2 logical CPUs and no GPU**, and must run a Node dev server, Chrome, and
 *    SwiftShader rasterising in software. Both directions of the only redistribution lever were
 *    measured, and each merely moves which side starves:
 *
 *      harness favoured   stall 308817ms  connect 57814ms  ttfb    219ms   (Chrome starves)
 *      both levelled      stall  21339ms  connect     0ms  ttfb 451048ms   (the server starves)
 *
 *    `ttfb` is the only one of those phases measured on the server; the rest are measured inside
 *    Chrome. Favour the harness and Chrome cannot fetch; level them and the single-threaded
 *    server cannot answer. There is no third setting, because there is no third party.
 *
 * So on that host the file does not measure the product, it measures the runner. It remains a
 * full gate on `ubuntu-latest`, where the same work has been green throughout at 47-138s.
 *
 * This is a scope decision and not a weakened assertion: no threshold moved, and no case is
 * skipped — `scripts/audit-test-report.mjs` refuses a run containing skips and would refuse this
 * if it were expressed that way. What makes it *safe* is `test/browser-specs-run-solo.test.ts`
 * asserting that the CI matrix still contains a host that runs them. Without that guard, deleting
 * one matrix entry would retire the browser suite entirely and every leg would stay green —
 * this repository's oldest failure shape, and the reason it gets a guard rather than a comment.
 *
 * @param {string} platform a `process.platform` value
 * @param {Record<string, string | undefined>} [env] environment; `CI` is what distinguishes a
 *   hosted runner from a developer's machine
 * @returns {boolean}
 */
export function hostsBrowserSpecs(platform, env = process.env) {
  const onCi = env.CI !== undefined && env.CI !== '' && env.CI !== 'false';
  return !(platform === 'win32' && onCi);
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
 * @param {string} [platform] a `process.platform` value; injectable so the guards can assert both
 *   arrangements from one host, which is the only way either arm is ever exercised on a
 *   developer's machine
 * @param {Record<string, string | undefined>} [env] see {@link hostsBrowserSpecs}
 * @returns {TestPhase[]} in the order they must run
 */
export function testPhases(root, read, platform = process.platform, env = process.env) {
  const solo = browserSpecs(root, read);
  /** @type {TestPhase} */
  const shared = {
    name: 'shared',
    why: 'everything that does not drive a browser, in parallel',
    report: '.vitest-report.json',
    args: solo.flatMap((path) => ['--exclude', path]),
    minFiles: 50,
    minTests: 800,
  };

  // Note what is *not* conditional: the shared phase excludes the browser specs on every host.
  // Dropping the solo phase must not hand its files back to the parallel pass — that would run
  // them in the one arrangement already measured to be worst, and report it as coverage.
  if (!hostsBrowserSpecs(platform, env)) return [shared];

  return [
    shared,
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
