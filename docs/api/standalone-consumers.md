# Standalone action-driven consumers

The extension SDK consists of `@aegis/core`, `@aegis/runtime`,
`@aegis/narrative` and `@aegis/browser`. A consumer installs a **complete local
tarball set**, not source aliases or deep imports into the engine checkout.
No registry publication is performed or required. The source packages and
packed packages remain `private: true`.

The approved delivery target is static/offline web, including nested GitHub
Pages paths. A desktop wrapper is not required or demonstrated. Existing
platformer, iso, FPS and horror PoCs keep their current entry points.

## Produce a pinned artifact set

Use the repository's supported Node/npm toolchain and locked dependencies:

```powershell
npm ci
npm run pack:sdk -- --revision <full-40-character-commit> --out out\sdk-release
npm run test:consumer -- --artifacts out\sdk-release --keep
```

The commit must equal this checkout's HEAD. Normal packing rejects modified or
untracked SDK inputs. During coordinated uncommitted development, add
`--allow-dirty` explicitly. This does **not** label the files as the unchanged
commit: `workingTree: "modified"`, the full source inventory and its digest are
stored in both `artifacts.json` and each package's `aegis-build.json`.

Packing captures source bytes into a fresh temporary staging tree and compiles
there; it never trusts an existing workspace `dist`. Every package includes
JavaScript, declarations, explicit exports, license, source/source maps and
build metadata. All sibling dependencies are rewritten in staging to the same
exact `0.0.0-local.r<revision>.d<digest>` version. Source manifests are untouched.
The digest includes build inputs and the Node/npm/TypeScript versions. The
artifact manifest also records each tarball's SHA-256 and npm integrity.

Output directories are immutable: the command refuses an existing destination.
The focused distribution test builds the same inputs twice and compares tarball
bytes. Different source bytes or compiler tool versions require a new artifact
set. Neither reproducible filenames nor a source revision alone prove byte
correspondence.

## Install into another repository

Copy all four tarballs and `artifacts.json` into a consumer-owned vendor
directory. Install **all four files in one npm invocation**:

```powershell
npm install --save-exact .\vendor\aegis-core-<version>.tgz .\vendor\aegis-runtime-<version>.tgz .\vendor\aegis-narrative-<version>.tgz .\vendor\aegis-browser-<version>.tgz
```

Commit the consumer's vendor policy and lockfile as appropriate. Do not install
only one tarball and let its exact siblings resolve from a public registry.
Do not replace dependency declarations with `*`, workspace aliases, or paths to
engine output. Updating the pinned engine means generating and validating a new
complete set, replacing the vendor files and deliberately updating the consumer
lock. Retain content/save compatibility policies independently of SDK updates.

Imports use public exports:

```ts
import { createRuntimeHost, parseContentJson } from '@aegis/runtime';
import { createNarrativeState } from '@aegis/narrative';
import { SaveService } from '@aegis/browser/save';
```

The Node rule path imports core/runtime/narrative only. Browser services expose
explicit storage, audio, UI and offline entry points. They do not load the
renderer, three.js, capture server or Node filesystem. Consumer code still owns
its state schema, legal commands, balance data, localized catalogs and content.

## What the independent fixture actually checks

`test:consumer` creates a new OS-temporary project outside the workspace, copies
the artifacts, and installs its own pinned TypeScript/esbuild tools. `NODE_PATH`
is cleared. Installed Aegis package trees are checked for symlinks, exact sibling
versions, provenance and licenses.

Every public entry is imported through its export map. A browser typecheck uses
DOM libraries without ambient Node types; a separate core/runtime/narrative
typecheck excludes DOM too. Both bundles are generated with tree shaking disabled
and reject Node built-ins, renderer and three.js imports. The Node bundle is
executed. Missing packed declarations or relative runtime files therefore fail
in the consumer rather than being supplied by a workspace alias.

The same fixture copies the two labs' consumer-owned composition roots, checks
their types, executes their Node traces and builds their nested-path static site.
`test/extension-distribution.test.ts` compares those traces with the workspace
route. `test/extension-labs.browser.test.ts` **serves that independently installed
consumer's build**, not a workspace bundle: its browser checkpoint is compared
with the headless scenario, then its entire HTTP origin is denied after a real
browser-process restart. No developer server API answers game commands.

`--keep` retains the temporary consumer with its own lockfile, bundles,
metafiles and `consumer-report.json` for investigation. Without it, the owned
temporary directory is removed. Initial tool installation can require registry
access through the documented npm proxy; **application execution** must not.
The standalone command is not itself evidence of offline installation, speech
quality, real touch support, or finished game content. The separate browser test
exercises installation/restart; physical-device and editorial review remain distinct.

## Run and deploy the tiny labs

```powershell
npm run build
npm run trace:labs
npm run build:labs -- --base /my-project/labs/ --out out\labs-release
npm run preview:labs -- --dir out\labs-release --port 4318
```

Open the reported loopback URL, then choose either lab. Upload the generated
directory unchanged to the corresponding static-host base path. The build emits
only static resources, a digest-checked resource graph and a bundled public
service-worker entry; it contains no accounts, remote service calls or daemon.
The preview is only a read-only local file server, not an application dependency.
Output directories are immutable; choose a fresh output path for another build.

Select **Install for offline use** once while connected. Readiness appears only
after all declared resources verify and the worker registers. The worker pins a
specific content revision, neither skips waiting nor forces a reload. Installation
and active source revision are not silently switched under a running case.
An installed pack includes both routes, data, local font, three spoken samples,
two small synthetic atmosphere fixtures and both print layouts.

For data iteration, edit `poc\turn-kitchen-lab\balance.json`, validate with the
headless trace, or edit the emitted `turn-kitchen-lab\balance.json` in an
**uninstalled development preview** and select the validated-new-run control.
The latter needs no TypeScript rebuild. Rebuilding is necessary before publishing
a new resource graph: an installed worker deliberately serves its pinned data.
Saves from another content revision are refused, not silently rebalanced.

Explicit update discovery uses `createInstallationRequest` from
`@aegis/browser/offline`, including the reference install button and development
balance-reload control. The controlling worker routes those marked same-origin
requests to the network without replacing its pinned gameplay responses.
Ordinary `fetch` or `cache: "no-store"` is not an update bypass. Publishing and
installing a complete new resource graph is still required for cold-start support
of newly edited rules; downloading a candidate alone does not activate a worker
or migrate existing saves.

The illustrative kitchen policies are explicit: two recipes start at zero-turn
cost; their delays are elapsed-turn anchored; the intermediate notice and arrival
are phase-entry anchored; expiration is phase-end anchored. Default turn 1 emits
the notice; turn 2 resolves batch A, batch B, arrival, expiration in that order.
Allowance edits move only unconsumed end-relative work. Next phase rejects
outstanding phase work rather than discarding it. Every neighboring-slot
transformation reads the same pre-boundary arrangement. These are fixture
policies, not decisions for either consumer game's economy or campaign.

`storybook-lab` has three bounded minigames, a small deduction/notebook example,
two private family projections and an idempotent cosmetic claim. Its generated
fixture exhaustively enumerates two approved structural combinations and saves
the resolved definition, not only the seed. This demonstrates finite composition,
not unlimited stories or editorially complete cases.

The print links expose A4 and Letter HTML for cards, a token, map, notebook and
rules using approved fixture IDs. Select actual size/100%, disable browser
headers/footers and test long-edge duplex on one sheet before cutting.
Browser geometry/PDF checks do not certify a physical printer's registration.

## Reference scope and release limits

`storybook-lab` and `turn-kitchen-lab` are small original fixtures, not either
motivating full game. Their TypeScript imports only public SDK exports. Kitchen
balance is external versioned JSON: edits are validated and activated only at
the declared fresh-run boundary, without rebuilding engine TypeScript. Existing
pending actions and saves remain bound to their content revision.

The reference shell uses consumer-owned Russian and English catalogs, native
keyboard/tap controls, captions, presentation preferences and explicit storage
status. Browser storage may be unavailable or evicted; an acknowledged write is
not an unconditional long-term durability guarantee. Local export/import is
backup, not cloud synchronization.

Controls capture the authoritative revision and a view-generation token when
rendered. Replaced controls cannot submit into a newer view, including a restore
whose numeric revision matches the prior view. Narrative choices and minigame
moves additionally carry their originating node/progress revision.

The shared reference controller continues **only already accepted pending work**
after checkpoint retry, unpause or intermediate-checkpoint reload. It calls the
runtime's `continuePending`, never re-dispatches the original action. A paused or
failed checkpoint is not labeled an ordinary completed action. Spoiler/privacy
preferences change the projection and cancel audio before their asynchronous
preference write; a failed write is reported without exposing the prior card.

Invalid, future or incompatible startup saves show recovery controls rather
than a new game or an endless reload-only screen. The original bytes can be
exported, a replacement/previous record is validated against both the envelope
and live adapter contract before CAS installation, and reset requires explicit
confirmation of the selected profile. Unavailable storage stays blocked; no
application can promise recovery from browser eviction or unreadable storage
metadata. These are local recovery controls, not permission to overwrite another
tab's newer revision.

Static hosting is not offline installation. The optional offline route must
finish validating the required same-origin resource graph before announcing
readiness, and a restarted offline browser must be exercised separately.
HTTPS is required outside loopback; unvalidated `file://` launch is unsupported.
Do not force a reload in the middle of a case to activate a content update.

Three original Russian sample lines are bundled with sanitized production
provenance and the user-approved voice audition. The other UI/story lines are
text/caption routes; **complete narration coverage is not claimed**. The two
additional lines still need final human editorial listening. Missing/failed
playback leaves readable captions and an explicit failure state. Synthetic
atmosphere pulses and screen-reader output are not spoken-narration evidence.
Same-session spoken pause/resume is checked with a 250 ms maximum unintended
offset difference. The source transport limits remain four requests, sixteen
voices and 64 MiB owned decoded PCM by default; focused service tests also
exercise lower limits and deliberately reject a 1 KiB PCM budget.

The local OFL Noto Sans font retains its original license and pinned SHA-256.
It is a readability option with Cyrillic coverage, not a medical claim. Likewise,
Chromium touch emulation is not a physical touch-device or Safari acceptance.
The reference tests use Chromium on Windows; Firefox, WebKit, real touch devices,
physical printing and final editorial review are not claimed. The fast automated
idle check samples 10,000 animation timeline positions, not displayed frames.
A separate probe observed 10,000 actual browser animation-frame callbacks and
then used a normal command to compare the newly committed live state with an
independent no-idle headless control. The full state and PRNG matched, but that
probe's strict browser teardown failed. See the
[extension acceptance report](../extension-acceptance.md) for the distinct
measurement, process and whole-workspace outcomes; no failed cleanup is counted
as a pass.

The release shell makes no application telemetry calls and includes no outbound
child links, debug state globals or runtime service requirement. This policy
covers the shipped fixture and SDK services, not arbitrary consumer JavaScript
or hosting-provider access logs.
