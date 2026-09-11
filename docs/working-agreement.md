# Working agreement

Rules for every session on this project. The PM enforces these. They exist because up to
four sessions work in parallel, and the failure modes of parallel agentic development are
predictable: interface drift, merge collisions on shared files, and untested code landing
because the thing it depends on wasn't runnable yet.

Read this together with `CHARTER.md` (what we are building, and the nine principles) and
`ENVIRONMENT.md` (corp npm proxy, Windows, Node + TypeScript only).

## 1. Contract ownership

A package's public contract is owned by exactly one session at a time — the one implementing
it. Nobody else edits it.

| Files                                            | Owner                              |
| ------------------------------------------------ | ---------------------------------- |
| `packages/core/**`, `packages/content/**`        | the core session                   |
| `packages/harness/**`, `packages/cli/**`         | the harness session                |
| `packages/mode-<x>/**`                           | that mode's session                |
| `games/<x>/**`                                   | that game's session                |
| `packages/render-three/**`                       | the renderer session               |
| root config, `scripts/`, `docs/adr/`, `.github/` | the PM (or a session the PM names) |

**You may read anything. You may only write files you own.**

If you need a change in a file you do not own — especially a `@aegis/harness` interface —
**do not edit it and do not work around it with a cast or a local re-declaration.** Stop,
report it to the PM with the reason, and keep going on something else. The PM applies the
change centrally so every parallel session gets it at once. A five-minute wait beats a
three-way merge conflict in a load-bearing interface.

**Component ids are scoped to a run, not to the workspace:** a `ComponentRegistry` is built fresh
per `runScene` / `runGameTest`, so a game's component ids need only be unique _within that game_ —
`Player` and `Patrol` are each defined by two different games today, deliberately. Never merge two
games' component sets into one registry; the registry throws on a genuine id conflict, and that
throw is a feature, not an obstacle to route around.

## 2. Never ship untestable code

You must be able to _run_ what you build. If the thing you depend on is only a stub, say so
immediately rather than writing a large body of code that has never executed.

This is why the early waves are deliberately serial: `core` must really work before the
harness is built on it, and `runScene` must really work before three mode sessions and three
game sessions build on it. Every session after wave 2 inherits a base it can actually execute.

## 3. The gate

Before you hand back, this must pass from the repo root:

```
npm run verify
```

which runs build + **type-check of every test file** + test + lint + dependency-boundary check.
"It works on my package" is not the gate; the whole workspace is the gate. If you broke something
you don't own, that is still your problem to report.

The test type-check step (`npm run typecheck:tests`, `tsconfig.tests.json`) exists because every
`packages/*/tsconfig.json` excludes `*.test.ts` from the build, vitest transpiles without
type-checking, and eslint is not type-aware — so for a long time `npm run verify` never
type-checked a single test file. A test fixture could silently drift out of contract with the type
it claims to exercise, and one had: `packages/mode-fps/src/systems.test.ts` built `InputFrame`s
missing `released` and `pointer` from the day it was written. Tests are code; they get checked.

`.github/workflows/ci.yml` runs this gate on pushes and pull requests for both Windows and
Ubuntu. The audited browser phase runs on Ubuntu CI and locally on Windows, but is explicitly
omitted on hosted Windows as documented in ADR-0010. A green Windows CI job alone is not browser
acceptance. Keep the workflow, local command and reported omissions aligned.

## 4. Determinism is not negotiable

Principle 3 in the charter. Concretely:

- No `Date.now()`, `performance.now()`, `Math.random()`, or `Math.sin`/`cos`/`tan`/`atan2`
  etc. in any simulation package **or in `games/*`** — including their tests. ESLint enforces
  this as an **error**; do not add an eslint-disable to get around it. Use `@aegis/core/math`.
  (`games/*` was outside the rule's `files` glob until it was extended; game code is where the
  AI, patrols, damage and win conditions live, so it is exactly the code whose non-determinism
  would corrupt a golden hash.)
- No iteration over unordered structures where order affects results.
- No wall-clock time in gameplay. Time is ticks.

If determinism forces you into an awkward design, take the awkward design.

## 5. Branch and handoff

- One branch per session. Commit in logical increments with real messages.
- Do not merge to `main` yourself. The PM reviews, verifies and merges.
- When you finish, reply to the PM with: what you built, **what you verified and how**,
  decisions you made that others must know about, anything you deferred, and any contract
  you are unsure about. Be specific about uncertainty — a flagged risk is cheap, a silent
  wrong assumption is expensive.

## 6. Scope discipline

Build what your brief asks for. If you spot something else broken, report it — don't
opportunistically fix it in your branch, because that is how two sessions end up editing the
same file. Charter anti-goals (no GUI editor, no graphics arms race) apply to everyone.
