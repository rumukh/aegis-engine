/**
 * The guard-rail rules are themselves guarded here — a test, not an audit.
 *
 * `eslint.config.js` carries four selector families that the simulation substrate depends on:
 * the `Math.sin`-style property bans, the two Math *evasions* (aliasing and computed access), the
 * wall-clock `new Date()` ban, and the absolute golden-hash ban. They are load-bearing and they
 * are fragile in a specific, invisible way: **ESLint flat config replaces a rule's options rather
 * than merging them**, so every selector that must apply to a file has to live in the one array
 * that wins for that file.
 *
 * Worse, which array wins is **order**-dependent. The general `files: ['**\/*.ts']` block also sets
 * `no-restricted-syntax` and also matches the simulation packages; the substrate block only wins
 * because it comes later. Reorder those two blocks, or add a third matching block below them, and
 * the Math and Date bans stop firing. Co-location is visible in a diff; ordering is a property of
 * the whole file that no reviewer of a single hunk can check.
 *
 * And the failure is silent. A lint rule that has stopped firing does not fail — it just checks
 * less, and `npm run verify` stays green. Both plausible resolutions of the merge that produced
 * this config scored green while dropping a whole family.
 *
 * A comment cannot hold that line: prose has no runner, and a manual probe is a claim about a
 * moment that expires the instant anyone edits the file. So each family is planted here as a
 * violation and asserted to fire, by **rule id and message**, in the file sets it must cover —
 * including the `games/**` case for the golden-hash ban, whose absence would stay invisible until
 * a game shipped a tautological pin.
 *
 * Uses `lintText` rather than temporary files on disk: nothing to clean up, and no chance of the
 * restore racing the run — the exact way an earlier hand-rolled probe of this config produced a
 * green result that described the wrong tree.
 * @packageDocumentation
 */
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';

/** Repository root, resolved from this file rather than the working directory. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const eslint = new ESLint({ cwd: REPO_ROOT });

/**
 * Budget for the one-time flat-config load, and for each case afterwards.
 *
 * Measured on this repository, in one process:
 *
 * ```
 * new ESLint({ cwd })                            3 ms
 * calculateConfigForFile (flat config load)  16634 ms
 * 1st lintText                                 141 ms
 * 2nd lintText                                   8 ms
 * 18 further lintText calls (warm)             304 ms
 * ```
 *
 * So the ~19 s this file used to cost is **not** the linting — all 19 probes together are under
 * half a second on a warm process. It is a single, process-wide load of `eslint.config.js`, which
 * pulls in `typescript-eslint` and through it the TypeScript compiler. Nothing here can make that
 * cheaper without linting against a *different* config, which is precisely what this file exists
 * to prevent.
 *
 * ## Where the load actually goes, since "make it cheap" is the obvious first ask
 *
 * ```
 * import('typescript')          760 - 1031 ms
 * import('eslint')             5957 - 13959 ms
 * import('typescript-eslint') 21000 - 34668 ms   <- the whole cost
 * import('./eslint.config.js')    83 -   306 ms   (once its deps are loaded)
 * ```
 *
 * It is **package-graph loading**, not compilation and not linting: TypeScript itself is a second,
 * and the config module evaluates in a tenth of one. The figures do not settle as the OS cache
 * warms, which on Windows points at on-access AV scanning of tens of thousands of small files.
 *
 * The consequence worth knowing before treating this file as an outlier: `npm run lint:code`
 * (`eslint .`) pays the same entry fee, and was measured at **125.5 s** on this box — roughly
 * **2×** this whole 19-case file (68.8 s wall) and ~4.6× its slowest case. A runner that cannot
 * afford this test cannot afford the gate's own lint step, which fails first and more loudly, with
 * no timeout to misattribute. So the honest reading is that this file is not expensive in itself;
 * it is one of two places that must load this repository's lint config at all.
 *
 * What can be fixed is where the cost lands. It used to be billed to whichever case ran first,
 * putting ~19 s of setup inside a 30 s per-test budget: ~10 s of headroom, so the file went red
 * under load — on this machine during a parallel `npm run verify`, and predictably on a cold,
 * slower CI runner. A timeout is indistinguishable from a broken guard, and it would blame
 * whichever unrelated commit happened to be in flight.
 *
 * The load now happens once in `beforeAll`, so every case below is billed only its own work.
 * Measured across the suite with `vitest run --testTimeout=180000 --reporter=json`, this file's
 * slowest case is now **139 ms idle / 232 ms** with the box at 100% CPU, and all 19 together sum
 * to 476 ms / 734 ms. It was the slowest test in the repository by 4.5× over the next one; it is
 * now outside the top twenty.
 *
 * The budget is for the hook, and it is sized against the **worst figure ever observed** for this
 * quantity, not a typical one. Independent measurements, three parties, this box:
 *
 * ```
 * ~13.5 s   solo, warm tree, box at 100% CPU                              (here)
 * ~16.6 s   solo, warm tree, idle                                         (here)
 *  25.8 s   solo, in a gate worktree                                      (group A)
 * ~67.5 s   freshly `npm ci`-ed tree (cold OS file cache), parallel load   (here)
 *  67.9 s   whole-suite run, three concurrent sessions                    (PM)
 *   129 s   whole-suite run, three concurrent sessions, worse             (PM)
 * ```
 *
 * The PM's ratio is the useful one: ~2.6× inflation from suite load over the same test run alone
 * (67.9 vs 25.8), and up to ~5× at the extreme. Both of the large figures are the **file total**,
 * which after this change is almost entirely this hook — the 19 cases contribute under a second —
 * so they are readings of the budget below, not of any test case.
 *
 * The spread is dominated by **cold I/O**, not CPU: saturating all sixteen cores barely moves it
 * (16.6 s → 13.5 s, within noise), while an uncached module graph quadruples it. A CI runner is
 * the bad case on both axes — cold every time, and 2-4 cores against this box's 16 — so 600 s is
 * ~4.6× the worst seen here and ~22× the PM's 27 s single-case reading. A machine **3× slower than
 * this one** would land near 390 s at the worst observed and still pass. That looks extravagant
 * and is deliberate: a hook budget is a *hang* detector, its only cost is how long a genuine hang
 * takes to surface, and the failure it must never produce is a timeout that an agent cannot tell
 * apart from a real cross-OS determinism finding on the first CI run this project has ever had.
 */
const CONFIG_LOAD_BUDGET_MS = 600_000;

/**
 * Load the flat config once, and prove it is the real one.
 *
 * The proof is not decoration. Everything below asks "did rule X fire?", and an empty or
 * unresolved config answers "no" to all of them — which reads as eighteen negative cases passing.
 * The first case guards that from one side (a clean file must produce no violations, which is also
 * what linting nothing produces); this guards it from the other, by requiring the rules under test
 * to be *configured* for a path they must cover before any case runs.
 *
 * It is falsifiable, measured rather than assumed: `calculateConfigForFile` returns 269 rules for
 * `packages/core/src/zz-warm.ts` and `undefined` for a path the config ignores (anything under
 * `dist/`). Point this at the wrong tree and the hook fails.
 */
beforeAll(async () => {
  const config: Linter.Config | undefined = await eslint.calculateConfigForFile(
    `${REPO_ROOT}packages/core/src/zz-warm.ts`,
  );
  expect(
    Object.keys(config?.rules ?? {}),
    'the flat config resolved to nothing, or to something without the rules this file tests — ' +
      'every case below would then "pass" by linting against nothing',
  ).toEqual(expect.arrayContaining(['no-restricted-syntax', 'no-restricted-properties']));
}, CONFIG_LOAD_BUDGET_MS);

/** Lint `source` as if it were the file at `relPath`, which selects the config blocks that apply. */
async function lintAs(relPath: string, source: string): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(source, { filePath: `${REPO_ROOT}${relPath}` });
  const messages = result?.messages ?? [];

  // The precondition, checked rather than assumed. A file that fails to parse yields a fatal
  // message and *zero* rule violations, which a naive assertion reads as "the rules don't fire".
  // An empty result must mean "nothing matched", never "nothing ran".
  const fatal = messages.filter((m) => m.fatal === true);
  expect(
    fatal.map((m) => m.message),
    `probe at ${relPath} did not parse`,
  ).toEqual([]);
  return messages;
}

/** Whether any message came from `ruleId` and mentions `fragment`. */
function fired(messages: Linter.LintMessage[], ruleId: string, fragment: string): boolean {
  return messages.some((m) => m.ruleId === ruleId && m.message.includes(fragment));
}

// --- the planted violations, one per family --------------------------------------------------

const GOLDEN_HASH_VIOLATION = `
export function probe(r: { hash: string }, e: { hashEquals(h: string): void }): void {
  e.hashEquals(r.hash);
}
`;
const MATH_PROPERTY_VIOLATION = `export const probe = (): number => Math.sin(1);\n`;
const MATH_ALIAS_VIOLATION = `const M = Math;\nexport const probe = (): number => M.sin(1);\n`;
const MATH_COMPUTED_VIOLATION = `const k = 'sin';\nexport const probe = (): number => Math[k as 'sin'](1);\n`;
const WALL_CLOCK_VIOLATION = `export const probe = (): number => new Date().getTime();\n`;

/**
 * Per-case budget, for the residual after the one-time load in `beforeAll`.
 *
 * Measured worst case across the whole suite: 232 ms, with the box at 100% CPU. 60 s is ~258×
 * that, so this fires only on a hang — which is the only thing a per-case budget on sub-second
 * work can usefully detect. It is set here rather than left to the root default deliberately: the
 * root number is sized for ordinary unit tests, and this file's cost profile is not theirs.
 */
const LINT_TIMEOUT_MS = 60_000;

describe(
  'eslint.config.js — every guard-rail family still fires',
  () => {
    it('the probe pipeline itself works (a clean file produces no rule violations)', async () => {
      // Without this, every assertion below could pass for the wrong reason: if `lintAs` were
      // silently linting nothing, the negative cases would all "pass" and the positive ones would
      // fail loudly — but a future refactor could invert that. This pins the baseline.
      const messages = await lintAs(
        'packages/harness/src/zz-clean.ts',
        `export const probe = (n: number): number => n + 1;\n`,
      );
      expect(messages).toEqual([]);
    });

    /**
     * Absolute — no location scoping, no exemptions. `games/**` is listed first because it is the
     * case whose absence would be least noticeable: a game pinning `hashEquals(result.hash)` reads
     * exactly like a determinism regression test and can never fail.
     */
    it.each([
      ['games/iso/src/zz-probe.ts'],
      ['games/platformer/src/zz-probe.ts'],
      ['packages/harness/src/zz-probe.ts'],
      ['packages/mode-fps/src/zz-probe.ts'],
      ['packages/cli/src/zz-probe.ts'],
      ['packages/render-three/src/zz-probe.ts'],
    ])('golden-hash ban fires in %s', async (path) => {
      const messages = await lintAs(path, GOLDEN_HASH_VIOLATION);
      expect(fired(messages, 'no-restricted-syntax', 'compares the run to itself')).toBe(true);
    });

    it.each([['packages/core/src/zz-probe.ts'], ['games/iso/src/zz-probe.ts']])(
      'Math property ban fires in %s',
      async (path) => {
        const messages = await lintAs(path, MATH_PROPERTY_VIOLATION);
        expect(fired(messages, 'no-restricted-properties', 'Math.sin')).toBe(true);
      },
    );

    it.each([['packages/core/src/zz-probe.ts'], ['games/fps/src/zz-probe.ts']])(
      'Math alias evasion ban fires in %s',
      async (path) => {
        const messages = await lintAs(path, MATH_ALIAS_VIOLATION);
        expect(fired(messages, 'no-restricted-syntax', 'Aliasing or destructuring Math')).toBe(
          true,
        );
      },
    );

    it.each([['packages/core/src/zz-probe.ts'], ['games/fps/src/zz-probe.ts']])(
      'Math computed-access evasion ban fires in %s',
      async (path) => {
        const messages = await lintAs(path, MATH_COMPUTED_VIOLATION);
        expect(fired(messages, 'no-restricted-syntax', 'Computed access to Math')).toBe(true);
      },
    );

    it.each([['packages/harness/src/zz-probe.ts'], ['games/platformer/src/zz-probe.ts']])(
      'wall-clock Date ban fires in %s',
      async (path) => {
        const messages = await lintAs(path, WALL_CLOCK_VIOLATION);
        expect(fired(messages, 'no-restricted-syntax', 'Wall-clock time breaks determinism')).toBe(
          true,
        );
      },
    );

    /**
     * The other direction. A resolution that hoists the determinism selectors into the general
     * `**\/*.ts` block — the natural way to "make sure they apply everywhere" — keeps every positive
     * case above green while breaking `render-three`, which legitimately runs on a wall clock, and
     * `packages/cli`, which is a process rather than a simulation. Only these assertions catch it.
     */
    it.each([
      ['packages/cli/src/zz-probe.ts', WALL_CLOCK_VIOLATION, 'Wall-clock time breaks determinism'],
      [
        'packages/render-three/src/zz-probe.ts',
        WALL_CLOCK_VIOLATION,
        'Wall-clock time breaks determinism',
      ],
      ['packages/cli/src/zz-probe.ts', MATH_ALIAS_VIOLATION, 'Aliasing or destructuring Math'],
      ['packages/cli/src/zz-probe.ts', MATH_COMPUTED_VIOLATION, 'Computed access to Math'],
    ])('determinism bans stay silent in %s', async (path, source, fragment) => {
      const messages = await lintAs(path, source);
      expect(fired(messages, 'no-restricted-syntax', fragment)).toBe(false);
    });
  },
  LINT_TIMEOUT_MS,
);
