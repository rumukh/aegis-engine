# @aegis/render-three

The optional visual adapter. Everything else in this engine is built so an agent can work without
pixels; this package is the one place pixels matter, and it must not compromise any of that.

> **The rule:** the simulation must not know this package exists. Rendering reads world state; it
> never writes to it, never advances it, never influences it. `noninterference.test.ts` proves it
> per tick, for all three modes.

## Preview assets without running a game

```powershell
npx aegis preview games\iso\assets\operative.gltf --clip walk --time 0.25 --out captures\operative.png --json
npx aegis preview games\iso\assets\access-console.gltf --serve --watch --out-dir captures --json
```

The standalone asset studio accepts direct local models/images or selected resources from a
`presentation/1` descriptor. It reuses the production loader and materials, but does not create
a world, initialize a plugin, or start a game. The persistent operator page supports orbit,
clip sampling/playback, reload, and revision-aware PNG capture with a fingerprinted recipe.

Use `@aegis/render-three/preview` for the warm Node API. See the
[asset preview reference](../../docs/api/asset-preview.md) for selection, lifecycle, safe local
automation, supported formats, freshness, and timing semantics.

## Play the three PoC games

```
npm install
npm run build
node poc/play.mjs
```

Then open <http://127.0.0.1:5173> and pick a game. Flags: `--port <n>`, `--host <iface>`.

| Game                                | Mode       | How you play it                                                                                                                                                                 |
| ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Coyote Gap** (`/play/platformer`) | platformer | `A`/`D` or `←`/`→` run (axis `MoveX`), `Space`/`W`/`↑` jump. Coyote time and jump buffering apply, so tapping jump while running chains maximum-distance hops.                  |
| **The Server Vault** (`/play/iso`)  | iso        | Left-click a floor cell to path there (A\*); left-click the guard to attack-move.                                                                                               |
| **Sector Breach** (`/play/fps`)     | fps        | `W`/`S` forward/back (axis `Forward`), `A`/`D` strafe (axis `Strafe`), `Space` jump, mouse look (click the canvas to capture the pointer), left click fires the hitscan weapon. |

Every game also takes `P` (pause/resume), `.` (single-step one tick while paused) and `R`
(restart at tick 0).

## Presentation is a separate document

`GameDefinition.presentation` and `StaticGame.presentation` accept
`{ manifest, assetRoot? }`. The manifest has discriminator `aegis: 'presentation/1'`; `assetRoot`
is an absolute host directory and is required when the manifest declares files. Only the
manifest, a page-relative asset base URL, and the prepared file inventory reach the browser.
Nothing is added to the simulation's scene, resources, components or hash.

The actual contract lives in `src/presentation/schema.ts`. For example, in a game's composition:

```js
presentation: {
  assetRoot: fileURLToPath(new URL('../games/my-game/assets/', import.meta.url)),
  manifest: {
    aegis: 'presentation/1',
    assets: [
      {
        id: 'operative',
        kind: 'gltf',
        src: 'operative.glb',
        provenance: { author: 'Your team', license: 'MIT', source: 'generate-assets.mjs' },
      },
      {
        id: 'deck',
        kind: 'texture',
        src: 'deck.png',
        provenance: { author: 'Your team', license: 'MIT', source: 'generate-assets.mjs' },
      },
    ],
    materials: [
      { id: 'deck-metal', shading: 'standard', map: 'deck', roughness: 0.7, metalness: 0.3 },
    ],
    surfaces: { floor: 'deck-metal' },
    entities: [
      {
        target: { name: 'operative' },
        visual: {
          kind: 'model',
          mesh: 'operative',
          animations: { idle: 'idle', move: 'walk', dead: 'death' },
        },
        fit: 'authored',
      },
    ],
    hud: {
      playerName: 'operative',
      winEvent: 'mission.completed',
      loseEvents: ['player.died'],
      steps: [{ id: 'switch', label: 'Activate the switch', event: 'switch.activated' }],
    },
  },
}
```

Absent presentation data retains the primitive mode. With a manifest, selected asset IDs must
resolve: a missing texture, model, frame or clip is an actionable `AEG-RENDER-*` diagnostic, not
a colored-box substitute. Explicit entity bindings override authored Sprite/Model fields, then
role bindings and the primitive palette provide defaults. Empty legacy appearance IDs remain legal.
An explicit sprite binding frame wins over `Sprite.frame`. When that binding omits a frame,
component-driven frame changes remain available for the same texture or an empty texture hint;
a frame belonging to a replaced atlas is not applied to the new atlas.

The loader uses the installed three.js texture/glTF facilities, with no CDN or runtime asset service.
Supported assets are PNG/JPEG/WebP, self-contained SVG, uncompressed glTF 2.0/GLB, and
WAV/OGG/MP3. glTF buffer/image dependencies must be embedded or within the declared local root.
Required compression-decoder extensions and external dependencies fail preflight. Asset provenance,
sizes and digests are carried in the prepared inventory. Author sources and licenses with the game.

The browser must support `createImageBitmap` for required image assets. Readiness includes a real
pixel decode: an image load event, and even Chromium's `image.decode()`, can succeed on a PNG whose
compressed pixels later fail WebGL upload. That corrupt-image case is a browser regression test,
separate from the server's refusal to serve files changed after preflight. SVG textures are
decoded as image elements before bitmap pixel validation, since Chromium rejects direct SVG
Blob-to-bitmap conversion; they must still pass pixel validation before readiness resolves.

Textures preserve alpha, sRGB/linear sampling and nearest/linear filtering. Atlas rectangles are
normalized `[u0,v0,u1,v1]` in **top-left image coordinates**. The shared helper converts UVs and
caches frame variants. Sprite animation lists use arbitrary authored frame names, selected by the
generic `idle`, `move`, `rise`, `fall`, `dead` states, with a positive `frameTicks`. Material maps
may repeat; use separate terrain images rather than repeating an atlas rectangle across its neighbors.

glTF instances preserve named nodes and animation clips, have independent transforms/skeletons,
and borrow cached geometry/materials. `fit: 'bounds'` is the default for an entity body;
`fit: 'authored'` preserves world units at its entity origin, with an optional presentation pose.
Use +Y up and actor feet at Y=0; iso maps grid Y to renderer Z. Poses use degree-based XYZ Euler
rotations. Camera-anchored objects provide viewmodels without modifying the gameplay camera.

World/entity/camera decoration, parallax, static instancing, fog and lights are declarative.
Isometric profiles may request `camera: { framing: 'level', padding: 1 }` to fit the complete
navigation grid across viewport aspects without changing the authoritative `IsoCamera`.
`padding` is a nonnegative world-unit margin. Omission or `framing: 'follow'` retains the existing
follow camera; camera framing overrides are rejected for other modes rather than ignored.
Event `burst`, `pulse`, `recoil`, `clip` and `frames` effects name their target and duration.
Clip/frame names belong in game data, not in engine code; `holdLast` supports a terminal pose.
An optional effect target `node` addresses a named model anchor. Recoil moves a view object,
never the aim camera. Effect timing derives from ticks; extra synchronization for picking cannot
advance it. An explicit authoritative step still advances presentation while paused; repeated
display frames without a world step do not. Payloads are preserved for extensions, but the renderer does not invent an exact
historic impact position when the event did not record one.

FPS camera-anchored objects and their bursts use a foreground pass so a nearby wall cannot
erase the viewmodel. They retain ordinary material depth testing against their own geometry;
only the world's depth is cleared between passes. The foreground uses its own light copies,
without a second background or fog, and borrows the same asset resources. Both shipped clients
use `renderAdapter(renderer, adapter)`; custom hosts can import the browser-safe helper from
`@aegis/render-three/render`. It restores renderer flags and preserves combined draw counters.

Default collider-derived level and trigger visuals remain visible. A replacement environment may
explicitly opt out with `legacy: { level: false, triggers: false }` only alongside declared
replacement objects. The diagnostic collision toggle retains the original geometry. Game owners
must still prove wall/deck/hazard coverage, hitbox alignment and navigation readability.

### Headless validation and ownership

```ts
import { validatePresentation } from '@aegis/render-three/presentation/validate';
import { preparePresentation } from '@aegis/render-three/presentation/node';
```

The validator returns the core `Validated<PresentationManifest>` diagnostic envelope and needs
neither a filesystem nor a GPU. Node preparation checks the closed file graph. The
`@aegis/render-three/presentation` entry exports the browser-safe asset/runtime APIs; it does not
import the Node preparer. Adapters remain synchronous and GPU-independent when given loaded
resources. Default image/audio decoding belongs to the browser, not to headless simulation.
Both clients also validate named bindings against the initialized mirror before the first mount,
so qualified prefab children and plugin-created entities are checked where their effective Names
actually exist. Later despawning does not rerun that initial-name check.

Adapter extensions can borrow `adapter.presentation.assets`, or call
`adapter.presentation.createVisual(spec)` for an authored-unit `{ root, clips, dispose }` handle.
The caller controls parenting and placement; the runtime cleans remaining handles on remount or
disposal. This is the shared path for a mode-specific wall replacement or view object, not a
reason to duplicate loaders. `entity(name)`, `object(id)`, `setEntityState(name, state)` and
`addEffect(effect)` expose existing instances and view-only behavior without hard-coded game names.

The asset library owns textures, materials and geometry. A model instance's `dispose()` releases
that instance, including its cloned `InstancedMesh` buffers and skeletons, not another actor's
shared geometry, materials or textures. Restart clears animation/effect/audio state
and reuses loaded assets; page disposal releases the library after its instances. Do not call
`dispose()` on a borrowed material or texture. Load errors, cancellation, same-tick duplicate
events, stale restart generations and repeat disposal have explicit coverage.

### Audio, UI and bounded quality

The two browser transports share a compact objective/health/progress HUD, loading/error states,
pause/restart/mute/quality controls and collapsible diagnostics. Existing debug handles and
readouts remain available. `aegis.ready` resolves only when real assets and the first world have
mounted; `aegis.presentation()` exposes status and resource/effect/audio counters. Outcome panels
report game events without changing simulation stepping.

Dev-client reloads also restore held clip/frame poses and HUD progress before readiness. The
frame request opts in with `presentationGeneration: null` initially and subsequently reports
the last hydrated generation. When it differs, the server includes `eventHistory`: a full
sequenced prefix captured with the same snapshot, avoiding a race between separate state and
history reads. Legacy requests and routine same-generation frames keep their previous shape.
Missing or inconsistent required history is a visible connection failure and is retried.

Cold-page hydration is silent: old audio, bursts, pulses, recoil and transient extension callbacks
are not replayed. Persistent animations still in progress are sampled at the snapshot tick.
Buffered live events beyond the hydrated prefix are retained; a continuing page also preserves
the fresh event suffix when observing a restart. Delayed control acknowledgements cannot reset
an already accepted generation or roll its snapshot backward. Static sessions still start locally
and need no history request.

Audio bytes preload with assets. A trusted gesture unlocks the shared AudioContext; locked,
muted, unavailable and error states are explicit. Unlock/unmute never replays old cues.
Pause/restart stop voices and reset cue state without duplicating ambient loops.

| Tier                 | Pixel-ratio ceiling | Transient effects | Audio voices |
| -------------------- | ------------------- | ----------------- | ------------ |
| `standard` (default) | 2                   | 128               | 16           |
| `low`                | 1                   | 32                | 8            |

Both retain collision readability and input semantics. This milestone has no dynamic shadows,
postprocessing, decoder services or streaming. The manifest caps individual decoration objects
at 256, total static instances at 4,096, and point lights at 8. Suppressed transient effects and
voice evictions are counted. Existing draw-call, payload and frame-work guards remain unchanged.
The browser's reduced-motion preference suppresses decorative parallax, bob/spin, sparks and
recoil while retaining essential actor/state and door clip transitions. Preference listeners
are removed on disposal.

`poc/platformer.mjs`, `poc/iso.mjs` and `poc/fps.mjs` are independent game composition roots.
`poc/poc-games.mjs` only aggregates and loads them. Game art, asset sources and event mappings
belong there and under the respective game, never as game-specific branches in engine code.

## Ship them as a static site

```
npm run build
npm run build:site        # writes dist-site/
```

`dist-site/` is a self-contained static site — a landing page, one route per game, the workspace's
built `dist/` modules and three.js — that any file server can hand out. `.github/workflows/pages.yml`
publishes it to GitHub Pages.

**It is not the dev server's HTML with the server removed, and that distinction is the whole point.**
The dev server owns the simulation in a Node process and the page posts input to
`POST /api/<id>/frame` once per displayed frame; uploading that page to Pages would produce a site
that loads, paints its HUD, and fails every exchange for ever. So the static build moves the session
into the page: `client/static-boot.ts` builds the same `createLiveSession`, from the same composed
plugin and the same scene document, and steps it on the same fixed timestep.

Nothing about the non-interference rule moves with it. The page still renders from
`session.snapshot()` restored into a **separate mirror world**, and the adapter is handed the mirror
— never the simulation's `World`. The boundary was always the snapshot, not the process.

The static client refreshes that detached observation only when its tick or restart generation
changes. Paused and sub-tick display frames still collect input, drain events, synchronize
presentation and draw, but do not copy the identical world again. A same-tick restart still
refreshes; a failed observation does not publish its revision. `aegis.snapshot()` returns a
defensive copy of the retained snapshot. Unsupported writes through the debug mirror cannot
change simulation state and heal on the next revision, not on every paused frame.

Three properties the exporter enforces rather than hopes for:

- **the module graph is crawled, not copied.** `dist/` contains `dev-server.js`, `catalog.js` and
  `capture.js`, which import `node:http` and `node:fs`. Only modules actually reachable from a
  page's own entry point are vendored, so a Node-only module cannot be shipped by accident.
- **an unservable static import fails the build.** Including any `node:` built-in. (`@aegis/harness`
  reaches `node:fs/promises` behind an `await import(...)`, which a page never fetches; the exporter
  reports it and does not fail.)
- **every URL is relative**, so the same bytes work at `https://<user>.github.io/aegis-engine/`, at a
  domain root, and under any prefix a reviewer serves them from.

`test/pages-site.test.ts` reads the artifact back with an independent parser; the site is then
played in a real browser, from a server that only serves files, by
`test/pages-site.browser.test.ts`.

## Screenshots

`node poc/capture.mjs` plays all three games in a real browser with real key and
mouse events and writes `screenshots/{platformer,iso,fps}.png`. It speaks the Chrome DevTools
Protocol over Node's built-in `WebSocket`, so it needs no extra dependency — just Chrome or Edge.
Add `--headed` to watch it happen.

Two properties it is built around, both learned by getting them wrong first:

**It replays the game's own `.input` script.** Not hand-written key timings — the same file the
game's acceptance test runs, compiled to browser events by `script-input.ts` through the same
binding table a human's keyboard goes through. The earlier version carried canned timings, and
when the platformer's lava ferry was restored they silently began running the player into a gap.
They were never stable anyway: hand-tuned wall-clock sleeps race the browser's frame pacing, and
the same commit died in **two runs out of three**.

> An enumerated fix is only as good as the enumeration. There is now no enumeration to be wrong
> about, because the source of truth is the file the tests already prove.

The replay is exact rather than hopeful: the session is paused and stepped explicitly, and
`aegis.sync()` guarantees each segment's input has reached the server _before_ the ticks it
applies to are simulated. The live input path is untouched — key and mouse events go through the
page's collector, the binding table, an HTTP packet and `LiveInput` exactly as a human's do. Only
the trigger for advancing time differs, and the accumulator that normally provides it has its own
tests (`loop.test.ts`, `session.test.ts`).

**It refuses to ship a failed playthrough.** The previous version counted dead entities and
printed them — and then wrote the PNG anyway, so a screenshot of a corpse falling out of the world
became the committed evidence that the game is playable. Reporting a problem is not the same as
declining to ship it. A capture now fails if the game's win event was never emitted or the player
ended up dead; the PNG is still written, because a failed frame is the most useful thing to look
at, but it no longer passes for success.

The frame kept is the one at a named event's tick — the win, or something more legible if a game
wins somewhere dull (Sector Breach's exit is a dead-end wall, so it photographs the firefight).
Only the event _name_ is a choice; the tick comes out of the run's own event log.

None of this is trusted on the strength of a screenshot: `script-input.test.ts` compiles a script
to browser events, replays them back through the real `LiveInput`, and asserts the resulting
simulation reaches **the same state hash** as the script itself — headlessly, in `npm run verify`.

## How it fits together

```
Node (dev-server process)                    Browser page
  scene JSON ─▶ World                          import map ─▶ three, @aegis/core,
  composed game plugin ─▶ Schedule                           @aegis/content, @aegis/mode-*
  fixed-step accumulator (wall clock)          POST /frame {input} ─▶ {tick, snapshot, events}
  live InputSource fed by the page             createWorld().restore(snapshot)   ← a *copy*
  world.snapshot() per frame                   RenderAdapter.sync(copy) ─▶ THREE.Scene
```

- The simulation runs in Node on a **fixed** timestep. Wall-clock enters in exactly one place —
  `loop.ts`, the accumulator — which converts real time into a whole number of `1 / tickRate`
  steps. The simulation never sees a variable `dt`, so a played session and a scripted headless
  run of the same input produce the same state hash (`session.test.ts`).
- The page renders a `WorldSnapshot` — plain JSON, exactly what CHARTER principle 4 promises — by
  restoring it into a throwaway `World`. The renderer therefore holds a _different_ world from the
  simulation and is structurally unable to write to it.
- Live input is mapped through `bindings.ts` onto the same logical actions, axes, look deltas and
  pointer samples the `.input` DSL compiles to. A human and a script reach the simulation through
  one identical door.
- There is **no bundler**. Every `@aegis/*` package except the harness is free of Node built-ins
  and is emitted as plain ESM with explicit `.js` extensions, so the page resolves them with an
  import map against the built `dist/` folders. three.js remains the only third-party runtime
  dependency (ADR-0005).

## What each adapter draws

Collision-derived geometry is read straight from world state. The table describes the compatible
primitive representation; optional presentation data replaces surfaces/actor visuals and adds
view-only dressing without altering those mechanical coordinates.

| Mode       | Camera                                                                                                                      | Geometry                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| platformer | orthographic side-on, from the `PlatformerCamera` rig (`viewHeight` is the zoom)                                            | the baked `PlatformerCollision` tilemap as solid blocks and low red hazard blocks; the player sized from its `TileCollider` with a facing pip from `BodyState.facing`; other damageable bodies; `KinematicPlatform` solids; translucent goal/hazard `Trigger` volumes                                                                                             |
| iso        | orthographic at the classic 2:1 isometric elevation, following `IsoCamera.target`                                           | the baked `NavGrid` as floor plates and wall columns; actors on their `GridPosition`, interpolated along the resolved path by `progress`, with camera-facing health bars; the `Blocking` door (which vanishes when the switch removes the tag); switch/exit trigger pads                                                                                          |
| fps        | perspective at `Transform.position + FpsCamera.eyeHeight`, oriented by `LookState` through the mode's own `forwardFromLook` | every solid `FPS_COLLISION` cell extruded from its `floor` to its `ceil` (door cells in orange, and they disappear when the game clears `solid`); a ground slab at each walkable cell's own floor height, which is what makes the coolant pit a hole; a dim ceiling; `HitBox` entities drawn exactly where the hitscan resolves them; translucent trigger volumes |

## Layout

| File                                       | Purpose                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `adapter.ts`                               | the `RenderAdapter` contract, keyed `Object3D` reconciliation, scene/camera helpers |
| `adapters/{platformer,iso,fps}.ts`         | one adapter per mode; `adapters/index.ts` selects by mode                           |
| `appearance.ts`, `primitives.ts`           | role palette + authored appearance, shared geometry/materials                       |
| `loop.ts`                                  | the fixed-timestep accumulator — the only wall-clock read in the package            |
| `live-input.ts`, `bindings.ts`             | browser reports ➜ `InputFrame`s, and the key/mouse binding table                    |
| `script-input.ts`                          | a game's `.input` script ➜ browser events, and back again for the round-trip test   |
| `session.ts`                               | world + schedule + live input, steppable in real time                               |
| `catalog.ts`                               | `GameDefinition` and scene loading — game-agnostic; the caller supplies the entries |
| `dev-server.ts`, `pages.ts`, `protocol.ts` | the `node:http` server, its HTML, and the wire types                                |
| `static-site.ts`                           | the static (GitHub Pages) export: pages, import map, module-graph crawl             |
| `client/`                                  | the browser entries: `boot.ts` (dev server), `static-boot.ts` (static), input, HUD  |
| `play.ts`, `capture.ts`                    | serve a catalogue, and screenshot a catalogue                                       |
| `../../poc/poc-games.mjs`                  | **the composition root**: wires the three PoC games into a catalogue                |
| `../../poc/build-site.mjs`                 | the same catalogue, exported as the static site                                     |

An adapter owns **no GPU state** — it builds a `THREE.Scene` and a `THREE.Camera` and nothing
else — so it constructs and runs headlessly in Node, which is how the non-interference proof runs
it against a live world.

## Why the game wiring lives outside `src/`

`@aegis/render-three` is _engine_. `scripts/check-deps.mjs` forbids anything under `packages/`
from importing anything under `games/` — by package name and by relative path, with a dedicated
message: _"the engine must NEVER depend on a game"_. That is the right rule, and it bites:

```
packages/render-three/src/probe.ts imports "@aegis/game-iso" which is not allowed for @aegis/render-three
packages/render-three/src/probe.ts reaches into games/ ("../../../games/iso/src/index.js")
  — the engine must NEVER depend on a game
```

So nothing under `src/` knows a game exists. `startDevServer({ games })` takes a catalogue,
`play(games)` serves one, `capture(games)` photographs one. `poc/poc-games.mjs` is the composition
root: it imports the three built game packages by ordinary bare specifier and hands the catalogue
over.

That file sits under `packages/render-three/` but outside the compiled output and outside the
package's `exports`/`files`, so it is not part of the shipped artefact. It does resolve
`@aegis/game-*` through workspace hoisting rather than a declared dependency — which check-deps
rightly refuses to let the engine declare. The durable home for this wiring is a project that is
_allowed_ to depend on both sides; an `aegis play` subcommand in `@aegis/cli` would satisfy
CHARTER principle 9. That is a PM call on the DAG.
