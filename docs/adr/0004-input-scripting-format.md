# ADR-0004: Input-scripting format

- **Status:** Accepted
- **Principle:** CHARTER §3.5 — "Input is a script."

## Context

An agent has no keyboard, so input must be authorable and readable as text, and a recorded
session must round-trip back to that same readable text (principle 5). The format has to cover all
three modes: d-pad-style digital actions and analog axes (platformer), **3D mouse-look**
(fps), and **click-to-move** pointer events on a grid (iso) — not just button presses. It must
diff cleanly and be robust to reordering.

Two shapes were considered: a raw per-tick frame array (`[{tick, actions, ...}]`) — precise but
unreadable and enormous — and a **line-oriented DSL** addressing ticks absolutely.

## Decision

**A small line-oriented DSL that compiles to one `InputFrame` per tick.** Grammar
(`harness/input-script.ts`):

```text
# comments start with '#'
hold    <Action> <a>..<b>       # hold a digital action across tick range [a, b)
press   <Action> @<t>           # edge-press for exactly tick t
release <Action> @<t>           # release at tick t
axis    <Name> <value> <a>..<b> # analog axis (e.g. -1..1) across [a, b)
look    <dyaw> <dpitch> @<t>    # relative mouse-look delta in degrees            [fps]
look    <dyaw> <dpitch> <a>..<b># spread the delta evenly across [a, b)           [fps]
aim     <yaw> <pitch> @<t>      # absolute look target, compiled to look deltas   [fps]
click   <x>,<y> @<t>            # primary pointer click at world/grid (x, y)      [iso]
point   <x>,<y> @<t>            # pointer move without a click                    [iso]
```

- **Ranges `a..b` are half-open** (include `a`, exclude `b`); `@t` is the single tick `t`
  (`{start: t, end: t+1}`). Half-open ranges compose without off-by-one overlap.
- **Ticks are absolute**, so lines reorder and diff independently — an agent can insert
  `press Jump @88` without renumbering anything else.
- The parser produces a validated `InputScript` (command AST + a `frames(totalTicks)` compiler).
  **Edge sets (`pressed`/`released`) are derived by diffing the held-action set between
  consecutive ticks**, so `hold` implies a `pressed` on its first tick and a `released` after its
  last — the author never hand-maintains edges.
- **Division of ownership:** `@aegis/core` owns the _logical_ `InputFrame` model
  (`actions`, `pressed`, `released`, `axes`, `look`, `pointer` — never hardware key codes);
  `@aegis/harness` owns the parser, the compiler, and record/replay (ADR-... replay).
- `formatInputScript` renders a script back to canonical text, so a recording _is_ a readable
  script.

## Consequences

- **Good:** input is legible ("run right, jump at 88"), diffable, reorderable; one format spans
  all three modes including mouse-look and click-to-move; recordings are human-readable.
- **Cost:** a hand-written parser and canonical formatter to build and test; mapping analog/look
  semantics per mode is a mode-side concern (the `input` phase system interprets the frame).
- **Constraint for implementers:** never put hardware key codes in the `InputFrame` — actions are
  logical names bound elsewhere; the frame is the mode's only input each tick (ADR-0001).
