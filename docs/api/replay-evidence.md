# Explain the first replay divergence

Record on the **known-good revision**, using the intended scene, composed plugin, seed, tick rate and input. Keep that file when testing a new revision. A recording made after a bug appeared cannot explain what used to happen.

```powershell
npx aegis record games\iso\levels\server-vault.scene.json --ticks 960 --input games\iso\play\server-vault.input --explain --out vault.replay.json
npx aegis replay vault.replay.json --json
```

`--explain` opts **recording** into state-field and event evidence. Replay detects the evidence in the file; there is no replay flag to forget. Without `--explain`, the file is the ordinary `recording/1` with hash pins and **no additional snapshots or event batches**. A legacy recording still verifies what it actually pinned. Its JSON explicitly reports `details: {"status":"unavailable","reason":"hash-only-recording"}`; a hash cannot be inverted into field values or missing events.

## Read the result

- `verified` covers all recorded pins; `match` is the **final state hash only**. An event-only difference, or a transient state change that later converged, can have `match: true`, `verified: false`. Verification fails with exit 1 by default. `--no-verify` changes the exit policy, not the comparison. Omitting `--json` displays the same bounded differences as text.
- On a match, `details.status` is `matched`. On divergence, `firstDivergentTick` and `details.tick` identify the earliest difference in execution order, not just the earliest different state hash. `phase: "step"` uses the zero-based input step (step 2 observes the world **after** the third step); `phase: "initial"` means before step 0, including a zero-step run.
- `details.fields.differences` gives `path`, `expected` and `actual`. For example, a changed position can report `/entities/4294967296/components/Transform/position/x`, `{ "value": 2 }` vs `{ "value": 7 }`. Paths use JSON Pointer escaping, packed handles rather than array positions, lexical object-key ordering and numeric array order. Added/removed subtrees count as one difference. `{ "missing": true }` is distinct from `{ "value": null }`. Allocator, PRNG, resources and tick are compared too.
- `details.events` compares **ordered** events from this one step (or bootstrap): type, payload and emission tick. `firstDifference` is the zero-based index within that batch, or `null` when the events matched. Windows start at that index, or at zero for context on a state-only failure.
- The report returns at most **16 field differences** and **8 events per side**. Each side reports its true total; `truncated` also accounts for skipped prefixes or shortened entries. Paths, event types and canonical value previews are capped at **200 UTF-16 code units**. Shortened values report a `preview`, original `chars` and full-value `digest`, so equal-looking prefixes can still be distinguished; shortened paths/types are flagged separately. A hash pin that differs with identical detailed evidence has zero observed field/event differences: the report does not invent a cause.

## Harness and file costs

Use `runScene(scene, { plugin, ticks, input, captureReplayEvidence: true })` and persist `serializeRecording(result.recording())`. For a pass/fail replay from a scene path, `replayRecording(parseRecording(text), { plugin, ticks: 0 })` uses the file's run length, rate, seed, input and evidence mode. For structured differences, run the candidate independently with the same options and `captureReplayEvidence: true`, then call `verifyReplay(parseRecording(text), candidate)`. Supplying a detailed file but no candidate evidence does **not** quietly pass. Evidence is separate from `captureHistory`, `result.at()` and `recordEvents`.

The optional `evidence` block (`replay-evidence/1`) interns JSON values by their exact canonical encoding: unchanged entities, resources, allocator and PRNG parts need not be stored repeatedly. Bootstrap and each step retain dictionary references and their FIFO event batch. Capturing both sides still costs a snapshot and comparison work each step. Recording refuses rather than silently dropping pins above **16,777,216 canonical UTF-16 code units** (unique values plus frame records). This is an evidence budget, not a bound on pretty-printed file bytes, transient heap usage or simulation time. Use a shorter reproduction if refused. Normal per-tick hashing and its compatibility benchmark are documented in [World hashing](./world-hashing.md).
