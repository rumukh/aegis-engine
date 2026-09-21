# Action-driven consumer extension: implementation and acceptance

This report tracks the implementation of **AEGIS extension specification v1.1
(2026-09-20)** for accessible narrative and turn-based consumers. It is not a
claim that Fluffy Bureau or Witch Kitchen has been implemented or released.

**Current status: implementation integrated; the complete local workspace gate
passed: 171 files and 2,480 tests, with no failures or skips.** Packaged-consumer,
reference and existing-game Chromium coverage passed together, including all
browser cleanup hooks. This is Windows Chromium acceptance, not blanket
cross-browser, physical-device or editorial approval; those limits remain below.
An API proposal, passing mock, or successful source-workspace build is not evidence
that a packaged consumer or a real browser passed.

## Baseline and approved scope

- The implementation baseline is
  `07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a`, matching the specification's assessed
  revision. Local main was fast-forwarded from `06c616d`.
- The user selected compatibility with **offline web applications and GitHub
  Pages/static hosting**. A Windows application wrapper is not required.
- Engine infrastructure and small original reference fixtures are in scope.
  Neither complete consumer game, production story content, nor either game's
  questionnaire is in scope.
- The user approved the standard MIT notice with
  `Copyright (c) 2026 Aegis contributors` for distributable engine artifacts.
- Registry publication, external deployment, production accounts, analytics,
  runtime speech services, and runtime model services are not authorized.
- Existing physics modes, demos, presentation behavior, and acceptance coverage
  must remain usable. The new child-oriented policies are opt-in.

## M0: reuse and architecture decisions

The existing core supplies a deterministic world, explicitly stepped simulation,
serializable resources, state hashing, saved PRNG state, and validated snapshot
restoration. These are reused rather than replaced.

The existing live session is mode-oriented and its pause boolean and restart
operation are not a complete command-host or save lifecycle. The existing audio
transport does not by itself establish offset-preserving narration. Package
exports and workspace builds do not establish standalone distribution.

Three additive packages separate actual dependency boundaries:

| Package            | Responsibility                                                                       | Allowed engine dependencies                   |
| ------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `@aegis/runtime`   | Headless command host, logical turns/jobs, content activation, checkpoint boundaries | `@aegis/core`                                 |
| `@aegis/narrative` | Pure narrative, deduction, minigame, family, generation and print-data helpers       | `@aegis/core`                                 |
| `@aegis/browser`   | Storage, media, DOM/accessibility and optional offline adapters                      | Core/runtime where needed; never render-three |

Shared audio primitives are extracted into the browser package and consumed by
the existing renderer through the public `@aegis/browser/audio/nodes` entry.
The dependency points from renderer to browser services, never from the DOM
consumer to the renderer. Native-ESM dev, preview and nested static routes all
resolve that narrow entry.

Command acceptance, committed state, and acknowledged persistence are separate
states. A committed zero-turn command changes the state revision and view without
advancing logical time. Strict checkpoints acknowledge each required intermediate
turn before the next substep; failed writes retain the pending action and expose
retry/recovery rather than replaying its effects.

Pause reasons compose as a set. An in-flight step can finish its already-committed
checkpoint before pausing; removing a reason does not queue or silently execute a
new gameplay command. Restoration stages and validates a replacement before
publishing it and invalidates callbacks belonging to the replaced session.

## Requirement-to-implementation map

The locations below distinguish integrated implementation from browser/release
acceptance. **Headless verified** does not imply that associated UI, storage,
device or standalone-distribution criteria passed.

| Requirements   | Public module or integration target                                           | Acceptance IDs | Status                                               |
| -------------- | ----------------------------------------------------------------------------- | -------------- | ---------------------------------------------------- |
| DIST-01..03    | Local artifact builder, isolated installed consumer, explicit package exports | A01, A02, K16  | Implemented; isolated consumer verified              |
| HOST-01..04    | `@aegis/runtime` command host and atomic replacement lifecycle                | A03..A07       | Implemented; headless/reference verified             |
| SAVE-01..04    | `@aegis/browser/save`, `@aegis/browser/indexeddb`                             | A08..A12       | Implemented; unit and Chromium verified              |
| SAVE-05        | Runtime checkpoint barrier plus browser ordered acknowledgements              | K04, K08, K09  | Implemented; interrupted UI flows verified           |
| AUDIO-01..04   | `@aegis/browser/audio`, shared renderer primitives                            | A13..A16, A21  | Implemented; Chromium samples/bounds verified        |
| AUDIO-05       | State-driven authored atmosphere and explicit silence                         | K13            | Implemented; Chromium lifecycle verified             |
| UI-01..05      | `@aegis/browser/ui`, opt-in child preset, reference shells                    | A17..A21       | Implemented; acceptance partial, see ledger          |
| UI-06          | Accessible slot selection and placement                                       | K11, K12       | Implemented; placement and narrow layout verified    |
| UI-07          | Spoiler-filtered public projection                                            | K14            | Implemented; failed/held-write UI verified           |
| OFFLINE-01..03 | `@aegis/browser/offline`, nested-path static reference build                  | A22..A24       | Implemented; actual restart/update verified          |
| STORY-01..03   | `@aegis/narrative` graphs, effects and content validation                     | A28, A29       | Implemented; editorial acceptance separate           |
| STORY-04       | Persistent irreversible claims and exclusive outcomes                         | K15            | Implemented; restoration verified                    |
| LOGIC-01..03   | Finite deduction, notebook provenance and exhausted hints                     | A25..A27       | Implemented; valid/invalid fixtures verified         |
| MINI-01..02    | Serializable minigame adapters and reference primitives                       | A08, A17, A21  | Implemented; three reference primitives verified     |
| FAMILY-01..03  | Turn/handoff projections, abilities and finite association hints              | A30            | Implemented; private DOM/audio removal verified      |
| GEN-01         | Validated bounded generation and resolved-case persistence                    | A31, A32       | Implemented; both finite combinations verified       |
| COLLECTION-01  | Validated catalogs and idempotent cosmetic grants                             | A06, A29       | Implemented; repeated/restore claims verified        |
| PRINT-01       | Shared print data/layouts and A4/Letter reference output                      | A33            | Implemented; browser/PDF geometry verified           |
| TURN-01..05    | Runtime revisions, resumable commands, jobs/phases and headless traces        | K01..K07, K16  | Implemented; actual frames and continuation measured |
| DATA-01..03    | Validated external JSON, safe activation and saved revision compatibility     | K10            | Implemented; external edit/refusal verified          |
| DESKTOP-01     | Approved static/offline web route; no packaged desktop claim                  | K17            | Implemented for approved web target                  |
| Compatibility  | Existing whole-workspace gate and demo coverage                               | A34            | Passed: complete local gate, 2,480 tests, zero skips |

## Acceptance ledger

Each row needs a reproducible command or named test, the revision/content it
exercised, its actual outcome, and its limits. Unit and browser evidence are
recorded separately where they prove different things.

### Integrated headless evidence

On Windows with Node `25.6.0`, the corrected runtime and narrative source drops
were applied to the baseline checkout without commits. All 39 imported files were
byte-checked against their handoff manifests. These commands passed:

```powershell
npx --no-install tsc -b packages\runtime packages\narrative
npx --no-install tsc -p packages\runtime\tsconfig.tests.json
npx --no-install tsc -p packages\narrative\tsconfig.tests.json
node scripts\run-tests.mjs packages\runtime\test packages\narrative\test
```

The audited run executed **9 files and 139 tests**, with no failures, skips or todo
cases: 50 runtime tests and 89 narrative tests. Full-workspace and browser
acceptance remain separate.

Two review defects have explicit failing-then-passing regressions. Asynchronous
restore now preserves pause additions/removals made during preparation unless
the caller supplied an explicit replacement set. Notebook restore and edits
solve once per canonical citation set rather than once per evidence mark; the
100/100/10-domain fixture asserts the number of enumerations, not a fragile
wall-clock timeout.

### Packaged and browser evidence

The integrated handoff contained 123 explicitly owned files; all matched their
source manifests byte-for-byte after restoring the upstream font license's LF
bytes. A path-specific `.gitattributes` rule preserves those vendor bytes on
future Windows checkouts. Integration checks exercised uncommitted source;
their evidence does **not** represent those changes as the unchanged baseline.

The retained SDK artifact set records source digest
`822772d115783a6eea50cded7b1494a04aca9704bf05cafb57b2d7df904ab9b6`
and version `0.0.0-local.r07f3cd0829a4.d822772d115783a6e`. Its four tarballs
were installed into a separate temporary consumer with its own lockfile,
TypeScript and esbuild, no package symlinks and no workspace source aliases.
Browser and no-DOM rule bundles use declared public exports. Both reference
apps' browser tests serve that consumer's static build, not workspace output.
Artifact and site revisions are separate: a changed consumer stylesheet needs a
new site build even when the SDK digest is unchanged.

The corrected browser/renderer workstream passed 184 distinct targeted tests:
155 unit/module-route/legacy tests and 29 actual-browser cases, including native
dev streams, asset preview and all three nested static PoCs. The assembled
reference acceptance subsequently passed 43 cases across its four root files
and the old live-stream browser spec. These overlapping scoped batches are
**not added together as a whole-workspace total**.

Reproduce the extension-focused checks with:

```powershell
node scripts\run-tests.mjs test\extension-distribution.test.ts test\extension-labs.test.ts test\extension-labs.browser.test.ts test\browser-services.browser.test.ts
```

The complete compatibility gate is `npm run verify`, including build, test
typechecking, the audited test runner, ESLint, dependency boundaries and Prettier.
The first integrated main run was stopped after becoming red: the procedural
platformer asset test exceeded 30 seconds, and several legacy browser cases
failed the unchanged 10-second owned-browser exit deadline after the close
command was acknowledged. A legacy static navigation also exceeded its deadline.
The completed shared phase had 151 files/2,287 tests, one failure and zero skips;
the separate timing phase passed all eight tests. The solo browser phase was
not completed, so there is no complete whole-workspace pass count.
The build and all test typechecks passed before these phases. A separate
`npm run lint` passed ESLint, dependency boundaries for all 15 workspace
projects, and repository-wide Prettier.
After integrating the final stylesheet and browser-test delta, build and test
typechecking passed again. The unchanged procedural asset test passed in
isolation: all five cases, with byte regeneration taking 4.186 seconds against
the original 30-second deadline. Its earlier timeout did not recur; no source
change or increased timeout was needed.

Source-independent shutdown controls reproduced the same failure on both
Chrome 153.0.8010.50 and Edge 153.0.4234.32: a fresh `about:blank`, plain native
Web Audio, and explicitly closed native Web Audio all acknowledged `Browser.close`
but retained a live OS process past ten seconds. None loaded the new SDK or any
game. Two isolated startup-flag hypotheses also failed and were not applied to
the launcher. This demonstrates that the shutdown failure does not require the
extension; it does not explain every other failure or waive compatibility
acceptance. Retained diagnostics are `browser-shutdown-controls.json`,
`browser-shutdown-controls-edge.json` and `browser-shutdown-flags.json` in the
implementation session artifacts.

After the duplicate full runs and focused browser jobs ended, the same fresh
Chrome blank-page shutdown control passed in 7,615 ms, within the unchanged
10,000 ms deadline. This is a positive control, not a whole-workspace pass.
The subsequent complete single-run gate failed, as detailed below.

No deadline, assertion, skip policy or test-audit floor has been relaxed.
The earlier failed run that could not resolve the renderer's new audio import
is also a red baseline, not acceptance.

### Historical complete gate: failed

The first completed `npm run verify` ran alone against the integrated implementation
on local main. Build and test typechecking passed. The audited test result was:

| Phase        | Files   | Tests     | Passed    | Failed | Skipped |
| ------------ | ------- | --------- | --------- | ------ | ------- |
| Shared       | 151     | 2,287     | 2,287     | 0      | 0       |
| Timing       | 1       | 8         | 8         | 0      | 0       |
| Solo browser | 18      | 171       | 124       | 42     | 5       |
| **Total**    | **170** | **2,466** | **2,419** | **42** | **5**   |

The browser phase took 3,196.29 seconds. Thirteen browser files failed and five
passed. The runner explicitly refused the result: failed browser hooks caused
five cases not to execute, and those skips are not accepted coverage.

Most reported failures were owned-browser processes remaining alive after an
acknowledged `Browser.close` past the unchanged ten-second deadline. Other
failures included 30-second navigation deadlines, aborted/unaccepted live-input
packets, and an `EPERM` deleting a stopped browser's temporary profile. The
navigation/input failures have not been independently explained; the blank-page
shutdown controls do not justify attributing every failure to the same cause.
These were blockers, not waived or reclassified passes.

The final reference file again passed eleven functional cases, including the
new layout/touch cases, and failed its restart and subsequent print cases.
The service file passed seven cases, failed restart and then skipped five cases
because setup could not replace the failed browser. Earlier focused successes
remain revision-specific evidence, not a substitute for this failed final gate.
No missing `@aegis/browser/audio/nodes` resolution error was reported.

The retained implementation-session artifacts include `verify-main-final.log`,
the complete `verify-final-shared.json`, `verify-final-timing.json` and
`verify-final-solo.json` reports, and `final-gate-totals.json`. These remain
historical failures; subsequent fixes do not relabel them.

### Acceptance reliability corrections

Alternating identical blank-browser controls isolated a temporary-storage
contribution: shutdown took 3,445–3,996 ms under the redirected `F:\temp`, versus
344–434 ms under C:. Moving temporary storage alone made all fourteen Coyote
browser cases pass, including navigation and live input. This does not establish
the physical mechanism of the storage difference or explain every earlier
failure.

The test runner now creates one owned directory outside the checkout, using
Windows local application data by default. Only child processes receive the
temporary-path overrides. An explicit absolute `AEGIS_TEST_TMPDIR` is supported;
invalid paths, aliases resolving into the checkout and cleanup failures refuse
the run. Eleven tests cover selection, ownership, actual child environments,
alias rejection and normal/explicit-exit cleanup. No browser deadline changed.
See [Environment constraints](../ENVIRONMENT.md#test-temporary-storage).

The next complete run exposed a separate reference-touch readiness race:
delivery of a navigation tap did not mean the destination control existed.
A deferred-target regression failed before correction. Touch automation now
waits for a visible, enabled target and loaded fonts, takes a layout frame,
reacquires the target and verifies its hit position before sending one trusted
touch. Both cached and uncached navigation routes are exercised. Input is not
retried. The temporary-storage and reference batch passed all 26 cases.

A later complete run executed all 173 browser assertions without failures or
skips, but still failed one live-stream suite's cleanup hook. The fixture kept
five browser processes until the end of the file and treated blank-navigation
acknowledgement as completion. A regression reproduced those retained processes
and the ten-second exit failure in isolation. Browsers are now retired after
each case, using the existing explicit navigation-completion boundary before
closing them. The two-viewer case still runs both viewers together. Cleanup
attempts every owned resource and reports all failures.

The corrected fixture verifies that all five original browsers exited with
code zero and that their profiles were removed before a subsequent case runs.
Root-process and child-process exit checks retain the ten-second deadline;
force killing is never a pass. The live-stream, navigation and strict lifecycle
batch passed all 32 cases. Red/green evidence is retained in
`stream-lifetime-red.log` and `stream-lifetime-green.log`.

### Final complete gate: passed

After those corrections, `npm run verify` completed with exit code zero on
Windows, Node 25.6.0 and Chromium 153.0.8010.50. Build, test typechecking,
ESLint, dependency boundaries for all fifteen workspace projects and
repository-wide Prettier passed. All three raw test reports report success:

| Phase        | Files   | Tests     | Passed    | Failed | Skipped |
| ------------ | ------- | --------- | --------- | ------ | ------- |
| Shared       | 152     | 2,298     | 2,298     | 0      | 0       |
| Timing       | 1       | 8         | 8         | 0      | 0       |
| Solo browser | 18      | 174       | 174       | 0      | 0       |
| **Total**    | **171** | **2,480** | **2,480** | **0**  | **0**   |

The browser phase completed in 1,013.85 seconds. All eighteen files passed,
including setup and cleanup; this is not merely a count of passing test bodies.
All fifteen reference-app cases, all thirteen browser-service cases, the five
live-stream cases and the existing PoC browser coverage ran in this gate.
There were no skipped or todo cases, relaxed deadlines, force-kill successes
or reduced audit floors.

The retained evidence is `verify-per-case-cleanup.log`,
`verify-green-shared.json`, `verify-green-timing.json`,
`verify-green-solo.json` and `verify-green-summary.json` in the implementation
session artifacts. The summary records each raw report's SHA-256 and independently
checks every file and assertion status, not just the runner exit code.
The refreshed guide's literal Ledge Hop example also validated and passed through
the CLI; its zero-tick and empty-schedule mutations both failed on the named
jump assertion, recorded in `guide-example-result.json`.

| IDs      | Required observation                                                                                                    | Current evidence                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A01, A02 | Isolated installed artifacts type-check and bundle, without workspace aliases, Node modules or three.js in the DOM path | Passed: `extension-distribution.test.ts`; reproducible tarballs and executed independent bundles                                           |
| A03..A07 | Action-only execution, repeated determinism, continuation, rejection/idempotency and composable pause                   | Passed: runtime suite and `extension-labs.test.ts`; stale UI controls also rejected after same-revision restore                            |
| A08..A12 | Mid-puzzle saves, storage failures, migration/refusal, conflicting writers, backup/import and scoped reset              | Passed: save unit tests, real cross-tab IndexedDB and reference startup/partial-minigame recovery                                          |
| A13..A16 | Offset resume, stale callback exclusion, gesture recovery and bounded pack/voice/memory lifecycle                       | Passed in Chromium: spoken sample and service regressions; transport limits below                                                          |
| A17      | Keyboard-only and touch-only reference interaction, including help/exit                                                 | Keyboard and real emulated-touch gameplay/help/navigation passed; physical touch, software-keyboard entry and OS dialogs remain unverified |
| A18      | Hotspots remain aligned after viewport changes                                                                          | Passed: current-rect/letterbox mapping, accessible list and real browser resize/placement checks                                           |
| A19, A20 | 200% text, contrast, reduced motion, Cyrillic and long localized labels                                                 | Corrected: both routes retain exactly 390px layout/scroll width with loaded font at 48px; desktop/Cyrillic/reduced-motion checks passed    |
| A21      | Muted sound-clue route preserves equivalent information                                                                 | Passed: shared localized caption/text clue and non-audio completion route; not full narration coverage                                     |
| A22..A24 | Installed offline cold start, interrupted installs/updates and release request/global/log/storage privacy               | Passed: actual reference/service restart, controlled revision update and privacy checks in the complete gate                               |
| A25..A27 | Unique and invalid deduction fixtures, revealed-only notebook help and exhausted hints                                  | Passed: narrative suite and cited reference notebook/hint route                                                                            |
| A28, A29 | Content diagnostics and restoration without duplicate entry/reward effects                                              | Passed: invalid content fixtures, restored active nodes and idempotent reference reward                                                    |
| A30      | Private handoff excludes secrets from DOM, accessible output, captions and narration                                    | Passed: neutral handoff and immediate removal even when preference writes throw or never acknowledge; human screen-reader review separate  |
| A31, A32 | Full finite fixture enumeration, bounded failure and preserved generated-case identity                                  | Passed: both supported generated combinations enumerated; resolved case retained across catalog changes                                    |
| A33      | A4/Letter output with no clipped essentials and documented duplex behavior                                              | Passed: browser/PDF geometry and export; physical print alignment not established                                                          |
| A34      | Existing engine and demo behavior remains covered                                                                       | Passed: complete local gate, 171 files/2,480 tests; zero failed/skipped cases or failed hooks                                              |
| K01      | 10,000 presentation frames cannot change authoritative state                                                            | Passed: 10,000 actual rAF callbacks plus live continuation equals independent no-idle control; strict browser cleanup also passed          |
| K02      | Costs 0/1/2 update correct clocks/revisions; invalid action has no partial cost                                         | Passed: exact reference trace, UI/save revision updates and rejection checks                                                               |
| K03..K05 | Intermediate events, resumable multi-turn checkpoints and stable same-turn collisions                                   | Passed: runtime ordering plus real retry, unpause and intermediate-reload continuations match uninterrupted snapshots                      |
| K06, K07 | Adjustable event anchors and read-consistent simultaneous transformations                                               | Passed: runtime and six/eight-slot reference fixtures, including reversed traversal                                                        |
| K08, K09 | Same-turn meaningful saves and strict failed-write recovery                                                             | Passed: persisted free mutations and interrupted writes; unrelated failed write cannot acknowledge another checkpoint                      |
| K10      | External balance edit without rebuild; invalid/mismatched content refused                                               | Passed: external JSON next-run activation, content validation and incompatible startup recovery                                            |
| K11, K12 | Accessible responsive placement and non-color/non-motion/non-audio localized status                                     | Pointer/keyboard/tap routes, semantic localized status and exact narrow 200% layout passed; physical-device limits remain                  |
| K13..K15 | Atmosphere/silence, spoiler projections and persistent irreversible outcomes                                            | Passed: real audio interruption/voice checks, immediate private projection and restored terminal claims                                    |
| K16, K17 | Public headless/independent bundle equivalence and approved offline release route                                       | Passed: same rule trace/checkpoint, independent nested static build, restart and persisted offline state                                   |

### Final reference corrections and observed frames

The corrected consumer site has revision `b892ce8548959b41ef7e25ef` and uses the
same pinned SDK artifact set above. Both apps were measured at 390px viewport
width and 200% text: actual layout width and document scroll width were exactly
390px, with the bundled font loaded at 48px. Single-shell/header/pause-control
assertions guard against duplicate rendering. Fresh default, narrow and
narrow-200% screenshots have adjacent provenance and DOM-measurement recipes.

The final touch test uses actual CDP `touchStart`/`touchEnd`, not mouse or
`element.click` activation. It completes the story's dialogue, scene selection,
notebook/hint, matching, ordering, reward, two-player handoff and navigation,
including help/back, replay, pause and settings. It then completes the kitchen
route and compares its full acknowledged state with the headless trace.
`scrollIntoView` positions automation targets; this is not a physical-device
scrolling, software-keyboard or operating-system dialog acceptance.

The earlier 13-case reference run passed eleven functional cases but failed
restart, the subsequent print case and cleanup at the strict browser-process
exit boundary. That historical run is **not green**. After the storage and
target-readiness corrections, the expanded fifteen-case file passed, including
restart, print and both touch-navigation variants. Cleanup attempts the
remaining owned resources and rethrows all cleanup failures rather than hiding
them or leaving the preview/witness alive.

The original fast CI check samples 10,000 native animation timeline positions.
It is not the literal K01 observation. An additional independently bundled
consumer probe counted **10,000 actual `requestAnimationFrame` callbacks in
166,796.2 ms** while observing presentation/audio behavior without a game
command. The companion pause/visibility observations include zero audio voices
and paused animation while explicitly paused.

Comparing only two stored checkpoints would not detect uncheckpointed live
drift. The final probe therefore follows the idle interval with one normal,
trusted `wait` command. The full newly acknowledged snapshot, PRNG and named
streams equal an independent Node consumer that executes the same
`begin`, `startA`, `startB`, `wait` commands **without** the idle interval.
Both end at turn 2/revision 5, with no pending action and runtime hash
`e14f44f5332abf95`. Their canonical snapshot SHA-256 is
`14be3622804d4aa6b658ad618f3d0438af46288584a309527d5cae1e245de978`.
The earlier `observed-frames-continuation.json` recorded a passing measurement
but failed browser cleanup; that historical process result remains failed.
The final repeat used the same immutable installed consumer and independent
control, the corrected local temporary storage and the unchanged browser-exit
deadline, additionally checking child-process drain. Measurement, browser
cleanup and the overall process all passed with no cleanup errors, recorded in
`observed-frames-accepted.json` and `observed-frames-accepted.log`. No gameplay
source or oracle was changed to obtain this result.

### Measured transport and negative controls

The approved Russian welcome recording is 5.0649167 seconds long. The measured
pause and resumed native source offsets were both 2.5813333333 seconds:
**0 ms source-start discrepancy**, against the 250 ms acceptance threshold.
This is a media-transport observation, not a claim of sample-accurate physical
speaker output. Stale success and failure callbacks cannot complete, recaption
or unduck a replacement line.

Default bounds are four in-flight requests/decode tasks, sixteen voices, 32 MiB
encoded bytes per asset and 64 MiB owned decoded PCM. The lower-limit browser
fixture observed two concurrent requests, three voices, explicit excess
rejection, and 3,456,000 owned decoded bytes returning to zero on release.
A 1 KiB PCM budget rejected the spoken sample while retaining its caption and
zero owned PCM. Atmosphere crossfade peaked at two voices; explicit silence
remained at zero through interruption/unlock. Decoder/device-internal memory
is outside the owned-buffer accounting boundary.

Review fixes were observed failing before correction, including foreign-write
checkpoint acknowledgement, stale effect rejection, ambience-only suspension,
pack activation/removal races and update requests intercepted by an old worker.
The update regression installs changed same-URL bytes and a new URL into r2
while ordinary r1 gameplay still receives r1 and refuses the new URL.
The calibrated touch mutation first confirmed the hit target: late touch-action
produced one pointer cancellation, 253px page scroll and zero commits. The fixed
pre-contact policy permits one drag commit and one tap-alternative commit while
retaining page scrolling outside the designated surface.

## Platform, asset and editorial limits

No platform is marked accepted before it is exercised. In particular, Chromium
automation with touch emulation is not a physical touch-device or iOS Safari pass.

| Acceptance boundary                                                       | Status                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Windows Chromium, exact version and OS                                    | Chromium 153.0.8010.50 on Windows; packaged reference and service/legacy routes exercised                           |
| Firefox desktop, exact version and OS                                     | Not yet exercised                                                                                                   |
| WebKit automation, exact version and OS                                   | Not yet exercised                                                                                                   |
| Real touch device: layout, audio unlock/resume and offline installation   | Not yet exercised                                                                                                   |
| Russian spoken sample rights, provenance, playback and human voice review | Three original prerecorded lines supplied; welcome voice audition approved; final clue/completion listening pending |
| Bundled Cyrillic font and license                                         | Pinned Noto Sans/OFL; all 66 Russian alphabet codepoints verified and local font loaded in browser                  |
| Educational accuracy, age suitability, emotional safety and pronunciation | Requires editorial/human review; not machine-certified                                                              |
| Consumer campaign economy, reachable endings and full content coverage    | Consumer responsibility, not established by engine fixtures                                                         |

Fluffy Bureau's pending product choices remain configurable. Witch Kitchen's
ending precedence, shelf feasibility, turn/economy budgets, event ordering and
transformation policies remain consumer decisions. Fixture defaults must be
labeled as illustrative rather than silently defining those games.

Browser storage remains origin-scoped and subject to eviction or user clearing.
An acknowledged IndexedDB transaction is not a promise of permanent storage.
Offline readiness applies only to the installed, verified content revision.

## Consumer handoff

See [Standalone action-driven consumers](./api/standalone-consumers.md) for
artifact installation, public imports, static build and offline update policy.
The [runtime](./api/action-runtime.md), [browser services](./api/browser-services.md)
and [narrative toolkit](./api/narrative-toolkit.md) references document public
types, examples, schemas and bounds.

Pin the current full commit and use a fresh output directory for each immutable
build. SDK inputs must be clean; for an intentional development snapshot only,
add `--allow-dirty`. Its provenance records modified inputs and their digest
rather than presenting them as the unchanged commit:

```powershell
$revision = git rev-parse HEAD
npm run pack:sdk -- --revision $revision --out out\sdk-local
npm run test:consumer -- --artifacts out\sdk-local --keep
npm run trace:labs
npm run build:labs -- --base /my-project/labs/ --out out\labs-local
npm run preview:labs -- --dir out\labs-local --port 4318
```

Neither a packaged desktop release nor blanket mobile/cross-browser acceptance
is claimed. No milestone is declared completely accepted while its mandatory
ledger entries remain partial or pending.

Consumers continue to own their actual state schema and compatibility policy,
stories, game rules, art, recordings, localization catalogs, private-view policy,
balance, campaign acceptance and final release decisions.
