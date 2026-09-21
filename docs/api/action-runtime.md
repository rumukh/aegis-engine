# Action runtime and logical turns

`@aegis/runtime` is the browser-neutral, renderer-free host for command-driven
games. Its only runtime dependency is the public `@aegis/core` package. It imports
no DOM, Node built-ins, physics mode, three.js, storage, network, or wall clock.
Existing fixed-timestep games retain their existing APIs and behavior.

The package exports ESM and declarations from its root. Consumers install the
coordinated packed artifacts, then import `@aegis/runtime`; do not import workspace
source paths. A Node program and a statically hosted browser bundle use the same
API. Offline installation, browser persistence and audio are separate adapters,
not background processes needed to execute a command.

## Minimal headless consumer

This complete example needs no renderer or timer. Balance is JSON data; the code
registers state, typed commands, rules and a view projection.

```ts
import { createRuntimeHost, parseContentJson, requireValue, schema, success } from '@aegis/runtime';

const contentRegistration = {
  schemaVersion: 1,
  schema: schema.object({
    actionCost: schema.number({ integer: true, min: 0, max: 2 }),
  }),
};
const content = requireValue(
  parseContentJson(
    '{"id":"sample","revision":"r1","schemaVersion":1,"data":{"actionCost":2}}',
    contentRegistration,
    'balance.json',
  ),
);

const host = createRuntimeHost({
  seed: 'sample',
  content,
  adapter: {
    id: 'sample',
    stateVersion: 1,
    state: schema.object({ moves: schema.number({ integer: true, min: 0 }) }),
    action: schema.literal('move'),
    content: contentRegistration,
    eventPhases: ['ready'],
    initialize: () => ({ moves: 0 }),
    resolve: (_action, read) =>
      success({ rule: 'move', payload: null, turns: read.content.data.actionCost }),
    commands: [
      {
        id: 'move',
        payload: schema.literal(null),
        progress: schema.literal(null),
        start(context) {
          context.state.moves++;
        },
      },
    ],
    view: (read) => ({
      moves: read.state.moves,
      turn: read.turn,
      revision: read.revision,
    }),
  },
});

requireValue(await host.dispatch('move'));
// getView(): { moves: 1, turn: 2, revision: 2 }
const saved = JSON.parse(JSON.stringify(host.snapshot()));
requireValue(await host.restore(saved));
requireValue(await host.dispatch('move'));
// getView(): { moves: 2, turn: 4, revision: 4 }
await host.dispose();
```

The larger executable fixture is
[`packages/runtime/test/fixture.ts`](../../packages/runtime/test/fixture.ts).
It demonstrates action costs 0/1/2, registered random streams, claims, two
concurrent jobs, arrival/expiration ordering, phases, adjustable allowance and
simultaneous slot transformations. Fixture ordering and prices are illustrative
policies, not Witch Kitchen or Fluffy Bureau game rules.

## Three separate clocks and three separate outcomes

| Concept           | Meaning                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revision`        | Increases once per committed zero-turn command, paid substep or content activation.                                                                      |
| `turn`            | Increases only for an accepted paid command's intervening logical turns.                                                                                 |
| Presentation time | Owned by the browser/audio/renderer; absent from snapshots and hashes.                                                                                   |
| Accepted          | A command was resolved and its first consistent substep committed. Invalid commands have no committed effects.                                           |
| Committed         | State, view, hash and transient events for one substep have been published. This does **not** mean persisted.                                            |
| Durable           | The configured checkpoint writer acknowledged that exact revision. This is the adapter's declared storage guarantee, not immunity from browser eviction. |

`dispatch` returns a promise because checkpoint acknowledgements are asynchronous,
not because gameplay rules may run asynchronously. The first committed view is
published synchronously, before storage IO. A zero-turn change is visible without
waiting for a paid turn. Subscriptions are not called immediately at registration;
read `getView()` for the initial projection.

Success returns `DispatchReceipt` with `accepted`, `revision`, `turn`, `hash`,
`durable` and `pending`. The failure arm includes `error` and `progress`:
`accepted`, `committedRevision`, `durableRevision` and `pendingAction`.
An invalid action has `accepted: false` and `committedRevision: null`. A failed
save **after** a commit has `accepted: true`; retry the checkpoint, not the action.
If a later substep fails, earlier committed substeps remain valid and resumable.
`pending: true` on success means a pause stopped the accepted action at a boundary.

Without a checkpoint writer, execution is in-memory and `durable` remains false.
`flush()` explicitly fails rather than claiming persistence in that mode.

## Registered state, rules and randomness

`RuntimeAdapter<State, Action, View, Content>` registers:

- `state` and `action` schemas, `stateVersion`, and a stable adapter ID;
- a `ContentRegistration` with schema version and optional cross-reference checks;
- synchronous `initialize`, `resolve`, `view`, command handlers and job handlers;
- an ordered `eventPhases` list and optional named `randomStreams`;
- optional `validate(read)` for active state, pending action, job and content references.

Schemas and rules are trusted executable application code registered at startup.
Content and snapshots are plain data, never evaluated as code. Rules must be
deterministic and side-effect-free outside their provided draft context; a closure
holding a mutable counter or independent PRNG is **not** durable state. The runtime
rejects promise-returning rule callbacks, but cannot make arbitrary consumer code
with an infinite synchronous loop safe. Its automatic job chains are bounded.

All authoritative data is stored in the registered
`world.resources["aegis.runtime.state"]` resource plus the explicit runtime
envelope. `world.tick` stays zero: it is not the logical clock. Consumers mutate
only `context.state` in staged transitions and may replace it wholesale. The live
world is never handed to a renderer or callback. Read contexts, content and
projection inputs are deep-frozen copies; returned views/snapshots and individual
listener arguments are isolated copies.

`resolve(action, read)` validates legality and resolves an `ActionPlan`:
`{ rule, payload, turns }`. It may draw from `read.random()` or
`read.random("registered-name")`. All draws are staged. Rejection, invalid state,
throwing projection or first-substep failure rolls back state **and** all streams.
No invalid command costs a turn, charges a resource, publishes an event or consumes
randomness. Costs must be nonnegative safe integers within `maxTurnsPerAction`.

Named streams are forked once, before initialization draws, and their states are
captured independently. The exposed random facade intentionally has no `fork`,
`load` or `save` method: arbitrary unsaved closure streams are not a supported
continuation route.

Command handlers have `payload` and `progress` schemas and optional
`start`/`turn`/`finish` callbacks. `start` runs once and may initialize
`action.progress` (initially `null`). `turn` runs for each paid logical turn.
`finish` runs once. Only `progress` is writable by the handler; modifications to
the passed action ID, cost, completed-turn counter or resolved parameters are not
accepted as engine state. Persist data needed by later substeps in `progress`.
Schemas validate state and resolved data without silently normalizing it; a
normalization that changes a saved value requires an explicit migration.

`context.claim(id)` consumes a durable claim and returns false if already claimed.
Consumers must choose idempotent behavior or reject duplicate command resolution.
`dispatch(action, { expectedRevision })` rejects stale UI commands before any
rule executes. Hidden/disabled choices still need consumer legality checks; a
visible button is not authorization.

## Commit order and resumable actions

For the first substep:

1. Parse the command, resolve its plan once, and stage `start`.
2. Drain work ready at the existing turn.
3. For a paid action, advance exactly one turn, run `turn`, then drain ready jobs.
4. If complete, run `finish` and drain its immediate jobs.
5. Validate state, references, progress and the projected view; atomically publish.
6. If configured, await this revision's checkpoint before any further substep.

Subsequent substeps omit resolution and `start`. Every paid turn has one commit;
the start/finish effects belong to the corresponding first/last turn commit.
A zero-turn command has one commit and does not age future jobs.

The snapshot includes the resolved pending action's ID, rule, payload, total
turns, completed turns and effect progress. There is no extra action opportunity
between substeps. `continuePending()` resumes that data without resolving again,
rerolling, recharging or rerunning `start`. A bad later rule leaves the prior
committed boundary intact and blocks unrelated actions; repair/recover explicitly.

`subscribe(view, reason)` refreshes UI (`reason` is `commit` or `restore`).
`subscribeCommits(commit)` exposes one immutable-by-isolation commit with snapshot,
hash, kind, action ID, view and transient events. One-shot audio/UI effects should
consume these live events, never replay an event history or infer a chime from
redrawing the same state. `subscribeStatus` exposes pause, busy and durability.
Listeners cannot cause nested commits: dispatch during a rule, writer, or listener
delivery rejects as `busy`, and nothing is queued. Unsubscription is idempotent;
listeners removed during delivery are not invoked later in that delivery.
Listener exceptions cannot roll back a published commit and are exposed through
`status.error` and optional `onError`, not silently swallowed.

## Strict checkpoint adapter contract

```ts
import type { CheckpointWriter } from '@aegis/runtime';
import { failure, success } from '@aegis/runtime';

const checkpoint: CheckpointWriter = async (request) => {
  // request = { revision, hash, kind, snapshot }
  // Persist this exact snapshot using the browser storage adapter.
  // Await its transaction/CAS acknowledgement, not just the start of a write.
  const acknowledged = await saveExactSnapshot(request.snapshot);
  return acknowledged
    ? success(undefined)
    : failure('storage-unavailable', 'Checkpoint transaction was not acknowledged.');
};
```

`saveExactSnapshot` above represents the consumer's configured storage service,
not an in-memory test double or a built-in runtime function. A browser save bridge
wraps this snapshot in its versioned game/profile envelope and keeps storage CAS
revision separate from runtime revision. It must serialize writes, detect writer
conflicts and retain a recovery copy. It must not coalesce away intermediate turns.
The runtime passes a frozen checkpoint copy and does not start the next substep
until acknowledgement.

`getStatus()` reports `checkpoint: disabled | idle | pending | failed`,
`checkpointRevision`, `durableRevision` and a structured error. After failure:

1. Leave the already committed view visible with an explicit unsaved/recovery state.
2. Call `retryCheckpoint()` to submit the **same revision/hash/snapshot** again.
3. On acknowledgement, call `continuePending()` if an action remains.

Retry does not emit another commit, rerun effects or proceed with remaining turns.
If a backend might have committed before its response was lost, the browser bridge
must reconcile the identical revision/hash idempotently rather than overwrite
conflicting progress. A writer's false success cannot be detected by the runtime.

`flush(revision)` acknowledges only an already persisted requested revision (or
awaits the currently active write). It does not silently retry a failure. The
initial uncommitted revision zero is not automatically written; before the first
meaningful commit it has no durability claim. Page-close flushes are at most
best-effort additions, not the primary save policy.

## Pause, restore and disposal

Pause is a **reason set**, with caller-owned string reasons such as `user`,
`visibility`, `handoff` and `parent`. Removing visibility cannot remove user pause.
Pausing never consumes a turn or changes the authoritative hash. Paused commands
reject immediately. Settings, help and narration controls remain external to the
gameplay command path; they may remain available while gameplay is blocked.

If pause arrives while a committed step is being written, that write may finish,
but no next turn begins while any reason remains. The dispatch resolves with a
pending action. `resume(reason)` only removes the reason; call `continuePending()`
explicitly to finish the accepted action. Never resubmit buffered input.

Idle waiting for input is **not** a pause. A browser may run CSS animation,
presentation frames and ambience without calling dispatch. Explicit user pause,
reduced motion and mute are different policies belonging to the presentation
adapter. The runtime itself owns no frames, timers, DOM listeners or audio.

`restore(candidate, options)`:

- blocks dispatch, copies the candidate and validates its complete structure;
- checks adapter/state version, exact content revision/hash, saved streams,
  pending rule/progress, job tokens/anchors, clocks, claims and consumer references;
- stages a replacement and its view without invoking `initialize` or entry effects;
- optionally awaits `prepareRestore(snapshot, content)` for active-content IO;
- replaces state once and publishes exactly one restored view, with no commit events.

The browser should discard transient selections, pointer captures and obsolete
audio callbacks on the restored-view notification, then reconstruct current UI.
Never reconstruct by replaying history. By default the pause reasons current at
installation are preserved, including additions and removals while asynchronous
preparation is pending. An explicit `pauseReasons` override is copied and validated
before preparation, then intentionally replaces the set only on successful
installation. Failed preparation leaves the current pause reasons untouched.

If the browser loaded an acknowledged record, pass
`{ durableRevision: candidate.revision }`. Any other supplied revision is rejected.
Without that evidence, strict hosts block gameplay until the restored checkpoint
is explicitly acknowledged via `retryCheckpoint()`.

Invalid restore leaves current state, view and content unchanged. A restore may
supersede outstanding checkpoint IO for explicit recovery. Late responses belong
to the old operation and cannot alter the new session's durability or continue
its old action. The storage adapter still owns actual transaction cancellation or
serialization; invalidating runtime callbacks cannot undo a completed disk write.
Restore during synchronous rules or notification delivery is rejected.

`dispose()` invalidates outstanding async callbacks, clears only this host's
subscriptions and rejects subsequent commands. It does not dispose shared
browser services or pretend to cancel a storage transaction it does not own.
No callbacks from outstanding preparation/writes can install state after disposal.

## Scheduled jobs, event anchors and phases

Register job handler IDs and payload schemas in `adapter.jobs`. A job is data:

```ts
const ticket = context.schedule({
  id: 'job-a',
  rule: 'ready',
  payload: { item: 'sample-item' },
  anchor: { kind: 'elapsed', turn: context.turn + 2 },
  phase: 'ready',
  priority: 0,
});
```

A delay of two scheduled at elapsed turn 5 is ready on turn 7, after the command
turn callback and before that turn's commit. Use the current turn for explicitly
immediate work. A past target is rejected.

Stable resolution order is:
**due turn, registered event-phase index, ascending priority, lexical stable job ID,
token**. This is independent of insertion order and browser callbacks. Each job
is removed and its durable consumed ticket recorded when its handler commits.
New immediate work cannot sort before or equal to the executing job; that is an
explicit `event-order` failure, not an iteration-dependent revisit.

`cancel({id, token})` rejects missing, completed or replaced tickets. Replacing
requires `schedule(newRequest, exactOldTicket)` with the same stable ID and gets
a new token. Reusing an ID without replacement is rejected while it is pending.
Tokens and consumed markers survive restore. An external completion callback
must not bypass this command/ticket boundary.

`enterPhase(id, allowance, "reject" | "cancel")` creates a new phase instance at
the current elapsed turn. The policy handles old **phase-anchored** jobs; absolute
elapsed jobs remain pending. There is no implicit dawn, free resource, wait,
turn advance or terminal result. Author explicit wait/end-phase commands.

| Anchor        | Due turn                                                   |
| ------------- | ---------------------------------------------------------- |
| `elapsed`     | Declared absolute `turn`, never changed by allowance.      |
| `phase-entry` | Saved phase instance's `enteredTurn + offset`.             |
| `phase-end`   | Saved phase instance's `enteredTurn + allowance + offset`. |

Entry offsets are nonnegative; end offsets may be negative. Anchors must refer
to the current phase instance. `adjustAllowance` changes only unconsumed
end-relative targets. Moving a pending target into the past is rejected atomically.
Consumed one-shots never reappear after an extension. Elapsed time is never
rewound, and a remaining-turn display is derived from phase data, not authoritative
clock mutation.

For simultaneous boundary transformations, use `applyBoundaryTransforms(state,
rules)`. Each named rule reads the **same frozen pre-boundary state** and returns
field writes. Rules are sorted by ID, duplicate IDs and overlapping parent/child
writes are rejected, and writes address existing own fields only. No sequential
neighbor cascade or iteration-dependent last-writer wins is permitted.
Install the result with `context.state = requireValue(result)` within a command.

Runtime defaults: at most 1,000 turns per action, 1,000 automatic jobs and 1,000
emitted events per commit, 10,000 pending jobs, and allowance at most 1,000,000.
Configure `limits` explicitly when needed. JSON validation bounds depth to 64,
traversal to 100,000 values and strings/keys to 2,000,000 characters; default schema
arrays are limited to 10,000 elements. Plain values only: no accessors, functions,
symbols, sparse/labeled arrays, class instances, nonfinite numbers or reserved
prototype keys. Bound violations are diagnostics, not fallback success.

## External JSON, staged reload and saved compatibility

Use `schema.object`, `array`, `record`, `union`, `literal`, `string`, `number`,
`boolean` and `json`, or implement the public `Schema<T>` interface.
Object schemas require exactly their declared fields. Use a union with
`schema.literal(null)` for an explicitly nullable field.
`InferSchema<typeof schemaValue>` yields a mutable state type.

`ContentRegistration.validate(data)` performs complete-pack cross-reference and
rule-variant checks. `validateReferences` supplies duplicate-record and missing-ID
diagnostics carrying catalog/file, record ID and field path. Numeric turn costs,
capacities, yields and other consumer balance bounds belong in the consumer
schema, not hard-coded engine constants. Developer diagnostics and localizable
`messageKey` values are separate; do not announce private diagnostic data in a
release live region.

For an edit-validate-reload loop without TypeScript recompilation:

1. Edit balance JSON and assign a new content revision.
2. `parseContentJson(text, registration, filename)` validates bounded JSON.
3. `host.stageContent(candidate)` validates and retains the complete pack.
4. Choose `activateContent(candidate, "restart")`, or `"boundary"` only when
   `canActivateContent` approves the current state and no pending jobs/actions exist.

Staging never changes active state. Invalid candidates preserve the prior pack.
Reusing one ID/revision with different content is refused. Boundary activation
may apply a synchronous registered `activateContent` transformation and commits
atomically; restart intentionally creates a new game with the saved seed while
keeping state revision monotonic. Activation itself is a strict checkpoint.

Snapshots pin content ID, revision, schema version and a deterministic hash of
the complete effective pack. Staged installed packs are retained by this host,
so an old save can select its exact revision; a new process must reinstall that
pack or report incompatibility. Never recompute resolved jobs/choices/rewards
under edited rules. The offline adapter owns retaining pack assets across launches.

`stateVersion` is the consumer's state/rule compatibility contract; update it
when changed rule semantics cannot continue old snapshots. The runtime format and
core snapshot versions pin the engine-side representation. Consumer migrations
must explicitly produce a fully valid compatible snapshot; restore does not
silently normalize or run new-game effects. `validateRuntimeSnapshot` and
`isRuntimeSnapshot` expose structural/core checks for generic save envelopes;
only `host.restore` has the registered adapter/content context for semantic checks.

## Headless evidence and limits

Run the focused suite from the repository root:

```powershell
npx tsc -b packages\runtime
npx tsc -p packages\runtime\tsconfig.tests.json
npx vitest run packages\runtime\test --reporter=dot
npx eslint packages\runtime
```

`runCommandTrace(host, steps)` collects commit hashes, turns and event types.
Each step names relevant `ruleIds` and may pin literal turn/revision/hash
expectations or supply an assertion returning `Outcome<void>`. Rejection can be
an expected result. Failure reports identify seed, content revision, step,
action, logical turn, revision and rule IDs. These reports are development data;
the helper never logs or exposes global inspection state.

| Requirements              | Scoped evidence                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| HOST-01..04; A03..A07     | Action-only execution; atomic negative cases; pause set; JSON continuation; staged restore; listener reentrancy and disposal.            |
| TURN-01..03; K02..K05     | Costs 0/1/2, immediate views, exact intermediate checkpoints, resolve-once progress, saved streams and deterministic collisions.         |
| TURN-04; K06..K07         | End-anchor recalculation, preserved consumed events, phase instances, simultaneous transformations and deterministic conflict rejection. |
| Runtime SAVE-05; K08..K09 | Separate revision/turn, strict non-coalescing barriers, failed-write recovery, pending action blocking, stale IO ownership.              |
| DATA-01..03; K10          | JSON bounds/references, no-code parsing, valid balance edit without engine rebuild, staged activation and matching-revision restore.     |
| TURN-05; headless K16     | Public trace helper, renderer-free fixtures, negative/mutation controls, independent literal golden.                                     |

The 10,000-read idle test proves authoritative state does not change merely by
reading views; it is **not** evidence of animated browser frames, working ambience
or real device behavior (the presentation portions of K01). In-memory checkpoint
test doubles prove the runtime barrier, not IndexedDB/browser acceptance.
Independently packed/browser traces, offline cold start, storage conflicts,
accessibility, audio and real-device acceptance belong to integration evidence.
The existing root workspace gate and existing mode/demo regressions remain
required at integration. These fixtures do not prove either consumer game's
economy, campaign reachability, endings, actual art or narration.
