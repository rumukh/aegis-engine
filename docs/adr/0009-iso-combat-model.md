# ADR-0009: Iso combat model, and the harness contract freeze

- **Status:** Accepted
- **Principle:** CHARTER §5 (input is a script), §6 (verification without pixels), §7 (agents
  can see without a GPU), and the mode boundary of ADR-0006.

## Context

The harness (`@aegis/harness`) is the layer that makes principle 6 real: run a scene for N ticks
with a scripted input, then assert on world state, events and invariants — no pixels. It ships
_before_ any `@aegis/mode-*` package exists, and three mode sessions (platformer, iso, fps) build
directly on its API in parallel the moment it merges. Two scope questions had to be settled by
this session because both become expensive to change once those three sessions are in flight:

1. **How does iso combat work?** The iso PoC ("the design docs left this deliberately open") could
   be either _turn-based initiative_ (classic CRPG rounds) or _real-time-with-cooldown_ (pause-
   optional, abilities gated by timers — Dragon Age: Origins style). This is not a rendering
   detail: it dictates the movement and time model `mode-iso` must carry, and therefore the size
   of that session.
2. **Are the three architect-flagged contracts final?** `ModePlugin`, `SemanticFrame` /
   `ViewProvider`, and `SimResult` were flagged as "uncertain." This session is the last one
   permitted to change them; after merge they FREEZE and only the PM may change them centrally.

## Decision

### 1. Iso combat is real-time-with-cooldown, not turn-based initiative

`mode-iso` implements **real-time-with-cooldown** combat: entities act continuously in the same
fixed-tick timeline as every other mode, and abilities/attacks are gated by per-entity cooldown
timers (a `Cooldown`-style component decremented by `dt` each tick). There is **one** movement and
time model, shared with platformer and fps.

**Turn-based initiative is deferred to v2.** Adopting it now would force `mode-iso` to carry _two_
movement models — the continuous fixed-tick one every other mode and the harness assume, plus a
discrete initiative-order/round scheduler with its own action economy — roughly doubling that
session's scope and leaking a second notion of "time" into a codebase whose determinism story
(ADR-0001) and input model (ADR-0004: a script is per-tick frames) are both built on a single
uniform tick. Real-time-with-cooldown expresses the PoC's combat feel (kite, cooldown windows,
focus-fire) entirely within the existing tick/`dt` model, so it needs no new engine concept and
composes cleanly with scripted input and the assertion API.

Consequences:

- **Good:** one time model across all three modes; scripted playthroughs and `hashEquals`
  determinism work identically for iso; `mode-iso` scope stays comparable to the other two.
- **Cost:** the classic turn-based CRPG feel is out of scope for the PoC.
- **v2 path:** turn-based initiative can be added later as an _additional_ opt-in scheduler on
  top of the tick model without breaking the real-time path; it is not precluded, only deferred.

### 2. The three flagged contracts — final rulings (now FROZEN)

- **`ModePlugin` — grows by exactly one optional hook: `init?(world): void`.** Evidence from all
  three game designs: each mode needs per-run setup that the scene file cannot express — the
  platformer spawns a mode-owned moving platform, fps extrudes collision from a floorplan, iso
  builds a navigation grid. `init` runs once, after the scene is instantiated and before tick 0.
  It is optional, so modes that need no setup are unaffected. **No custom input-binding hook was
  added:** the input DSL (ADR-0004) compiles to generic per-tick `InputFrame`s, and each mode
  reads the action/axis/look/pointer names it cares about inside its own input-phase systems, so
  binding is already a mode concern with no contract surface. This is the change the architect
  predicted `ModePlugin` would most likely need; it is made now, and the contract is otherwise
  unchanged.
- **`SemanticFrame` / `ViewProvider` — the fps-specific fields are now optional** (`occluded?`,
  `visibleFraction?`, and any `bounds?`). Per the PM's ruling: visibility/occlusion is meaningful
  for a 3D fps view but not for an orthographic platformer or iso projection. Making them optional
  means the fps session cannot force an interface change that breaks the other two modes
  mid-flight; a mode simply omits what it cannot compute.
- **`SimResult` — shape confirmed, no change.** Every game test reads it, so additions are cheap
  but renames are expensive (ADR-0008). Its members (`world`, `tick`, `seed`, `hash`,
  `tickHashes`, `events`, `query`, `at`, `frame`, `ascii`, `assertInvariant`, `recording`,
  `replay`) already cover the three games' `defineGameTest` blocks with no gap, verified against a
  fake mode plugin exercised end-to-end in the harness's own tests. Pinned as-is.

These three contracts are now **frozen**. Only the PM may change them, centrally, on request.

## Consequences

- The three mode sessions can start in parallel against a stable API: one time model, a known
  setup hook, view fields they can safely omit, and a `SimResult` that will not be renamed under
  them.
- `mode-iso`'s scope is bounded to a single movement model; turn-based initiative is a documented
  v2 item rather than an open question.
- A harness-level guarantee backs replay determinism: `runScene` instantiates each run from a deep
  copy of the scene, so a run never mutates the caller's `SceneFile` and `replay()` reproduces a
  byte-identical hash even when the same scene object is reused.
