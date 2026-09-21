# Narrative and puzzle toolkit

`@aegis/narrative` is an opt-in, deterministic data library. Its only dependency is
the public `@aegis/core` package. It has no DOM, Node, three.js, storage, audio,
network, physics-mode, or continuously running loop dependency. All exports are
available from `@aegis/narrative`; no internal or source imports are required.

The package implements mechanisms, not either consumer game. Stories, balance,
localization, art, spoken recordings, educational accuracy, endings, and family
rules belong to consumers. Nothing selects a locale or imposes the child profile
on another game.

## Boundary and integration contract

All definitions and state are JSON-serializable. Public validation and restore
functions decode unknown input, reject unsupported versions and missing
references, and return detached data. Reducers do not modify their input state.
Install their returned state through the runtime's atomic command boundary;
persist it after the runtime commit, not after an animation or audio callback.

Validation APIs named `validateNarrative`, `validateDeduction`,
`validateChildProfile`, `validateNarrativeChildProfile`, and
`validateResolvedCase` return core `Validated<T>`. Use `requireValid(result)` for
the throwing form. `parseDeduction`, `validateMinigame`, `validateFamily`, and
`validateCosmetics` are throwing decoders. The distinction is part of the public
API, not a promise that every function beginning with `validate` returns the same
envelope.

Expected invalid actions/content throw `ToolkitError`, a core `DiagnosticError`
with `code`, `messageKey`, `path`, and `diagnostics`. For example:

```ts
import {
  advanceNarrative,
  ToolkitError,
  type NarrativeCommand,
  type NarrativeGraph,
  type NarrativeState,
} from '@aegis/narrative';

export function choose(graph: NarrativeGraph, state: NarrativeState, command: NarrativeCommand) {
  try {
    return { ok: true as const, state: advanceNarrative(graph, state, command) };
  } catch (error) {
    if (!(error instanceof ToolkitError)) throw error;
    return {
      ok: false as const,
      code: error.code,
      messageKey: error.messageKey,
      path: error.path,
    };
  }
}
```

Map `messageKey` through the consumer's catalog. Developer diagnostics contain
English, candidate assignments, and private content identifiers: **never send
diagnostic messages/data to child-facing live regions or normal production
logs**. Unexpected callback exceptions propagate; the toolkit does not turn
programmer errors into success-shaped fallbacks.

Stable content IDs are 1-128 ASCII characters (letters, digits, `.`, `_`, `:`,
`/`, `-`, starting with a letter/digit), excluding reserved object-property names.
Cosmetic claim identities are opaque nonempty strings up to 512 characters, so
they can carry both minigame result IDs and structured family ability identities.
Numbers used as counters/quantities are bounded safe integers. Recursive JSON is
limited to 32 levels and 100,000 values; cyclic objects, functions, class
instances, non-finite numbers, and unsafe keys are rejected.

## Narrative graphs: STORY-01, STORY-02, STORY-04

The exported `NarrativeGraph` schema has:

| Field                                  | Meaning                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `schema: 1`, `id`, `revision`, `start` | Versioned graph identity and initial node.                                                                                 |
| `catalogs`                             | Explicit arrays for `scene`, `text`, `asset`, `clue`, `fact`, `glossary`, `reward`, `completion`.                          |
| `flags`, `items`, `data`               | Declared boolean flags, nonnegative integer consumables, and consumer JSON data keys.                                      |
| `effects`                              | Globally unique effect definitions; each effect ID is its persistent once-only claim identity.                             |
| `nodes`                                | Scene/text/narration bindings, entry effects, choices, automatic edges, explicit revisit policy, ending-resolution marker. |
| `endings`                              | Consumer-authored ordered eligibility guards and effect IDs. First eligible ending wins.                                   |
| `maxAutomaticSteps`                    | Explicit automatic transition budget, 1-1024.                                                                              |

A node has `id`, `scene`, `text`, `narration: string | null`,
`revisit: 'allow' | 'forbid'`, `entryEffects`, `choices`, `automatic`, and
`resolveEnding`. Choice/edge IDs are unique within that node. Both have `to`,
`guard` (use explicit `null` for always), and an `effects` array; choices also
have a localized `text` reference.

Guards are tagged `flag` (`id`, `value`), `item` (`id`, `atLeast`), `claimed`
(`id` of an effect), `all`/`any` (`guards`), or `not` (`guard`). Depth is bounded
at 16 and expression count at 256. There is no evaluated code or expression
string language.

Effects are tagged:

| Kind       | Fields beyond stable `id`                                                      |
| ---------- | ------------------------------------------------------------------------------ |
| `flag`     | `flag`, `value`                                                                |
| `item`     | `item`, bounded signed integer `delta`; resulting inventory cannot be negative |
| `claim`    | `catalog: 'clue' \| 'fact' \| 'glossary' \| 'reward' \| 'completion'`, `ref`   |
| `consumer` | `handler`, `reads`, `writes`, JSON `payload`                                   |

`ConsumerEffects` is an explicitly registered map of pure handlers with
`validate(payload): void` and
`apply(payload, inputs): Record<string, Json>`. Payloads validate before graph
activation. At execution all declared reads **and writes** must already exist in
state. A handler receives cloned declared inputs only, and must return exactly
the declared writes. Built-in effects also validate their dependencies and
numeric results. All effects, entries, automatic transitions, and ending effects
are staged on detached state; failure returns no partial state. **Handlers must
not perform external side effects**: no transaction can undo a consumer's
arbitrary network/DOM/storage writes.

```ts
import {
  createNarrativeState,
  advanceNarrative,
  projectNarrative,
  restoreNarrative,
  requireValid,
  validateNarrative,
} from '@aegis/narrative';

const graph = requireValid(validateNarrative(authoredJson));
let state = createNarrativeState(graph, { items: {}, flags: {}, data: {} });
const view = projectNarrative(graph, state);
state = advanceNarrative(graph, state, {
  node: view.node,
  revision: view.revision,
  choice: selectedChoiceId,
});
state = restoreNarrative(graph, JSON.parse(JSON.stringify(state)));
```

The sample's `authoredJson` and `selectedChoiceId` are consumer inputs. A complete
original definition and its branch assertions are in
`packages/narrative/test/fixtures.ts` and `narrative.test.ts`.

Flags persist across any consumer-defined periods. Every effect ID is once-only
for this graph state, including item consumption: an explicit revisit does not
repeat entry grants or consumption. Collection membership is also deduplicated
when different claimed effects refer to the same reward/clue. Repeated mechanics
belong to consumer commands or deliberately separate claim identities, not an
implicit reset of this ledger.

Automatic edges use authored first-enabled order. Cycles exceeding the budget
report the traversed node/edge chain and discard the staged transition. Manual
revisits are explicit, not mistaken for automatic loops. Unknown, disabled,
wrong-node, and stale-revision choices are rejected. The projection includes
enabled flags, but hiding a disabled button is not an authorization boundary.

Restore checks graph/content identity, visits, claims, collections, inventory,
and settled-node consistency. It **does not enter a node, reapply effects, settle
automatic edges, or reevaluate a committed ending**. Consumers must retain the
matching content revision or migrate explicitly. A snapshot is validated state,
not cryptographic proof of an honest player; trusted local save editing is not
prevented.

Wrong-answer routes are consumer-authored revisitable/manual paths. The toolkit
does not invent punitive loss, currency, game endings, or campaign-length rules.
The fixture demonstrates two exclusive consumer-ordered outcomes, a cross-period
flag, a consumed ticket, and irreversible reward/completion claims.

## Finite deduction, notebook and hints: LOGIC-01 through LOGIC-03

`DeductionCase` declares 1-8 arbitrary axes with 1-128 stable value IDs each,
optional compatibility, intended assignment, substantive clues, explained red
herrings, and `maxCandidates` (1-100,000). The **raw Cartesian product** must fit
the limit before any enumeration; a restrictive compatibility predicate is not
a workaround for an oversized input.

The raw candidate count multiplied by total compatibility/clue expression nodes
is additionally capped at 10,000,000, so independently bounded inputs cannot
multiply into an impractical search.

Predicates are `eq`/`ne` (`axis`, `value`), `in` (`axis`, `values`), and
`and`/`or` (`terms`). They have the same 16-level/256-expression limit as guards.
Clues name `requires` clue IDs, `requiresAnswer`, and `explanationKey`. All clues
are required in this deliberately small model. Red herrings have only IDs and
explanation references, not secretly contradictory constraints.

`validateDeduction(unknown)` checks:

- The intended assignment satisfies compatibility and every real clue.
- Every required clue is reachable from the empty revealed set without the
  unknown answer; cycles and answer-locked access are rejected.
- Revealed reachable prefixes remain nonempty, and complete clues leave exactly
  one candidate.

`inspectDeduction` returns candidates, reached clues, prefix counts and
diagnostics. Failure diagnostics identify clue IDs and candidate assignments
(up to 32, with an explicit truncation flag). Since every accepted clue preserves
the same intended assignment, **every allowed subset/order** preserves at least
that assignment; the diagnostic prefix trace is one deterministic authored-order
witness, not exhaustive order enumeration.

`solveDeduction(case, revealedIds)` uses compatibility and **only** the revealed
predicates. It checks reveal prerequisites. It does not use the intended answer
to filter candidates. Opening ambiguity is normal; only the complete set must be
unique. This is finite enumeration, not natural-language inference or a general
solver.

The access proof covers the declared prerequisite model. Authors must faithfully
declare answer dependencies; the toolkit cannot infer hidden unlock conditions
inside unrelated consumer JavaScript.

`createNotebook`, `restoreNotebook`, `proposeNotebookMarks`, and
`setNotebookMark` operate on `NotebookState`. Each mark records axis/value,
`unknown`/`excluded`/`confirmed`, `user`/`evidence` source and clue citations.
Assistance cites the revealed subset whose candidate set proves the mark.
Evidence is rechecked on restore; hidden, unsupported or fabricated citations
fail. User hypotheses are not silently "corrected". Choose `preserve-user` or
`replace-user` explicitly when applying evidence.

Restore and single-mark edits solve each distinct citation set once per
operation, sharing support checks across marks and citation-order permutations.
The cache is local to that operation: different subsets, changed content and
later reveal states never borrow stronger or stale evidence. Every mark still
validates its own citations and provenance, including proposals ignored by the
`preserve-user` policy.

`nextHint(case, tiers, state, revealedIds, allowance)` uses authored tier order,
required citations, and persisted `{ schema: 1, used: string[] }`. It only
returns a tier when all its cited clues are revealed and the tier is unused.
It returns `{ status: 'exhausted', reason: 'review' | 'allowance', state }` when
no new permitted tier exists. A later clue may unlock a tier after a review
result. No currency is charged and no facts are fabricated. Keep hint state
namespaced to the active case; tier IDs identify authored content, not a global
cross-case allowance. The consumer/editor must approve the actual hint wording:
IDs and citations cannot prove the semantics of prose.

## Minigames: MINI-01 and MINI-02

```ts
import {
  createMinigameRegistry,
  createMinigame,
  reduceMinigame,
  projectMinigame,
  type MinigameDefinition,
} from '@aegis/narrative';

const registry = createMinigameRegistry();
const definition: MinigameDefinition = {
  schema: 1,
  id: 'find-leaf',
  revision: 'one',
  kind: 'scene-selection',
  adapterSchema: 1,
  config: { targets: [{ id: 'leaf', labelKey: 'object.leaf', required: true }] },
  outputs: [{ kind: 'clue', id: 'leaf-observation' }],
};
const initial = createMinigame(definition, 'case-one-leaf-attempt', registry);
const completed = reduceMinigame(
  definition,
  initial,
  { type: 'move', revision: initial.revision, value: { target: 'leaf' } },
  registry,
);
const view = projectMinigame(definition, completed, registry);
```

All instances persist definition/content identity, instance ID, revision,
lifecycle status, rule progress and optional result. `restoreMinigame` validates
committed progress and independently derives/checks completion and outputs.
Use a fresh stable instance ID for a deliberate replay. Closed instances reject
new moves. A result ID is `<instanceId>:complete`; the **parent host** consumes it
once. Nothing in a minigame grants campaign items or modifies another UI.

Lifecycle actions `suspend`, `resume`, and `cancel` include the current revision.
Suspension preserves progress and rejects moves; cancellation is terminal for
that instance. Restore preserves suspension. Selection coordinates and ongoing
drag gestures are browser state, not committed rule progress.

| Built-in kind     | Config / moves                                                                                                | Accessible projection                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `scene-selection` | `targets: {id,labelKey,required}[]`; move `{target}`                                                          | Activate a labeled target from a non-spatial list. Wrong targets are non-punitive.                                                  |
| `matching`        | `cards: {id,pair,labelKey,backLabelKey}[]`, exactly two per pair; `{type:'select',card}` or `{type:'clear'}`  | Select two cards; mismatches remain visible until explicit clear, never a timer. Hidden face labels are absent from the projection. |
| `ordering`        | `items: {id,labelKey}[]`, `solution: string[]`; `{type:'place',item,index}` or `{type:'submit'}`              | Select an item then a position. Authored order, never platform collation. Incorrect submission remains editable.                    |
| `rule-table`      | `initial`, `states: {id,textKey,complete}[]`, `moves: {id,from,to,labelKey,media,alternativeKey}[]`; `{move}` | Activate a legal choice with an equivalent text/visual label. All states must have a route to completion.                           |

`ruleFixture` in the test fixtures demonstrates constrained selection, exact
quantity, causal change and media comparison through `rule-table`. The quantity
fixture represents halves as two quarter-units; `exactQuantity(numerator,
denominator, unitsPerWhole)` requires exact divisibility and returns a bounded
integer. It never compares floating-point answers. Media rules name an optional
asset ID and mandatory alternative key; matching informational equivalence and
asset playback remain the consumer/browser's responsibilities.

For bespoke rules, register a `MinigameAdapter<Config, State, Action, View>` in
`MinigameRegistry`. Implement config/state/action decoders, initial state,
deterministic reducer, projection and completion predicate. Values crossing the
registry boundary must still be JSON. Kind registration cannot be overwritten.
The custom counter in `minigames.test.ts` is executable evidence that a consumer
can add a minigame without changing engine code.

## Family and association rules: FAMILY-01 through FAMILY-03

`FamilyDefinition` declares players (`id`, `labelKey`, abilities and role),
private card data, per-player count/capacity, and explicit `stock`/`reject`
remainder policy. Distribution uses authored deck/player policy order. Consumers
may seed/shuffle a resolved deck before creation; persist that actual deck
revision rather than rerolling it during restore.

`createFamilyState` begins neutral. The only legal reveal path is
`confirmHandoff(definition, state, playerId, revision)`. `beginHandoff` first
removes the active-player view and names the next recipient. `projectFamily`
returns either the neutral screen or **only** the confirmed player's private
cards/available abilities. Neutral output has no hands, face text, role secrets,
or previous-player private state; it includes `stopPrivateNarration: true`.
Browser adapters must stop private speech, replace DOM/accessibility projections,
and restore focus at this boundary.

`parseFamilyState` validates/detaches **without** changing phase. Use it in a
runtime schema that executes on every commit. `restoreFamily` is deliberately
different: disk restore always requires neutral reconfirmation, without giving
an extra turn or resetting ability use. Do not call the disk restore operation
as a per-command schema normalizer.

`consumeAbility` checks the confirmed active player and declared ability.
It returns `{ state, consumed, claimId }`. The first consumption is true;
subsequent consumption is false with the same state/claim identity. Only apply a
consumer benefit when `consumed` is true, in the same parent transaction.
Privately informed hint-givers use the declared role and private card contents.
Public questions, responses, and a shared solution belong in consumer-owned
`publicData`; there is no elimination mechanic.

**Trusted pass-and-play only.** Authoritative state and local saves contain
secrets. Never render them directly or copy private fields into `publicData`.
These projections are not encryption, authentication, or protection against
developer tools.

`validateAssociationGroups` checks approved token/image groups against answer
IDs, forbidden tokens, image catalog IDs, and explicit compatible-answer IDs.
Lexical normalization uses NFKC, lowercase, Cyrillic yo-to-e folding, and
punctuation/whitespace normalization. Whole normalized token sequences are
checked, including direct answer IDs. `selectAssociation` projects only the
selected group's tokens/images, not compatibility metadata. This prevents
declared direct tokens; **it cannot detect arbitrary semantic synonyms,
implications, or freeform hints**. Human adjudication remains necessary.

## Child content profile: STORY-03

`CHILD_PROFILE` defaults to ten words per explicit sentence segment, three new
terms, exactly three fact IDs, three primary choices per rendered page, complete
finite narration bindings and at most 128 phrase combinations. Other consumers
can choose different limits or omit this opt-in module.

`ChildCase` supplies lines/phrase variants, new terms, facts/clues/rewards,
red-herring explanation lines, annotated nodes, decisions with explicit
`pageSize`, and route fixtures. `ContentCatalogs` supplies assets, clues, facts,
glossary, rewards and speakers. References, duplicates, graph edges and complete
routes are checked.

Each `ChildTextVariant` declares `sentences`, placeholders and narration.
Placeholders have stable IDs, `maxWords` and optional finite `{id,text}` variants.
Tokenization recognizes Unicode letters/numbers, retaining internal apostrophes
and hyphens as one word; punctuation alone is not a word. Cyrillic including both
cases of yo is covered by tests. For `{name}` substitution, the sentence's
worst-case count uses the declared bound **at each occurrence**, not the shortest
sample.

Narration bindings name `selection` (one variant ID per placeholder, in order)
and `assetId`. A line with no placeholders uses `selection: []`. Every finite
combination must have a binding. Bound-only free text is permitted in a
deliberately non-narrated profile, but cannot pass complete narration coverage;
this module does not promise arbitrary-name speech. Binding validation proves
references/coverage, not that an audio file says the right words.

`validateNarrativeChildProfile` binds these annotations to the actual narrative
entry, nodes, edges, text references and all choices. Larger decision sets
require authored paging; the browser must honor the validated `pageSize`.
This is data validation, not proof of the rendered UI's control count.

`reportTeachingRoutes` reports encounters and **distinct nodes** along each
declared complete route, never a disconnected global text count.
`reportNarrativeTeachingRoute` goes further: it executes an explicit sequence of
choice IDs through the real narrative guards/effects on private state, requires
a committed ending, and reports recurrence/explanation coverage from the actual
visited nodes. A disabled choice cannot earn teaching credit. Repeated visits
increase encounter counts but do not inflate distinct-node recurrence.
`childRouteDiagnostics` produces editorial warnings for insufficient recurrence
and absent explanation presentation.

Human review still owns scientific accuracy, emotional safety, age suitability,
the meaning of a "sentence", pedagogy, asset rights and pronunciation. No
validator certifies those properties.

## Generation: GEN-01

`GenerationTemplate` names a revision, finite dimensions/options, and explicit
compatible bundles. Every bundle resolves all dimensions and contains a complete
`ResolvedCase`: narrative, deduction, child annotations, catalogs and content
identity. A missing combination is unsupported, not permission to mix random
actors, grammar, facts or voices.

`generateCase(template, seed, maxAttempts = 64, handlers?)` uses the core seeded
PRNG and draws bundles without replacement. It fully validates structure,
cross-module references, child policy and deduction **for every attempted
output**. It returns either `{ok:true,value,attempts}` or
`{ok:false,diagnostics,attempts}`. There is no invalid fallback. The template
product and attempt budget are independently bounded at 4096.

`enumerateCaseCombinations` enumerates the full small product, reporting valid,
invalid and unsupported rows separately. The four-row test fixture contains two
valid resolved combinations and two explicit unsupported results; ambiguity and
missing-content mutations fail rather than becoming "generated cases".

Persist the complete `GeneratedCase` returned in `value`, including its
`resolved` definition, bundle and template revision. `restoreGeneratedCase`
validates that saved definition, **never** regenerates from the seed or a changed
current catalog. Asset availability/content retention still belongs to the
versioned pack/save host. This is replayable authored combinations, not unlimited
new stories or semantic compatibility inference.

## Collections and printing: COLLECTION-01, PRINT-01

`validateCosmetics`, `createCosmeticState`, `restoreCosmetics`, `grantCosmetic`
and `equipCosmetic` supply the small shared cosmetic mechanism. Grants are
idempotent by explicit claim identity; reusing an identity for another item is an
error. Duplicate item grants cannot accumulate currency. Equipment must be owned
and fit its declared slot. Both narrative rewards and minigame result consumers
use the same helper in tests. No payments, shops or monetization rules exist.

`layoutPrint(document, options, approvedContentIds)` exports physical millimeter
geometry for A4/Letter cards, tokens, map, notebook and rules. Each item retains
its digital `contentId`, text front, optional text back, and material kind.
Options explicitly specify rows, columns, margins, gutters, point size and
`none`/`long-edge`/`short-edge` duplex.

Back pages mirror **cell positions**, not text: horizontal positions for portrait
long-edge duplex, vertical positions for short-edge. Front/back pages stay
paired, including empty slots on incomplete final sheets. Print at actual size,
disable browser headers/footers, and test a single sheet for feed orientation
and registration before cutting.

`renderPrintHtml(layout)` emits escaped, script-free HTML/CSS, with no URL or
external asset interpretation. Text is conservatively wrapped against explicit
line/character budgets; overflow and oversized unbreakable words are errors, not
silent clipping or truncation. The data export also supports a consumer-owned
artwork/PDF renderer. It does not generate artwork, a town map, or final game
decks.

Geometry and escaping are covered headlessly. Actual font metrics, browser print
scaling, readable output and physical printer registration still require
reference-app/device review; this package does not claim that those human/device
acceptance requirements have passed.

## Focused evidence and packaging

From the repository root:

```powershell
npx --no-install tsc -b packages\narrative
npx --no-install tsc -p packages\narrative\tsconfig.tests.json
npx --no-install vitest run packages\narrative
npx --no-install eslint packages\narrative
```

Tests cover branch mutations and disabled/stale choices, atomic consumer
failures, missing refs, automatic cycles, persistent claims/endings, 27/64/100
candidate profiles, arbitrary axis counts, ambiguity/contradiction/access cycles,
revealed-only notebook/hints, all minigame families and partial restores,
handoff privacy and abilities, Cyrillic/placeholder/narration/profile failures,
actual executable teaching routes, full finite generation enumeration,
post-update generated restore, cosmetic reuse and A4/Letter print geometry.

The package exports emitted ESM/declarations and includes an MIT license. It
remains `private: true`: local packing is supported, registry publication is not
authorized. Core is pinned to `0.0.0` in the workspace manifest; the coordinating
artifact route must version/pin the selected core and narrative artifacts
together. It must not accidentally resolve a similarly named registry package.
Root references, dependency checks, source aliases, standalone artifact
installation, browser UI, full workspace verification and device evidence are
owned by the integration workstream, not silently certified by this package's
focused suite.
