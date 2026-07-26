# ADR-0001: Determinism strategy

- **Status:** Accepted
- **Principle:** CHARTER §3.3 — "Deterministic by construction."

## Context

Determinism is the foundation the whole engine rests on (principle 3, anti-goal §5.4): the same
scene + input script + seed must produce a **byte-identical state hash on any machine, every
time**. That is what lets an agent reproduce a bug, lets CI assert on gameplay, and makes replay
trustworthy. Three things threaten it:

1. **Floating-point results that differ across CPU/OS.** IEEE-754 `+ - * /` and `sqrt` are
   correctly-rounded and identical everywhere. The danger is the **transcendentals** (`sin`,
   `cos`, `exp`, `pow`, `log`, `atan2`, …): the C library implementations are _not_ specified to
   the last bit and genuinely differ between platforms and even libm versions.
2. **Unstable iteration order** (e.g. hashing entities into a `Map` and iterating insertion order
   that varies with spawn timing).
3. **Ambient non-determinism**: `Date.now()`, `performance.now()`, `Math.random()`.

A common answer is fixed-point integer math everywhere. It is bulletproof but it taxes every
line of gameplay code, complicates the content format, and fights TypeScript's `number`.

## Decision

**Use `float64` (JS `number`) with three disciplines, not fixed-point.**

1. **Control operation order.** Determinism comes from evaluating the same operations in the same
   order, which our fixed tick loop and deterministic iteration order (ADR-0002) already
   guarantee. IEEE-754 `+ - * / sqrt` are reproducible across machines, so ordinary vector math is
   safe.
2. **Own our transcendentals.** `@aegis/core/math` provides its own `sin`, `cos`, `tan`, `atan2`,
   `asin` and `acos`, implemented as fixed polynomial approximations that are bit-identical
   everywhere, instead of calling `Math.sin`. Simple, exact ops (`abs`, `floor`, `ceil`, `min`,
   `max`, `sign`) wrap `Math.*` because they are exact by definition. `sqrt` also wraps
   `Math.sqrt`: ECMA-262 formally classifies it as implementation-approximated, but every
   mainstream engine lowers it to the hardware square-root instruction, which IEEE-754 requires to
   be correctly rounded — so **in practice** it is bit-identical everywhere. `round` does **not**
   wrap `Math.round`; see §"Rounding" below.
3. **Ban the ambient sources by lint.** [`eslint.config.js`](../../eslint.config.js) makes it an
   **error** in every simulation package (`core`, `content`, `harness`, `mode-*`) to reference
   `Date`, `performance`, `Math.random`, or any banned transcendental `Math.*` property. Time is
   the integer tick + fixed `dt`; randomness is the seeded PRNG in `core/prng.ts`.

State hashing (`core/hash.ts`) serialises the world through a canonical, key-sorted encoding so
the digest is invariant to object key order.

### Which functions core actually provides

The lint rule bans more `Math.*` members than `@aegis/core/math` replaces. As of today core
provides `sin`, `cos`, `tan`, `asin`, `acos`, `atan2`, `sqrt`, `abs`, `sign`, `floor`, `ceil`,
`round`, `min`, `max`, `clamp`, `lerp`, `wrapAngle` and `approxEqual`, plus the vector and
quaternion surfaces. It does **not** provide `exp`, `pow`, `log`, `log2`, `log10`, `cbrt`,
`hypot` or the hyperbolics, all of which the lint rule forbids.

That is deliberate, not an oversight — but it does mean a mode that needs one of them has **no
legal path today**. The rule stands: do not reach for `Math.pow`. Ask the core session to add a
deterministic implementation, which then becomes the single shared one. Integer exponents are
usually expressible as repeated multiplication (`x * x`), and `hypot` as
`sqrt(x*x + y*y)` — both exact and already legal.

### Domain of `sin`/`cos`/`tan`

`sin`/`cos` use a two-word Cody–Waite argument reduction. That reduction is only exact while
`k · PIO2_HI` is exact, i.e. up to `k ≈ 2^22`; past that it degrades, and it degrades quietly.
Measured absolute error against the platform reference: 1.1e-16 at `|x| ≤ 1e6`, **1.9e-9 at
`|x| ≈ 1.9e7`** (already outside the ≤ 1e-9 contract), 6.2e-2 at 1e15, and beyond `|x| ≈ 1.2e17`
the result stops being a sine at all (`sin(1e18)` came out as `2.8e16`; `sin(1e150)` as
`-Infinity`, which then fed straight into world state).

So the contract names a **domain**: `|x| ≤ SIN_DOMAIN_MAX = 2^20·π` (≈ 3.294e6 radians ≈ 524288
full turns). Inside it the measured worst-case absolute error is 2.2e-16. Outside it — and for
`NaN`/`±Infinity` — `sin`/`cos`/`tan` throw a `RangeError` rather than return a plausible-looking
wrong number. An angle that large is an accumulator bug; failing at the source beats poisoning the
state hash later. `wrapAngle` exists for the rare legitimate case.

### Rounding

`round` is **round half away from zero** (`round(2.5) === 3`, `round(-2.5) === -3`) and is
implemented by splitting the integer part with `Math.trunc` and comparing the remainder. It is
_not_ `Math.round` (which is half-up: `Math.round(-2.5) === -2`) and _not_ `Math.floor(x + 0.5)`
(which is half-up _and_ double-rounds: `0.49999999999999994 + 0.5` is exactly `1` in float64).
All three disagree, so the rule is stated here and pinned by test.

The private `nearestInt` used inside argument reduction is separately half-up. Any consistent tie
rule reduces correctly, but the specific one is baked into every `sin`/`cos` result and therefore
into every stored replay — changing it is a breaking change.

### What the state hash covers

`World.hash()` is computed over the `WorldSnapshot`: components, resources, PRNG state and the
entity allocator. It does **not** cover the event stream. Two runs whose damage/kill/trigger
events diverged completely still compare equal under `hashEquals` if their component state
converged. Use `world.events.digest()` — the same canonical encoding and FNV-1a-64, computed over
the recorded stream — to pin that half; the core determinism proof pins both.

Keeping them separate is a deliberate trade: folding events into `StateHash` would be a stronger
single check, but it changes the meaning of every stored replay and every pinned `GOLDEN_HASH`,
and it would make the digest depend on whether event recording happened to be enabled. Two
explicit digests say what they cover.

Snapshotting also **enforces** finiteness, in two places, because one is not enough:

1. **Rejected at the write boundary.** `spawn`, `add`, `setResource` and `ComponentType.create`
   raise `AEG-CORE-0001` naming the component and JSON path (and the entity, where one exists)
   rather than accepting `NaN`/`±Infinity`. Non-finite is therefore unrepresentable in world
   state, and the error fires at the code that produced it — principle 8's whole purpose. The
   check runs on the _input_, before any caller-supplied `ComponentType.clone`, so a lossy
   clone cannot smuggle a value past it.
2. **Preserved by the clone, caught at `snapshot()`.** A system mutating a stored component in
   place — `world.get(e, C).v = 0 / 0`, the most common way a simulation produces `NaN` —
   touches no write boundary and no clone. The clones therefore _preserve_ non-finite values
   rather than laundering them through `JSON.parse(JSON.stringify(…))`, which is what makes
   the guard in `canonicalStringify` reachable from `snapshot()`/`hash()`/`clone()`; those turn
   it into a locating diagnostic naming entity, component and path.

**Explicitly not attempted:** making snapshot→restore preserve a non-finite value.
`JSON.stringify({v: Infinity})` is `'{"v":null}'` by specification, and principle 4 requires the
world to serialise to JSON, so a world that _can_ hold a non-finite value cannot round-trip.
Rejecting at the boundary is what dissolves that contradiction rather than papering over it.
Sentinel-encoding (`{"$nonfinite":"Infinity"}`) was also rejected: it changes the snapshot format
_and_ the hash input, invalidating every stored replay and every pinned `GOLDEN_HASH` — an
enormous blast radius for a value class the engine should never hold.

## Consequences

- **Good:** gameplay code reads naturally (`v.x += speed * dt`); no fixed-point ceremony; the
  lint rules make violations impossible to merge; `sqrt`-based length/normalise stay exact.
- **Cost:** we must implement and test our own transcendentals, and prove they are stable. Proof
  is by _pinned literal_, not by self-comparison: a test that re-runs the same code twice in one
  process proves repeatability, which is much weaker than "on any machine, every time". The
  sfc32 stream, the FNV-1a-64 digest, the `sin`/`cos`/`atan2` tables and the 300-tick canary all
  have checked-in expected values. A diff in one of those is either an approved algorithm change
  — which invalidates every stored replay and every pinned `GOLDEN_HASH` — or a bug. **Never
  regenerate a pinned value to make a test pass.**
- **Constraint for implementers:** never introduce `Math.sin` et al. in a sim package; import from
  `@aegis/core/math`. If a genuinely new non-deterministic need appears, it goes through core.
- **Constraint for implementers:** keep angles inside `SIN_DOMAIN_MAX`. If an angle accumulates
  without bound, wrap it (`wrapAngle`) at the point it is stored, not at the point it is used.
- **Revisit if:** float proves insufficient for a specific subsystem (e.g. very long-running
  physics accumulation); we would then localise fixed-point to that subsystem, not globally.
- **Revisit if:** a mode needs `exp`/`pow`/`log`. Add them to `@aegis/core/math` with pinned
  golden values; do not relax the lint rule.
