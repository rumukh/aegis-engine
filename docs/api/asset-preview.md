# Standalone asset preview

Opt-in cinematic materials and reflection captures use the shared
[cinematic presentation pipeline](./cinematic-presentation.md). Descriptor previews retain its
PBR map closure, quality and output transform settings; they still do not create a gameplay world.

`aegis preview` renders an asset in a studio, not in a game. It does not accept a scene,
resolve a game plugin, create a world, run systems, or replay input. A model, image, or
material can be reviewed before any game exists.

The workflow uses the same `preparePresentation`, checked local file closure,
`loadPresentationAssets`, model instances, texture sampling, and materials as production
presentation. It has its own asset-only browser entry, not the game client at tick zero.

Use [`aegis import`](./asset-import.md) to package a reviewed local GLB/glTF and
its exact dependencies with explicit provenance. Preview the resulting
`asset.presentation.json`; import does not replace visual or animation review.

## One-shot captures

Build the workspace once. Subsequent asset edits need no workspace rebuild.

```powershell
npx aegis preview games\platformer\assets\engineer.svg --out captures\engineer.png --json
npx aegis preview games\iso\assets\operative.gltf --clip walk --time 0.25 --out captures\operative.png --json
npx aegis preview games\fps\assets\generated\kestrel-security.glb --out captures\kestrel.png --width 1280 --height 720 --json
npx aegis preview games\fps\assets\generated\vaultline-rifle.glb --view left --out captures\rifle.png --json
```

Each invocation writes the actual studio canvas to the requested PNG and writes
`<name>.png.preview.json` beside it. The managed browser and loopback server are then closed.
The PNG contains the specimen, not the operator interface. `--json` returns the same versioned
capture report; errors use the CLI's diagnostic envelope on stderr and a nonzero exit.

Supported inputs are uncompressed glTF 2.0 (`.gltf` or `.glb`), PNG, JPEG, WebP,
self-contained SVG, and `presentation/1` JSON. A direct file needs no manifest, scene,
catalog, or `aegis.json`. Its preview ID is `preview-asset`.

Only installed local modules are used. Compressed glTF requiring a decoder, remote
dependencies, escaping paths, active SVG, bad buffers, and undecodable images are refused
rather than replaced with a thumbnail or fallback mesh. The existing production limits
apply: 32 MiB per file, 64 MiB for the selected closure, and 256 files. Portable asset names
and relative dependencies must obey that same preflight policy.

## Selecting from a presentation descriptor

The descriptor is structurally validated, but only the selected asset/material closure is
prepared and loaded. Entity bindings, decorations, effects, audio, HUD, and game environment
settings are not instantiated.

| Selection       | CLI                              | Meaning                                                  |
| --------------- | -------------------------------- | -------------------------------------------------------- |
| Model           | `--model <id>`                   | Instantiate that declared glTF asset once.               |
| Texture         | `--texture <id>`                 | Display that texture on an aspect-correct plane.         |
| Atlas frame     | `--texture <id> --frame <name>`  | Use the declared normalized atlas rectangle.             |
| Material sample | `--material <id> --shape sphere` | Use the production material on a sphere, cube, or plane. |
| Model override  | `--model <id> --material <id>`   | Override the model's materials with a declared material. |

`--material` refers to a descriptor material ID, not an internal glTF material name.
Ambiguous descriptors require an explicit selection; missing IDs and frame names report
the available choices. The persistent page lets an operator select those same declarations.

Declared standard-material overrides preserve glTF's flat shading when a mesh has no
`NORMAL` attribute, in both the studio and game presentation. A cached library-owned
material variant is used; geometry is not modified and normals are not synthesized.
Normal-bearing meshes retain their authored normals and the original declared material.

Descriptor asset paths are relative to its directory by default. Set `--asset-root <dir>`
when the descriptor uses another local root. The Node API takes an absolute `assetRoot`.
Direct file inputs instead use their own directory; they do not accept `assetRoot`.

## Studio controls

Models are framed automatically from their posed mesh bounds. Textures preserve aspect
ratio and atlas cropping. Camera coordinates stay in asset units with +Y up; no physics or
game camera is involved.

| Option                  | Values                                                                            |
| ----------------------- | --------------------------------------------------------------------------------- |
| `--view`                | `three-quarter`, `front` (+Z), `back` (-Z), `left` (-X), `right` (+X), `top`      |
| `--projection`          | `perspective` or `orthographic`                                                   |
| `--camera` / `--target` | A pair of comma-separated `x,y,z` coordinates; overrides the named view           |
| `--lighting`            | `studio`, `neutral`, or `warm`; model-embedded lights do not override the studio  |
| `--background`          | A quoted six-digit hex color, default `"#18212f"`                                 |
| `--clip` / `--time`     | An exact model clip name and sample time in seconds; default is rest pose at zero |
| `--width` / `--height`  | Exact PNG dimensions, default 1024 by 768                                         |

For negative CLI camera coordinates, the `--camera=-3,2,4` spelling avoids treating the value
as another option. Dimensions must be integers between 64 and 4096, with no more than
8,388,608 total pixels. A fixed clip time must be within the clip's duration; it is not silently
clamped or wrapped.

The operator page supports orbit, pan, zoom, reset-to-fit, background and lighting choices,
clip selection/play/scrub, asset/material/frame selection, and PNG capture. It displays mesh,
triangle, vertex, material, texture, bounds, and revision information. Focus the viewport for
arrow-key pan, `+`/`-` zoom, and `F`/`Home` fit; dragging orbits and right-dragging pans.
Controls are labelled, the page resizes, and status/error messages are live regions.

Playback is studio animation only and starts paused. The reduced-motion preference pauses
playback. Paused studios render on changes, not through a game or simulation loop.

## Keep the workbench warm

```powershell
npx aegis preview games\iso\assets\access-console.gltf --clip activate --time 0.4 --serve --watch --out-dir captures --json
```

The first JSON response has discriminator `asset-preview-session/1` and includes `url`,
`token`, `revision`, `outputDir`, and `coldStartMs`. Open that exact loopback URL in a browser
or the browser canvas. Keep the command attached and stop it with Ctrl+C.

`--watch` implies `--serve`. Without watch, **Reload source** and the reload API still work.
`--out-dir` explicitly enables host capture writes. `--out <png>` also enables writes in that
file's directory and makes an initial capture before serving. Do not combine the two.
A server started without either flag can display assets, but cannot write capture files.

On an edit, the host re-prepares a complete selected local closure. Files are served through
revision directories such as `assets/r3/`, preserving the production loader's literal
extension and closure checks. The checked-byte reader is never bypassed. Changed dependencies,
including textures, are decoded into a new library; older asynchronous loads cannot overwrite a
newer request. Successful replacement disposes the previous instance and its owned library.

Camera position, pan, zoom, clip, and sample time survive reloading the same specimen.
Changing to a different specimen refits and resets its clip. A bad edit reports the new failed
revision and labels any last-good specimen that remains visible. Such pixels cannot satisfy a
capture of the failed revision. Repair the source and reload to recover.

If an otherwise valid model edit removes or renames the selected clip, or shortens it past
the retained sample time, the new revision remains failed until the operator explicitly
chooses a current clip/time or **Use rest pose for this revision**. The last-good specimen
stays labeled while the new decoded model waits; no requested animation is silently replaced.
The API can repair the same revision with `configure({ clip: null, time: 0, playing: false })`
or an explicit valid clip/time. This does not restart the server, browser, or game.

A revision is a session-local attempt number; a fingerprint identifies checked content.
Explicit reloads can create new attempt numbers for identical content. Unchanged filesystem
notifications and writes of unrelated capture output do not create content revisions.

Logical source/root parents are watched non-recursively with narrow entry filters, while
current resolved asset roots carry the dependency watches. Retargeting a directory junction,
renaming a dependency directory, or replacing a directory handle causes the appropriate
watches to be rebound. Reloading does not leave a native watch attached to an old target.
This does not recursively scan or watch a source root's parent directory.

## Warm Node API

Use `@aegis/render-three/preview`, not the renderer's general barrel, to avoid game-host imports.

```js
import { resolve } from 'node:path';
import { startAssetPreview } from '@aegis/render-three/preview';

const preview = await startAssetPreview({
  source: resolve('games', 'iso', 'assets', 'operative.gltf'),
  outputDir: resolve('captures'),
  watch: true,
  settings: { clip: 'walk', time: 0 },
});

try {
  await preview.capture({ filename: 'walk-start.png', width: 640, height: 480 });
  await preview.configure({ clip: 'walk', time: 0.25, view: 'front' });
  await preview.capture({ filename: 'walk-quarter.png', width: 640, height: 480 });
  await preview.reload();
  const state = await preview.state();
  await preview.capture({
    filename: 'after-reload.png',
    revision: state.revision,
    width: 640,
    height: 480,
  });
} finally {
  await preview.close();
}
```

All captures in this example reuse the same browser, page, and renderer. There is no game
start between them. `reload(selection?)` resolves after the new specimen is ready or rejects
with its diagnostics. `configure(settings)` changes camera, lighting, clip/time, playback, or
material-sample shape. `capture(request)` serializes with other managed operations and returns
an `asset-preview-capture/1` report.

For an exact stored camera, settings accept `camera: { position, target, zoom?,
orthographicHeight? }` and `projection`. The receipt records the actual camera used for the
requested output aspect, not just the name of a view. Explicit camera zoom is not fitted a
second time for portrait output, so a stored recipe preserves its framing. `clip: null`
selects rest pose.

`startAssetPreviewServer(options)` is the browser-free HTTP host for embedders. It performs
preflight and serves the operator page, but cannot itself produce PNGs without attached
automation. `startAssetPreview(options)` adds the managed capture browser and writer.
An explicitly supplied `browser` is borrowed: closing the preview closes only its page.
Otherwise the preview terminates its own browser and removes its temporary profile.

## Local automation protocol

The server binds only `127.0.0.1`. Mutating requests require `Content-Type: application/json`
and `X-Aegis-Preview-Token` with the startup token. Origin and Host must match the exact
loopback endpoint. No remote runtime dependency, CORS publication, arbitrary source-path
change, or arbitrary output-path API is provided.

| Route                | Request / result                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `GET /api/state`     | `asset-preview-state/1`: current filesystem revision and prepared inventory              |
| `GET /api/events`    | Same state through server-sent events                                                    |
| `POST /api/reload`   | `{}` or `{ "selection": { "kind": "model", "id": "hero" } }`; re-prepares the source     |
| `POST /api/studio`   | `{}`; managed browser status, recipe, and statistics                                     |
| `POST /api/settings` | A settings object; configures the managed browser                                        |
| `POST /api/fresh`    | `{ "revision": 3 }`; checks the current source and closure                               |
| `POST /api/capture`  | `{ "revision": 3, "filename": "hero.png", "width": 640, "height": 480, "settings": {} }` |

**Prepared is not rendered.** Filesystem state uses `preparing`, `prepared`, `failed`, and
`closed`. Browser state uses `loading`, `ready`, `failed`, and `disposed`. Read the browser
status after an HTTP reload, or use the Node `reload()` method that waits for it.

HTTP and event-stream delivery can overlap. Duplicate states join the same asset load, and a
late `preparing` message cannot undo an already prepared revision. Browser `ready()` follows
the current load; an explicit revision still rejects if superseded. A lost connection disables
capture until the server confirms its current prepared revision again. Changing view settings
does not count as that confirmation, and a closed revision cannot be reopened by a stale message.

HTTP capture requires an explicit revision. Loading, failure, stale revision, or source drift
cannot return a last-good capture as a success. Revision refusal is HTTP 409, access refusal
403, and invalid content/settings 422; the body contains `diagnostics` and the current
revision. Correct the problem, inspect the current state, and retry that revision.

Output names are portable PNG **basenames** of at most 100 characters. Paths, traversal,
device names, and aliases of source files, the descriptor, or prepared dependencies are
rejected for both PNG and sidecar. The output directory is fixed at startup. Keep captures
separate from authored inputs even though source-alias writes are refused.

## Capture evidence and timing

The versioned sidecar records source bytes/SHA-256, dependency paths/bytes/SHA-256, the closure
fingerprint, revision, rendered asset/selection, clip and time, camera, lighting, background,
posed bounds and mesh/resource statistics, exact PNG dimensions/path/SHA-256, and host/browser
information. `poseSampleHash` is a bounded sample of posed vertices, not a simulation hash or
a proof of every vertex. `readPreviewCapture(sidecar)` checks the accompanying PNG against its
recorded dimensions and fingerprint.

Direct input has `provenance.status: "user-supplied"` with `author`, `license`, and `source`
all `null`. Descriptor declarations have `status: "declared"` and retain their supplied values.
Declared provenance is not an independent license audit. Nothing uploads or publishes the
asset or capture.

Freshness means source and checked dependency bytes matched before and after capture, at the
reported `checkedAt`; it does not promise the source cannot be edited afterwards. The JSON is
published last as the capture's commit marker. If PNG publication succeeds but sidecar writing
fails, the operation still fails; a PNG alone is not a successful capture report.

| Measurement             | Scope                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| `sessionColdStartMs`    | Start through initial browser specimen readiness                        |
| `browserStartMs`        | Owned browser launch; `null` when a browser was explicitly borrowed     |
| `prepareMs`             | Current revision's filesystem preflight and fingerprints                |
| `loadMs`                | Current browser specimen's decode/instantiation                         |
| `renderMs` / `encodeMs` | Canvas render call and PNG encoding; not isolated GPU execution time    |
| `captureMs`             | Managed capture through browser readback and post-capture source checks |
| `pngWriteMs`            | PNG publication, excluding the later sidecar write                      |
| `totalMs`               | Current capture through PNG publication, excluding sidecar finalization |
| `lastReloadMs`          | Most recent explicit Node API reload; `null` if none was measured       |

For complete iteration latency, time the outer reload-and-capture calls, including sidecar
publication. `preview.browser.test.ts` records those paired measurements in
`preview-benchmark.json` when `AEGIS_PREVIEW_EVIDENCE_DIR` is set. It retains a 1,000 ms warm
median target rather than turning an absolute performance threshold into a timing-sensitive CI
assertion. The actual samples and host load must accompany a performance claim.

On 10 September 2026, Windows x64 / Node 25.6 measured a **130 ms median** across 11 warm
reload-and-capture samples at 640 by 480 pixels: five edited console textures and six Kestrel/
rifle model reloads, including PNG and sidecar publication. Samples ranged from 109 to 215 ms
at approximately 29% whole-machine load. Separate, fully cold CLI examples at 1024 by 768 took
8.4-12.0 seconds to reach initial readiness on the shared workstation. These are local
observations, not portable guarantees: use the persistent workbench for rapid iteration.

Recipes and source fingerprints are stable evidence. **Pixel identity across GPUs, browser
versions, and rendering backends is not guaranteed.** This workflow assesses assets, not
gameplay; continue using the existing headless and browser game acceptance surfaces for that.

The no-game regression guards reject world/simulation creation and game-host imports on both
Node paths, and run the studio controller with those guards armed. A separate browser-classified
spec uses the real production loader and real PNGs, animation poses, edit/failure/recovery,
operator controls, resource lifetimes, and the built one-shot CLI.
