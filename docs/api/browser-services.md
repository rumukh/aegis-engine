# Browser lifecycle services

`@aegis/browser` is an optional, framework-neutral adapter package for action-driven
games. It has no three.js, renderer, Node, server, capture, telemetry, or cloud
dependency. Existing physics games retain their controls and audio behavior.
The approved delivery target is an offline web app on ordinary static hosting,
including nested GitHub Pages paths, **not a packaged Windows application**.

## Public entry points

| Import                          | Responsibility                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@aegis/browser/save`           | Pure bounded JSON save codec, migration, replaceable storage interface, memory adapter, ordered save service |
| `@aegis/browser/indexeddb`      | Real transactional IndexedDB adapter                                                                         |
| `@aegis/browser/checkpoint`     | Strict `@aegis/runtime` checkpoint bridge                                                                    |
| `@aegis/browser/audio`          | Narration, authored atmosphere, independent buses, shared production voice cleanup/gain automation           |
| `@aegis/browser/audio/nodes`    | Narrow shared primitives for existing renderer dev/static/preview module graphs                              |
| `@aegis/browser/ui`             | Native controls, logical coordinates, placement, focus, projection, catalogs and opt-in preferences          |
| `@aegis/browser/offline`        | Declared resource graphs and transactional pack publication                                                  |
| `@aegis/browser/offline/worker` | Public worker attachment, fetch handler and registration helpers                                             |

The root re-exports these APIs and therefore includes the runtime checkpoint
dependency. `/save` remains independent of the runtime and browser storage; it is
usable headlessly. Browser globals are accessed only by the adapters that need
them, not as import-time side effects. Workers are consumer-bundled from the
**public export**, never imported from a private engine `dist` path.

## Persistence and strict checkpoints

`SaveEnvelope<State, Resume>` contains `format: "aegis.save"`, `formatVersion: 1`,
`gameId`, `profileId`, `contentRevision`, `schemaVersion`, engine
`{ id, snapshotVersion, revision }`, independent monotonic `revision`, full `state`,
consumer-owned `resume`, and optional JSON `settings`. Neither media clocks nor
timestamps participate in authoritative hashes. Durable state must include
pending actions/jobs, consumed claims, clocks, resolved content choices, and
every independently forked PRNG stream; executable systems, event history,
closures, DOM, promises and audio objects are not durable state.

Create a `SavePolicy` with:

- Exact game/profile, current state-schema version and engine compatibility.
- `acceptsContent(revision, schemaVersion)` and
  `validateState(value, schemaVersion)` for each explicitly supported version.
- `validateResume(value, schemaVersion)` and `isCurrentState(value)`.
- Optional byte/depth/node limits. Defaults are **4 MiB UTF-8**, depth **64**,
  **200,000** JSON nodes. Arrays must be dense, numbers finite, objects plain,
  identifiers bounded, and unsafe properties/cycles rejected.

Runtime consumers can use public `isRuntimeSnapshot` as the structural guard,
then additionally check the expected adapter, state version and content identity.
`host.restore` still owns full semantic/rule/reference validation. A structural
guard alone is not permission to apply a snapshot to the wrong game.

```ts
import { SaveService } from '@aegis/browser/save';
import { IndexedDbSaveStorage } from '@aegis/browser/indexeddb';
import { createSaveCheckpoint } from '@aegis/browser/checkpoint';
import { createRuntimeHost } from '@aegis/runtime';

const storage = new IndexedDbSaveStorage('my-application-saves');
const saves = new SaveService(storage, policy);
const saved = await saves.load();
const checkpoint = createSaveCheckpoint(saves, () => ({
  format: 'aegis.save',
  formatVersion: 1,
  gameId: 'my-game',
  profileId: 'local-profile',
  contentRevision: content.revision,
  schemaVersion: adapter.stateVersion,
  engine: { id: 'aegis-runtime', snapshotVersion: 1, revision: engineRevision },
  resume: currentResumeData(),
}));
const host = createRuntimeHost({ adapter, content, seed, checkpoint });
if (saved) {
  // First prepare and validate the matching installed content, not "latest".
  const outcome = await host.restore(saved.state, {
    durableRevision: saved.state.revision,
  });
  if (!outcome.ok) showLocalizedRecovery(outcome.error.messageKey);
}
```

`policy`, adapter/content and application functions above are consumer declarations,
not implicit engine defaults. A stored record is already durable; only pass its
runtime revision as `durableRevision` after reading/validating it. An imported
backup is **not** already acknowledged local storage.

`save(draft)` detaches/validates the draft immediately, then serializes every write.
It deliberately does **not coalesce**. Its resolved number names the actual stored
revision. `flush()` waits for outstanding writes, and rejects on failure rather
than returning an optimistic acknowledgement. Runtime revision, logical turn and
storage revision are separate: many meaningful zero-turn mutations can be saved.

The checkpoint bridge returns success only after the exact write is durable.
It refuses metadata that relabels the snapshot's effective content revision or
state schema version.
Runtime therefore cannot advance to the next multi-turn substep while a required
save is pending or failed. Retry with `host.retryCheckpoint()`, then explicitly
`host.continuePending()` if appropriate; **do not dispatch the original action
again**. The bridge recognizes the retained failed snapshot and retries that
write without replaying effects. Identical concurrent acknowledgements share
one write; changed/stale checkpoint identities are refused. Explicit
`SaveService.load`/`reset` changes its epoch and invalidates bridge deduplication.
Retries are also bound to an opaque write-operation identity, not merely the
service's failure status. If another caller's draft failed first, the bridge
refuses to claim or retry it as its own checkpoint. Resolve that foreign write
explicitly before resubmitting the checkpoint. `SaveService.save(draft, token)`,
`ownsFailedWrite(token)` and `retry(token)` support this ownership check; ordinary
direct `retry()` explicitly retries the service's actual retained draft.

Statuses are `idle`, `pending`, `saved`, `unavailable`, `conflict`, `failed`, with
persisted revision/pending count and a localizable error. Subscribe with the
returned unsubscribe function. UI displays a saved indicator only for the
acknowledged state, never simply because the UI has advanced.

### Transactions, recovery and backup

`SaveStorage.read/compareAndSwap/reset` is replaceable. `MemorySaveStorage` is the
headless adapter. `IndexedDbSaveStorage` reads the expected revision, preserves
the previous record and writes the new one in **one readwrite transaction**.
Acknowledgement occurs on transaction completion, not on a request's success.
The adapter requests strict durability; actual storage remains browser-managed.
Quota, blocked opens, unavailable storage, aborted transactions, corruption and
competing writers reject explicitly. There is no localStorage fallback.

`recovery()` reads the previous validated envelope without silently replacing
the current one. A corrupt/unsupported save is not converted into a new game.
`reset({ gameId, profileId })` requires exact namespace confirmation and CAS.
It removes only that profile's progress/recovery data, retaining a metadata-only
revision tombstone. This prevents a stale tab from overwriting a newly restarted
profile (the reset/ABA problem). Revisions do not restart at one after reset.
After a failed load whose storage revision could be read, explicit confirmed
reset remains possible; the application must disclose progress loss first.

`exportSave` and `importSave` are local bounded backup operations, not sync.
`migrateSave` accepts unique sequential `from -> from + 1` steps. A step can
provide `migrate(state)` or `migrateEnvelope({ state, resume, contentRevision,
settings })`. Every intermediate result is revalidated and size-checked.
Callbacks receive detached data. Failed migration never writes or alters the
original stored bytes. Future formats/schemas and absent steps are incompatible,
not an invitation to reset. Content migrations must explicitly accept their
source revision/version and produce an accepted target; matching identifiers
alone do not prove compatible rules.

Settings may belong to the envelope, but a separate settings profile is preferable
when preferences must change while gameplay is blocked. Declare that ownership;
do not use a settings change to bypass a strict gameplay durability failure.

Browser storage is origin-scoped and can be evicted, cleared or unavailable in
private mode. Transaction acknowledgement is **not an unconditional permanent-save
guarantee**. Offer local backup and explicit recovery. `storage.close()` closes only
the adapter's connection; it never clears unrelated databases.

## Audio transport

`createNarration({ baseUrl, onState, onCaption?, onComplete?, ...limits })` owns one
Web Audio context. `registerPack({ id, revision, assets, lines })` registers
metadata only. A line has a stable ID, asset ID, and consumer-localized caption.
Loading/decoding is lazy and pack-scoped; registering eight cases does not decode
eight cases. `releasePack(id)` aborts its pending loads, stops its voices and drops
its owned decoded buffers.

Call `unlock()` directly from a trusted interaction. The context is created/resumed
before an asynchronous boundary. Failed/suspended unlocks are observable as
`blocked` and require an explicit retry gesture; a bounded resume timeout defaults
to 3 seconds. A repeated gesture retries pending resume without creating duplicate
contexts or loops. `playLine(packId, lineId)`, `pause`, `resume`, `replay`, and `stop`
never dispatch game actions.

Statuses are `idle`, `loading`, `playing`, `paused`, `completed`, `blocked`, `failed`.
The caption is published with its request, stays readable on missing/undecodable
voice failure, and is cleared by `stop`/`clear`. A missing line ID has no invented
caption. Errors carry `aegis.browser.*` message keys separately from developer
diagnostics. The consumer must show a disclosed text-only fallback, not claim
narration succeeded.

Pause records elapsed **AudioContext time** and resumes a new buffer source at
that offset. Replay starts at zero. Request/voice identity prevents stale decode
or `onended` callbacks from replacing captions/completing another line, and active
completion is at most once. Context interruption preserves narration offset and
requests a gesture rather than silently advancing. Restored disk sessions normally
replay the current line from the beginning; this service does not promise durable
sample-exact disk offsets. Story progression remains manual/command-driven.
An obsolete effect request's **rejection**, as well as its successful decode, is
generation-checked: it cannot fail a replacement line, change its caption or
unduck music after a restore/privacy boundary.

`setVolume('narration' | 'music' | 'effects', 0..1)` controls separate buses.
Music ducking during speech defaults to gain 0.35 and is configurable.
`setAtmosphere({ packId, asset, fadeSeconds })` selects an authored loop; null
means **explicit silence**. Crossfades are bounded to 0..5 seconds and retain at
most two music voices; rapid replacements discard obsolete fades. Same-state
updates are idempotent. Silence survives pause/unlock without reviving a previous
loop. These are authored tempo/intensity variants, not pitch-preserving time
stretching.
Atmosphere-only interruption also publishes `blocked`, zero active voices and a
gesture-required error. `resume()` rejects while desired audio remains suspended;
`unlock()` recovers exactly one currently selected loop and clears the blocked
state. Explicit silence does not become an implicit request to restart a loop.

Use **`clear()` at restore/handoff/privacy transitions**: it clears captions,
invalidates pending one-shots/loops and stops owned voices. Then reconstruct
permitted ongoing ambience/lines from the new projection, never historical
one-shot events. `stop()` alone stops the narration line, not unrelated effects.
`dispose()` aborts loads, invalidates callbacks, disconnects nodes and closes only
the owned context.

Default bounds: **4 concurrent requests/decode tasks**, **16 active voices**,
**32 MiB encoded per file**, **64 MiB owned decoded PCM**,
**32 registered packs**, **4096 assets/lines per pack**. PCM accounting uses
buffer length times channel count times four bytes, not encoded file size.
Decode rejects and does not cache a buffer exceeding the budget; the browser may
temporarily allocate its decoder output before that check. Browser audio pipeline
and device memory are not fully measurable by this service. It does not use
browser-managed streaming media. Existing renderer quality limits remain
8/16/24/32 voices and its existing cue semantics remain unchanged.

Renderer audio and narration share extracted production `releaseAudioVoice`,
`cleanupAudioActions` and `rampAudioGain`; the DOM path imports no renderer types.
The legacy renderer imports only the declared `/audio/nodes` entry. Its shared
dev/preview import map, preview vendor allowlist and static module crawler resolve
that entry, including relative nested-deployment URLs. Preview does not expose
the browser package's root or its runtime checkpoint adapter.

## DOM/SVG, input and privacy

`logicalPoint` maps client coordinates through a **fresh**
`getBoundingClientRect()` and centered contain/letterbox transform. Reading the
current rect on each hit accommodates scrolling, resizing and rotation.
`validateHotspots/hitHotspot` operate on logical data. `createHotspotList` exposes
the same objects as labeled native buttons, so spatial precision is not required.
Layered illustrations, SVG composition and card/notebook/map layout remain plain
consumer DOM/SVG; no UI framework is imposed.

`createActionButton` uses native **click only** for activation; browsers synthesize
that for pointer, Enter and Space. It does not also dispatch on pointerup/keydown.
Repeated held keys and overlapping async activation are suppressed.

`createPlacement` offers `select`, pure `preview`, validated `place` and `cancel`.
Consumer validators explain invalid/full/irreversible destinations through
message keys; the engine never discards an item to make a move succeed.
`bindPlacementItem/bindPlacementSlot` connect semantic buttons to both dragging
and select-item/select-destination operation. The bound item button is the
designated drag surface: it receives `touch-action: pinch-zoom` **before contact**,
not after a movement threshold. Pan suppression is confined to that button;
outside page scrolling and browser zoom remain available. Unbinding restores the
button's original inline policy. Pointer capture, Escape, blur and scene/load
cancellation release transient selection. Touch/pen pointerup handles a completed
tap or drag once, suppressing associated compatibility clicks; mouse and keyboard
retain their native click route. Destination taps reject moved/cancelled contacts
instead of converting scrolling into a placement.
Touch tap selection requires neither drag nor hover. Logical adjacency comes
from `slotNeighbors(id, authoredAdjacency)`, never CSS/DOM order. Status badges,
ages and readiness are consumer projections of committed state, not timers.

`rememberFocus`, `openDialog` and `replaceProjection` implement native modal
focus/restore and explicit cancellation/audio/announcement hooks. Every caller
must clear live regions outside a replaced subtree too. `bindVisibilityPause`
adds/removes only the `"visibility"` reason, preserving other runtime pauses.
Dispose all returned bindings/listeners when their view is removed.

`projectPresentation(entries, { playerId, handoff, hideSpoilers })` returns only
permitted content fields. Denied private/spoiler text, caption and narration IDs
are **absent**, not CSS-hidden. Required warnings can use an authored
`safeAlternative`. Handoff returns no private entries. Build DOM, accessible
names/live regions and narration exclusively from this projection. The
authoritative save still contains secrets: trusted shared-device play is not
cryptographic privacy against local developer tools.

`createMessages` requires consumer catalogs and exact authored placeholders:
there is no English child-visible fallback or inferred grammatical inflection.
`applyPresentationPreferences` sets root language, 100..200% text scale, reduced
motion, comfort and spoiler flags. Preferences are serializable consumer-owned
data; the application must persist them. Cyrillic/yo and long labels are preserved.
Consumers supply/bundle licensed fonts with Cyrillic coverage; system fonts in
the reference CSS are a fallback, not a dyslexia-treatment claim.

`CHILD_SAFE_PRESET` and scoped `CHILD_SAFE_CSS` are **opt-in**: 48px minimum
controls, 24px main text, wrapping/reflow at 200%, high-contrast foreground/control
colors, visible focus, reduced-motion handling, manual advance, visibility pause,
and no telemetry/debug/outbound-link defaults. `choicePage` defaults to three
primary choices and supports explicit consumer-configured limits. Art-dependent
contrast, essential alt labels, sound-equivalent clues and actual screen-reader
usability still require application acceptance. Comfort colors/assets and
parent-facing settings/backup/reset controls belong to the consumer.

## Installed offline packs and static hosting

An `OfflinePack` declares stable `id`, `revision`, and every required shell,
script, image, audio, font, locale, style and data resource. Each resource has
its own ID, relative `src`, exact decoded-transfer byte count, kind and SHA-256.
Use a slash-terminated deployment `baseUrl`, including the repository/subdirectory
on GitHub Pages. Outbound/redirected URLs, duplicate URLs/IDs, query aliases and
paths escaping that base are rejected. Default limits are 32 MiB per resource,
64 MiB per pack, 4096 resources and four concurrent requests.

`OfflinePackStore.install` streams bounded responses, checks every size/digest,
and writes a unique staging cache. Only after **all** resources succeed does one
catalog publication make the pack discoverable. Failure/interruption removes
the owned staging cache; no partial pack is ready. Same-revision installers use
Web Locks to serialize publication across tabs. Unsupported secure-context
storage/crypto/locks produce an explicit unavailable state, not online-only
success. The opt-in browser support floor includes these APIs.

`inspect` verifies actual installed resources, not only a readiness flag.
`list` refuses corrupt/evicted entries instead of listing them as usable.
`activate(ref, accepts, safeBoundary)` requires a fully installed, compatible
revision and an explicit safe boundary. There is no forced reload or automatic
latest-content substitution.
The complete inspect/digest/activation interval holds the revision's shared Web
Lock. Installation and removal use the matching exclusive lock; removal refuses
a busy revision instead of deleting bytes under verification. Within the owning
store, activation/removal intent is reserved before the first await, and `retain`
rejects while removal is pending rather than returning a false successful hold.

Use the same `contentRevision` in saves and pack selection. Inspect/install the
exact saved revision before restore and give `SavePolicy.acceptsContent` the
validated compatibility decision. `retain` protects a revision in the owning
store until its release function runs. Enumerate all retained save/profile
references before **explicit maintenance removal**; in-memory holds are not
cross-tab leases. There is no automatic pruning of old revisions. `remove`
requires exact pack/revision confirmation and refuses that store's active/held
revision. It never deletes other namespaces.

A consumer service-worker entry imports the supported public exports:

```ts
import { OfflinePackStore } from '@aegis/browser/offline';
import { attachOfflineWorker } from '@aegis/browser/offline/worker';

const store = new OfflinePackStore({
  namespace: 'my-game',
  baseUrl: new URL('./', self.location.href).href,
});
attachOfflineWorker(self, store, {
  packs: [{ id: 'shell', revision: 'release-1' }],
  shell: 'index.html',
  onError: reportLocalFailure,
});
```

The consumer owns `reportLocalFailure` and must not send/log private state.
`registerOfflineWorker(script, baseUrl)` uses a scoped module worker. The fetch
handler uses explicit immutable revision pins and cached validated resources;
network fallback is **off by default**, outbound requests are denied, and missing
resources return 503 with a local error callback. Root and child-directory
navigations resolve only to their declared index resources. No `skipWaiting`,
client takeover or midgame reload is performed. Stage a new worker/content
revision and activate it under the consumer's save-compatibility/update policy.
Do not promise `file://` support.

Installation/update traffic is a separate explicit route. `OfflinePackStore`
uses `createInstallationRequest(resource, baseUrl, signal?)` automatically; the
worker recognizes its same-origin, application-local marker, strips it, and
fetches uncached bytes from the worker's own network context. `cache: "no-store"`
on an ordinary controlled-page fetch does **not** bypass a service worker.
Use the same public helper when downloading an updated manifest. Normal gameplay
continues to read its pinned old revision while changed and newly added URLs are
installed into a new pack; no cache or active-case swap happens during download.
Redirects/outbound paths remain forbidden. A deliberately read-only installation
can set `allowInstallationNetwork: false` on the worker routes.

The release helpers make no telemetry requests, expose no debug globals and log
no progress. `assertChildSafeView` rejects outbound navigation and embedded
frames/objects in a candidate view before mounting. It does not certify arbitrary
consumer JavaScript, hosting-provider logs, external CSS, or manually added
third-party integrations. Audit the assembled production bundle too.

## Measured evidence and remaining acceptance

Evidence on **2026-09-20**, Windows, **Chrome 153.0.8010.50**:

| Requirements      | Implementation/evidence                                                                                                                                                                                     | Acceptance boundary                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| SAVE-01..04       | Codec/migration/future-version/bounds tests; ordered detached writes; corruption refusal; real two-tab IndexedDB CAS, aborted-write rollback, previous copy and namespace reset; reset-ABA regression       | Browser eviction remains possible; not a permanent-durability claim                                |
| SAVE-05           | Public runtime bridge tests exercise failed intermediate turn, blocked dispatch, retry, continuation and acknowledged recovery without double charge; zero-turn saves have distinct revisions               | Full reference application routes are integration-owner evidence                                   |
| AUDIO-01..04      | Real Web Audio decode, captions on failure, offset pause/resume, stale source callbacks, scoped memory release and bounded requests/voices                                                                  | Actual Russian sample measured separately below; no synthetic tone counted as narration acceptance |
| AUDIO-05          | Two authored test variants, rapid crossfades, explicit silence, suspend/unlock, held-load cancellation                                                                                                      | Test variants are transport stimuli, not production soundtrack assets                              |
| UI-01/02/04/06/07 | Coordinate/adjacency/projection unit tests; real native keyboard/click/drag/Escape, emulated touch taps, selection across resize, Cyrillic labels, focus and private-tree removal                           | Physical touch, assistive technology and full consumer layout remain unverified here               |
| UI-03/05          | Opt-in thresholds/preferences, 200% real-browser controls/reflow and reduced motion; consumer-configurable pagination                                                                                       | Full artwork contrast, bundled font coverage and parent control UX belong to application review    |
| OFFLINE-01..03    | Real CacheStorage/SW, digests, interrupted install, retained/mismatched revision refusal; actual browser process restart with persisted profile/IndexedDB while every application HTTP request receives 503 | The reference release bundle still needs its own complete graph/privacy audit                      |

The approved Russian `lab.welcome.wav` is the default narration fixture at
`poc/lab-shared/assets/lab.welcome.wav`; `AEGIS_NARRATION_SAMPLE` can override it.
The workstream measured that same approved recording through the override before
the root integration placed it at the shared fixture path.
Decoded duration: **5.0649166667 s**. Mid-line pause: **2.552 s**.
Actual native buffer-source restart offset: **2.552 s**, observed
discrepancy **0 ms**, below the **250 ms** tolerance; a 350 ms pause did not advance
the retained offset. This measures the backend scheduling boundary, not
acoustic output or sample-accurate physical-device playback.

Atmosphere measured two peak voices, two requests and **1,152,000 bytes** of
decoded PCM; releasing the pack returned owned PCM to zero. Explicit silence
remained at zero voices across suspend and repeated unlock. A separate
concurrency/limit probe observed exactly **2 requests**, **3 voices** with three
additional effects rejected, **3,456,000 bytes** PCM, and zero after release.
Held narration/atmosphere loads did not resurrect after `clear()`.

A fresh Chromium page also exercised native autoplay denial (suspended context,
bounded blocked result and readable caption), then trusted-gesture recovery.
Explicit context suspension required another gesture and repeated unlocks
retained exactly one narration voice. Invalid media bytes produced a visible
failure while retaining the caption.

Review regressions also exercise foreign failed-write ownership, actual
controlled-worker installation of changed/new revision URLs, gated real-digest
activation versus removal, racing retention, stale effect **failure** after
replacement speech, atmosphere-only interruption, and touch dragging on a
scrollable mobile viewport. The late-touch-policy negative control receives a
real pointer cancellation, scrolls the page and commits nothing; the fixed
pre-contact policy commits once while outside scrolling and tap placement still
work. These remain emulated device checks, not physical-touch certification.

The browser suite uses real Chromium/IndexedDB/CacheStorage/AudioContext, with
injected transaction aborts and HTTP denial as deliberate failures. Memory-adapter
and typed-failure tests are not substituted for browser evidence. Atmosphere and
concurrency fixtures use synthetic WAV tones only as automated stimuli; the
narration-resume fixture uses the approved spoken recording, not those tones.

Firefox, WebKit/Safari, physical touch hardware, acoustic device interruption,
screen-reader review, and final-game privacy/editorial acceptance are **not
claimed**. Touch emulation is not iOS/mobile acceptance. No Windows wrapper or
full consumer game is implemented by this package.

Targeted commands:

```powershell
npx tsc -b packages\browser
npx vitest run packages\browser test\browser-services.browser.test.ts packages\render-three\src\client\audio.test.ts packages\render-three\src\client\audio-spatial.test.ts
npx vitest run packages\render-three\src\client-streams.browser.test.ts packages\render-three\src\preview\preview.browser.test.ts test\pages-site.browser.test.ts --no-file-parallelism
```

The real-browser integration spec lives in root `test/`, since its development
driver belongs to render-three; importing that driver from a browser-package
test would violate the package dependency DAG. It is not included in SDK artifacts.
The existing live-dev stream, standalone preview (including built CLI), and nested
static-site browser suites were also run after wiring the extracted public audio
entry. Unit-level audio success alone did not establish native-ESM route closure.

The repository integration owner runs the complete workspace gate, distribution
fixtures and reference acceptance after assembling the concurrent workstreams.
