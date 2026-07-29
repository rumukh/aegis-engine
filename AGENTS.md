# AGENTS.md — building a game in Aegis

> You are a coding agent. You have no hands, no eyes and no GPU. This document is how you
> author, run, observe, debug and prove a game in Aegis using nothing but text.
>
> Read [`CHARTER.md`](./CHARTER.md) for _why_ the engine is shaped this way and
> [`docs/architecture.md`](./docs/architecture.md) for _how_ it is put together. This file is
> the operating manual: the loop, end to end, with the traps marked.

**Every command and every output block in this guide is supposed to have been executed against this
repository**, at `main` = `ffa3f1a`, and nearly all of them were. Two claims were not, and running
them at `e0c1917` is how that was discovered: `holds` was said to report nothing but its label, and
`aegis test` was said to glob `dist/*.gametest.{js,mjs,cjs}`. Neither had been true since `de6b7d9`
and `b8759ba` respectively — **both ancestors of the revision named above.** The first appeared in
three places: a row in [§9](#9-known-rough-edges), a row in
[§6.7](#67-assertion-reference), and a transcript in §6.7 showing a failure message the harness no
longer emits. All are corrected below against measured output.

That is this document's own lesson about propagation channels, arriving unannounced in the document
itself, and it is worth more than the corrections: **one claim, checked by reading rather than
running, reproduced itself into three places and survived every reading of the file.** Where
something does not work, this guide says so instead of showing what it ought to do — but "was
executed" is a claim about a revision, not a property of prose. Re-measure rather than trust,
including here.

Transcripts beginning `$ node .tmp/…` came from throwaway probe scripts written to a scratch
directory while this guide was being checked; they are not files in the repository. Where the
probe is worth reproducing, its source is inline in the surrounding section.

**What this guide does not cover.** Rendering and the browser dev server (`@aegis/render-three`) —
you never need them to build or verify a game. Prefabs, beyond noting that they exist and that
`AEG-CONTENT-0006` reports a bad reference. Authoring scenes through the typed
`createSceneBuilder` API rather than JSON. Writing a new **mode** (as opposed to a game on top of
an existing one) — see [ADR-0006](./docs/adr/0006-mode-module-boundary.md). Multiplayer,
networking and save games, which the engine does not have. If you need one of these, read the
package source; it is short and heavily commented.

---

## Contents

1. [Orientation](#1-orientation)
2. [Authoring content as data](#2-authoring-content-as-data)
3. [The composed-plugin pattern](#3-the-composed-plugin-pattern)
4. [Input is a script](#4-input-is-a-script)
5. [Running and observing headlessly](#5-running-and-observing-headlessly)
6. [Writing a game test that can actually fail](#6-writing-a-game-test-that-can-actually-fail)
7. [Debugging without pixels](#7-debugging-without-pixels)
8. [The loop, end to end](#8-the-loop-end-to-end)
9. [Known rough edges](#9-known-rough-edges)

---

## 1. Orientation

### 1.1 What Aegis is

A TypeScript monorepo containing a **deterministic ECS simulation library**, three **modes**
(`platformer`, `iso`, `fps`), a **test harness**, a **CLI**, and an optional three.js renderer
nobody needs in order to build or verify a game.

Four properties define everything else:

| Property                  | What it means for you                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Text is the substrate** | Scenes, tilemaps and input are JSON and plain-text files you can read, diff and write.                                        |
| **Headless-first**        | The whole simulation runs in Node with no window. Rendering is an adapter that reads the world and never writes to it.        |
| **Deterministic**         | Fixed timestep, seeded PRNG, no wall clock, no `Math.random`, stable iteration order. Same scene + script + seed → same hash. |
| **Verified by assertion** | You prove a game works by running it and asserting on world state and events — never by looking at it.                        |

### 1.2 What you can and cannot do

Be honest with yourself about this table before planning any work.

| You want to…                              | Can you? | How                                                                                                     |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| Author a level                            | Yes      | Write a `*.scene.json` with an inline ASCII tilemap                                                     |
| Schema-check content before running       | Yes      | `aegis validate` → stable `AEG-CONTENT-nnnn` codes                                                      |
| Drive a game without a keyboard           | Yes      | The input-script DSL (`hold`, `press`, `click`, `aim`, …)                                               |
| Watch the world at any tick               | Yes      | `aegis inspect --view world` — the entire world serialises to JSON                                      |
| "See" a 2D level                          | Yes      | `aegis inspect --view ascii` — a character grid with a legend                                           |
| "See" a 3D scene                          | Partly   | The semantic frame: projected screen positions, depth, occlusion. No pixels.                            |
| Prove a playthrough completes             | Yes      | `defineGameTest` + `expectSim` + `assertInvariant`                                                      |
| Reproduce a run exactly                   | Yes      | `aegis record` / `aegis replay`; hashes are byte-identical across runs                                  |
| Run a **game's own** systems from the CLI | Yes      | `aegis.json` beside the scene, or `--plugin <module>#<export>` ([§3.4](#34-how-a-plugin-reaches-a-run)) |
| Judge whether a jump "feels good"         | **No**   | Nothing in this engine gives you feel. Assert on measurable beats instead.                              |

### 1.3 The package graph

Eight packages, a strict DAG, enforced mechanically by
[`scripts/check-deps.mjs`](./scripts/check-deps.mjs) at both the `package.json` and the
`import`-statement level.

```
core ──▶ (nothing)
content ──▶ core
harness ──▶ core, content
mode-platformer | mode-iso | mode-fps ──▶ core, content, harness
render-three ──▶ core, content, harness, mode-*
cli ──▶ everything
```

Three rules explain the shape, and you will hit all three:

1. **`core` depends on nothing.** No runtime deps, no DOM, no Node built-ins on its public
   path. This is what makes the engine embeddable and testable in a bare V8.
2. **Rendering points inward.** `render-three` reads the world; the world never imports
   rendering. You never need the renderer to finish a game.
3. **Modes never depend on each other, and the harness never depends on a concrete mode.** A
   mode plugs into the harness through the `ModePlugin` interface. This is why _your game_
   must also be a `ModePlugin` — there is no second injection path ([§3](#3-the-composed-plugin-pattern)).

Package ownership is real and enforced socially: see
[`docs/working-agreement.md`](./docs/working-agreement.md) §1. **You may read anything; you
may only write files you own.** If you need a change in `@aegis/harness`, report it — do not
route around it with a cast or a local re-declaration.

### 1.4 The one real gate

```
npm run verify
```

That is `build` → `typecheck:tests` → `test` → `lint` (eslint + dependency boundaries +
prettier) over the **whole workspace**. Not your package — the workspace. `npm run verify` is the
gate, and `.github/workflows/ci.yml` now runs it on every push, on `windows-latest` and
`ubuntu-latest`. Measured on the first runs: ubuntu 2m15s green; windows 11m, and on windows the
browser tests in `packages/render-three` are **not yet passing** — see [§9](#9-known-rough-edges).

`npm run test` does not invoke Vitest directly. It runs `scripts/run-tests.mjs`, which deletes the
previous run's report, runs Vitest, and then refuses the run unless Vitest's own JSON report shows
it happened: no failures, **no skipped tests** (this repo declares none, so a skip means a hook
died and took its file's cases with it), and a floor on how much of the corpus ran. That wrapper
exists because CI was measured reporting green twice on a suite whose browser tests had failed or
been skipped — the exit code alone was not enough to tell a passing run from an absent one.

Vitest runs over `packages/*/{src,test}/**/*.test.ts` and
`games/*/{src,test}/**/*.test.ts`. `aegis test` is a second, independent runner over the same
specs, discovering compiled `*.gametest.{js,mjs,cjs}` modules
([§6.6](#66-the-template)). Both should be green; they fail differently, and the one you reach for
depends on whether you are debugging the game or the gate.

### 1.5 Setup

Node 24 / npm 11, Windows, corporate npm proxy pinned in `.npmrc`. Read
[`ENVIRONMENT.md`](./ENVIRONMENT.md) before touching dependencies.

If you add or change a dependency, run `node scripts/canonicalise-lockfile.mjs --write` afterwards.
`npm install` behind the proxy silently rewrites the lockfile's `resolved` URLs to internal hosts,
which still works on this machine and cannot be installed anywhere else. The gate catches it, but
only after you have wondered why.

```
npm install
npm run build
```

One install, not two. `@aegis/cli` declares `bin: { aegis: "bin/aegis.mjs" }`, and that file is
committed — so npm links `node_modules/.bin/aegis` during install, before anything is built. Run a
command before the build and it tells you so:

```
$ npx aegis --help
[aegis] this checkout has no build yet: …\packages\cli\dist\main.js does not exist.
Run `npm run build` from the repository root (`npm run verify` builds before it tests).
$ echo $LASTEXITCODE
69
```

Earlier revisions pointed `bin` straight at `dist/main.js`, which npm could not link on a clean
clone because the target did not exist yet; `npx aegis` then died with `could not determine
executable to run`, a message naming neither this package nor the build, and the documented
workaround was to run `npm install` a second time. If you are reading that instruction anywhere,
it is stale.

Verify the CLI is live:

```
$ npx aegis --help
aegis — the agent-first, headless game engine CLI

Usage: aegis <command> [options]

Commands:
  run       Simulate a scene headlessly for a number of ticks.
  test      Discover and run headless gameplay tests.
  inspect   Inspect world, semantic frame or ASCII view at a tick.
  validate  Validate a scene/prefab/tilemap document.
  record    Run a scene and write a replay recording.
  replay    Replay a recording and verify determinism.
  scaffold  Generate a game, scene, tilemap, prefab or test from a template.

Run 'aegis <command> --help' for command-specific usage.
Add --json to most commands for machine-readable output.
```

---

## 2. Authoring content as data

### 2.1 The running example

Everything from here to [§6](#6-writing-a-game-test-that-can-actually-fail) uses one tiny game,
**Ledge Hop**: run right, jump a three-tile gap, land on the far ledge. It uses only stock
`platformer` components, which means the whole CLI works on it — that will matter in
[§3.4](#34-how-a-plugin-reaches-a-run).

Create `ledge-hop/ledge-hop.scene.json` at the repo root, exactly as follows.

<!-- template-exempt: authored for this guide — Ledge Hop has no file in the repository (see §9) -->

```json
{
  "aegis": "scene/1",
  "name": "Ledge Hop",
  "mode": "platformer",
  "seed": "ledge-hop",
  "resources": {
    "platformer.tilemap": {
      "aegis": "tilemap/1",
      "name": "ledge-hop",
      "width": 24,
      "height": 8,
      "tileSize": 1,
      "legend": {
        "#": { "solid": true, "sprite": "ground" }
      },
      "layers": [
        {
          "name": "collision",
          "data": [
            "........................",
            "........................",
            "........................",
            "........................",
            "........................",
            "........................",
            "##########...###########",
            "##########...###########"
          ]
        }
      ]
    }
  },
  "entities": [
    {
      "id": "player",
      "tags": ["Player"],
      "components": {
        "Transform": { "position": { "x": 2.5, "y": 2.5, "z": 0 } },
        "Velocity": {},
        "PlatformerController": {},
        "BodyState": {},
        "TileCollider": { "halfWidth": 0.4, "halfHeight": 0.5 }
      }
    },
    {
      "id": "camera",
      "components": {
        "Transform": { "position": { "x": 2.5, "y": 3, "z": 10 } },
        "PlatformerCamera": { "target": "player", "viewHeight": 10 }
      }
    }
  ]
}
```

A real, shipped game lives in `games/<name>/` next to the three PoCs, with `levels/`, `play/`,
`src/` and `test/` directories and a workspace `package.json`. The repo root is used here only
so the tutorial cannot collide with anyone's package.

It also needs an `aegis.json` beside it, or the CLI will refuse to run it
([§3.4](#34-how-a-plugin-reaches-a-run)). Ledge Hop uses only stock components, so the stock
plugin is the honest answer — `ledge-hop/aegis.json`:

<!-- template-exempt: authored for this guide — Ledge Hop has no file in the repository (see §9) -->

```json
{
  "plugin": "platformer",
  "tests": ["./*.gametest.mjs"]
}
```

`aegis scaffold game` writes that file for you; this one is hand-written because the scene is.

### 2.2 Scene anatomy

| Field       | Meaning                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `aegis`     | Schema discriminator. `"scene/1"`, `"prefab/1"` or `"tilemap/1"`. Required.                      |
| `mode`      | `platformer` \| `iso` \| `fps`. Selects the stock component set the document is checked against. |
| `seed`      | PRNG seed. Number or string. Part of the determinism contract — change it, change the hash.      |
| `resources` | World-level singletons, keyed by resource id. This is where a tilemap goes.                      |
| `entities`  | A list of `{ id, tags?, prefab?, components? }`. `id` becomes the entity's `Name`.               |

`tileSize` is `1`, **world Y increases upward**, and a tile at grid `(col, row)` — row 0 at the
top — occupies `x ∈ [col, col+1]`, `y ∈ [H-1-row, H-row]`. So in Ledge Hop the bottom two rows
are ground at `y ∈ [0, 2]`, the gap is columns 10–12, and the player starts standing at
`y = 2.5` (feet at 2.0, on top of the ground).

### 2.3 Trap: the tilemap must be **inline**

There is **no scene → tilemap-file reference** in the format. A mode reads its tilemap from a
scene _resource_ under a mode-specific key:

| Mode         | Resource key         |
| ------------ | -------------------- |
| `platformer` | `platformer.tilemap` |
| `iso`        | `IsoGrid`            |
| `fps`        | `fps.floorplan`      |

A standalone `*.tilemap.json` file is a fragment you paste in, a document `aegis validate` can
check on its own, and a thing the renderer and tests may cross-check — but nothing loads it into
a run. `aegis scaffold game` writes one anyway and does not wire it up ([§9](#9-known-rough-edges)),
which is exactly why a scaffolded platformer scene has no ground and no ASCII view.

### 2.4 Discovering the component vocabulary

Do not guess component ids. Ask the validator: hand it a document with a component id that
cannot exist, and the JSON diagnostic lists every id registered for that mode.

```
$ npx aegis validate .tmp/probe.scene.json --json
{"files":[{"diagnostics":[{"code":"AEG-CONTENT-0005","data":{"component":"?","known":["AttackOrder","Attacker","Blocking","Controlled","Dead","GridPosition","Health","IsoActor","IsoCamera","Light","Model","MoveOrder","Name","Sprite","Transform","Trigger","Triggered"]},"fix":"Register the component type, or fix the component id.","location":{"path":"entities[0].components.?"},"message":"Entity \"x\" uses unknown component \"?\"","severity":"error"}],"file":".tmp/probe.scene.json","ok":false}],"ok":false,"strict":false}
```

(`.tmp/probe.scene.json` was
`{ "aegis": "scene/1", "name": "probe", "mode": "iso", "entities": [{ "id": "x", "components": { "?": {} } }] }`.)

The three vocabularies, obtained exactly that way:

| Mode         | Registered component ids                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| _all modes_  | `Transform`, `Name`, `Sprite`, `Model`, `Light`, `Health`, `Dead`, `Trigger`, `Triggered`                       |
| `platformer` | …plus `Velocity`, `PlatformerController`, `BodyState`, `TileCollider`, `PlatformerCamera`, `KinematicPlatform`  |
| `iso`        | …plus `GridPosition`, `IsoActor`, `MoveOrder`, `AttackOrder`, `Attacker`, `Controlled`, `Blocking`, `IsoCamera` |
| `fps`        | …plus `CapsuleBody`, `FpsController`, `LookState`, `FpsCamera`, `Hitscan`, `HitBox`                             |

Your game adds its own on top, through its plugin ([§3](#3-the-composed-plugin-pattern)).

### 2.5 Trap: `tags` are permissive, `components` are strict

<!-- template-exempt: sketch — an entity fragment illustrating the tags/components trap -->

```json
{
  "id": "player",
  "tags": ["Player"],
  "components": { "TileCollider": { "halfWidth": 0.4 } }
}
```

- An id in **`components`** must be registered. If it is not, you get `AEG-CONTENT-0005` and the
  document is rejected.
- An id in **`tags`** is looked up in the registry and, _if missing, silently synthesised_ as a
  fresh zero-data marker component.

That second rule is convenient and dangerous. A typo in a tag validates clean, spawns a marker
nobody queries, and your `has: ['Player']` query silently matches nothing:

```
$ npx aegis validate .tmp/typo.scene.json
ok .tmp/typo.scene.json: no problems found

$ npx aegis inspect .tmp/typo.scene.json --tick 5 --query "has:Player"
scene : .tmp/typo.scene.json
mode  : platformer
tick  : 5
seed  : ledge-hop
hash  : e9932a2931efc6f9
query: has:[Player]
entities: 0 of 2
```

(`.tmp/typo.scene.json` is the Ledge Hop scene with `"Player"` misspelled `"Playre"`.)

There is no diagnostic — only `entities: 0 of 2`. When a query unexpectedly returns nothing, dump
the world unfiltered ([§7.1](#71-the-triage-ladder)) and read the component ids that actually
landed on the entity.

### 2.6 Diagnostics

Every content problem is a `Diagnostic { code, severity, message, location, fix?, data? }` with a
**stable code**. Branch on `code`; the message is for humans.

| Code               | Meaning                                               |
| ------------------ | ----------------------------------------------------- |
| `AEG-CONTENT-0001` | Not valid JSON                                        |
| `AEG-CONTENT-0002` | Missing/unknown `aegis` discriminator                 |
| `AEG-CONTENT-0003` | Required field missing                                |
| `AEG-CONTENT-0004` | Field has the wrong type                              |
| `AEG-CONTENT-0005` | Unknown component id                                  |
| `AEG-CONTENT-0006` | Unresolvable prefab reference                         |
| `AEG-CONTENT-0007` | Duplicate entity/prefab id                            |
| `AEG-CONTENT-0008` | Component data failed the component's own shape check |
| `AEG-CONTENT-0009` | Tilemap rows inconsistent with declared width/height  |
| `AEG-CONTENT-0010` | Tilemap cell uses an undefined legend key             |
| `AEG-CONTENT-0011` | `mode` is not a supported game mode                   |

A real run against a deliberately broken document — a duplicate entity id, a string where a number
belongs, and a misspelled component:

```
$ npx aegis validate .tmp/broken.scene.json
error AEG-CONTENT-0007 at entities[1]: Duplicate entity id "player".
  fix: Give each entity a unique id within the document.
error AEG-CONTENT-0004 at entities[0].components.Transform.position.x: Component "Transform" field "position.x" must be a finite number, but "2.5" (string) was authored.
  fix: Author "position.x" as a finite number, e.g. 0 (the default).
error AEG-CONTENT-0005 at entities[0].components.PlatformerControler: Entity "player" uses unknown component "PlatformerControler" - did you mean "PlatformerController"?
  fix: Rename "PlatformerControler" to "PlatformerController", or register the component type.
-- 3 error(s), 0 warning(s), 0 info in .tmp/broken.scene.json
```

Three things worth noticing, because they are what makes this surface usable without a human:
every problem is reported in one pass rather than one-at-a-time; the location is a **path into the
document** (`entities[0].components.Transform.position.x`), not a line number; and near-miss
component ids get a suggestion. Exit code is `2` for content problems (distinct from `1` for a
failed run), so a script can tell "your content is wrong" from "your game is wrong".

### 2.7 Validate before you run

```
$ npx aegis validate ledge-hop/ledge-hop.scene.json
ok ledge-hop/ledge-hop.scene.json: no problems found
```

Validation runs before instantiation everywhere — `parseScene` → `validateScene` →
`instantiateScene`. A scene that fails validation never reaches the world, so `aegis run` will
print the same diagnostics and refuse.

---

## 3. The composed-plugin pattern

This is the part that is easy to get wrong, and getting it wrong looks like "my systems never
run".

### 3.1 A game is a `ModePlugin`

The harness composes a run's schedule **only** from `plugin.systems()`. There is no
`extraSystems` option, no registration hook, no second injection path. So a game that has its own
systems must ship its own `ModePlugin`: the stock mode plugin with the game's components and
systems folded in.

<!-- template-exempt: contract summary of packages/harness/src/plugin.ts, re-annotated; an interface declaration is read, not copied into a game -->

```ts
interface ModePlugin {
  readonly mode: GameMode; // 'platformer' | 'iso' | 'fps'
  components(): readonly ComponentType<unknown>[]; // registered before the scene loads
  init?(world: World): void; // per-run setup, before tick 0
  systems(): Schedule; // the ordered per-tick pipeline
  view(): ViewProvider; // semantic frame + ASCII view
}
```

The shipped platformer PoC, [`games/platformer/src/plugin.ts`](./games/platformer/src/plugin.ts),
is the canonical shape. It reuses the mode's `init` and `view` verbatim and only enriches the
component set and the schedule:

<!-- template-source: games/platformer/src/plugin.ts #file -->

```ts
import { createSchedule } from '@aegis/core';
import type { GameMode, Schedule, World } from '@aegis/core';
import { healthSystem } from '@aegis/content';
import type { ModePlugin, ViewProvider } from '@aegis/harness';
import {
  platformerInit,
  platformerView,
  PLATFORMER_COMPONENTS,
  PLATFORMER_SYSTEM_LIST,
} from '@aegis/mode-platformer';
import { COYOTE_GAP_COMPONENTS } from './components.js';
import { COYOTE_GAP_GAME_SYSTEMS } from './systems.js';

export function coyoteGapSchedule(): Schedule {
  return createSchedule().addAll([
    ...PLATFORMER_SYSTEM_LIST,
    healthSystem,
    ...COYOTE_GAP_GAME_SYSTEMS,
  ]);
}

export const coyoteGapPlugin: ModePlugin = {
  mode: 'platformer' as GameMode,
  components: () => [...PLATFORMER_COMPONENTS, ...COYOTE_GAP_COMPONENTS],
  init: (world: World): void => platformerInit(world),
  systems: () => coyoteGapSchedule(),
  view: (): ViewProvider => platformerView(),
};
```

Rules that follow from this:

- **Keep `mode` as the stock mode's name.** It selects the coordinate conventions, the ASCII
  legend and the renderer. It is not a namespace for your game.
- **Always spread the mode's systems first**, then content systems, then yours. Ordering inside a
  phase is resolved topologically from each system's `before`/`after` names, so declare those on
  your own systems rather than relying on array position.
- **Do not forget `init`.** It bakes the tilemap into a collision grid (platformer), the nav grid
  (iso), the extruded floorplan (fps). Omit it and everything falls through the floor.
- **Emit game vocabulary from game systems.** The mode emits mechanical facts
  (`player.jumped`, `player.landed`, `platform.boarded`, `trigger.entered`, `entity.died`); your
  systems translate those into `level.completed`, `enemy.killed`, `player.died`. Your assertions
  read the game vocabulary; that is what makes a failure message say what broke.

### 3.2 The registry is built per run, and that is the point

`runScene` builds a fresh `ComponentRegistry` for every run from core + content + `plugin.components()`.
Component ids therefore only need to be unique **within one game**.

Today two ids are deliberately defined twice across the PoCs:

| Id       | `games/platformer`                                | `games/iso`       | `games/fps`          |
| -------- | ------------------------------------------------- | ----------------- | -------------------- |
| `Player` | tag                                               | —                 | tag (different type) |
| `Patrol` | **data** component `{ minX, maxX, speed, phase }` | **zero-data tag** | —                    |

### 3.3 Merging two games' component sets throws — do not route around it

```
$ node .tmp/registry-probe.mjs
[aegis] ComponentRegistry: id "Patrol" is already registered to a different component type
```

That probe did exactly one thing:

<!-- template-exempt: sketch — the single line a throwaway probe ran -->

```js
createRegistry().registerAll([...COYOTE_GAP_COMPONENTS, ...ISO_GAME_COMPONENTS]);
```

The throw is a **feature**. Two different shapes claiming one id is a real ambiguity: iso's
`Patrol` carries no data, the platformer's carries four numbers, and a scene authored for one
would be silently mis-instantiated by the other. If you hit this error you have built one
registry for two games. Build one per game. Never rename a component to dodge it, and never
`delete`/re-register to force it through.

### 3.4 How a plugin reaches a run

Your plugin is a JavaScript value. Three things need to get hold of it, and each has its own door.

| Door                                                       | How the plugin arrives                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `runScene(scene, { plugin, … })` — a test or a script      | You pass the value directly                                          |
| `defineGameTest({ options: { plugin } })` + `aegis test`   | The value rides inside the literal, or is named as a string          |
| `aegis run` / `inspect` / `validate` / `record` / `replay` | Named as a **string** the CLI imports — this is what `aegis.json` is |

The CLI resolves a plugin three ways, in precedence order:

1. **`--plugin <module>#<export>`** — explicit, dynamically imported.
2. **`aegis.json`** next to (or above) the scene: `{ "plugin": "<module>#<export>" }`.
3. **Nothing** — the stock plugin for the scene's `mode`.

Declare it once and every command picks it up. `games/platformer/aegis.json` in full:

<!-- template-source: games/platformer/aegis.json #file -->

```json
{
  "plugin": "@aegis/game-platformer#coyoteGapPlugin",
  "tests": ["./dist/*.gametest.js"]
}
```

With that beside the scene, the CLI drives the real game — and **says which plugin it used and how
many systems that installed**, so you can never be quietly running something else:

```
$ npx aegis run games/iso/levels/server-vault.scene.json --ticks 960 --input games/iso/play/server-vault.input
scene    : games/iso/levels/server-vault.scene.json
mode     : iso
plugin   : @aegis/game-iso#serverVaultPlugin (aegis.json: …/games/iso/aegis.json)
systems  : 12
ticks    : 960
seed     : poc-iso
hash     : cb0f07007ad8608a
entities : 6
events:
  cell.entered ×27
  move.ordered ×6
  path.resolved ×5
  attack.fired ×4
  damage.taken ×2
  enemy.damaged ×2
  trigger.entered ×2
  attack.ordered ×1
  door.opened ×1
  enemy.killed ×1
  entity.died ×1
  guard.alerted ×1
  mission.completed ×1
  path.blocked ×1
  switch.activated ×1
```

The `--plugin` flag overrides it and reports its own provenance (`(--plugin)` instead of the
config path), which is what you want for a one-off:

```
$ npx aegis run games/platformer/levels/coyote-gap.scene.json --ticks 400 --input games/platformer/play/coyote-gap.input --plugin '@aegis/game-platformer#coyoteGapPlugin'
scene    : games/platformer/levels/coyote-gap.scene.json
mode     : platformer
plugin   : @aegis/game-platformer#coyoteGapPlugin (--plugin)
systems  : 11
ticks    : 400
seed     : poc-platformer
hash     : d813e4e19db7444d
entities : 7
```

#### The refusal is the important part

Forget to name a plugin and the CLI **stops**, rather than running the bare mode and exiting `0`:

```
$ npx aegis inspect ledge-hop/ledge-hop.scene.json --tick 5 --query "has:Player"
error [AEG-CLI-0020]: Refusing to run "ledge-hop/ledge-hop.scene.json": no plugin was named for it, and it declares 1 marker(s) the default "platformer" mode plugin does not provide: Player.
  fix: No registered system reads those markers, so this run would exercise the "platformer" mode alone and still exit 0 — the exact silent failure this check exists to prevent. Name the plugin: --plugin <module>#<export> (e.g. --plugin @aegis/game-platformer#myGamePlugin), or declare it once beside the scene in aegis.json: { "plugin": "@aegis/game-platformer#myGamePlugin" } — `aegis scaffold game` writes that file for you. If the stock "platformer" mode genuinely is what you want, say so with { "plugin": "platformer" } and the markers become yours to consume.
```

Read that error as the shape of a good diagnostic, not just an obstacle. The failure it prevents —
a run that completes, hashes and exits `0` while the entire semantic layer never executed — is
invisible by construction, so the tool refuses rather than guessing. If the stock mode really is
what you want, saying `{ "plugin": "platformer" }` is an explicit answer, not a workaround.

---

## 4. Input is a script

You have no keyboard. Input is a text file compiled to one `InputFrame` per tick.

### 4.1 Grammar

```text
# comments start with '#'
hold    <Action> <a>..<b>        # hold a digital action across tick range [a, b)
press   <Action> @<t>            # edge-press for exactly tick t
release <Action> @<t>            # release at tick t
axis    <Name> <value> <a>..<b>  # analog axis (e.g. -1..1) across [a, b)
look    <dyaw> <dpitch> @<t>     # relative mouse-look delta, degrees            [fps]
look    <dyaw> <dpitch> <a>..<b> # same delta spread evenly across [a, b)        [fps]
aim     <yaw> <pitch> @<t>       # absolute look target, compiled to deltas      [fps]
click   <x>,<y> @<t>             # primary pointer click at world/grid (x, y)    [iso]
point   <x>,<y> @<t>             # pointer move without a click                  [iso]
```

Two properties do all the work:

- **Ranges `a..b` are half-open** — include `a`, exclude `b`. So `hold Right 0..40` and
  `hold Right 40..80` compose with no overlap and no off-by-one.
- **Ticks are absolute.** `@88` means tick 88 forever, regardless of what other lines exist.

You never hand-maintain edges. `pressed`/`released` are _derived_ by diffing the held-action set
between consecutive ticks, so a `hold` implies a `pressed` on its first tick and a `released` on
the tick after its last.

### 4.2 Absolute ticks mean lines reorder freely

This is worth internalising because it is what makes an input script diffable: you can insert one
`press Jump @88` line anywhere without renumbering anything. Measured, on the shipped platformer
PoC — its inline script and its `play/coyote-gap.input` file contain the same commands in
different orders:

```
$ node .tmp/order-probe.mjs
inline script      hash=d813e4e19db7444d
play/*.input file  hash=d813e4e19db7444d
identical: true
```

### 4.3 What each mode expects

Real excerpts from the three shipped playthroughs.

**platformer** — digital actions only (`games/platformer/play/coyote-gap.input`):

```text
press Jump @28          # beat 2: clear the spike pit onto the plateau
press Jump @74          # beat 3: stomp the critter from above -> enemy.killed + bounce

hold Right 0..126       # beats 1-3: run to the lip of the lava gap, then STOP on solid ground
hold Right 138..152     # beat 4a: the ferry has docked left -> step aboard (platform.boarded)
                        # beat 4b: ticks 152..189 Right is UN-HELD -- we stand still and the
                        #          ferry carries us across the lava (x rises with no input)
hold Right 190..400     # beat 4c: ferry has reached the right dock -> walk off onto the ledge,
                        #          then keep running toward the coyote gap
```

Note the deliberate **gap** in the hold. Not holding a key is an authored beat; that script is
what proves the moving platform actually carries the player.

**iso** — pointer clicks on grid cells (`games/iso/play/server-vault.input`):

```text
click 1,5 @40     # hold the spawn first: at (1,1) the guard can never see us (Chebyshev >= 4),
                  # so the clockwork patrol really walks. Then descend the winding left column.
click 7,5 @102    # chase it up the corridor. It has swept (1,5) -> (9,5) — eight legs — before it
                  # turns and spots us at t178, and it freezes on (9,5) the moment it does.
click 9,5 @195    # attack-move: we let it fire first (t178, t218) and kill it at t225 with two
                  # shots -> enemy.killed, damage.taken x2, Health 20.
click 9,1 @232    # head for the security switch: cross to the col-7 shaft and climb toward (9,1).
click 4,7 @300    # try the vault while still climbing the col-9 shaft: the door is sealed, so the
                  # pathfinder honestly reports path.blocked and drops the in-flight order.
click 9,1 @308    # resume to the security switch; reaching (9,1) at t330 unseals the vault door.
click 4,7 @340    # the same target now resolves against the mutated grid -> mission.completed t505
```

Read that script as a specification of the _playthrough_, not just the input. Every comment names
a beat and a tick, and the beats are chosen so the run cannot succeed by accident — it holds the
spawn so the patrol actually walks, and it clicks the vault once while the door is still sealed so
the blocked-path branch is exercised. [§7.2](#72-when-a-golden-moves) explains why that matters
more than it looks.

**fps** — absolute aim plus analog movement (`games/fps/play/sector-breach.input`):

```text
# 1. Face the east wall panel and shoot it to open the blast door.
aim 90 0 @8
press Fire @20

# 2. Face north (into the facility) and advance out of the start room.
aim 0 0 @32
axis Forward 1 40..124

# 3. Leap the coolant pit — take off just before its south lip.
press Jump @124
axis Forward 1 124..170
```

Prefer `aim` over `look` when you know where you want to point: `aim` is absolute and survives
edits to earlier lines, `look` accumulates deltas and does not.

### 4.4 Ledge Hop's script

Create `ledge-hop/play.input`:

```text
# Ledge Hop — run right, hop the gap.
hold Right 0..120
press Jump @48
```

Action names (`Right`, `Jump`, `Fire`, `Forward`) are **logical** — never key codes. Each mode's
`input`-phase system decides what they mean.

---

## 5. Running and observing headlessly

### 5.1 The CLI surface

| Command          | Use it for                                                           | Exit codes                            |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------- |
| `aegis run`      | Simulate N ticks, print seed / hash / entity count / event histogram | 0 ok, 2 bad content                   |
| `aegis inspect`  | Dump `world`, `frame` or `ascii` at a tick                           | 0 ok, 2 bad content                   |
| `aegis validate` | Schema-check documents                                               | 0 clean, 2 problems                   |
| `aegis record`   | Run and write a `*.replay` recording                                 | 0 ok                                  |
| `aegis replay`   | Re-run a recording and check the pinned hash                         | 0 match, 1 mismatch                   |
| `aegis test`     | Discover and run `*.gametest.{js,mjs,cjs}` modules                   | 0 all passed, 1 failure or none found |
| `aegis scaffold` | Generate a game / scene / tilemap / prefab / test                    | 0 ok                                  |

Add `--json` to almost anything for machine-readable output. Prefer it: you get stable keys
instead of a formatted table.

**Read a green result carefully: "I checked and found nothing" and "I never looked" print the
same.** `aegis test` now tells you both — the summary reports what it scanned, not just what
passed:

```
$ npx aegis test
PASS sector breach: shoot the door, jump the pit, kill the grunt, reach the exit (600 ticks)
PASS sector breach (lose): walk into the coolant pit without jumping (300 ticks)
PASS sector breach (probe): the capsule is stopped by walls and slides along them (200 ticks)
PASS server vault: win the firefight, open the door, reach the exit (960 ticks)
PASS server vault (lose): stand in the guard’s fire and die (300 ticks)
PASS coyote gap (lose): a corpse driven to the flag does not finish the level (400 ticks)
PASS coyote gap (lose): walk into the critter instead of stomping it (140 ticks)
PASS coyote gap: stomp, ferry across the lava, coyote-jump, buffer onto the flag (400 ticks)
PASS coyote gap (lose): miss the coyote jump and fall out of the world (360 ticks)
PASS coyote gap (lose): run into the spike pit without jumping (120 ticks)
-- 10 passed, 0 failed, 0 invalid of 10 — 4 file(s) scanned, 1 via aegis.json, 10 test(s) found, 34 unrelated export(s) skipped
```

`4 file(s) scanned` is the number that matters. A spec in a directory the build excludes
contributes nothing ([§6.6](#66-the-template)); without the scan count a green run would shrink
silently and still read as success. Check the count, and check your game is named in the list.

It will also tell you outright when a game declared an `aegis.json` but contributed no test:

```
note: 1 game(s) declare an aegis.json but contributed no GameTest to this run:
        …/games/fps/aegis.json
      Neither the discovery glob nor a "tests" entry found one. Add e.g. { "tests": ["./dist/*.gametest.js"] } to include it.
```

Note also what those ten tests _are_: five of them are **lose cases** — a corpse driven to the flag
that does not finish the level, an operative standing in the guard's fire until it dies, a capsule
sliding along a wall. A suite that only proves the happy path passes when the failure conditions
stop working.

### 5.2 Run

```
$ npx aegis run ledge-hop/ledge-hop.scene.json --ticks 120 --input ledge-hop/play.input
scene    : ledge-hop/ledge-hop.scene.json
mode     : platformer
plugin   : platformer (aegis.json: …/ledge-hop/aegis.json)
systems  : 5
ticks    : 120
seed     : ledge-hop
hash     : ff0c3d6ee3f19d81
entities : 2
events:
  player.landed ×2
  player.jumped ×1
markers  : Player
           ^ no registered plugin provides these, so no system reads them. That is expected
             for markers your own systems will consume; if they belong to a game whose systems
             should be running, pass --plugin <module>#<export> or add an aegis.json beside
             the scene.
```

Four lines of that output are provenance, and they are the most useful part. `plugin` and
`systems` tell you _what actually ran_ — five systems, so the stock platformer pipeline and
nothing else. `markers` names every component id in the scene that no registered system reads:
here `Player` is a tag our own assertions query and no system consumes, which is fine and
expected. On a real game a name in that list means a system you thought was installed is not.

The **event histogram is the fastest read on whether a beat happened at all.** `player.jumped ×1`
means the jump input was consumed; `player.landed ×2` means the initial touchdown plus the far
ledge.

`--hash` prints only the hash, for scripting. `--seed` overrides the scene's seed. `--plugin`
overrides `aegis.json` ([§3.4](#34-how-a-plugin-reaches-a-run)).

### 5.3 See a 2D level

```
$ npx aegis inspect ledge-hop/ledge-hop.scene.json --tick 60 --input ledge-hop/play.input --view ascii
# ascii tick=60 24x8
........................
........................
........................
..........@.............
........o...............
........................
##########...###########
##########...###########
# legend
  ! = hazard volume
  # = solid tile
  . = empty
  = = moving platform
  @ = player
  E = enemy / damageable body
  G = goal / exit volume
  ^ = hazard tile (spikes / lava)
  o = other entity
```

That is the player mid-jump over the gap at columns 10–12. (`o` is the follow camera.) The iso
view is richer, because the mode draws its nav grid, doors and trigger volumes:

```
$ npx aegis run games/iso/levels/server-vault.scene.json --ticks 60 --ascii
scene    : games/iso/levels/server-vault.scene.json
mode     : iso
plugin   : @aegis/game-iso#serverVaultPlugin (aegis.json: …/games/iso/aegis.json)
systems  : 12
ticks    : 60
seed     : poc-iso
hash     : 77eb885f841099ca
entities : 6
events:
  (no events)
# ascii tick=60 12x9
############
#@..#...#K.#
#.#.#.#.#..#
#.#...#...##
#.###.#.##.#
#..G.......#
####D#######
#...X......#
############
# legend
  # = solid wall (impassable)
  . = floor (passable)
  @ = the controlled operative
  D = sealed door (Blocking entity; removed when its switch is flipped)
  G = a non-controlled actor (e.g. the guard)
  K = switch trigger volume
  X = exit / objective trigger volume
```

(The event log is empty because this run supplied no input script — the operative is still on its
spawn at tick 60. The guard has moved: `game.patrol` is running, which the `systems : 12` line
confirms.)

**Trap: the ASCII raster clamps.** An entity outside the grid is drawn at the nearest border cell,
which looks exactly like an entity standing inside a wall. Here is a run whose jump was too late,
so the player fell into the pit and out of the world:

```
$ npx aegis run ledge-hop/ledge-hop.scene.json --ticks 120 --input ledge-hop/try.input --ascii
scene    : ledge-hop/ledge-hop.scene.json
mode     : platformer
plugin   : platformer (aegis.json: …/ledge-hop/aegis.json)
systems  : 5
ticks    : 120
seed     : ledge-hop
hash     : ab17f454d635f288
entities : 2
events:
  player.landed ×1
markers  : Player
           ^ no registered plugin provides these, so no system reads them. …
# ascii tick=120 24x8
........................
........................
........................
........................
........................
........................
##########...###########
##########...###o#@#####
# legend
  ! = hazard volume
  # = solid tile
  . = empty
  = = moving platform
  @ = player
  E = enemy / damageable body
  G = goal / exit volume
  ^ = hazard tile (spikes / lava)
  o = other entity
```

(`ledge-hop/try.input` is the same script with `press Jump @70`. The `markers` note is elided
after its first line here; it is the same four-line block shown in [§5.2](#52-run).)

The `@` looks like it is embedded in the ground. It is not — it is 20 units below the map:

```
$ npx aegis inspect ledge-hop/ledge-hop.scene.json --tick 120 --input ledge-hop/try.input --view world --query "has:Player"
scene   : ledge-hop/ledge-hop.scene.json
mode    : platformer
plugin  : platformer (aegis.json: …/ledge-hop/aegis.json)
systems : 5
tick    : 120
seed    : ledge-hop
hash    : ab17f454d635f288
query: has:[Player]
entities: 1 of 2
#0 "player"
  BodyState = {"airborneTicks":61,"carriedBy":-1,"coyoteRemaining":0,"facing":1,"grounded":false,"jumpBufferRemaining":0}
  Name = {"value":"player"}
  PlatformerController = {"coyoteTicks":6,"gravity":60,"jumpBufferTicks":6,"jumpSpeed":16,"maxFallSpeed":30,"moveSpeed":8}
  Player = {}
  TileCollider = {"halfHeight":0.5,"halfWidth":0.4,"offsetX":0,"offsetY":0}
  Transform = {"position":{"x":18.19999999999998,"y":-20.75,"z":0},"rotation":{"w":1,"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}}
  Velocity = {"dx":8,"dy":-30}
```

`dy: -30` is terminal velocity, `airborneTicks: 61`, `grounded: false`. **ASCII is a summary;
`--view world` is the ground truth.** Never conclude from ASCII alone.

Also note the missing event: the intact run emitted `player.jumped ×1`, this one emitted none at
all. The jump was pressed 22 ticks after the player left the ledge, and coyote time is 6 ticks —
so the press was simply discarded. The event histogram told you that before you read a single
coordinate.

### 5.4 The semantic frame — seeing without a raster

Every mode produces a **semantic frame**: a camera snapshot plus a list of visible entities, each
with world position, projected screen position, depth, layer, `occluded`, `visibleFraction` and
the glyph the ASCII raster would use. Entities are sorted by ascending depth, ties broken by
entity id, so a frame is deterministic and diffable.

```
$ npx aegis inspect ledge-hop/ledge-hop.scene.json --tick 60 --input ledge-hop/play.input --view frame
# frame tick=60 mode=platformer viewport=160x90 entities=2
# camera pos=(8.500000000000004,3.0999999999999996,10) projection=orthographic
  #1 camera [-] world=(8.500000000000004,3.0999999999999996,10) screen=(80,45) depth=0 glyph=o
  #0 player [PlatformerController] world=(10.500000000000004,4.6,0) screen=(98,31.5) depth=10 glyph=@
```

For `fps` this is the _only_ view — there is no picture at all — so it is how you answer "is the
enemy on screen, where, and is anything in front of it". Read through a probe script, because the
CLI cannot load the fps game's plugin:

```
$ node .tmp/fps-frame-probe.mjs
camera pos=(0,1.6,14.999999999999963) projection=perspective
  exit tags=[] screen=(160,136.91611342228296) depth=4.000000000000037 occluded=false visibleFraction=1
```

Two caveats, and they are why you should assert on world state and use the frame only to
understand: only entities the mode's `ViewProvider` considers renderable and in view appear at all
— at that tick the world held five named entities (`player`, `button`, `grunt`, `exit`, `pit`) and
the frame listed one — and the fps `occluded` / `visibleFraction` fields are flagged in
`docs/architecture.md` §8 as the least settled contract in the engine.

### 5.5 Record and replay — the determinism proof

```
$ npx aegis record ledge-hop/ledge-hop.scene.json --ticks 120 --input ledge-hop/play.input --out ledge-hop/run.replay
recording : ledge-hop/run.replay
scene     : ledge-hop/ledge-hop.scene.json
mode      : platformer
ticks     : 120
seed      : ledge-hop
hash      : ff0c3d6ee3f19d81
```

The recording is readable JSON, and the input round-trips back to canonical DSL text — a
recording _is_ a script (first 9 lines; `tickHashes` continues for 120 entries):

<!-- template-exempt: transcript — truncated output of `aegis record` -->

```json
{
  "aegis": "recording/1",
  "scene": "ledge-hop/ledge-hop.scene.json",
  "seed": "ledge-hop",
  "ticks": 120,
  "input": "hold Right 0..120\npress Jump @48",
  "finalHash": "ff0c3d6ee3f19d81",
  "tickHashes": ["8401946d29bc194b", "ddb1bfaefd12782a", "33d6f2bb3c89c37b"]
}
```

```
$ npx aegis replay ledge-hop/run.replay
recording : ledge-hop/run.replay
scene     : ledge-hop/ledge-hop.scene.json
mode      : platformer
ticks     : 120
seed      : ledge-hop
expected  : ff0c3d6ee3f19d81
actual    : ff0c3d6ee3f19d81
match     : yes
```

Verification is **on by default**; `--no-verify` reports a mismatch without failing. A mismatch is
never "flaky" — it is a determinism bug (a clock, an unseeded random, an unordered iteration), and
the harness names the first divergent tick.

### 5.6 Going beyond the CLI

The CLI can now drive your game ([§3.4](#34-how-a-plugin-reaches-a-run)), so reach for it first.
But it only exposes what its flags expose. The moment you want a value it does not print — the
world at tick 400, a specific component's field over time, a derived digest — write a throwaway
script against `runScene` instead. That is not a workaround; it is the same API the CLI is built
on, and it is what produced several transcripts in this guide.

<!-- template-exempt: sketch — a throwaway probe script, not shipped -->

```js
// probe.mjs — run from the repo root: node probe.mjs
import { runScene } from '@aegis/harness';
import { serverVaultPlugin, SERVER_VAULT_SCRIPT } from '@aegis/game-iso';

const result = await runScene('games/iso/levels/server-vault.scene.json', {
  plugin: serverVaultPlugin,
  ticks: 960,
  seed: 'poc-iso',
  input: SERVER_VAULT_SCRIPT, // or your own DSL text
  captureHistory: true, // needed for result.at(tick) and assertInvariant
});

console.log(result.hash, result.query({ has: ['Operative'] }).count());
console.log(result.ascii(400)?.rows.join('\n')); // the level at tick 400
for (const e of result.events.history()) console.log(e.tick, e.type);
```

Note the difference from the CLI path: here the plugin is the **imported value**, not a string.
Inside the workspace that is simpler and type-checked; the string form exists so that a tool with
only a config file to read can still name it.

`SimResult` is the whole observation surface:

| Member                         | What it gives you                                            |
| ------------------------------ | ------------------------------------------------------------ |
| `world`, `tick`, `seed`        | Final state and the run's identity                           |
| `hash`                         | Final deterministic state hash                               |
| `tickHashes`                   | Per-tick hash timeline (on by default)                       |
| `events`                       | `history()`, `count(type)`, `ofType(type)`                   |
| `query(descriptor)`            | Query the final world                                        |
| `at(tick)`                     | The world at an earlier tick — **requires `captureHistory`** |
| `frame(tick?)`, `ascii(tick?)` | Semantic frame / character grid at any captured tick         |
| `assertInvariant(name, check)` | Check a property on every captured tick                      |
| `recording()`, `replay()`      | Portable recording; deterministic re-run                     |

---

## 6. Writing a game test that can actually fail

This section matters more than the rest of the guide combined. A test that cannot fail is worse
than no test, because it consumes the budget you would otherwise have spent writing one that can.

### 6.1 Rule 1 — a test's job is to name the broken thing

Hash drift tells you _something_ changed. A named assertion tells you _what_ broke. Write the
named assertions first and treat goldens as a backstop for drift the named assertions did not
model.

Measured, on the shipped iso PoC. I rebuilt its plugin with one system removed — `game.detect`,
the system that lets the guard notice the operative — and ran the game's own spec against it:

```
$ node .tmp/mut.mjs
passed=false
Expected "a hostile guard holds its ground instead of patrolling on" to hold on the final world (tick 960), but the predicate returned false.
```

That message is a bug report before you have opened a single file: the guard never turned hostile.
A golden-hash mismatch on the same run would have said only that sixteen hex characters differ.

Note _which_ assertion caught it, though. This one came through `holds`, which prints only its
label — so the label is carrying the entire diagnosis. When the broken capability is expressed as
an event, the message is far richer; the same mutation on a `eventEmitted` assertion prints the
whole histogram of what _did_ happen ([§6.5](#65-mutation-check-your-own-test) has one). Prefer
event assertions where a capability emits an event, and write `holds` labels that would read as a
bug report on their own ([§6.7](#67-assertion-reference)).

### 6.2 Rule 2 — an equality assertion is an oracle only if the two sides have independent provenance

If both sides of an equality derive from the same source, agreement is guaranteed by construction.
The assertion survives the source being wrong, which means it can never fail, which means it is
not a test.

The concrete instance of this in a golden-hash check:

|     | Form                                                               | Provenance of the expected side | Can it fail? |
| --- | ------------------------------------------------------------------ | ------------------------------- | ------------ |
| ✓   | `.hashEquals(GOLDEN_HASH)` where `GOLDEN_HASH` is a pinned literal | The literal, fixed at pin time  | Yes          |
| ✗   | `.hashEquals(result.hash)`                                         | The run being asserted on       | **No**       |

The second form reads exactly like a determinism regression test. It is not one. Measured: I ran
the platformer PoC's real scene, seed and script twice — once with its real plugin, and once with
a plugin identical except that every _game_ system was dropped from the schedule, so the level
cannot be completed. Then I checked both assertion forms against each run. `selfReferential`
compared the run's hash to itself; `named` was `eventEmitted('level.completed', 1)`.

```
intact hash=d813e4e19db7444d  selfReferential=PASS  named=PASS
broken hash=7320396f76b7075f  selfReferential=PASS  named=FAIL
```

The hash changed completely, the level was never completed, and the self-referential assertion
still passed — because it compared the new hash to itself. Only the named event assertion caught
it.

The rule generalises far past hashes, and the generalisation is the useful part. The screening
question is **not** "where did this value come from?" — it is:

> **Do the two sides have a common ancestor, and if that ancestor were wrong, would this
> assertion still pass?**

If the answer is yes, you have written a tautology with the shape of a test. Four ways to get
there, all seen in this repository:

| Shape                                                               | Common ancestor    | What it survives                    |
| ------------------------------------------------------------------- | ------------------ | ----------------------------------- |
| A run's hash compared to itself                                     | The run            | Any change to the simulation at all |
| A golden captured from the implementation at assert time            | The implementation | The implementation being wrong      |
| An expectation written against the component's `defaults()`         | The defaults       | The defaults being wrong            |
| Two key sets compared to each other, both derived from one contract | The contract       | The contract being wrong            |

The fix is always the same: **write the value down.** A literal has no ancestor.

### 6.3 `GOLDEN_HASH` — pin it as a literal

<!-- template-exempt: sketch — the shape of a pinned literal, not a file -->

```js
/**
 * Golden final-state hash. Captured once from a green run and pinned here as a literal, so a
 * later regression changes the run but never this number. Re-pin only on a deliberate change.
 */
const GOLDEN_HASH = 'ff0c3d6ee3f19d81';
```

Capture it deliberately, once:

```
$ npx aegis run ledge-hop/ledge-hop.scene.json --ticks 120 --input ledge-hop/play.input --hash
ff0c3d6ee3f19d81
```

When it does not match, the harness tells you both sides:

```
FAIL ledge hop: run right, clear the gap, land on the far ledge (120 ticks)
     Expected final state hash 0000000000000000, but got ff0c3d6ee3f19d81 after 120 ticks.
     Either the golden hash is stale (update it) or a change altered simulation output.
```

A golden pins **change detection**, never correctness. It cannot tell you the new behaviour is
wrong — only that it is different. Correctness lives in the named assertions.

Two shipped examples are worth reading before you write your own, because both spell out the
_provenance_ of the number rather than just declaring it golden:
[`games/iso/src/server-vault.ts`](./games/iso/src/server-vault.ts) (`GOLDEN_HASH`, pinned after
the first green run) and
[`games/fps/src/sector-breach.gametest.ts`](./games/fps/src/sector-breach.gametest.ts), whose
comment states explicitly that the value is a literal "not `result.hash`, which is
self-referential and can never fail". Copy that habit: the comment on a golden should say where
the number came from and what re-pinning it requires, not merely that it is a golden.

### 6.4 `GOLDEN_TRAJECTORY` — because the final hash is blind to timing

The final state hash describes the world after the last tick. It says nothing about _when_
anything happened along the way, and playthroughs characteristically **end at rest** — player
parked on the goal, enemy dead, cooldowns expired. Two runs whose timelines differ throughout can
converge on the same resting state, and the final hash cannot tell them apart.

Measured, on the shipped iso PoC. I moved one line of its input script — the final
`click 4,7 @340` that breaches the vault, to `@420` — and changed nothing else:

```
$ node .tmp/timing.mjs
breach click @340  mission.completed@505  hash=cb0f07007ad8608a  hashMatchesGolden=true  trajectory=2c6881a477e2d268  trajectoryMatchesGolden=true
breach click @420  mission.completed@585  hash=cb0f07007ad8608a  hashMatchesGolden=true  trajectory=3d533c9edb70690f  trajectoryMatchesGolden=false
```

The mission completed **eighty ticks later** and `GOLDEN_HASH` was byte-identical. A test pinned
only on the final hash would not have noticed that the pacing of the entire back half of the level
had moved. The trajectory pin caught it.

All three PoCs now carry both pins plus the same digest helper, which uses `hashString` from
`@aegis/core` — the same frozen FNV-1a the world hash uses, so the digest is exactly as portable
and deterministic as the hashes it summarises. This is `trajectoryDigest` as it appears verbatim in
[`games/platformer/src/coyote-gap.gametest.ts`](./games/platformer/src/coyote-gap.gametest.ts)
(and identically in the iso and fps specs). Copy this rather than inventing your own — the
separator is part of the convention, and a different one yields digests that silently match
nobody:

<!-- template-source: games/platformer/src/coyote-gap.gametest.ts #region -->

```ts
export function trajectoryDigest(tickHashes: readonly StateHash[]): StateHash {
  return hashString(tickHashes.join('|'));
}
```

Pin the result exactly like `GOLDEN_HASH` — capture once from a green run, write the literal down,
re-pin only on purpose and only with an explanation ([§7.2](#72-when-a-golden-moves)).
`tickHashes` is captured by default, so this costs nothing.
[§6.6](#66-the-template) shows both pins in place.

If you care about a specific beat's timing — and you usually should — assert on it directly as
well, because that produces a far better failure message than a digest can. As a complete
expectation over the iso PoC's `SimResult`:

<!-- template-exempt: sketch — one illustrative expectation -->

```js
expectSim(result).holds('mission completed on tick 505', (r) =>
  r.events.history().some((e) => e.type === 'mission.completed' && e.tick === 505),
);
```

### 6.5 Mutation-check your own test

A test you have never seen fail is a hypothesis. Break the capability, confirm the assertion you
expect goes red, put it back. Two minutes, every time.

**Start with the two cheapest mutations, because they are generic and they catch the worst
failure mode.** Re-run your test with:

1. **`ticks: 0`** — if it still passes, nothing you assert depends on the simulation running.
2. **an empty schedule** — a plugin with the same components but `systems: () => createSchedule()`.
   If it still passes, nothing you assert depends on any system being correct.

Both should turn your test red. If either stays green, your assertions describe the _scene file_,
not the _game_.

This is not hypothetical, and it is why the technique is worth internalising rather than the
particular defect. Until very recently the starter test from `aegis scaffold game` failed exactly
this check: it contained a real-looking assertion whose fact was established by scene
instantiation, so it passed with the simulation deleted. Measured on that template:

```
as generated            passed=true  ticks=120
with 0 ticks            passed=true  ticks=0
with every system gone  passed=true  ticks=120
```

One hundred and twenty ticks of simulation, and removing all of it changed nothing. That is
[§6.2](#62-rule-2--an-equality-assertion-is-an-oracle-only-if-the-two-sides-have-independent-provenance)
in a different costume — the assertion and the thing it checked shared an ancestor (the scene
file) that the run never touched.

The current template passes, and the harness now catches the degenerate case outright:

```
as generated            passed=true
with 0 ticks            passed=false  <- [aegis] assertInvariant("the player never falls out of the world") on a 0-tick run: there is no tick to check, so this would pass for any predicate — including () => false. Give the run at least 1 tick.
with every system gone  passed=false  <- the player is not standing on solid ground — is platformer.tilemap in the scene resources?
```

That first message is worth reading twice. The harness does not merely fail; it explains _why the
assertion was vacuous_ — "this would pass for any predicate, including `() => false`". Apply the
same standard to your own tests.

One wrinkle if you try this on a scaffolded test: it names its plugin as a **string** for the CLI
to resolve, so `runGameTest` cannot run it directly (`plugin.components is not a function`).
Substitute the plugin object first — `{ ...spec, options: { ...spec.options, plugin: platformerPlugin } }`
— then mutate.

Here is the same pair run against the Ledge Hop test in [§6.6](#66-the-template):

```
as written              passed=true
with 0 ticks            passed=false  <- Expected exactly 1 "player.jumped" event, but 0 were emitted during the 0-tick run.
with every system gone  passed=false  <- Expected exactly 1 "player.jumped" event, but 0 were emitted during the 120-tick run.
```

Red both times, and the message names the capability rather than reporting that a number moved.
Run this check once when you write a test; it takes seconds and it is the difference between a
test and a decoration.

Then mutate the specific capabilities. Break the input so the jump lands outside the coyote
window:

```
$ npx aegis test "ledge-hop/**/*.gametest.mjs"
FAIL ledge hop: run right, clear the gap, land on the far ledge (120 ticks)
     Expected exactly 1 "player.jumped" event, but 0 were emitted during the 120-tick run.
     Events that WERE emitted:
       - player.landed ×1
-- 0 passed, 1 failed of 1
```

Put it back:

```
$ npx aegis test "ledge-hop/**/*.gametest.mjs"
PASS ledge hop: run right, clear the gap, land on the far ledge (120 ticks)
-- 1 passed, 0 failed of 1
```

If a mutation you expected to be caught is _not_ caught, you have found a gap in your assertions,
not a robust system. Add the assertion that catches it.

### 6.6 The template

`ledge-hop/ledge-hop.gametest.mjs` in full. This file runs green as written, is lint- and
prettier-clean, and every assertion in it has been observed to fail under mutation.

<!-- template-exempt: authored for this guide — Ledge Hop has no file in the repository (see §9) -->

```js
// "Ledge Hop" — the acceptance test. Run with: aegis test "ledge-hop/**/*.gametest.mjs"
import { hashString, Transform } from '@aegis/core';
import { defineGameTest, expectSim } from '@aegis/harness';
import { BodyState, platformerPlugin } from '@aegis/mode-platformer';

/**
 * Golden final-state hash. Captured once from a green run and pinned here as a literal, so a
 * later regression changes the run but never this number. Re-pin only on a deliberate change,
 * and only with an explanation — see §7.2.
 */
const GOLDEN_HASH = 'ff0c3d6ee3f19d81';

/**
 * Golden digest of the entire per-tick hash timeline. GOLDEN_HASH describes where the run *ends*;
 * this describes how it got there. Same pinning rules.
 */
const GOLDEN_TRAJECTORY = '4eb1220792762ac2';

/** Digest a run's per-tick hash timeline into one comparable value (same shape the PoCs use). */
function trajectoryDigest(tickHashes) {
  return hashString(tickHashes.join('|'));
}

export default defineGameTest({
  name: 'ledge hop: run right, clear the gap, land on the far ledge',
  scene: 'ledge-hop/ledge-hop.scene.json',
  options: { plugin: platformerPlugin, captureHistory: true },
  ticks: 120,
  seed: 'ledge-hop',
  input: `
    hold Right 0..120
    press Jump @48
  `,
  expect(result) {
    expectSim(result)
      // Each of these names one capability, so a failure says which one broke.
      .entityExists({ has: ['Player'] })
      .eventEmitted('player.jumped', 1) // the jump input was actually consumed
      .eventEmitted('player.landed', 2) // start-of-run touchdown + the far ledge
      .holds('player finished right of the gap (x >= 13)', (r) => {
        const t = r
          .query({ has: ['Player', 'Transform'] })
          .one()
          .get(Transform);
        return t.position.x >= 13;
      })
      .holds('player finished standing on solid ground', (r) => {
        const b = r
          .query({ has: ['Player', 'BodyState'] })
          .one()
          .get(BodyState);
        return b.grounded;
      })
      // Change detectors, checked last: they catch drift the named assertions did not model.
      .hashEquals(GOLDEN_HASH)
      .holds(
        'the per-tick hash timeline matches the golden trajectory (see GOLDEN_TRAJECTORY)',
        (r) => trajectoryDigest(r.tickHashes) === GOLDEN_TRAJECTORY,
      );

    // A property that must hold on EVERY tick, not just the last one.
    result.assertInvariant('never fell out of the world', (w) => {
      const t = w
        .query({ has: ['Player', 'Transform'] })
        .one()
        .get(Transform);
      return t.position.y > -1;
    });
  },
});
```

For a game with its own systems, one line changes: `plugin: platformerPlugin` becomes
`plugin: myGamePlugin` ([§3](#3-the-composed-plugin-pattern)). Everything else is identical.

#### Where the file has to live

A shipped game puts its spec in **`games/<name>/src/<name>.gametest.ts`**. Not in `test/`. This is
a build constraint, not a style preference, and getting it wrong fails silently:

<!-- template-source: games/fps/tsconfig.json #region -->

```json
// games/fps/tsconfig.json
"include": ["src/**/*.ts"],
"exclude": ["src/**/*.test.ts", "src/**/*.spec.ts", "test", "dist"],
```

`aegis test` globs **compiled** output (`**/*.gametest.{js,mjs,cjs}`), so a spec the build excludes
never reaches `dist` and the CLI cannot see it — no error, no warning, just a green run over fewer
games than you think. All three PoCs sat that way for a while: iso defined its playthroughs inside
`src/server-vault.ts`, fps defined its inside a Vitest file under `test/`, and `aegis test` ran the
platformer alone and exited 0 with a green summary. **A gate over one of three PoCs is a more
dangerous signal than no gate at all, because it reads as coverage.**

`games/platformer/test/gametest-discovery.test.ts` now enumerates `games/` from disk and fails if
any game ships no discoverable `dist/*.gametest.js`, so a fourth game is covered automatically.

Then wrap the spec in a Vitest file under `games/<name>/test/` so `npm run verify` runs it too —
the two runners fail differently and that is the point. The wrapper is small:

<!-- template-exempt: skeleton with `my-game` placeholders; its real twins are games/*/test/*.test.ts -->

```ts
import { describe, expect, it } from 'vitest';
import { runGameTest } from '@aegis/harness';
import spec from '../src/my-game.gametest.js';

describe('My Game', () => {
  it('completes the playthrough exactly as the spec asserts', async () => {
    const outcome = await runGameTest(spec);
    if (!outcome.passed) throw outcome.error ?? new Error('game test failed');
    expect(outcome.passed).toBe(true);
  });
});
```

### 6.7 Assertion reference

| Assertion                         | Fails when                 | Failure message contains                                                     |
| --------------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| `entityExists(query)`             | Nothing matches            | Every entity in the final world                                              |
| `entityCount(query, n)`           | Count ≠ `n`                | The matched entities, named                                                  |
| `eventEmitted(type, times?)`      | Wrong count (or none)      | Ticks it fired on + the full event histogram                                 |
| `eventNotEmitted(type)`           | It fired                   | Every tick it fired on                                                       |
| `hashEquals(literal)`             | Final hash ≠ literal       | Both hashes                                                                  |
| `holds(label, predicate)`         | Predicate is falsy         | Label, seed, tick + a world census; `actual`/`expected`/`detail` if returned |
| `assertInvariant(name, check)`    | Fails on any captured tick | The name and the failing tick                                                |
| `invariants: [...]` on `runScene` | Fails live, during the run | The name and the failing tick, thrown at that tick                           |

`holds` is the escape hatch, and what it prints depends entirely on what your predicate returns.
Return a bare boolean and you get the label, the run, and a census of the world it rejected:

```
Expected "never true" to hold on the final world (seed "poc-fake", tick 60), but it did not.
  world   : 3 entities: #0 "hero", #1 "critter", #2 "platform"
Return { ok, actual, expected } from the predicate (instead of a bare boolean) to have the offending value printed here.
```

Take that last line's advice — return `{ ok, actual, expected, detail }` — and the offending value
appears instead of the census:

```
Expected "player reached x >= 500" to hold on the final world (seed "poc-fake", tick 60), but it did not.
  expected: ">= 500"
  actual  : 8
  detail  : player ran out of runway
```

The difference between those two transcripts is one `return` statement, and it is the difference
between knowing that something is wrong and knowing what. Write labels that carry the threshold as
well — `'player finished right of the gap (x >= 13)'`, not `'player moved'` — because the label is
the only part that survives into a summary line.

`assertInvariant` and `at(tick)` both require `captureHistory: true`. Live `invariants` passed to
`runScene` do not, and they fail _at_ the offending tick rather than after the run, which is what
you want when you are hunting _when_ something broke.

---

## 7. Debugging without pixels

### 7.1 The triage ladder

Work down it. Each rung is cheaper than the one below.

1. **Event histogram** — `aegis run … ` or `result.events`. Did the beat happen at all? A missing
   `player.jumped` is a different bug from a `player.jumped` in the wrong place.
2. **Named assertion message** — it already tells you which capability broke and, for events, on
   which ticks.
3. **ASCII view at the suspect tick** — `aegis inspect --view ascii --tick N`. Cheap spatial
   read. Remember it clamps ([§5.3](#53-see-a-2d-level)).
4. **World dump, filtered** — `aegis inspect --view world --query "has:Player"`. This is ground
   truth: exact component values, exact positions.
5. **Bisect the tick** — with `captureHistory: true`, `result.at(t)` gives you the world at any
   tick. Binary-search `tickHashes` for the first tick that differs between two runs; the
   `replay` command already does this for you and names the first divergent tick.
6. **Live invariant** — pass `invariants: [{ name, check }]` to `runScene` and it throws
   `InvariantError` naming the exact tick the property first broke.

### 7.2 When a golden moves

**A moved golden is not automatically wrong. It is automatically _unexplained_.** Re-pinning
without an explanation converts a detector into a rubber stamp — and it is silent, because the
test goes green and nothing records that you never found out why.

1. Did any named assertion also fail? If yes, fix that first — the golden is downstream noise.
2. If _only_ the golden moved, you changed behaviour without changing any beat you had modelled.
   Find out which. Diff the two runs' `tickHashes` for the first divergent tick, then dump
   `at(tick)` on both sides of it. `aegis replay` already names the first divergent tick for you.
3. Once you can state in one sentence what changed and why it is correct, re-pin the literal in
   the same commit as the change that caused it, and put the sentence in the commit message.
4. If you cannot state it, you have a bug, not a stale golden.

If the trajectory moved and the final hash did not, the change is **pure timing** — something
happens earlier or later than it used to and the world still ends up in the same place. If the
final hash moved and the trajectory did not, you have a determinism problem, not a gameplay one:
the same timeline cannot produce two endings.

#### A golden pinned to a degenerate playthrough certifies nothing

The most instructive move is a legitimate one. The iso PoC's `GOLDEN_HASH` changed from
`a76c70407b775b92` to `cb0f07007ad8608a` — not because engine behaviour changed, but because the
**input script was rewritten**. The old playthrough was degenerate in two ways it was possible to
believe were fine:

- The operative was spotted at t18, while the guard was still on its spawn cell — so the run
  never exercised the clockwork patrol it existed to prove. The new script holds the spawn until
  t40, where the guard cannot see it (Chebyshev ≥ 4), and lets the patrol actually walk.
- It clicked the exit at t300, **three ticks after** the door had already unsealed at t297 — so
  the "breach the sealed door" beat was decided before the click. The new script clicks the vault
  at t300 while the door is still sealed (proving `path.blocked` fires and the order is dropped)
  and again at t340 once it is open.

Both old runs completed. Both hashed stably. Both would have passed a `hashEquals` pin forever.
The golden was doing its job perfectly and certifying a playthrough that proved almost nothing —
which is the same failure as
[§6.5](#65-mutation-check-your-own-test)'s scaffolded test, one level up: **a pin is only as good
as the run underneath it.** Before you pin, ask what the run would have to break for the
playthrough to stop being valid, and check it is not already broken.

### 7.3 Determinism failures

If a replay mismatches, or two runs of the same scene differ, you have violated ADR-0001. The
usual causes, in order of likelihood:

- `Date.now()`, `performance.now()`, `Math.random()` — lint bans these as **errors** in every
  simulation package _and_ in `games/*`, including tests. Do not add an `eslint-disable`.
- `Math.sin`/`cos`/`atan2`/`pow`/… — platform libm is not bit-identical across machines. Import
  from `@aegis/core/math` instead. Also lint-banned.
- Iterating an unordered structure where order affects the result.
- Wall-clock anything in gameplay. Time is the integer tick.

If determinism forces an awkward design, take the awkward design.

---

## 8. The loop, end to end

```
scaffold ──▶ author ──▶ run ──▶ observe ──▶ assert ──▶ verify
                ▲                              │
                └──────────────────────────────┘
```

### Step 1 — scaffold

```
$ npx aegis scaffold game ledge-hop --mode platformer
scaffolded game "ledge-hop" (platformer):
  ledge-hop/aegis.json
  ledge-hop/ledge-hop.scene.json
  ledge-hop/ledge-hop.tilemap.json
  ledge-hop/ledge-hop.input
  ledge-hop/ledge-hop.gametest.mjs

next:
  aegis validate ledge-hop/ledge-hop.scene.json
  aegis run ledge-hop/ledge-hop.scene.json --ticks 120 --input ledge-hop/ledge-hop.input --ascii
  aegis test "ledge-hop/*.gametest.mjs"
```

That output runs as generated: the scene has a wired-in tilemap and a controlled player, the
`aegis.json` names the plugin so nothing is silently skipped, and the starter test carries a real
`assertInvariant` plus end-state checks. Run the `next:` commands before editing anything — they
are the loop in miniature, and seeing them green tells you the toolchain works before you start
changing things.

Two habits to keep even so. **Mutation-check the generated test** ([§6.5](#65-mutation-check-your-own-test));
it passes today, and the reason to check is that you did not watch it fail. And **the emitted
`*.tilemap.json` is still a standalone document** — the scene carries its own inline copy under
`resources`, so editing the `.tilemap.json` file alone changes nothing
([§2.3](#23-trap-the-tilemap-must-be-inline)).

The rest of this walkthrough uses the hand-authored Ledge Hop scene from
[§2.1](#21-the-running-example), which adds a gap to jump so there is something to debug.

### Step 2 — author, and validate before running

```
$ npx aegis validate ledge-hop/ledge-hop.scene.json
ok ledge-hop/ledge-hop.scene.json: no problems found
```

### Step 3 — run

```
$ npx aegis run ledge-hop/ledge-hop.scene.json --ticks 120 --input ledge-hop/play.input
scene    : ledge-hop/ledge-hop.scene.json
mode     : platformer
ticks    : 120
seed     : ledge-hop
hash     : ff0c3d6ee3f19d81
entities : 2
events:
  player.landed ×2
  player.jumped ×1
```

### Step 4 — observe, and tune the script

The input script is where you iterate. Change a tick, re-run, read the histogram. Sweeping the
jump tick on Ledge Hop, with only the events shown:

| `press Jump @`  | events                                 | outcome                                |
| --------------- | -------------------------------------- | -------------------------------------- |
| `@48`           | `player.jumped ×1`, `player.landed ×2` | clears the gap                         |
| `@62`           | `player.jumped ×1`, `player.landed ×2` | clears it on coyote time               |
| `@66` and later | `player.landed ×1`                     | jump discarded; falls out of the world |

### Step 5 — assert

Write the game test ([§6.6](#66-the-template)), capture the goldens, mutation-check it.

```
$ npx aegis test "ledge-hop/**/*.gametest.mjs"
PASS ledge hop: run right, clear the gap, land on the far ledge (120 ticks)
-- 1 passed, 0 failed of 1
```

### Step 6 — verify

```
npm run verify
```

Build + test type-check + the whole test suite + eslint + dependency boundaries + prettier. This
is the gate. "It works in my package" is not.

Before you hand back, per [`docs/working-agreement.md`](./docs/working-agreement.md) §5: report
what you built, **what you verified and how**, decisions others must know about, anything you
deferred, and anything you are unsure about. A flagged risk is cheap; a silent wrong assumption is
expensive.

---

## 9. Known rough edges

Every row below was **re-measured behaviourally at `e0c1917`** — each defect reproduced by running a
command, and each reproduction paired with a positive control showing the same probe returns the
opposite answer when the defect is absent. Not one row was checked by reading the source. One row
was deleted as a result, and another had its stated mechanism replaced.

The controls are not ceremony. One probe here first came back empty for _both_ arms, which reads
exactly like a defect that no longer reproduces; the real cause was a malformed query exiting 1
before it measured anything. **An instrument that produces nothing looks identical to an instrument
reporting nothing wrong**, and only the arm you expect to fire tells the two apart.

That is also why the words _"Verified on this revision"_ no longer head this section. Under them,
**two clauses here were already false at the revision they named** — `holds` reporting only its
label (fixed in `de6b7d9`) and `aegis test` globbing `dist/*.gametest.{js,mjs,cjs}` (never true
since `b8759ba`; the string is in no CLI source file, only in documents). Both are ancestors of
that revision. Both claims were plausible, both were inspected rather than run.

Entries that stood here earlier are gone because they were genuinely fixed: the CLI could not load a
game's plugin, there was no `aegis.json`, `aegis test` reached one game of three,
`aegis scaffold game` produced something that did not run, unknown flags were ignored silently,
`inspect --view world` dumped every resource in full, and nothing prevented a self-referential
golden.

**Re-measure before you trust any list like this one, including this one.** A row here is a claim
about behaviour, and the only thing separating a true one from a merely convincing one is a command
you ran.

**The resource-id row below is the one exception to the paragraph that opens this section, and says
so rather than borrowing its authority.** It was not reproduced by a probe with a control; it is
proved by
construction, which for this defect is the stronger evidence and not the weaker. Resource-id
checking is opt-in — `validateResources` returns immediately when no registry is supplied
(`packages/content/src/load.ts:626`) — and **all three** callers in shipped code pass only a
component registry: `packages/harness/src/run.ts:338`, `session.ts:121`, `world.ts:46`. The value is
applied to the world regardless (`load.ts:781`). Both arms are already pinned by green tests —
`load.test.ts:286` _"says nothing about resources when no registry is supplied"_ and `:291`
_"refuses to instantiate a scene whose resource id is unknown"_ — so the behaviour is deliberate and
tested, not an oversight. Enabling the check needs a `ModePlugin` contract addition and the three
modes declaring their ids, deferred to v2 and written down at both ends (`load.ts:396`,
`registry.ts:78`). An enumeration of every caller settles this where a single probe could not: a
probe would only ever have told you about the one path it took.

| #   | Rough edge                                                                                                                                                                                                                                                                                                                                                                                                                          | Work around it by…                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **A scene's tilemap must be inlined into `resources`; the `*.tilemap.json` file next to it is not loaded.** `aegis scaffold game` writes both, and editing only the standalone file changes nothing about the run.                                                                                                                                                                                                                  | Editing the inline copy under `resources["platformer.tilemap"]` ([§2.3](#23-trap-the-tilemap-must-be-inline)).                                                   |
| 2   | **A typo in `tags` is silent.** Ids in `components` must be registered; ids in `tags` are synthesised if unknown. `"Playre"` validates clean — `no problems found`, exit 0, even under `--strict` — and `has:Player` returns `entities: 0 of 2` with no diagnostic. Only the `markers` line on a run or `inspect` names the unknown id, annotated with the reason nothing reads it.                                                 | Reading the `markers` line, and dumping the world when a query returns nothing ([§2.5](#25-trap-tags-are-permissive-components-are-strict)).                     |
| 3   | **A spec the build excludes is invisible to `aegis test`** — but not because of where it lives. The CLI's default glob is `**/*.gametest.{js,mjs,cjs}` and is layout-agnostic: a hand-written `.mjs` dropped inside `test/` _is_ found. The real constraint is that a TypeScript spec must be **compiled**, and every `games/*/tsconfig.json` excludes `test`, so a `.ts` spec written there never becomes a file the glob can see. | Putting the spec somewhere the build compiles it — `games/<name>/src/<name>.gametest.ts` ([§6.6](#66-the-template)) — and reading the scan count in the summary. |
| 4   | **The ASCII raster clamps off-grid entities to the border**, so a fallen entity renders as if standing inside a wall.                                                                                                                                                                                                                                                                                                               | Confirming with `--view world` ([§5.3](#53-see-a-2d-level)).                                                                                                     |
| 5   | **A scaffolded `*.gametest.mjs` names its plugin as a string**, so `runGameTest` cannot run it directly (`plugin.components is not a function`) — only the CLI resolves strings.                                                                                                                                                                                                                                                    | Substituting the plugin object before calling `runGameTest` ([§6.5](#65-mutation-check-your-own-test)).                                                          |
| 6   | **A typo in a scene's `resources` id is silent, and the value still reaches the world.** Resource-id checking is opt-in and no shipped caller opts in, so `"gravty"` validates clean, runs clean, and is stored under the misspelling — where the mode that wanted `"gravity"` never looks. Unlike row 2 there is not even a `markers` line, because nothing knows the id was meant to be anything.                                 | Dumping resources with `aegis inspect --view world` and reading back the id you actually got, not the one you typed.                                             |

| 7 | **The `packages/render-three` browser tests are the suite''s only host-sensitive files, and vitest must be told so — and then three rounds went to a cause that measurement, twice, put somewhere else.** They pass on `ubuntu-latest` and on a development box; on `windows-latest` they failed thirteen pushes to `main` in a row, always in `browser-playability.test.ts`, never with a statement about the product. Run 30377421271: ubuntu ran 72 files / 1020 tests green with that file at 47.7s; windows ran the same corpus with it at **607.3s and 7 failures**. The file''s CPU sampler named a cause — _"this process held a CPU only 0% of the window — it was NOT SCHEDULED"_ — so `vitest.config.ts` now runs the two browser files as their own project, `sequence.groupOrder: 1`, `poolOptions.forks.singleFork`. That fixed `browser-diagnostics.test.ts` (33 of 33) and two of the seven, **and run 30380984122 then returned the same 0% verdict with the machine entirely to itself.** Two further rounds went to the reading that the process was blocked on I/O; the instruments added alongside refuted it each time, and the second refutation inverted the problem. Run 30385141986, both legs, one commit: identical GL implementation (`ANGLE … SwiftShader driver` — `--use-angle=swiftshader` is a request, not a guarantee, and this is the first time anyone checked), identical 2 cores, 5.2GB of 8.0GB free, Defender exclusions confirmed applied. Then the per-game numbers: **windows render p95 2.1/2.2ms against ubuntu''s 5.4/8.1ms, and gap p95 77/169ms against 200/388ms. The failing leg rasterises _faster_ than the passing one.** It painted 274 frames while the harness captured 21 of them. Nothing is wrong with the browser; **what is starved is the Node process — which is also the web server**, which is why `boot`, the one phase that is purely Node reading files and answering requests, ran 56.7s against ubuntu''s 1.8s while its event loop lagged 28352ms inside 34s. Both schedulers are fair per _thread_ and Chrome brings tens to Node''s handful; Linux `sched_autogroup` stops a many-threaded process out-voting a small one, and Windows has no equivalent. So the file raised its own priority to ABOVE_NORMAL before starting the server, and the two cache-disabling Chrome flags went — they were the only ones that _created_ work. **Then the whole scoreboard above turned out to be unreadable.** Commit `553f4f6` went green on both legs; re-running that same run id, on the same tree, produced 3 failures. The suite is _flaky_ there, so every "arrangement X costs N failures" claim above — including the ones this row was written to record — is a single sample of a wide distribution, and not one of them is established. Only continuous instruments survive that, which is why the next round added two: a boot-stage marker in the served page, and in-flight tracking in the stalling proxy, each mutation-checked in both arms before being believed. The marker answered immediately, and it is the finding: every failure reports `bootStage: ABSENT` — Chrome never finishes loading the page's ~63 ES modules, so `boot()` is not stuck in its body and did not throw. It never ran. Then the one remaining lever was measured in **both** directions, and each merely moves which side starves: favour the harness and Chrome cannot fetch (`stall 308817ms, connect 57814ms`) while the server answers instantly (`ttfb 219ms`); level them and Chrome's phases collapse (`stall 21339ms, connect 0ms`) while the single-threaded server cannot answer at all (`ttfb 451048ms`). There is no third setting because there is no third party: 2 vCPUs, no GPU, a Node dev server, Chrome, and SwiftShader rasterising in software. **So on that host the file does not measure the product, it measures the runner — and it no longer runs there.** `scripts/test-phases.mjs` omits the browser phase on a Windows _CI_ runner; not on Windows, because these specs pass on a 16-core development box and keying on the OS would have retired them from the primary host to fix a fault that host does not have. No threshold moved and no case is skipped — the audit refuses skips outright and would refuse that — and they gate in full on `ubuntu-latest`, where the same work has been green throughout at 47-138s. | Adding any new browser-launching test to `BROWSER_TEST_FILES` in `vitest.config.ts`. `test/browser-project-membership.test.ts` fails if you forget, because that regression is invisible everywhere except the leg you are not watching. Note `fileParallelism: false` looks like the setting for this and is not — vitest lists it in `NonProjectOptions`, so inside a project it is ignored silently. And before believing any verdict about _why_ a host is slow, check that you have instrumented the leg that **passes**: every wrong turn above came from a number that existed only on the failing side, where "slow" and "starved" and "fewer cores" all look alike. The blank-page control was read as proof the hosts were identical — it loads no modules and touches no GL, so it could not have seen either thing it was cited for. And if you are tempted to simplify the drop to "skip on Windows", or to trim the CI matrix: keep a non-Windows leg, because `test/browser-specs-run-solo.test.ts` is now the only thing standing between that matrix and a browser suite that runs **nowhere** while every leg reports green. One more, cheap to inherit: an exclusion is local to the scanner that implements it. `test/browser-project-membership.test.ts` exempted itself from its own scan with a `SELF` check while still containing a bare `launchBrowser` literal, and `scripts/test-phases.mjs` — a different scanner, reading the same marker, with no `SELF` concept — duly classified that static guard as a browser spec. Not containing the marker is the only exemption that travels; both files build it by concatenation now. |

The reason this section exists at all — and the reason [§6](#6-writing-a-game-test-that-can-actually-fail)
is written the way it is — is a defect that entered this codebase from `docs/architecture.md` §7,
a design document, with a comment on the line claiming it "pins the golden state hash". It was
then copied verbatim into a shipped game test, three harness tests, a second design doc, a commit
message and the `scaffold` generator. Six channels, one source, none of which could ever fail.

Two lessons, and the second is the load-bearing one:

- **Comments do not stop copying.** The comment on the original line was not merely insufficient,
  it was actively wrong, and it propagated along with the code every time.
- **A bad pattern's channels have different half-lives.** A lint rule closes the _code_ channel
  permanently and mechanically — and one now exists for this idiom, backed by a repository-wide
  invariant test for the spellings a syntactic rule cannot see. Prose has no runner, so the
  _prose_ channel is closed only by a human reading a document and asking what a line is _for_ —
  a one-time act nobody schedules. `AGENTS.md` is prose plus templates, which makes it the
  highest-half-life propagation channel in this repository.

So: **anything in here that looks like a template will be copied verbatim by someone who read the
snippet and not the paragraph around it.** Two consequences for how this file is maintained.

**Every template block names the file it came from.** The composed plugin in
[§3.1](#31-a-game-is-a-modeplugin) is `games/platformer/src/plugin.ts`; `trajectoryDigest` in
[§6.4](#64-golden_trajectory--because-the-final-hash-is-blind-to-timing) is the function of that
name shared by all three PoC gametests; the scaffold output in [§8](#8-the-loop-end-to-end) is
whatever `aegis scaffold game` currently emits. Those have executable twins: the gate runs them,
so they cannot rot here without rotting there, and you can diff them yourself.

**Two blocks do not, and you should know which.** The Ledge Hop scene in
[§2.1](#21-the-running-example) and its game test in [§6.6](#66-the-template) are authored for
this guide, because a tutorial needs a level small enough to read and a gap to fall into. They
have no file in the repository to be checked against. What they do have is a weaker guarantee that
is still worth something: on every revision of this document they are extracted from the markdown
above, written to disk, and run — validate, run, `aegis test`, and both mutations from
[§6.5](#65-mutation-check-your-own-test) — and the transcripts shown are that run's output. If the
engine changes so that they stop working, the next person to revise this file finds out
immediately. **That is a person, not a runner, and a person is exactly the weak link this section
is about.** Landing them under `games/` as a fourth gated example would close it properly.

Check the provenance of what you copy.
