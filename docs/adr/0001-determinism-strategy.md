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
2. **Own our transcendentals.** `@aegis/core/math` provides `sin/cos/tan/asin/acos/atan2` (and
   friends) implemented as fixed polynomial/CORDIC approximations that are bit-identical
   everywhere, instead of calling `Math.sin`. Simple, exact ops (`sqrt`, `abs`, `floor`, `min`,
   `max`, `round`) wrap `Math.*` because they are already correctly-rounded.
3. **Ban the ambient sources by lint.** [`eslint.config.js`](../../eslint.config.js) makes it an
   **error** in every simulation package (`core`, `content`, `harness`, `mode-*`) to reference
   `Date`, `performance`, `Math.random`, or any banned transcendental `Math.*` property. Time is
   the integer tick + fixed `dt`; randomness is the seeded PRNG in `core/prng.ts`.

State hashing (`core/hash.ts`) serialises the world through a canonical, key-sorted encoding so
the digest is invariant to object key order.

## Consequences

- **Good:** gameplay code reads naturally (`v.x += speed * dt`); no fixed-point ceremony; the
  lint rules make violations impossible to merge; `sqrt`-based length/normalise stay exact.
- **Cost:** we must implement and test our own transcendentals, and prove they are stable (a
  determinism test re-runs a scene and asserts equal hashes — part of the Definition of Done).
- **Constraint for implementers:** never introduce `Math.sin` et al. in a sim package; import from
  `@aegis/core/math`. If a genuinely new non-deterministic need appears, it goes through core.
- **Revisit if:** float proves insufficient for a specific subsystem (e.g. very long-running
  physics accumulation); we would then localise fixed-point to that subsystem, not globally.
