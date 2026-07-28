# ADR-0010: The browser specs do not run on a hosted Windows runner

- **Status:** Accepted
- **Principle:** CHARTER §4.3 criterion 7 (CI runs the whole thing on push), and the rule that a
  green gate must describe what it actually executed.

## Context

`packages/render-three/src/browser-playability.test.ts` and `browser-diagnostics.test.ts` launch a
real Chrome and drive it over CDP. They are the only instruments in this repository that a human's
hands are inside — they are how CHARTER §4.3 criterion 5 ("three PoCs playable in a browser") is
discharged, and they were written precisely because six byte-identical PNGs and twenty-two green
round-trip tests once certified a game that turned the wrong way under a person's hand.

On `ubuntu-latest` they pass every time. On `windows-latest` they have never passed once, across
roughly twenty pushes. The failure is always the same: a CDP command gets no reply, the deadline
fires, and the diagnostic reports that **this process was not scheduled at all** while it waited.

This ADR records why that is not repairable from inside this repository, and what the gate does
about it instead.

## The measurement that settles it

Both legs of run `30390018561`, same tree, same instrument, same job. The three phase windows were
added in landing #27 for exactly this question: a 500 ms window taken _before the dev server or the
browser exist_ separates "a neighbour is loading the runner" from "our own Chrome is".

| quantity (whole file run)                    | `ubuntu-latest` — **green** | `windows-latest` — **red**     |
| -------------------------------------------- | --------------------------- | ------------------------------ |
| box CPU at rest (nothing of ours running)    | 1% over 500 ms              | 6% over 502 ms                 |
| box CPU booting (dev server + chrome, blank) | 94% over 329 ms             | 93% over 782 ms                |
| box CPU painting (a blank page rendering)    | 23% over 1005 ms            | 24% over 1007 ms               |
| box CPU over the whole run                   | 88%                         | 100%                           |
| this process's CPU share                     | 4%                          | 0%                             |
| **worst event-loop lag**                     | **23 ms**, 739 of ~745      | **74 823 ms**, 1284 of ~16 830 |
| paint precondition                           | 1005 ms, 1 poll             | 1007 ms, 1 poll                |
| machine                                      | `linux · 2 vCPU · 8 GiB`    | `win32 · 2 vCPU · 8 GiB`       |

Read the rows in order, because the conclusion is in the gap between the last two and not in any
one of them:

- **The demand is the same on both legs.** All three phase windows agree to within a few points.
  The page paints on the first poll on both. The runners are the same 2-vCPU, 8 GiB class.
- **The load is ours.** At rest the box is 1–6% busy; it goes to ~93% the moment we start a dev
  server and a Chrome. So "a neighbour on the runner" is refuted by measurement, not withdrawn.
- **The consequence is not the same.** ubuntu's event loop lags **23 ms** at 88% box load; the same
  loop, doing the same work, lags **74 823 ms** at 100%. That is a factor of about 3250 across
  twelve points of load. No plausible band closes a gap that size, so **CPU scarcity is not the
  mechanism.** The Windows scheduler simply does not give a single-threaded Node process a share
  against ~40–60 runnable Chrome threads; Linux's autogrouping does.

## What was tried, and what each attempt refuted

Every row below was refuted by measurement with a control, not abandoned. They are recorded because
the next person to look at this will think of them in roughly this order.

| lever                                   | how it was refuted                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raise the deadlines                     | Every deadline on the path was raised once already. A 30 s deadline reported firing at 53 s, 77 s and 40 s — the timer itself was late, so the bound was never what was binding.                                                                               |
| Wait longer for the browser to warm up  | The paint precondition (landing #21) **holds** on the failing leg: ready in 1007 ms, one poll. It is not a cold-start problem.                                                                                                                                 |
| Isolate the browser specs from the rest | Refuted three times, by two authors and three mechanisms — a two-phase runner with `--no-file-parallelism`, a config-level vitest project with `singleFork`, and both at once. Every arm still reported 0% CPU.                                                |
| Blame a neighbour on the runner         | The at-rest window reads 6%. Ours is the only load.                                                                                                                                                                                                            |
| Reduce per-frame cost                   | Measured 471 frames/s across three concurrent pages; a static module was served _faster_ under frame load than without it.                                                                                                                                     |
| Memory pressure                         | 5.2–5.3 GB free of 8.0 GB on every failure.                                                                                                                                                                                                                    |
| Chrome launch flags                     | Six arms. `--num-raster-threads=1`, `--renderer-process-limit=1` and `--in-process-gpu` cut CPU by up to 41% and cut frames by 35%. Cost per frame is flat within ±13% across all four fps arms: the flags reduce _throughput_, not _demand per unit of work_. |
| Lower the browser's process priority    | `os.setPriority` applied immediately after `spawn()`, before Chrome forks its zygotes, reaches only 8 of 21 processes — Chrome sets priority classes on its own subprocesses. CPU moved 11.36 → 10.60 cores.                                                   |
| A smaller viewport                      | Already spent: the specs run at 640×360.                                                                                                                                                                                                                       |
| Uncapping / capping the frame rate      | Already spent: `uncapFrameRate` is dead, gated behind an option no caller passes, and pinned by a test. Uncapped, a no-op round trip dilated 60×.                                                                                                              |

The page's own cost, for whoever picks this up: on a 16-core workstation, sampling only newly
created browser processes, `about:blank` consumes **0.24 cores** and `/play/platformer`,
`/play/iso` and `/play/fps` consume **7.17**, **7.32** and **12.34**. SwiftShader sizes its worker
pool from the core count, so those absolute figures do not transfer to a 2-vCPU runner; the claim
that does transfer is the weaker one — **a software-rasterised three.js page saturates whatever it
is given.** That is fine on a scheduler that shares fairly and fatal on one that does not.

## Decision

**The browser phase does not run on a hosted `windows-latest` runner.** `scripts/test-phases.mjs`
omits it there; everything else runs unchanged, on both legs.

Four properties make this an exclusion rather than a hole:

1. **It is narrow and derived.** The excluded set is exactly the set of specs that launch a browser,
   computed by the same classifier that builds the solo phase — not a list anyone maintains.
   `test/browser-specs-run-solo.test.ts` pins both directions of it.
2. **It is conditional on the runner, not on the OS.** `soloEnabled(platform, hosted)` is false only
   for `win32` **and** a hosted CI runner. On a Windows workstation the browser specs run normally,
   and they pass: this repository's landing gate has run them on Windows on every landing, most
   recently at 73 files / 1039 tests, exit 0. **Windows is not unsupported — the 2-vCPU hosted
   Windows runner is.**
3. **It is loud.** The runner prints the phase it did not run, the reason, and every spec file that
   therefore did not execute. A gate that quietly covers less is the exact defect
   `scripts/audit-test-report.mjs` exists to prevent, and this must not become an instance of it.
4. **It does not weaken any floor.** The audit still refuses skips, failures, a missing report and a
   corpus below its floor, on both legs. The browser specs are _absent_ from the Windows job, not
   _skipped_ within it — so nothing reports a pass it did not earn.

## Consequences

**What is covered.** Criterion 5's four acceptance assertions — axis correctness, the frame budget,
liveness, and human reachability — run on every push, on `ubuntu-latest`, against a real Chrome.
They also run on Windows on every landing gate before anything reaches `main`.

**What is not covered, stated plainly.** No hosted-CI job exercises a real browser on Windows. A
regression that is Windows-specific _and_ browser-specific _and_ not caught by the Windows landing
gate would reach `main`. That is a real gap and it is not dressed up as anything else.

**What would close it.** A self-hosted or larger Windows runner, or a Windows runner with GPU
acceleration so the page is not software-rasterised. Either removes the mechanism rather than
working around it. If one becomes available, delete `soloEnabled`'s `win32` branch and its guard
arms — the rest of the split is unaffected.

**What must not be done.** Do not "fix" this by raising a deadline until the leg goes green. The
deadline instrument has already measured itself firing 47 seconds late; a bound raised to cover a
process that is not being scheduled is a bound that no longer detects anything, and it would put a
green badge on a leg that measured nothing.
