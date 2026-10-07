# AEGIS extension specification: accessible 2D narrative and turn-based games

Version: 1.3  
Date: 2026-09-20; Witch Kitchen update 2026-10-07 (section 22.10); Fluffy Bureau update 2026-10-08 (section 23)  
Status: implementation handoff; Fluffy Bureau PM decisions and team assumptions are in section 23  
Target repository: `rumukh/aegis-engine`  
Consumer repositories: `rumukh/fluffy-bureau`, `rumukh/witch-kitchen`  
Assessed engine revision: `07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a`

## 1. Assignment and intended outcome

Extend AEGIS so an independent repository can build and ship an accessible,
Russian-language, offline-first 2D detective game using supported public APIs.
The motivating game is "Fluffy Bureau of Investigations", a cozy adventure for
children aged 8-9 and their families.

This is an **engine implementation handoff**, not an instruction to build the
eight-case game. Implement reusable infrastructure and small demonstration
fixtures in the engine repository. The game repository will own its stories,
illustrations, recordings, characters, balancing, and final application.

The desired result is:

1. A supported, reproducible standalone-consumer integration route.
2. An action-driven browser host that does not require a physics game mode.
3. Reliable save/restore, narration, accessible 2D interaction, and offline assets.
4. Reusable narrative, deduction, and minigame foundations with explicit contracts.
5. A small reference application proving these pieces work together.
6. Documentation and acceptance evidence enabling another agent to build the game
   without importing engine internals or modifying engine source per case.

Do not turn the engine into a game-specific implementation. In particular, do not
hard-code eight cases, character names, a pie mystery, Russian-only engine UI,
fixed campaign rewards, or a specific town map into runtime packages.

Sections 1-21 retain the original Fluffy Bureau handoff and its child-safe
defaults. Section 22 adds the Witch Kitchen consumer profile and reusable
turn-based management requirements. Shared infrastructure should satisfy both
profiles without making either game's content, tone, or optional features
mandatory for the other. Existing requirement IDs and acceptance criteria remain
in force within their original scope.

### Normative language

- **MUST**: required for the relevant milestone to be accepted.
- **SHOULD**: expected unless an alternative is documented with its tradeoff.
- **MAY**: optional.
- **P0**: required before production of the first game case.
- **P1**: required for the complete campaign and family modes.
- **P2**: required for the later replay/sandbox/print scope, not a first-case gate.

API and package names proposed below are design targets, not claims that those
exports already exist. Preserve equivalent existing APIs where practical.

## 2. Product constraints the engine must support

The consumer game has the following requirements:

| Area | Required capability |
|---|---|
| Presentation | Illustrated 2D scenes, character/wardrobe layers, hotspots, cards, notebook, map, gentle transitions. No 3D traversal requirement. |
| Language | Russian throughout the child-facing application; engine facilities must remain locale-independent. |
| Sessions | Eight authored cases, approximately 15-25 minutes each, with pause and local autosave. Duration is a design target, not a countdown. |
| Players | Solo and local shared-device family play for 2-4 people. Networking is not part of this specification. |
| Logic | Deduction over three answer dimensions with reference sizes 3/3/3, 4/4/4, and 5/5/4. Exactly one final solution. |
| Content | Dialogue, 3-5 substantive clues, 1-2 explained red herrings, progressive hints, gentle resolution, three factual cards, and rewards per case. |
| Interaction | Hidden objects, matching/memory, footprints, event ordering, symbol ciphers, sound comparison, dialogue choices, quantities, compass, causal repair, alphabet sorting. |
| Accessibility | Large controls/text, keyboard and touch, captions, replay narration, non-audio equivalents, reduced motion, adjustable presentation. |
| Family modes | Private cards, a privately informed hint-giver, turn-taking, once-per-game abilities, no player elimination. |
| Later scope | Validated template-based case generation, collections, cosmetic decoration, printable game materials. |
| Restrictions | No ads, purchases, chat, outbound child-facing links, gameplay timers, telemetry, or transmission of names/progress. |
| Tone | No frightening default presentation, violence, punishment, ridicule, or punitive loss of earned cosmetic currency. |

Local storage of a chosen name, avatar, settings, and progress is necessary and
permitted. "No data collection" means no analytics or transmission, not a ban on
the local saves explicitly requested by the game.

### Implementation defaults and product decisions

The following defaults make this handoff implementable; they are not a claim that
the PM has approved changes to the original game brief. Keep consumer policies
configurable. `PM_QUESTIONNAIRE_RU.md` identifies product decisions requiring
confirmation, especially device support, shared-device play, offline delivery,
voice personalization, and accessibility acceptance.

Generic engine work may proceed where these answers do not change its contract.
Do not silently convert an unresolved product choice into a permanent limitation.

- The initial application is a browser application with HTML/CSS/SVG presentation.
- AEGIS core owns authoritative game state. Browser services are adapters around it.
- The engine does not require a new renderer, online service, runtime LLM, or TTS service.
- Family play is trusted pass-and-play, not secure multiplayer.
- Generated cases use authored, finite content pools and deterministic rules.
- Narration is bundled, rights-cleared recorded audio with finite phrase variants.
- A free-text player name may be displayed without being spoken. A game may instead
  supply a finite catalog of voiced names. Do not promise arbitrary-name narration.
- No gameplay countdowns are introduced. Parent-managed break reminders are
  optional host functionality, separate from simulation and unavailable by default.

## 3. Verified baseline and limitations

The assessment inspected engine `main` at the revision above. Recheck relevant
code before implementation; newer main-branch changes take precedence.

| Existing foundation | Important limitation |
|---|---|
| Core world, resources, components, deterministic simulation, PRNG, input actions, events. | These are primitives, not a detective/adventure application framework. |
| `World.snapshot()` and validated `World.restore()`. | No complete browser autosave, save migration, or host resume lifecycle. Event history and audio position are not a save system. |
| Live render session with pause/restart. | No supported end-to-end save-load contract for the live browser host. |
| Web Audio cues, loops, captions, gesture unlock. | Pause stops voices; interrupted narration does not resume at its previous position. Configured clips are decoded together. |
| Sprite-like visuals and orthographic platformer presentation. | These use three.js plane meshes. They are not a DOM/Canvas2D adventure toolkit. |
| HTML demo controls, subtitles, accessibility attributes. | English demo shell, diagnostics, and demo-specific UI; incomplete touch-oriented interaction. |
| Static browser execution and same-origin media loading. | Static HTTP deployment does not guarantee offline cold start. The exporter assumes engine-monorepo layout. |
| TypeScript ESM packages with exports. | Assessed packages are private, version `0.0.0`, without a normal released SDK distribution. |
| Existing platformer, isometric, FPS, and horror examples. | Closed `GameMode` vocabulary is not a reason to pretend a narrative game is a platformer. |

Do not claim packaging, browser-device acceptance, or final-game privacy has
already been proven by that assessment. It was source-level research.

## 4. Architecture and ownership boundaries

### 4.1 Preferred structure

Keep `@aegis/core` browser-neutral and free of DOM, Web Audio, storage, and network
dependencies.

Add a browser-safe package or equivalent supported entry points for:

- Action-driven runtime hosting.
- Persistence adapters.
- Audio/narration playback.
- Asset lifecycle and optional offline support.
- DOM/pointer/accessibility helpers.

An illustrative name is `@aegis/browser`. Narrative and puzzle helpers may be
separate packages or appropriately scoped modules. Do not create one package per
feature without a concrete dependency or distribution reason.

Do not make the DOM path depend on three.js. Reuse useful existing implementations
by extracting shared functionality behind public browser-safe entry points, not
by copying private render-three code.

### 4.2 Ownership matrix

| Engine owns | Consumer game owns |
|---|---|
| Runtime lifecycle and serializable-state contracts. | Actual case/campaign state schema and game rules. |
| Persistence, migration hooks, storage errors. | Save compatibility policy for its content revisions. |
| Narration transport, queues, replay, captions. | Scripts, speakers, recordings, pronunciation, approved names. |
| Generic scene and accessible interaction primitives. | Art direction, maps, illustrations, outfits, layout composition. |
| Narrative graph execution and validation mechanisms. | Dialogue, choices, clue placement, conclusions. |
| Deduction evaluation and finite-solution validation. | Meaning of each answer dimension and authored clue predicates. |
| Minigame lifecycle and reusable interaction adapters. | Puzzle data, educational objectives, bespoke game rules. |
| Turn/handoff/private-view mechanisms. | Family-mode rules, deck contents, role/ability balancing. |
| Template generation and validation mechanisms. | Compatible story bundles, motives, facts, vocabulary. |
| Print layout/export primitives, if P2 is implemented. | Final print-and-play artwork, text, deck composition. |

### 4.3 Compatibility rule

Existing demos and public APIs MUST retain their behavior unless a separately
documented migration is necessary. New child-oriented behavior should be opt-in
through a preset/configuration, not a global change to FPS or platformer controls.

The preferred narrative path uses core directly and does not extend `GameMode`.
If existing tooling genuinely prevents this supported path, document the exact
obstruction and make the smallest additive change. Do not broadly redesign scene
formats or replace the current renderer as a prerequisite.

## 5. P0: standalone distribution and public APIs

### DIST-01: supported consumer build

A separate project MUST be able to install/consume the required built packages,
type-check, bundle, and run without engine-source deep imports or knowledge of
`packages\...\dist` layout.

Provide a reproducible local artifact route using the repository's existing
package manager, such as packed package tarballs built from a pinned revision.
Public registry publication is not required and MUST NOT happen without approval.

Requirements:

- Include JavaScript, declaration files, necessary package metadata, and licenses.
- Resolve selected sibling-package dependencies reproducibly.
- Do not rely on a wildcard version accidentally resolving to an unrelated package.
- Document how to build artifacts and update a consumer's pinned engine revision.
- Keep a clear correspondence between artifact version/build metadata and source.
- Preserve existing source-workspace development workflows.

### DIST-02: browser-safe exports

Every browser entry point MUST exclude Node-only imports and server/capture code.
Importing the browser host must not transitively import the render-three root,
filesystem modules, process-only utilities, or three.js.

Provide an explicit export map. Browser consumers MUST NOT need unexported paths
to reach the host, narration, persistence, or input helpers.

### DIST-03: independent consumer fixture

Add an integration fixture that consumes packed artifacts outside the engine
workspace dependency graph. A temporary test directory is sufficient; a second
permanent repository is unnecessary.

The fixture MUST demonstrate that success does not depend on workspace symlinks,
source aliases, ambient dev dependencies, or unpublished build output.

## 6. P0: action-driven host and lifecycle

### HOST-01: action-driven execution

Provide a public host around a core-backed game adapter. It MUST support a game
whose logical state advances only in response to commands. Continuous 60 Hz
simulation is not required for a notebook or dialogue choice.

The host MUST NOT fabricate movement inputs or attach platformer/physics systems
to make a non-physics game function.

An illustrative contract is:

```ts
type Outcome<T, Code extends string> =
  | { ok: true; value: T }
  | { ok: false; error: { code: Code; messageKey: string } };

type PauseReason = "user" | "visibility" | "handoff" | "parent";

interface RuntimeHost<Action, Snapshot, View> {
  getView(): View;
  dispatch(action: Action): Outcome<void, "busy" | "paused" | "invalid-action">;
  subscribe(listener: (view: View) => void): () => void;
  pause(reason: PauseReason): void;
  resume(reason: PauseReason): void;
  snapshot(): Snapshot;
  restore(snapshot: Snapshot): Promise<
    Outcome<void, "invalid-save" | "incompatible-save" | "restore-failed">
  >;
  dispose(): Promise<void>;
}
```

Adapt signatures to existing engine conventions. Preserve the semantics below,
not necessarily these names.

### HOST-02: command and state semantics

- Apply a valid command exactly once, then publish the committed view.
- Reject invalid commands explicitly without partial state changes.
- Reject duplicate completion/claim actions or make them idempotent as declared.
- Keep authoritative state serializable; do not store DOM nodes, media elements,
  promises, functions, or renderer objects inside the world.
- Keep animation interpolation and wall-clock timing out of deduction outcomes.
- Support discriminated, typed game commands rather than unvalidated string bags.
- Expose commit notifications suitable for autosave without requiring full replay
  history or per-animation-frame writes.
- Snapshot and restore must preserve PRNG state and future deterministic behavior.

### HOST-03: pause policy

Maintain a set of pause reasons, not one competing boolean. Removing a visibility
pause MUST NOT remove a user's explicit pause.

While gameplay is paused:

- Game commands that mutate puzzle/campaign progress are rejected.
- Settings, help, narration replay, and resume remain available through host/UI
  controls that do not advance gameplay.
- Audio and relevant animations follow the declared pause policy.
- No input is buffered for unexpected execution after resume.
- Private handoff screens do not continue speaking a secret clue.

Visibility-based pause is configurable and enabled in the child-safe preset.
Only owned listeners, frames, timers, and audio nodes may be stopped on disposal.

### HOST-04: atomic restore

Validate a candidate snapshot and all required content references before replacing
the current live state. An invalid restore MUST leave the current session usable.

During restore:

1. Block gameplay dispatch and stage validation/migrations.
2. Prepare the replacement core state and required active content.
3. Replace authoritative state atomically.
4. Clear stale input, selections, transient events, and obsolete audio callbacks.
5. Reconstruct UI from current state rather than replaying historical side effects.
6. Publish one consistent restored view and establish the proper pause reasons.

Do not reissue rewards, redisplay private information, or repeat one-shot story
effects because a save is loaded.

## 7. P0: persistence and autosave

### SAVE-01: versioned save envelope

Define a generic validated envelope with at least:

- Save-format version.
- Consumer game identifier and save/profile identifier.
- Content revision and game-state schema version.
- Engine snapshot compatibility metadata.
- Monotonic save revision.
- Serialized authoritative state.
- Consumer-declared resume state: scene/node/minigame identifiers and progress.
- Local settings where appropriate, stored separately or with explicit ownership.

Wall-clock timestamps and media offsets may appear as host metadata but MUST NOT
affect deterministic world hashes or the result of game rules.

A save is not merely a seed or a list of prior inputs. Persist enough current state
to restore a partially completed puzzle and a generated case after an app update.

### SAVE-02: transactional local storage

Provide an IndexedDB-backed persistence adapter and an in-memory test adapter.
Keep the storage interface replaceable for a future packaged desktop host.

- Namespace records by game identifier; never clear unrelated origin storage.
- Commit each save atomically.
- Retain a previous valid revision or equivalent recovery copy.
- Serialize/coalesce writes without allowing an older async write to replace a
  newer state.
- Detect conflicting writers using revision checks; do not silently overwrite
  progress from a second tab.
- Expose explicit pending, saved, unavailable, conflict, and failed statuses.
- Handle unavailable storage, quota exhaustion, private-mode restrictions,
  corruption, and unsupported versions without pretending a save succeeded.
- Do not silently replace corrupted progress with a fresh game.

Browser storage is origin-scoped and may be cleared or evicted. Documentation and
UI MUST NOT describe it as an unconditional durable-save guarantee.

### SAVE-03: autosave boundaries

Autosave after committed meaningful actions, including:

- Clue collection and notebook changes.
- Dialogue transitions and choices.
- Committed minigame moves.
- Hint use and once-per-game abilities.
- Rewards, unlocks, case completion, avatar changes, and decoration changes.

Persist after commits rather than waiting for tab close. Page lifecycle flushes
are best-effort additions, not the primary mechanism.

Expose a flush/acknowledgement API. A completed acknowledgement means the declared
revision is persisted; a pending save must not be presented as persisted.

Transient pointer drag coordinates need not be saved. The last committed piece
placement MUST be saved. The game must be able to resume every meaningful
minigame state, not only the start of a case.

### SAVE-04: migration, recovery, and reset

- Register explicit, sequential consumer migrations.
- Reject unknown future versions with a useful, localized recovery state.
- Validate migrated data before installing it.
- Preserve the original record if migration fails.
- Provide parent-facing export/import and a documented size limit.
- Treat imports as untrusted data: validate schema, bounds, identifiers, and
  compatibility; never evaluate content as code.
- Reset requires explicit confirmation and affects only the chosen game/profile.
- If recovery cannot preserve progress, disclose that before any reset.

Export/import is a local backup facility, not cloud synchronization.

## 8. P0: narration, captions, and audio lifecycle

### AUDIO-01: narration service

Provide a browser-safe narration API independent of three.js with:

- Play a line by stable line/asset identifier.
- Stop or replace the active line.
- Pause and resume.
- Replay the complete current line.
- Report loading, playing, paused, completed, blocked, and failed states.
- Synchronize the active caption with the corresponding line.
- Separate narration, music, and effects volume controls.
- Optional music ducking during narration.

All failures must be observable and localizable. Captions remain readable when
playback fails; a text-only fallback is disclosed, not reported as full narration.

### AUDIO-02: precise pause and interruption behavior

- A same-session pause resumes the active spoken line at its previous offset.
- If the browser cannot resume without a new gesture, show an explicit resume
  control. Do not drop the line or advance the story silently.
- A replay request starts the line from the beginning and cancels stale playback.
- Starting a different line invalidates callbacks from the previous line.
- Completion fires at most once for the active playback request.
- Restoring a persisted session MAY replay the current line from the beginning;
  the documented default is replay, not an attempt at sample-exact disk resume.
- Story progression must not depend on real-time audio duration. Manual advance is
  the child-safe default.

### AUDIO-03: autoplay and device lifecycle

Honor browser autoplay restrictions through a clear first interaction. Handle
suspended contexts, visibility changes, output interruptions, and device resume.
Repeated unlock attempts must not duplicate music loops or narration.

Shared-device privacy transitions MUST stop or safely finish public narration
before presenting private information and must never narrate a hidden hand.

### AUDIO-04: bounded loading

Support case/scene-scoped audio packs and unloading. Do not decode all eight cases'
recordings on the first user interaction.

- Bound concurrent asset requests and active voices.
- Account for decoded PCM memory where the engine owns decoded buffers.
- Document the limits of estimating memory for browser-managed streaming media.
- Preserve current renderer limits unless an explicit configurable alternative is
  introduced; do not simply disable limits to accommodate a campaign.
- Missing voice mappings and unsupported formats are content errors with a visible
  fallback and diagnostic code.

The engine does not synthesize arbitrary player names, send text to a cloud API,
or claim complete narration from a browser screen reader.

## 9. P0: 2D interaction, localization, and accessibility

### UI-01: framework-neutral DOM/SVG path

Provide a working reference host and reusable helpers, not a new mandatory UI
framework. A consumer may use plain DOM or its chosen UI framework.

Support:

- Responsive illustrated scenes with logical-coordinate hotspots.
- Layered transparent images for characters and cosmetic customization.
- Overlay cards, dialogue, notebook panels, and map navigation.
- Correct hit testing after scale, letterboxing, scrolling, and device rotation.
- An accessible non-spatial list/navigation route to interactive scene objects.
- Focus restoration after overlays, transitions, private handoffs, and load.

Art assets and actual game layouts remain consumer content.

### UI-02: unified input

Use Pointer Events or an equivalent unified mouse/touch/pen approach. Support
keyboard activation, selection, cancellation, and focus without double-firing a
command through overlapping pointer/click/keyboard listeners.

Do not require hover, precision dragging, right-click, multi-touch, or timed input.
Every drag interaction MUST have a click/tap/keyboard alternative such as
"select item, then select destination".

Apply scroll suppression only within the active interaction that needs it.
Do not disable browser zoom or keyboard access across the application.

### UI-03: child-accessible reference preset

The reference application and reusable components MUST support:

- Interactive targets at least 48 by 48 CSS pixels at their default scale.
- Default main reading text at least 24 CSS pixels, with text scaling to 200%.
- No loss of essential actions/content at 200% text scaling.
- Text contrast of at least 4.5:1, with 3:1 for qualifying large text and essential
  non-text control boundaries/indicators.
- Visible focus, meaningful labels, and semantic buttons/dialogs.
- No color-only or sound-only clue encoding.
- Reduced-motion support and no essential flashing effects.
- Captions and alternative representations for sound-discrimination puzzles.
- No more than three primary decision choices at a time.

Persistent navigation, help, narration, and accessibility utilities are not counted
as primary story choices, but must remain visually subordinate and comprehensible.

Use paging/progressive disclosure for larger choice sets without losing keyboard
or screen-reader context.

The font preference should be described as a readability option, not a guaranteed
treatment for dyslexia. Bundle fonts with appropriate Cyrillic coverage.

### UI-04: localization

- All reusable child-visible strings use message keys and consumer-supplied catalogs.
- Do not bake English labels into error messages shown to the child.
- Allow root language and locale configuration.
- Support Cyrillic, including uppercase/lowercase yo, and long Russian labels.
- Support alternative display forms for inflected names/items through authored
  data. Do not assemble Russian sentences by naive English-style concatenation.
- Keep logical identifiers locale-independent.
- Use deterministic authored ordering for alphabet puzzles when order affects
  solutions; do not depend on browser-specific collation behavior.

Developer diagnostics may be in English, but must be separated from child-facing
messages and must not expose secrets through an accessible live region.

### UI-05: comfort and parent controls

Expose a persisted presentation preference for an enhanced-brightness/comfort mode.
Consumers supply appropriate assets/colors/explanatory text. This is not a license
to make the default scene frightening.

Provide integration hooks and reference controls for volume, readability, reduced
motion, progress overview, local backup, and reset.

If parent break reminders are implemented, they MUST:

- Be explicitly enabled by a parent.
- Never change deduction, rewards, or puzzle results.
- Pause safely at a resumable state.
- Avoid urgency, punishment, or a child-facing countdown.

Do not implement a complex parental identity/account system.

## 10. P0: offline delivery and child-safe release shell

### OFFLINE-01: complete local resource graph

Support a declared, same-origin asset graph with stable content identifiers and
revision metadata. Include images, audio, fonts, localization, and puzzle data.

No production dependency may require an external CDN, analytics endpoint, remote
font service, hosted TTS, or runtime model API.

Local paths must resolve in a normal production browser bundle, not only inside
the engine's development server or monorepo static exporter.

### OFFLINE-02: explicit offline installation

Provide an opt-in offline reference build, for example a service-worker-backed
installed web app. Mere static HTTP hosting is not sufficient evidence.

- Report which content packs are installed and usable offline.
- Mark a pack ready only after all required assets are available and validated.
- An interrupted install must not leave a falsely complete pack.
- Handle insufficient storage with a clear explanation.
- An offline cold start must work after installation and browser restart.
- Updates must not silently replace content beneath an active case.
- Keep save/content compatibility explicit when activating an update.
- Do not force a page reload in the middle of play.

Initial installation/download may require network access. Once the required packs
are installed, the reference game must not require network access to play or resume.
Do not promise unvalidated `file://` execution.

### OFFLINE-03: release privacy

The child-safe release shell MUST:

- Make no application telemetry, analytics, advertising, or remote diagnostics calls.
- Expose no outbound links in child-facing views.
- Have no chat, accounts, purchase UI, or third-party embeds.
- Omit global debug objects exposing snapshots, private clues, or full game state.
- Avoid logging names, answers, or private cards during normal production operation.
- Confine local storage/reset to the application's namespace.

Development tooling may retain explicit diagnostics. The existing demos need not
lose their developer inspector, but the new release preset must not enable it.

This policy controls supported engine services and the reference bundle. It cannot
certify arbitrary consumer JavaScript or eliminate a hosting provider's access
logs; document that boundary.

## 11. P1: narrative data and content validation

### STORY-01: declarative narrative graph

Provide a serializable graph format and runner with stable identifiers for:

- Scenes and dialogue nodes.
- Localized text and narration bindings.
- Choices, guards, transitions, and declared effects.
- Clue/fact/glossary/reward references.
- Case completion and cross-case flags.

Use existing typed state/effect facilities where possible. Do not introduce `eval`,
arbitrary JavaScript expressions in JSON, or dynamically fetched scripts.

The graph runner must be deterministic for the same state and actions. Save the
active node and relevant state explicitly. Restoring must not replay entry effects.

### STORY-02: effect and progression safety

- Guarded options cannot be invoked by submitting a hidden/disabled choice ID.
- Each effect declares its data dependencies and is validated before commit.
- Reward and clue claims are idempotent.
- Normal wrong-answer branches are non-terminal and may offer progressive help.
- A missing node/asset/effect is an explicit content error, not a silent jump.
- Deliberate revisitable dialogue is supported without unbounded automatic loops.
- Automated transitions have a bounded execution limit and useful cycle diagnostics.

### STORY-03: child-game validation profile

Provide a configurable content-validation profile for the motivating game:

- At most ten words per authored child-facing sentence.
- At most three new glossary terms per case.
- Exactly three educational fact cards in each completed authored/generated case.
- Narration coverage for every required child-facing line and phrase variant.
- Explanations for every declared red herring.
- At most three primary choices in a rendered decision group.
- Valid references for all clue, fact, reward, speaker, and asset IDs.

Define and document tokenization. Prefer explicit authored sentence segments and
structured glossary references over fragile punctuation guessing. Validate
interpolated text using declared placeholder bounds/variants.

The desired repeated teaching of a term must be reviewed along playable routes,
not inferred from three appearances somewhere in an unreachable content graph.
Support route fixtures or reports for this review.

Scientific accuracy, emotional safety, age appropriateness, pronunciation, and
whether a hint is pedagogically fair require human/editorial approval. A validator
may require source/review metadata but MUST NOT claim to prove those properties.

## 12. P1: deduction and notebook foundations

### LOGIC-01: finite candidate model

Provide a reusable finite deduction module independent of the DOM.

An instance contains:

- Named axes with stable value IDs.
- A candidate space derived from those domains and declared compatibility rules.
- A declared intended solution.
- Machine-readable clue predicates.
- Unlock/visibility prerequisites.
- Explanatory content references for hints and red herrings.

The reference profile supports three axes with 27, 64, and 100 possible triples.
Do not assume every game has exactly three axes, but do not build a general-purpose
symbolic theorem prover.

Support a small validated predicate language: equality/inequality, membership,
conjunction, and disjunction are sufficient starting primitives. Bound nesting
and expression size. Do not encode logic only in human-readable prose.

### LOGIC-02: correctness contract

- The intended solution satisfies all substantive clues.
- Every reachable required-clue prefix preserves at least one possible solution.
- The designated complete clue set leaves exactly one candidate.
- Required clues are reachable without needing the unknown answer first.
- Red herrings are annotations or truthful observations with misleading
  interpretations, not contradictory hard constraints.
- Validation reports remaining candidates and responsible clue IDs on failure.

Uniqueness is required at the end, not after the opening scene. Revealing the full
answer too early can be reported for editorial review but is not automatically
equivalent to logical invalidity.

The game author must define the meaning of each axis. The engine must not assume
that "What" means a missing item already revealed in the introduction.

### LOGIC-03: notebook and hints

Provide serializable notebook state with unknown, excluded, and confirmed marks,
including whether a mark is user-entered or supported by a revealed clue.

An assistance operation may propose marks and MUST cite the revealed clue(s) that
support them. It must not secretly consult unrevealed clues or overwrite user marks
without the consumer's declared interaction policy.

Support ordered or rule-selected hint tiers. Hint selection must be reproducible,
resumable, and aware of already revealed information.

After exhausting available new hints, return an explicit exhausted/review state.
Do not fabricate new facts or loop indefinitely promising an additional clue.

The consumer configures hint allowances and non-punitive wrong-answer behavior.
The reference child-game profile has no currency loss or terminal failure.

## 13. P1: reusable minigame integration

### MINI-01: lifecycle contract

Define a typed minigame adapter/registry with:

- Kind and schema version.
- Validated configuration.
- Serializable initial/current state.
- Legal commands and deterministic transition logic.
- View-model projection.
- Completion and optional clue/reward output.
- Explicit cancellation/suspension/resume behavior.
- An accessible alternative interaction path.

A minigame must not bypass the host by directly awarding campaign rewards or
mutating another game's DOM/state. Completion is a committed logical event or
result consumed once by the parent narrative.

### MINI-02: reusable primitives

Cover these interaction families rather than hard-coding eleven themed games:

| Primitive | Example uses |
|---|---|
| Scene target selection | Magnifier/hidden objects, footprints, map destinations. |
| Pairing and memory | Smell pairs, animal tracks, symbol correspondence. |
| Ordering and placement | Timeline, alphabet shelf, map fragments. |
| Constrained selection/quantity | Kind dialogue, cipher answer, baking measures. |
| Causal state changes | Repairing a dam or arranging a simple mechanism. |
| Media comparison | Replayable sound differences with equivalent visual/text clues. |

Implement and demonstrate at least scene selection, matching, and ordering in the
P1 reference application. The remaining families must be possible through the same
public adapter contract and documented with small rule fixtures.

Use exact bounded quantities or rational representations where puzzle answers
depend on halves/quarters. Avoid floating-point equality as an educational rule.

Do not add countdowns, reflex requirements, punitive failure screens, or obligatory
dragging to these reference primitives.

## 14. P1: local family play and private views

### FAMILY-01: turn and handoff model

Support stable local player IDs, active player, turn phase, public state, and
private projections. Persist turn position and ability use.

Provide an explicit handoff flow:

1. Hide the previous player's private content.
2. Display a neutral handoff screen.
3. Require confirmation from the next player.
4. Reveal only that player's permitted view.

Hidden information must be absent from visible DOM, accessible labels/live
regions, narration, and public event summaries. Styling content transparent is
not sufficient.

The authoritative in-memory state and local save may contain secrets. State
inspection through developer tools is outside the trusted-family threat model.
Do not promise cryptographic secrecy on a shared device.

### FAMILY-02: reusable rule support

The public interfaces must support:

- A privately informed hint-giver.
- Private clue hands and public questions/responses.
- A shared solution and no elimination.
- Once-per-game abilities with idempotent consumption.
- A configurable hand/deck distribution policy.

Do not hard-code "three cards each" without validating deck size and player count.
Exact deck rules and polite question wording are game content.

### FAMILY-03: constrained association hints

Support hints selected from authored dream images or approved word-token groups.
Validate forbidden direct answer tokens and declared compatibility metadata.

Do not claim a blacklist can determine whether arbitrary natural-language hints
are semantically too explicit. If freeform text is exposed, identify the weaker
guarantee and leave adjudication to a human.

## 15. P2: validated replay generation, collections, and printing

### GEN-01: template generation

Provide a deterministic generator over authored compatible bundles:

- Locations, actors, objects, motives, restoration actions, clue patterns.
- Difficulty-specific candidate domains.
- Red-herring explanations.
- Exactly three applicable fact cards and bounded glossary content.
- Narration/text variants and reward references.

Compatibility must be explicit. Do not generate a character action, grammatical
form, fact, or voice line merely because its ID exists in a random pool.

Every output must pass structural, content, and deduction validation.

- Use seeded PRNG, not wall-clock time or `Math.random()` in generation.
- Bound generation/search attempts and return a typed failure when no valid case
  can be produced.
- Never return an invalid case as a success-shaped fallback.
- Save the chosen case definition or its versioned resolved identifiers, not only
  the seed, so updates do not change an in-progress mystery.
- Describe the feature as replayable combinations of authored content, not an
  unlimited source of original fully narrated stories.

### COLLECTION-01: persistent cosmetic state

Existing core resources and the save system should suffice for collections,
unlocks, cosmetic inventories, and slot-based decorations. Add only shared helpers
with demonstrated reuse, such as validated item catalogs and idempotent grants.

No shop/payment platform, monetization framework, open-world simulation, or
real-time gardening system is required. User-triggered cozy interactions may be
ordinary commands and dialogue.

### PRINT-01: print-and-play support

Provide reusable print layouts or a data export compatible with a consumer-owned
print renderer. Use the same approved content IDs as the digital game.

Reference coverage:

- Cards with front/back alignment guidance.
- Tokens and a simple map.
- Notebook sheets.
- Readable rule pages.
- A4 and Letter layouts with no clipped text or essential elements.

An HTML/CSS print implementation is acceptable; a new PDF dependency is not
mandatory. The final game's 60 clue cards, 24 dream cards, six tokens, and artwork
remain game deliverables, not engine acceptance content.

## 16. Reference application

Create a small, original, non-frightening reference application, provisionally
called `storybook-lab`. It is infrastructure evidence, not the first Fluffy Bureau
case and not a reskin of the horror demo.

It should contain:

- One illustrated/simple 2D room and a small map.
- A layered configurable avatar and a local display name.
- A short branching dialogue with no more than three choices at once.
- A tiny deduction problem with machine-readable clues.
- Notebook marks and one explained hint.
- Three minigames: scene selection, matching, ordering.
- A gentle completion and idempotent cosmetic reward.
- Pause/replay narration, settings, comfort mode, and local save/resume.
- A two-player private handoff example.
- One small generated-case fixture once P2 is complete.

Include a Russian locale and real, rights-cleared spoken sample lines for the
narration demonstration. Synthetic tones are suitable for automated audio tests,
but not evidence that Russian narration is complete. If sample recordings are
unavailable, disclose that specific acceptance gap rather than silently replacing
the voice demonstration with tones.

Do not require paid assets, external accounts, runtime network services, or
generated assets with unclear redistribution rights.

The standalone-consumer fixture and reference app may share content fixtures but
must not conceal unsupported private imports.

## 17. Acceptance matrix

Use the repository's existing test/build tooling. Add focused coverage for new
contracts and preserve existing renderer/demo acceptance. Do not replace behavior
checks with screenshots alone.

| ID | Scenario | Required outcome |
|---|---|---|
| A01 | Build/install packed packages in an isolated consumer. | Type-checks and bundles through declared public exports, without source aliases or monorepo paths. |
| A02 | Bundle the DOM reference path. | No Node-only modules or three.js dependency in that path. |
| A03 | Start and complete an action-only dialogue/puzzle. | No physics mode or continuous gameplay timer required. |
| A04 | Repeat identical seed and command sequence. | Identical authoritative outcomes and hashes at corresponding commits. |
| A05 | Snapshot, JSON round-trip, restore, continue. | Same future authoritative outcomes as uninterrupted execution. |
| A06 | Submit invalid, duplicate, and stale completion commands. | Explicit rejection or declared idempotency; no double clue/reward grants. |
| A07 | Combine user, visibility, and handoff pauses. | Removing one reason does not incorrectly resume the others; no queued surprise actions. |
| A08 | Save midway through each reference minigame, reload after save acknowledgement. | Restores committed progress, active scene, notebook, hints, and rewards correctly. |
| A09 | Simulate unavailable/full storage and aborted writes. | Explicit failure state; no false "saved" status or silent progress reset. |
| A10 | Restore corrupt, older-migratable, and unknown-future saves. | Safe recovery/migration/refusal respectively; current valid session remains usable on failure. |
| A11 | Competing tabs attempt writes from the same revision. | Conflict is detected; no silent last-writer loss. |
| A12 | Export/import and reset. | Valid round-trip; invalid imports rejected; only selected application data reset after confirmation. |
| A13 | Pause halfway through a spoken line, then resume. | Continues at the paused position within documented media tolerance; does not restart or skip by accident. |
| A14 | Replay or replace a line while old callbacks remain pending. | Only the active request controls captions/completion; no stale story advance. |
| A15 | Browser denies autoplay or resumes with audio suspended. | Clear gesture-based recovery, readable captions, no duplicate loops. |
| A16 | Move repeatedly between audio packs. | Active voices/listeners/resources stay bounded; inactive owned buffers are released according to policy. |
| A17 | Use only keyboard, then only touch. | Every reference interaction and exit/help action is possible without hover or dragging. |
| A18 | Resize/rotate with an active hotspot scene. | Hit targets stay aligned and accessible navigation remains available. |
| A19 | Increase text to 200%, enable reduced motion, inspect contrast. | No lost essential content/actions; declared accessibility thresholds hold. |
| A20 | Use Russian locale, long labels, and Cyrillic names. | No missing glyphs, clipped essential text, English child-visible fallback, or broken substitutions. |
| A21 | Mute audio and complete a sound-clue fixture. | Equivalent information is available without revealing more than the audio route. |
| A22 | Complete offline installation, restart browser, block network. | Reference app cold-starts, plays, and resumes installed content without network dependency. |
| A23 | Interrupt pack installation or introduce an app/content update. | No falsely ready pack and no destructive mid-case reload; compatibility is explicit. |
| A24 | Inspect production requests, links, globals, logs, and storage. | Child-safe preset respects the declared privacy/offline boundaries. |
| A25 | Validate good and deliberately ambiguous/contradictory deduction fixtures. | Good cases have one final solution; bad cases return actionable clue/candidate diagnostics. |
| A26 | Request notebook help before hidden clues are revealed. | Suggestions derive only from available information and cite their support. |
| A27 | Exhaust all hints and repeat a wrong guess. | Explicit non-punitive review path; no invented evidence or endless generator loop. |
| A28 | Inject missing nodes, voice bindings, fact cards, or glossary violations. | Content validation identifies affected case/node/string IDs. |
| A29 | Restore after narrative reward/entry effects. | No duplicate effects and correct active node. |
| A30 | Switch players during speech and through screen-reader navigation. | No previous/next player's secrets leak in the handoff view, captions, or public announcements. |
| A31 | Generate supported finite reference case combinations. | Every result passes logic/content checks, or returns an explicit bounded failure. |
| A32 | Resume a generated case after catalog/generator changes. | Original case is preserved or explicitly reported incompatible, never silently changed. |
| A33 | Print the sample on A4 and Letter. | Readable cards/sheets, no clipped essentials, documented duplex behavior. |
| A34 | Run existing engine validation and demo coverage. | No unexplained compatibility regressions. |

For A13, document a measurable tolerance appropriate to the backend; target no more
than 250 ms of unintended skip/repetition in the reference implementation. Do not
claim sample-accurate resume unless that property is actually established.

For A16, publish request concurrency, voice counts, owned decoded-memory budgets,
and measured behavior for the reference pack. "Memory seems fine" is not evidence.

For finite small generator fixtures, enumerate the full supported combination
space. For larger catalogs, retain per-output validation and report the bounded
coverage of property-based/randomized exploration honestly.

### Browser/device scope

Document exact versions and environments actually exercised:

- Current Chromium-based desktop browser on Windows.
- Current Firefox desktop browser.
- WebKit/Safari compatibility using available automation.
- At least one real touch-device check for viewport, audio unlock/resume, and
  offline installation behavior before claiming mobile readiness.

WebKit automation or touch emulation is not equivalent to iOS Safari acceptance.
If a required environment is unavailable, record the gap explicitly; do not invent
a pass. The engine can complete intermediate milestones without claiming untested
platform support.

## 18. Implementation milestones and dependency order

### M0: baseline confirmation and API plan

Reconcile this specification against current main. Identify reused code, proposed
package boundaries, compatibility concerns, and any already-completed requirements.

Deliver an implementation map from requirement IDs to public APIs/modules and
focused acceptance coverage. Do not reimplement capabilities that already satisfy
the contract.

### M1: standalone runtime foundation

Implement DIST and HOST requirements, plus the minimum browser reference shell.
Prove the isolated consumer build and a non-physics action-driven scenario.

Exit criteria: A01-A07 and relevant existing compatibility coverage.

### M2: first-case readiness

Implement SAVE, AUDIO, UI, and OFFLINE P0 requirements. Build the reference
application's minimal narrative/minigame state using explicit adapter code if the
general P1 authoring layer is not complete yet.

Exit criteria: A08-A24, plus A34 and documented device-scope gaps. This is the
first-case production gate: save, narration, accessibility, and offline behavior
are foundations, not features to postpone until after writing the campaign.

### M3: campaign and family toolkit

Implement STORY, LOGIC, MINI, and FAMILY reusable modules. Replace reference-only
glue with the supported modules without changing the established behavior.

Exit criteria: A25-A30, campaign-state/save regression coverage, and a public-API
example showing how a consumer adds a case and a minigame without engine changes.

### M4: replay and ancillary scope

Implement GEN and the limited COLLECTION/PRINT requirements.

Exit criteria: A31-A34 and complete documentation of generator compatibility,
offline asset limits, and print limitations.

Each milestone should be independently reviewable and keep the existing engine
usable. Do not create a long-lived engine fork or require the consumer game to
move into the engine monorepo.

## 19. Required implementation deliverables

The implementing agent must leave:

1. Source changes and focused coverage for the implemented requirement IDs.
2. Public exports/types and a reproducible artifact/consumer build route.
3. The reference application and isolated-consumer integration fixture.
4. Documentation covering setup, architecture, lifecycle, save schema/migrations,
   audio semantics, offline installation/updates, and accessibility integration.
5. Content-schema documentation and small valid/invalid fixtures.
6. A migration/compatibility note for any changed existing behavior.
7. A requirement-to-evidence report with implemented, partial, deferred, and blocked
   statuses. Do not label an entire milestone complete when mandatory gaps remain.
8. A concise consumer handoff explaining what the Fluffy Bureau agent still owns.

Do not silently downgrade missing functionality to text-only play, remove
requirements to make the report green, or present an unexercised integration as
working. Explicitly document limitations and the nearest supported alternative.

Do not publish packages, deploy externally, add telemetry, or create production
accounts as part of this assignment.

## 20. Non-goals

- Writing or shipping the full Fluffy Bureau game.
- Producing eight cases, final illustrations, music, or a complete voice library.
- Real-time network multiplayer, accounts, matchmaking, or cloud saves.
- Runtime generative AI, arbitrary-name TTS, or semantic moderation guarantees.
- A new 3D renderer, full visual editor, or open-world simulation.
- Payments, advertisements, engagement analytics, or monetized cosmetics.
- A comprehensive anti-cheat/security system for trusted shared-device play.
- Guaranteeing that arbitrary third-party game content is educationally correct,
  emotionally safe, or legally compliant.

## 21. Baseline source references

These links describe the assessed starting point, not necessarily final locations
after implementation:

- [Core package and exports](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/core/package.json#L1-L29)
- [Simulation and scheduler API](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/core/src/scheduler.ts#L274-L358)
- [World snapshot and restore](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/core/src/world.ts#L791-L903)
- [Restored deterministic continuation coverage](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/core/src/determinism.test.ts#L192-L224)
- [Current live-session contract](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/session.ts#L38-L146)
- [Renderer export map](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/package.json#L1-L69)
- [Current audio implementation](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/client/audio.ts#L414-L543)
- [Presentation schema and asset budgets](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/presentation/schema.ts#L132-L282)
- [Current hardware input listeners](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/client/input.ts#L312-L322)
- [Existing demo HTML shell](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/page-chrome.ts#L280-L383)
- [Monorepo-oriented static exporter](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/static-site.ts#L79-L211)
- [Same-origin asset loading](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/presentation/assets.ts#L429-L548)
- [Static boot and diagnostic exposure](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/client/static-boot.ts#L310-L338)
- [Existing game-mode vocabulary](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/core/src/modes.ts#L9-L16)

## 22. Additional consumer profile: Witch Kitchen

### 22.1 Motivation, scope, and ownership

The second consumer is "Krestets: Witch Kitchen at the Border of Worlds", from
the supplied Russian specification "Ведьмина кухня на границе миров.txt".
It is a cozy, single-player, turn-based narrative management/puzzle game for
ages 12+, not a children's detective game.

Its two principal screens are the tavern and the between-night management view.
Players extract emotions through conversations, arrange jars on a small shelf,
start recipes that complete over subsequent player turns, and manage a
twelve-night campaign with conditional endings. Illustrations, portraits,
cosmetic animation, music, and whispers create atmosphere; none advances the
logical clock.

This is a suitable action-driven consumer of AEGIS core. It does not justify a
new renderer, physics mode, server-authoritative game loop, runtime model service,
or game-specific engine fork. Prefer the shared DOM/SVG host and public core
interfaces already specified above. A three.js presentation MAY remain optional;
the illustrated 2D path MUST NOT require it.

The original brief names Godot 4. Choosing AEGIS replaces that technology
requirement; it must not silently replace the requested PC experience with an
unapproved delivery format. On 2026-10-07 the PM selected both an in-page
itch.io HTML5 build and a downloadable offline Windows build; see section 22.10
(WEBHOST-01, DESKTOP-02).

| Reusable engine responsibility | Witch Kitchen responsibility |
|---|---|
| Command-driven time, deterministic scheduling, serializable pending work. | Listening, cooking, patience, arrival waves, clock adjustments, and night rules. |
| Atomic state transitions, checkpoints, storage failures, migration hooks. | Guest palettes, shelf contents, recipe jobs, economy, campaign flags, ending state. |
| Validated external data and safe development reload boundaries. | Recipes, dialogue, all balance values, difficulty presets, and event policies. |
| Accessible slot placement, status projections, and filtered presentation. | Shelf adjacency, aging, contamination, recipe matching, spoiler classification. |
| Adaptive audio transport and presentation lifecycle. | Music, sound design, whispers, cue mappings, and deliberate silence. |
| Headless execution and reproducible diagnostic fixtures. | Economy tuning, solvability routes, narrative quality, and actual player studies. |

Do not add engine concepts named heat, sediment, memory thread, guardian, or a
particular ending. Existing resources, typed game commands, and consumer effects
should represent these. An inventory/crafting framework is not required merely
because one consumer has jars and recipes.

The child-safe preset remains unchanged. Witch Kitchen may select its own
typography, choice counts, tone, difficulty, and presentation policy while reusing
accessibility mechanisms. Fluffy Bureau's sentence limits, family modes,
deduction model, full narration coverage, and printing are not Witch Kitchen
production gates. Witch Kitchen requires telemetry off by default; it does not
introduce or require an analytics service.

### 22.2 Priorities and reuse

The following priorities apply only to this additional profile:

- **K0**: required for a reliable nights 1-4 vertical slice.
- **K1**: required before claiming the complete campaign/release supported.

They do not promote Fluffy Bureau's P1/P2 work into its P0 scope or require that
unrelated family/deduction modules finish before Witch Kitchen can proceed.

| Dependency | Reuse or extension |
|---|---|
| DIST-01 through DIST-03 | Reuse the pinned, independent-consumer artifact route and browser-safe exports. |
| HOST-01 through HOST-04 | Reuse command dispatch, pause reasons, subscriptions, and atomic restore. Extend with TURN requirements. |
| SAVE-01 through SAVE-04 | Reuse envelopes, adapters, recovery, and migrations. SAVE-05 adds strict logical-turn boundaries. |
| UI-01, UI-02, UI-04 | Reuse illustrated scenes, accessible input, and localization. UI-06/UI-07 add slot/status and spoiler projections. |
| AUDIO-01 through AUDIO-04 | Reuse transport, buses, unlock, captions, and bounded loading; narration coverage remains consumer-defined. |
| STORY-01 and STORY-02 | Reuse graph/effect contracts where needed; explicit typed consumer rules are acceptable for the initial slice. |
| OFFLINE and release shell | Reuse appropriate asset/privacy facilities; required offline delivery follows the selected release target. |

Before implementing an extension, confirm whether an existing public API already
satisfies it. Expose or compose that API rather than replacing tested primitives.
The requirements below describe missing end-to-end contracts, not a claim that
AEGIS lacks basic stepping, resources, snapshots, audio, or deterministic PRNG.

### 22.3 K0: logical turns and scheduled work

#### TURN-01: separate logical time from presentation

Support a persisted integer logical clock driven exclusively by accepted consumer
commands. Commands may cost zero, one, or multiple logical turns; the reference
fixture MUST exercise costs 0, 1, and 2.

- Rendering, audio playback, animation completion, pointer movement, visibility
  changes, and elapsed wall time MUST NOT consume turns.
- Do not equate the game's logical turn with an always-running fixed physics
  frame. Existing deterministic stepping may be reused behind the adapter.
- A zero-turn command may change state and save revision without aging jobs,
  expiring patience, or advancing the logical clock.
- Refresh view projections and any renderer mirror on committed state revision,
  not only on logical tick changes. A zero-turn mutation must become visible
  immediately without waiting for the next paid action.
- All authoritative randomness uses the saved engine/consumer PRNG state.
- Cosmetic clocks and interpolation are excluded from authoritative state hashes.
- Idle effects must be able to animate and ambience must be able to play while
  gameplay awaits a command. Give cosmetics an independent presentation clock.
  Waiting for input is not a global pause that also freezes visuals and audio.
- Keep explicit user pause, cosmetic pause/reduced motion, and audio mute policy
  distinct. Redrawing a revision must not replay already-consumed one-shot cues.
- Ordinary offline play MUST NOT require a daemon, remote agent, or JSON-RPC
  exchange for each player action. Developer inspection/control is optional.

#### TURN-02: bounded, resumable multi-turn commands

Validate a command before applying its costs or effects. Reject invalid commands
with a typed reason and no partial mutation.

A multi-turn command MUST process every intervening logical turn, not jump a
counter past scheduled events. Define it as a validated action with ordered,
consistent substep commits. Persist its identifier, resolved parameters, remaining
substeps, and effect progress whenever an intermediate checkpoint is saved.

Restoring that checkpoint must finish or resume the declared action without
recharging its cost, rerolling its result, repeating an effect, or granting an
extra player action between its substeps. Block unrelated gameplay dispatch
while an action is pending. Each published substep is a committed state, not an
unrecoverable half-written transaction.

Bound automatic transitions and zero-turn effect chains. A bad configuration or
cycle must produce a diagnostic rather than hang the browser.

#### TURN-03: serializable jobs and deterministic event order

Provide a documented public scheduling route for delayed jobs, phase events, and
consumer-defined expiration. Reuse existing scheduling facilities where possible.

- Scheduled work uses stable IDs and serializable payloads, not saved closures,
  promises, browser timers, or renderer callbacks.
- Define exactly when a delay starts and which turn makes a job ready.
- Define a stable resolution order for events sharing a logical turn. Provide
  explicit phases/priorities or an equivalent consumer composition mechanism.
- Event processing must not depend on component iteration, DOM order, asset
  loading, or callback arrival order.
- Persist pending jobs, consumed one-shot events, and phase/period identity.
- Expose cancellation/replacement semantics and reject stale job completions.
- Restoring cannot issue duplicate arrivals, rewards, readiness effects, or
  campaign transitions.

The fixture must include two concurrent jobs and a same-turn collision between
job readiness, an arrival, and an expiration. Its declared ordering is fixture
data, not an implicit decision about the final game's balance.

#### TURN-04: phase boundaries and adjustable budgets

Support consumer-defined phases/periods and bounded turn-budget adjustments.
Represent elapsed logical time separately from any adjustable allowance or
remaining-turn display.

Changing an allowance MUST NOT implicitly rewind event history, reset jobs, or
repeat a one-shot event. The consumer declares whether each scheduled event is
anchored to elapsed time, phase entry, or phase end. Recalculate end-relative
events only according to that declared policy.

Phase-boundary effects require read-consistent inputs and atomic results so
multiple slot transformations can inspect the same pre-transition state.
Conflicting effects require deterministic resolution or explicit rejection, not
last-writer behavior based on iteration order. Consumer-defined transformation
rules remain outside the engine.

Pause and help remain available independently of whether a gameplay action is
currently legal. The host must support an explicit consumer-defined wait/end-phase
command if the final design calls for one; it must not invent free resources or
silently advance time to escape a stalled state.

#### TURN-05: headless rule execution

Document a renderer-free route to instantiate a consumer, load validated data,
dispatch commands, checkpoint, restore, and inspect deterministic results.

Provide small reusable fixture/report helpers or examples for command traces,
seeded scenarios, rejection reasons, and state assertions. A failing trace should
identify the seed, content revision, action, logical turn, and relevant rule IDs.
Keep these development diagnostics out of normal release UI/logging.

No general planning solver is required. Campaign reachability, economy sampling,
and individual ending routes are consumer tests using this interface; passing an
engine fixture is not proof that the game's balance or all endings are feasible.

### 22.4 K0: turn checkpoints and external configuration

#### SAVE-05: logical-turn checkpoint policy

Add an opt-in strict checkpoint policy to SAVE-03:

- Save after every committed logical turn, including intermediate substeps of a
  multi-turn action.
- Save every meaningful zero-turn mutation, including committed placement,
  purchases, free serving, hints with usage counts, and budget adjustments.
- Save phase transitions and between-period management actions.
- Include pending actions/jobs, phase clocks, PRNG state, consumed-event markers,
  and the consumer's complete campaign state in the validated snapshot.
- Keep save revisions independent of logical turn numbers; several valid saves
  can occur at the same turn.

Document the snapshot boundary: executable systems, closures, browser input,
presentation objects, and historical event logs are not durable game state.
Reconstruct the registered systems/schemas on load without rerunning new-game
effects over restored progress. Store durable story claims and consumed-event
markers in components/resources, not only in the cleared event history.
Any independently forked PRNG streams must have their own state captured; saving
the world's generator alone does not capture arbitrary generators in closures.

In this strict policy, coalescing MUST NOT skip a required turn checkpoint. Use a
durability barrier or equivalent ordered acknowledgement before progressing past
that checkpoint. Retaining every historical save forever is not required; the
latest valid revision and declared recovery copy are sufficient.

On persistence failure, show an explicit retry/recovery state and do not present
ordinary continued play as safely autosaved. The reference profile blocks further
gameplay commits until the failure is resolved. Page-close handlers are not a
substitute for this contract.

#### DATA-01: external, validated consumer data

Support runtime loading of versioned JSON content/configuration through public,
browser-safe APIs. CSV MAY be an authoring input if it is converted and validated
through the same documented route; a second runtime parser is not mandatory.

Consumers register schemas and cross-reference checks. Errors MUST identify the
file/catalog, record ID, and field where possible. Validate bounds, integer turn
costs, identifiers, references, duplicates, and declared rule variants before
activating a pack. Do not interpret arbitrary code or expressions from data.

The Witch Kitchen fixture keeps all gameplay balance values outside TypeScript:
action costs, phase lengths, thresholds, yields, prices, capacities, recipe
durations, and difficulty modifiers. Runtime safety limits and presentation
implementation constants are not game balance and need not become editable.

#### DATA-02: safe development reload

Provide a documented edit-validate-reload workflow that changes gameplay balance
without recompiling engine or consumer TypeScript. A deliberate reload/restart
at a declared safe boundary is sufficient; arbitrary mid-action hot mutation is
not required.

- Stage and validate the complete candidate revision before activation.
- Reject invalid candidates explicitly, preserving the previous active revision.
- Do not mix old rules, new catalogs, and already-resolved pending jobs silently.
- Let the consumer choose a safe boundary or an explicit restart.
- Demonstrate a balance edit becoming available for the next playthrough within
  the brief's five-minute iteration target, without an engine rebuild.

#### DATA-03: saved content compatibility

Persist the effective content/configuration revision alongside game-state schema
metadata. Resume with the matching installed revision/resolved data, run an
explicit validated migration, or report incompatibility.

Do not silently recompute in-progress jobs, previously granted rewards, random
guest choices, or ending eligibility under newly edited rules. Coordinate pack
retention/activation with SAVE and OFFLINE facilities rather than introducing
another independent content-version system.

### 22.5 K0/K1: presentation, audio, and narrative integration

#### UI-06: K0 accessible slots and rule status

Extend the shared selection/placement helpers to accept stable slot/item IDs,
consumer validation, and committed move commands.

- Support pointer dragging and an equivalent select-item/select-destination
  keyboard/click/tap route.
- Preview legal destinations without mutating authoritative state.
- Invalid moves leave state unchanged and explain the rejection accessibly.
- Cancel on Escape, interrupted pointer capture, scene replacement, and restore;
  do not duplicate the commit through both drop and click handlers.
- Preserve logical adjacency across responsive reflow. Gameplay neighbors are
  consumer data, not whichever elements happen to be adjacent in the DOM.
- Allow consumer-provided shape, text, status badges, ages, and progress labels.
  Critical state must remain understandable without color, motion, or sound.
- Derive displayed turn counters and readiness from committed state, not from
  animation progress or wall-clock countdowns.

Full containers, overflow, stacking, swaps, and irreversible-action confirmation
are consumer policies surfaced through explicit validation/confirmation hooks.
Never silently discard or overwrite an item to make placement succeed.

#### UI-07: K1 spoiler-aware projections

Reuse the private-view/projection boundary for an optional streamer presentation
mode without requiring family-play mechanics.

Consumer-tagged spoiler content must be excluded from visible panels, captions,
accessible names/live regions, and narration under the selected policy. Merely
hiding a rendered element with CSS is insufficient.

Keep authoritative campaign state unchanged. Preserve necessary interaction
labels and consequence warnings using consumer-authored safe alternatives.
Restore focus and persist the presentation preference. This is a stream/view
filter, not protection against local save or developer-tools inspection.

#### AUDIO-05: K1 state-driven atmosphere

Expose a browser-safe route to select authored music states/stems/tempo variants,
crossfade them, apply bus gains/ducking, and enter an explicit silence state.
Reuse current loop/gain/cue capabilities rather than duplicating audio engines.

- Consumer projections map logical phase, remaining allowance, and story flags
  to presentation states; audio never changes authoritative game progress.
- Demonstrate at least two authored tempo/intensity states and bounded crossfade.
- A declared silent/no-ticking state must remain silent on restore and unlock.
- Pause/resume, repeated updates, rapid state changes, and load must not duplicate
  loops or allow stale callbacks to resurrect an obsolete cue.
- Reconstruct ongoing ambience from current state on load; do not replay every
  historical one-shot chime or story whisper.
- Keep music, effects, and speech independently controllable, with readable
  captions and existing memory/voice limits intact.

Authored tempo variants are acceptable. Changing playback rate and therefore
pitch MUST NOT be mislabeled pitch-preserving tempo control. Real-time
time-stretch DSP is not required unless separately approved.

#### STORY-04: K1 campaign flags and irreversible effects

Demonstrate the STORY guard/effect mechanism with cross-period flags, a consumable
story item, an irreversible claim, and mutually exclusive terminal outcomes.

The consumer supplies ending precedence and eligibility. The engine must preserve
effect/claim identity through save/load, reject stale or disabled choices, and
avoid reevaluating an already-committed ending into a different result on restore.
Completion of audio or visual transitions must not be the authoritative trigger.

Do not encode Witch Kitchen's particular endings, counts, dialogue, or sacrifices
in the reusable graph runner.

#### DESKTOP-01: K1 release-target decision and adapter boundary

Record whether the approved PC release is browser-hosted, installable/offline web,
or a packaged Windows application before claiming release readiness.

If packaged Windows delivery is selected, provide a supported reference packaging
route and storage/asset adapters using the same public runtime and save contract.
The packaged reference must launch without a separately installed Node runtime,
engine checkout, development server, or agent-control daemon; it must locate
bundled assets and preserve saves/settings across ordinary restart and update.
Exercise audio unlock/lifecycle and local export/import in that host.

Choose the wrapper and installer/update policy explicitly; this specification
does not mandate Electron, Tauri, a native renderer, or public distribution.
Browser execution alone is not evidence that the packaged-PC requirement passed.
If a browser release is selected instead, document browser-storage eviction and
backup limitations and apply the agreed OFFLINE requirements.

### 22.6 Additional reference fixture and acceptance matrix

Add a small original `turn-kitchen-lab` scenario, or equivalent separate mode in
the reference consumer. It demonstrates shared APIs, not the final game's art,
story, recipes, campaign, or names. It may use plain shapes and sample data.

Include two management phases, a configurable turn budget, three waiting actors,
a six-slot arrangement with an eight-slot variant, one/two concurrent delayed
jobs, one period-boundary transformation, and one conditional terminal result.
Use explicit fixture policies for unresolved product rules below.

| ID | Scenario | Required outcome |
|---|---|---|
| K01 | Run 10,000 presentation frames with an idle effect and ambience, replay audio, open help, and change visibility without a game command. | Cosmetics/audio progress while awaiting input and obey explicit pause policy; no authoritative logical-clock, job, patience, PRNG, or campaign changes. Host pause metadata may change. |
| K02 | Execute valid commands costing 0, 1, and 2 turns; reject an invalid command. | Exact declared clock changes; zero-cost changes increment state revision, refresh visible/mirrored state, and notify persistence without repeating cues; rejection has no partial costs/effects. |
| K03 | Place an event at the intermediate turn of a two-turn action. | Event occurs exactly once; the action cannot skip it. |
| K04 | Restore at that intermediate checkpoint and continue. | Same final state/PRNG as uninterrupted execution; no duplicate charge/effect or extra player action. |
| K05 | Collide arrival, expiration, and two job completions on one turn. | Stable documented order and identical results across repeated seeded runs. |
| K06 | Change a turn allowance and exercise short/long phase configurations. | Declared event anchors hold; no repeated one-shots or accidental fixed-length dawn. |
| K07 | Evaluate several adjacent-slot transformations with reversed iteration order. | Identical result or the same explicit conflict; no accidental sequential cascade. |
| K08 | Reload after acknowledgements for a free move, usage-limited hint, zero-turn purchase, and phase transition. | Latest committed state and usage counts are preserved even when logical turn numbers match. |
| K09 | Interrupt strict checkpoint writes, including a multi-turn action. | Explicit failure/pending state; no falsely durable progress; recovery does not duplicate the pending action. |
| K10 | Change a JSON balance value, then load invalid/mismatched revisions. | Valid next-run change needs no TypeScript rebuild; invalid activation is rejected; saved-rule compatibility is explicit. |
| K11 | Complete slot moves using pointer, keyboard, and click/tap alternatives; resize during selection. | One valid commit per move, stable logical adjacency, accessible rejection/cancellation, no dropped items. |
| K12 | Disable color distinctions/motion/audio and use long Russian labels, then an English catalog. | Essential states and actions remain distinguishable; no missing glyphs or lost controls. |
| K13 | Switch between tempo states and silence; pause, restore, and unlock repeatedly. | Bounded voices, no duplicate/stale loops, correct silence, no logical-time advance. |
| K14 | Enable spoiler filtering and inspect visual, accessible, caption, and narration projections. | Tagged content is absent or safely substituted; essential consequence warnings remain available. |
| K15 | Restore after an irreversible story effect and a terminal outcome. | No repeated consumption/reward and no changed ending. |
| K16 | Run the scenario headlessly and through an independently bundled consumer. | Same authoritative trace via public APIs; no daemon or workspace-private imports needed. |
| K17 | Exercise the approved release target, including offline restart where required. | Documented target works with persistent state; packaged-PC support is claimed only after its conditional requirements pass. |

K0 acceptance comprises K01-K12 and K16, together with the relevant existing
DIST/HOST/SAVE/UI checks. K1 adds K13-K15, K17, and compatibility coverage for both
consumer profiles. Existing Fluffy Bureau A01-A34 requirements remain intact.

### 22.7 Product ambiguities that engine work must not decide silently

The supplied game document is not yet a complete executable rules contract,
despite its included inconsistency audit. Record these as consumer decisions, not
engine limitations or permission to drop mechanics:

| Topic | Decision/evidence needed before final game acceptance |
|---|---|
| Ending precedence | The default winding ending and the no-pie/zero-thread letter ending overlap. Define exclusive triggers, required keys, and precedence. Define whether thread eligibility is captured before consuming the last thread for the pie. |
| Storage feasibility | The final complex recipe requires seven emotion jars plus three sediment jars, exceeding eight shelf slots if jars do not stack. The storage jar removes sediment occupancy but still leaves seven emotion slots versus six initially. Specify upgrades, stacking, staged loading, or another approved route; do not silently make a supposedly optional upgrade mandatory. |
| Action-budget proof | The stated 10-13-turn service matrix assumes only three listening actions for three dishes. A ramen, fish soup, and gingerbread require six newly extracted jars: using that same matrix gives 13-16 turns before any other work. Carryover stock and selective service may resolve this, but the 9-11 average and 13 peak need actual campaign scenarios, not that simplified calculation. |
| Event and phase timing | Define readiness versus expiration order, when newly scheduled cooking starts, initial guest availability, full-seat arrivals, no-action/wait behavior, and dawn/midnight behavior under 12/15/18-turn modes and clock extensions. |
| Transformation conflicts | Define "young", adjacency exposure duration, simultaneous merge/aging/overheat precedence, overflow, and the exact between-night boundary. Do not derive these rules from storage iteration order. |
| Economy and door unlocks | Two city guests yield 16-24 sparks before modifiers, not the stated 25-40 nightly target; other routes need separate projections. Doors are described both as costing one story and unlocking from four cards. Specify the intended relationship and affordable progression routes. |
| Delivery and content scope | Confirm the PC delivery format and remaining authored dialogue/quests. Placeholder engine fixtures are not evidence of a finished twelve-night, four-ending campaign or its target playtime. |

Generic infrastructure work can proceed while these are resolved. Fixture defaults
must be labeled as illustrative. The original game's outcome, content, and
playtest criteria remain owned by `rumukh/witch-kitchen`.

**Status after the PM answers of 2026-10-07.** The table above records the
original findings. The `rumukh/witch-kitchen` decision record `PM_ANSWERS_RU.md`
resolves them as follows. Remaining rule precision is tracked as Q51-Q75 in
`PM_ANSWERS_REVIEW_RU.md`, with working assumptions in `ASSUMPTIONS_V1_RU.md`.
Engine work must not settle those questions silently.

| Topic | PM decision | Open follow-up |
|---|---|---|
| Ending precedence | Q31-Q33: New Spring, Remember, Wound, Letter in that priority. Winding the clock is a deliberate one-Key action. The thread is checked when the Pie is started; serving the Pie is the condition. | Q67: resolution moment and conflicting actions. |
| Storage feasibility | Q15-Q17: the 2x4 shelf upgrade is mandatory for the best ending, only sediment stacks (up to three), and a one-place tray holds overflow. | Q58 overflow; Q66 same-night extraction and generator guarantees. |
| Action-budget proof | Q14: probabilistic acceptance thresholds, fresh-jar-only orders and a new one-jar Nostalgia recipe, supported by the PM's Monte Carlo model. | Simulation code not yet supplied; Q64 order generation. |
| Event and phase timing | Q06-Q12: tick-0 guest, waves 2/5/8, predawn at dawn minus 3, chime/arrival/readiness/patience order, Wait and End night actions. | Q54-Q56: patience arithmetic, clock adjustment, guest lifecycle. |
| Transformation conflicts | Q16, Q22-Q24: orthogonal adjacency, pre-step evaluation without chains, merge before amber, dawn position checks. | Q60: boundary order, drain precedence, Trepet start. |
| Economy and door unlocks | Q26-Q28: quality-based city pay, tips, a 15-25 nightly target, free doors after four full stories, and a permanent collection separate from spendable stories. | Q52-Q53: story completeness and quality rounding. |
| Delivery and content scope | Q01-Q05, Q44: itch.io HTML5 plus offline Windows build, Russian-only first release, commercially licensed assets. Authored content remains consumer work. | Q69-Q70: Windows wrapper and browser storage notice. |

### 22.8 Integration order and additional deliverables

1. **K-M0: reconcile and resolve boundaries.** Recheck current engine APIs, map
   shared requirements to existing implementation work, identify the release
   target decision, and keep unresolved game policies explicit.
2. **K-M1: reliable turn slice.** Build TURN, SAVE-05, DATA, and UI-06 on the shared
   DIST/HOST/SAVE foundation. Deliver the independently consumable reference
   scenario and K0 evidence before claiming support for production nights 1-4.
3. **K-M2: campaign presentation and release.** Complete AUDIO-05, UI-07, STORY-04,
   and the approved DESKTOP-01 route. Deliver K1 evidence and documentation without
   importing Fluffy Bureau-specific family/deduction prerequisites.

Extend the requirement-to-evidence report from section 19 with all added IDs and
K01-K17. Include public API examples for zero/multi-turn actions, scheduled jobs,
strict checkpoint acknowledgement, external-data reload, and headless continuation.
Record implemented, reused, partial, deferred, and blocked status separately.

The engine handoff must tell each consumer which shared artifacts it can install
and which game rules/content it still owns. Do not create or publish a registry
release, build the full game, modify either game's PM questionnaire, or introduce
production services as part of this documentation extension.

### 22.9 Source-specific integration cautions

The additional source audit used the same assessed revision as section 3. These
are reasons for the contracts above, not instructions to replace existing APIs:

- [Explicit core stepping](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/core/src/scheduler.ts#L289-L338)
  already supports deterministic local execution. In contrast, the
  [stock static boot loop](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/client/static-boot.ts#L260-L282)
  advances from wall time and refreshes its world mirror by tick/restart
  generation. Reusing that loop unchanged would violate TURN-01.
- [Visual motion](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/presentation/runtime.ts#L844-L881)
  and [particle aging](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/presentation/runtime.ts#L981-L991)
  currently sample the supplied presentation tick. Separate cosmetic time or use
  the independent DOM presentation path rather than advancing gameplay to keep
  the room animated.
- [World restore](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/core/src/world.ts#L860-L902)
  clears event history; [PRNG forks](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/core/src/prng.ts#L27-L58)
  create separate state. SAVE-05 must cover consumer state outside the world's
  automatically captured generator.
- [Audio integration](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/client/presentation-host.ts#L213-L228)
  is currently wired through the presentation host, while the
  [public presentation barrel](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/presentation/index.ts#L1-L7)
  does not expose that audio service. Extract supported browser-safe access under
  the shared AUDIO/DIST contracts; do not make consumers deep-import internals.
- [Current presentation budgets](https://github.com/rumukh/aegis-engine/blob/07f3cd0829a45dc0eaa3b3a396c11cf66aa7f88a/packages/render-three/src/presentation/schema.ts#L261-L277)
  include a 32 MiB per-file and 64 MiB aggregate bound. Measure the actual campaign
  assets before claiming they fit. Reuse scoped pack loading/ownership where
  needed rather than merely increasing limits or assuming unlimited preload.

### 22.10 Witch Kitchen PM decisions (2026-10-07) and delta requirements

**Engine baseline re-check.** AEGIS `main` at
[`0abd61b5a679020bfb66bf4db24888df9e339d4d`](https://github.com/rumukh/aegis-engine/tree/0abd61b5a679020bfb66bf4db24888df9e339d4d)
contains `@aegis/runtime`, `@aegis/browser`, `@aegis/narrative`, standalone SDK
artifacts and `poc/turn-kitchen-lab`. Its
[requirement map](https://github.com/rumukh/aegis-engine/blob/0abd61b5a679020bfb66bf4db24888df9e339d4d/docs/extension-acceptance.md#L68-L97)
records TURN-01..05, SAVE-05, DATA-01..03, UI-06, UI-07, AUDIO-05 and STORY-04
as implemented. DESKTOP-01 is limited to the approved static/offline web route,
and [platform limits](https://github.com/rumukh/aegis-engine/blob/0abd61b5a679020bfb66bf4db24888df9e339d4d/docs/extension-acceptance.md#L409-L433)
remain explicit. The requirements below are deltas over those implementations:
reuse the existing APIs rather than re-implementing them.

A consumer MAY first implement a delta inside `rumukh/witch-kitchen` through
public extension points such as the replaceable `SaveStorage`. Upstream it when
another consumer needs it or when it changes a public engine contract. Open
engine issues #8 (unbounded consumed jobs/claims), #15 (rebinding a save to
another profile) and #17 (per-commit cost) directly affect a twelve-night
campaign with a save after every action. Check them before relying on default
limits.

| PM decision (`rumukh/witch-kitchen` `PM_ANSWERS_RU.md`) | Delta requirements |
|---|---|
| Q01, Q03, Q05: itch.io page with in-page HTML5 build (network acceptable, no offline promise) and a downloadable Windows build, offline from first launch, with local file saves; pay-what-you-want, so commercially licensed assets only | WEBHOST-01, DESKTOP-02, SAVE-07 |
| Q02, Q43: Windows, mouse and keyboard, window from 1280x720, text 100-150%, full keyboard control, colour-independent states, no screen-reader promise in the first release | UI-09 |
| Q45, Q46: three slots, autosave after every action, export/import, undo of free rearrangements, replay of the current night with the same guests, a checkpoint before night 12, no repeated awards | SAVE-06, TURN-06, TURN-07 |
| Additional requirement 1 (Доп-1): detailed, gradual, disableable onboarding through characters and highlighted "what/why" cards | UI-08 |
| Q40, Q41: only grandmother's whispers voiced; other characters use speech-like murmur; three authored tempo versions switched on chimes; the nameless guest silences music and ticking | AUDIO-06 |
| Q47: no telemetry; a user-exported night report for playtests | DIAG-01 |
| Q14, Q37, Q50: probabilistic load thresholds and automated ending-route checks across many seeds | TURN-08 |
| Q44: Russian-only first release | No change; engine facilities stay locale-independent. |

#### WEBHOST-01: K0 shared-origin embedded browser hosting

itch.io serves HTML5 uploads from shared domains (`html.itch.zone`,
`html-classic.itch.zone`), whose browser storage is shared by every hosted game
([itch.io issue 1155](https://github.com/itchio/itch.io/issues/1155),
[itch.io notice](https://itch.io/post/8502982)). The browser build MUST:

- Use a globally unique namespace for IndexedDB database names, save game/profile
  identifiers, CacheStorage names and any other keys. Generic names such as the
  documentation's `my-application-saves` are insufficient.
- Never enumerate, clear or evict another application's storage.
- Keep saves independent of the URL path or upload ID. A new upload changes the
  path; saves must survive it subject to DATA-03 content compatibility.
- Register no service worker or offline pack in this build unless explicitly
  enabled. Offline play is not promised for the browser route.
- Run correctly inside an iframe with relative URLs. Capture keys only while
  focused, unlock audio on the launch click, and support host fullscreen.
- Disclose browser-storage eviction and recommend local export as backup.

Verify the host's current upload limits at release time.

#### DESKTOP-02: K1 offline Windows package from the same static build

Provide a reference route that wraps the consumer's static build as a Windows x64
application. It requires no separately installed Node runtime, engine checkout,
development server, agent daemon or network at run time.

- It MUST start and play on a clean supported Windows installation with the network
  disabled from the first launch.
- With a system WebView such as Tauri/WebView2, the default
  `downloadBootstrapper` needs internet when WebView2 is absent. Use an offline
  installer or fixed runtime, or a self-contained runtime such as Electron
  ([Tauri WebView2 options](https://v2.tauri.app/distribute/windows-installer/)).
  Choose by measured size and startup time, and document the choice.
- Load assets from the package through a stable application origin or protocol,
  with no `file://` dependency and no remote fonts, CDNs or services.
- Ship a portable archive compatible with itch.io app updates; an installer is
  optional. Updates replace application files and never touch saves.
- Enforce a minimum 1280x720 logical window, resizing, fullscreen and correct DPI
  scaling.
- Detect a second instance writing the same slot as a conflict, never a silent
  overwrite.

#### SAVE-06: K0 slots, named checkpoints and global profile

- Each slot is an independent strict record with its recovery copy. The consumer
  declares the slot count; Witch Kitchen uses three.
- Consumer-declared named checkpoints per slot: Witch Kitchen uses `night-start`
  and `pre-finale`. They are created consistently with the corresponding current
  revision.
- Restoring a checkpoint writes a new monotonic revision; revision numbers never
  rewind.
- A separate global profile stores settings, achievements, endings seen and
  onboarding preferences. Awards are idempotent claims: slot restore, night replay
  and import cannot duplicate or revoke them.
- A slot exports and imports as one bounded, validated file containing its
  checkpoints. Import targets an explicitly confirmed slot and never imports global
  awards. Re-binding the envelope to another slot must be explicit (issue #15).
- Strict SAVE-05 failure handling applies to every slot write.

#### SAVE-07: K1 file-backed `SaveStorage`

Implement the existing `SaveStorage` read, compare-and-swap, recovery and reset
contract over files for the desktop route:

- Write a temporary file, flush it and replace atomically. Keep the previous copy,
  check the revision before replacement, and reset only the declared namespace.
- Retry transient Windows sharing violations from antivirus or indexing a bounded
  number of times, without leaving a partial or zero-length current file.
- Store saves in per-user application data outside the installation directory.
- Expose them to page script only through a narrow command API, not general
  filesystem access.
- Use native dialogs for export and import, with the same bounded validation as
  `exportSave`/`importSave`.

#### TURN-06: K0 revertible zero-turn commands

Support consumer-declared revertible command classes. Witch Kitchen permits only
shelf and tray moves and swaps.

- Undo restores the exact previous authoritative state as a new committed and
  checkpointed revision.
- The undo stack is bounded. Its persistence policy is declared: saved with the
  slot or cleared on reload.
- Any non-revertible command, logical-turn advance, phase transition, randomness
  draw, claim or information reveal clears the stack. Undo is never available for
  actions that spend time, keys or currency, reveal hints, or draw randomness.

#### TURN-07: K0 replayable period streams

A consumer can restart the current period (night) from its checkpoint with
identical random content—arrivals, replacements and divination reveals—regardless
of player actions.

- Pre-roll the period schedule into state at the period boundary. Otherwise derive
  it from named streams whose draw counts do not depend on actions.
- Provide a test helper proving that two different action traces from the same
  checkpoint observe the same stream-derived schedule.
- Slot-local rewards revert with the restored state; global awards stay claimed.

#### TURN-08: K0 headless seed sweeps

Run consumer policies over many seeds through the TURN-05 headless route.

- Per-seed results are deterministic and independent of worker count or
  scheduling.
- Aggregate metrics: served and satisfied counts, ticks used at p50/p90/max,
  purchase timing and ending reachability.
- Every failing seed produces a replayable trace.
- Record measured throughput. The sweep must support at least 10,000 seeds per
  ending-route policy in one release-candidate run.

Statistical sweeps provide evidence. They are not proof of a guarantee "for any
stream"; such a claim also needs explicit generator constraints.

#### UI-08: K0 onboarding and contextual explanations

- Highlight a logical UI target by stable control ID, not a CSS selector, with an
  anchored "what is this / why" card.
- Trigger by committed state on first encounter, with queueing and dismissal.
- Never spend logical turns or limited hints, and never block pause or settings.
- Move focus in and restore it afterwards. Honour reduced motion, spoiler filtering,
  150% text at 1280x720, and targets that are scrolled or temporarily hidden.
- Persist "seen" state in the scope the consumer declares. A global setting disables
  cards; help can reopen them.

#### UI-09: K0 desktop viewport and scaling profile

- At logical viewports from 1280x720 CSS px—with Windows display scaling of
  100-150% and text scaling of 100-150%—no essential content or action is lost.
- Below the minimum, follow a declared uniform scale-down or notice; controls must
  never overlap.
- Keyboard-only play completes every action, including slot placement, dialogue
  and between-night screens.
- Essential state never depends only on colour or sound.

Screen-reader support is not promised for this consumer's first release.
Existing semantic output must not regress.

#### AUDIO-06: K0 bus policies, event-driven tempo and speech-like cues

- Separate buses for at least music, ambience/ticking, effects, voice and essential
  interface sounds.
- Each presentation state declares a mute, duck or keep policy per bus. For example,
  the nameless-guest state mutes music and ticking, ducks effects by a declared
  amount, and keeps voice and essential interface sounds. User volume and mute
  settings still apply.
- Logical events such as chimes trigger transitions between authored tempo
  versions, with bounded crossfades. Restoring mid-period selects the current
  version without replaying past chimes.
- Per-speaker speech-like cue sequences follow text reveal. They are skippable;
  reduced motion reveals text instantly. Captions cover whispers and essential
  signals. None of this gates or changes gameplay.

#### DIAG-01: K0 user-exported local session report

In release builds, a user action exports a bounded local report. It contains:

- content and engine revisions;
- seed and stream identifiers;
- the period;
- command identifiers with logical ticks;
- outcomes and metrics.

It contains no free text, story content or personal data, and requires no network.
Desktop uses a save dialog; the browser downloads a file.

Persist the period's command log with the slot so a reload cannot truncate the
report. Reports replay through the headless runner to reproduce a playtest period.

#### Additional acceptance

| ID | Scenario | Required outcome |
|---|---|---|
| K18 | Make three shelf moves, undo two, request a hint, then reload. | Undone state is exact with monotonic revisions; the hint closes undo; reload follows the declared stack policy. |
| K19 | Replay one night from its checkpoint with two different action traces. | Identical arrivals, replacements and reveals; local rewards revert; global awards are not duplicated. |
| K20 | Use three slots: reset one, export/import with checkpoints, restore the pre-finale checkpoint. | Other slots and the global profile stay intact; import grants no awards; strict failures block play. |
| K21 | Trigger onboarding for first encounters, disable it, use only the keyboard at 1280x720 and 150% text. | Each card appears once per declared scope; no turns or hints are spent; focus returns correctly. |
| K22 | Complete a night with only the keyboard at 1280x720 and 100/125/150% display scaling. | No clipped essential content and no colour-only state. |
| K23 | Serve two builds from one origin under different paths, framed beside another app using generic storage names. | Saves survive the path change; the other app's data is untouched; reset is namespaced; no service worker is registered. |
| K24 | On clean Windows 10 22H2 and 11 machines with networking disabled from first launch, start, play, save, quit, restart, update files and open a second instance. | Offline play and resume work; saves survive updates; concurrent writes report a conflict without loss. |
| K25 | Kill the desktop process at each file-write step and inject sharing violations. | The last acknowledged revision is always recoverable; no partial current file appears. |
| K26 | Enter the nameless-guest state, pass chimes, restore mid-night, skip murmur and enable reduced motion. | Bus policies and tempo selection are correct; past chimes are not replayed; gameplay is unchanged. |
| K27 | Reload mid-night, export the report and replay it headlessly. | Complete night log without text content; replay reaches the same outcome hash. |
| K28 | Sweep at least 10,000 seeds per policy twice with different parallelism. | Identical aggregates; failing seeds include replayable traces; throughput is recorded. |

For Witch Kitchen, K23 and K24 supersede the earlier offline-web interpretation
of K17. All prior requirements and acceptance rows remain in force within their
original scope.

## 23. Fluffy Bureau PM decisions (2026-10-07) and delta requirements

**Sources.** The PM answered every questionnaire item and approved scripts for the
prologue and all eight cases at three difficulty levels. They are in
`rumukh/fluffy-bureau` under `docs/pm/2026-10-07/` (`PM_ANSWERS_RU.md`, decisions
D01-D25). Team assumptions for points the PM left open are in
`docs/DECISIONS_RU.md` (T-entries). Where they conflict with defaults in sections
1-21, the PM answers and T-entries take precedence for this consumer.

**Engine baseline re-check (2026-10-08).** AEGIS `main` at
[`0abd61b5a679020bfb66bf4db24888df9e339d4d`](https://github.com/rumukh/aegis-engine/tree/0abd61b5a679020bfb66bf4db24888df9e339d4d)
implements sections 5-15 for the approved static/offline web route:
`@aegis/runtime`, `@aegis/browser` (save, IndexedDB, narration, UI, offline),
`@aegis/narrative`, reproducible SDK packing and `poc/storybook-lab`. Its
[acceptance report](https://github.com/rumukh/aegis-engine/blob/0abd61b5a679020bfb66bf4db24888df9e339d4d/docs/extension-acceptance.md)
records a complete Windows Chromium gate. It does not claim WebKit, Firefox or
physical-device acceptance. Reuse these APIs; the requirements below are deltas.

The engine contains **no** 2D character animation, rig, timeline, cutscene or
lip-sync facility. Open issues #8, #9, #13, #14, #15 and #17 affect this consumer.

### 23.1 Decision-to-delta map

| PM decision | Delta requirements |
|---|---|
| Q26, Q27: animated characters, lip-sync and intro cutscenes. The customized avatar is animated in every scene and cutscene. T05 interprets this as real-time layered 2D puppets and in-engine cutscenes, not frame-by-frame animation or pre-rendered video. | ANIM-01..07 |
| Q29, Q30: everything a child needs is voiced, including button labels. Lines start automatically, stop when the child advances and never auto-advance. Synthetic voices are pre-generated, with a narrator and a distinct voice per character. | AUDIO-07, ANIM-04 |
| Q09: up to four independent profiles, a save after every move, and no silent overwrite from a second tab | SAVE-08 (issue #15) |
| Q43: saves remain compatible between versions; an update never restarts an active case | DATA-04, SAVE-09 (issues #8, #9, #17) |
| Q02, Q03, T02: Windows plus landscape tablets, including iPadOS Safari; offline after installation from Stage 1 | UI-10, OFFLINE-04 |
| Q10: full play without sound, keyboard and touch, text scaling, readability option, reduced motion following the system setting | Existing UI-01..05; ANIM-06 |
| Q22, D24: the comfort lamp brightens the scene, warms the music and adds a reassuring line | ANIM-06, AUDIO-07 |

### 23.2 P0: 2D animation and cinematics

#### ANIM-01: browser 2D stage without three.js

- Provide a browser-safe public entry, as a new package or an `@aegis/browser`
  subpath, chosen in an ADR. It MUST NOT import the renderer, three.js or Node
  modules, and MUST pass the DIST-02 and standalone-consumer checks.
- Use the logical coordinate space already used by `logicalPoint`, `hitHotspot`
  and `createHotspotList`. Puppets and hotspots MUST stay aligned through resize,
  letterboxing and rotation.
- Support ordered layers (background, midground, characters, foreground, effects)
  and a camera with pan, zoom and framing presets clamped to scene bounds.
  Accessible DOM controls remain outside the drawing surface.
- Choose the drawing technology (DOM/CSS transforms, Canvas 2D or WebGL without
  three.js) by measurement. Target 60 fps with a 30 fps floor for four puppets,
  effects and a 2048x1536-class background on iPad (9th generation) class
  hardware. Measure with throttled Chromium and WebKit automation; physical
  devices remain consumer acceptance.
- Presentation time never changes authoritative state (TURN-01, K01).

#### ANIM-02: layered puppet rig format

- A versioned, validated JSON rig plus image atlases: parts with pivots,
  parent-child hierarchy, z-order and default transforms.
- Swappable part states: poses and expressions; eyes (open, half, closed);
  brows; and a declared mouth-shape set with a documented mapping from common
  viseme or Preston Blair (A-H, X) sets.
- Accessory slots composed at runtime: for example, species base plus scarf plus
  hat. Colour tint channels use masks and a declared palette, plus anchors such as
  a badge pinned to the scarf. Five species with every scarf colour and hat MUST
  render without pre-rendering combinations.
- Diagnostics for missing parts, invalid pivots, unknown mouth shapes and
  oversized textures. Asset IDs integrate with offline packs.
- Texture size is capped at 4096 px for iPadOS Safari. Owned decoded image memory
  is budgeted per pack using width x height x 4 bytes.

#### ANIM-03: clips and procedural motion

- Keyframed per-part clips (translation, rotation, scale, opacity and state swaps)
  with easing, loops and additive layers, such as idle breathing plus a gesture.
- Built-in behaviours: breathing or bobbing, a blink scheduler using
  presentation-only seeded randomness, look-at, hop, walking in or out along a
  path, and emote reactions.
- Deterministic sampling: a clip time maps to exactly one pose, enabling tests,
  seeking and skip-to-end.

#### ANIM-04: lip-sync from mouth-cue tracks

- Each voice line may ship a validated cue track: time-stamped mouth shapes with
  optional amplitude. It is independent of how cues were produced, for example TTS
  viseme events or audio analysis.
- The speaking puppet follows the cue track from the narration playback clock
  (AUDIO-07). Through pause, resume, replay, stop and interruption, drift MUST NOT
  exceed 50 ms. After stop, completion or failure, the mouth returns to its rest
  shape.
- Fallbacks: if cues are missing, use amplitude from the decoded buffer or a
  generic talk loop for the line's duration. If narration failed or is blocked,
  use a neutral mouth or a bounded subtle talk loop while the caption is visible,
  without claiming synchronized speech. Muted volume still animates from cues.

#### ANIM-05: cutscene timelines

- A declarative, versioned, validated timeline with camera moves, background
  changes, puppet entry, exit, movement, poses and emotes, narration lines,
  music and atmosphere changes, effects, transitions, wait-for-input markers and
  comfort-lamp variants.
- A narration step waits for the line to finish. Unless the consumer configures
  otherwise, it then waits for "next" (Q29: no automatic advance of text).
  Non-speech motion plays automatically.
- Pause (composing with HOST-03 reasons), resume, skip to the declared end state
  and replay. Restoring a save during a cutscene restarts it from the start or its
  last declared marker, as documented. Gameplay effects are never re-applied.
- Cutscenes emit presentation events only. The consumer commits "completed" or
  "skipped" through an ordinary runtime command.
- The player avatar is a role bound at runtime to the active profile's
  composition (ANIM-02). Every spoken line has its caption.

#### ANIM-06: accessibility, comfort and lifecycle

- Reduced motion, from the system preference or a consumer setting: replace camera
  pans with cuts or crossfades, damp large motions and never flash. Lip-sync and
  blinking remain.
- Comfort presentation (Q22): a consumer-declared brightness/warmth treatment and
  optional asset variants, applied instantly and reversibly.
- Pause composes with runtime pause reasons and `bindVisibilityPause`. Hidden
  documents do no animation-frame work.
- Disposal releases owned images, atlases and listeners. Memory stays bounded
  across repeated scene changes.
- Handoff and private projections remove private visuals and stop private
  narration (reuse A30 behaviour).

#### ANIM-07: preview and validation tooling

- A local preview route in a reference fixture loads consumer rigs, clips,
  cutscenes, cue tracks and voice files. It plays lines with lip-sync, shows
  diagnostics and toggles reduced motion and comfort. Asset production uses it.
- A headless validator checks rigs, clips, cutscenes and cue tracks without a
  browser.

### 23.3 P0: narration, profiles, compatibility and devices

#### AUDIO-07: narration playback clock and audio ergonomics

- A public API to read the active request's line ID, status and playback position
  in seconds, suitable for per-frame sampling, consistent through pause, resume,
  replay and gesture recovery, with start/stop notifications.
- Optional per-line metadata registered with a pack, such as a cue-track reference.
- On-demand label speech (Q29 button labels) with a documented policy relative to
  the active line, either replacing it or queuing after it.
- Issue #13: effect preloading, per-call gain, music loop points and scoped effect
  failures.

#### SAVE-08: multiple local profiles

- A profile registry: create, list, rename and delete, up to a consumer-declared
  limit. Saves and per-profile settings are namespaced; device-level settings are
  separate.
- Explicit rebinding or copying of an envelope to another profile (issue #15).
  Export and import work per profile. Verify existing cross-tab conflict detection
  per profile.

#### DATA-04 and SAVE-09: long-lived save compatibility

- Compatible content and schema evolution (issue #9): optional fields,
  multi-version registrations and explicit migrations. A compatible content update
  MUST load existing saves; an incompatible one keeps the existing explicit
  recovery route.
- Bound the growth of consumed jobs and claims (issue #8) for a campaign that saves
  after every action, preserving idempotency.
- Measure and bound per-commit cost (issue #17) for a Fluffy-sized state: progress
  for eight cases at three levels, a notebook and collections.

#### UI-10: child-safe preset correctness and tablet profile

- Fix the `CHILD_SAFE_CSS` specificity and reduced-motion attribute placement
  (issue #14).
- A landscape tablet profile: a rotate prompt in portrait, safe-area insets, a
  1024x600 minimum logical viewport, and WebKit-tested audio unlock, IndexedDB and
  service-worker behaviour.

#### OFFLINE-04: incremental media packs

- Install large media incrementally by content pack (the prologue and case 1
  first), with progress, a storage estimate before installation and handling of
  iPadOS storage limits.
- Installing a later pack never disturbs an active case. The existing rule against
  forced reloads mid-case applies.

### 23.4 Additional acceptance

| ID | Scenario | Required outcome |
|---|---|---|
| F01 | Four puppets, effects and a target-resolution background under 4x CPU throttling. | 60 fps target, 30 fps floor in Chromium; WebKit result recorded. |
| F02 | All five avatar species with every scarf colour and hat. | Correct runtime composition, tint and badge anchor without pre-rendered combinations. |
| F03 | Pause, resume, replay and interrupt a spoken line. | Cue drift at most 50 ms; rest mouth after stop or failure. |
| F04 | Remove a cue track; then fail or block narration. | Declared fallbacks; no claim of synchronized speech. |
| F05 | Pause, skip, replay and restore a save mid-cutscene. | No re-applied gameplay effects; captions for every line; no automatic text advance by default. |
| F06 | Enable reduced motion and comfort. | Declared transformations; no flashing. |
| F07 | Render 10,000 animation frames. | Authoritative state unchanged (K01). |
| F08 | Perform 50 scene transitions with puppets and atlases. | Owned decoded memory returns to baseline within tolerance; no leaked listeners. |
| F09 | Sample the narration clock through pause, resume, replay and unlock recovery. | Correct positions and notifications. |
| F10 | Use four profiles: rebind, export, import and reset one. | Isolated saves and settings; the others are untouched. |
| F11 | Load an older compatible save; refuse an incompatible one; make 10,000 commits. | Compatible save loads; recovery for the incompatible one; bounded claims with preserved idempotency. |
| F12 | Commit repeatedly on a Fluffy-sized state. | Measured per-commit cost within a documented budget. |
| F13 | Install the prologue and case 1 pack, cold-start offline, then install a later pack mid-case. | Offline play works; the active case is undisturbed. |
| F14 | Run the standalone consumer check with the new entries. | No three.js or Node imports; the packed SDK installs into an isolated consumer. |

### 23.5 Ownership, coordination and non-goals

- The engine owns mechanisms: formats, players, validators and preview tooling.
  The consumer owns art, rigs, clips, cutscene scripts, recordings, cue production
  and Russian catalogs.
- Section 22.10 (AUDIO-06, SAVE-06) changes the same audio and save modules. Land
  shared fixes for issues #8, #9, #13, #15 and #17 once, compatible with both
  consumers, and coordinate changes to those modules between engine workstreams.
- Non-goals: frame-by-frame animation, video decoding, skeletal mesh deformation,
  runtime speech synthesis and 3D presentation for this consumer.
