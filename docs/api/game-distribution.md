# Distributing a mode-based game

`aegis play` and `aegis export` take a **game directory or its `aegis.json`**, defaulting to the current directory. They don't import the demo catalogue. `npm run play` and `npm run build:site` at the engine root still serve/export the four-game collection at `play/platformer/`, `play/iso/`, `play/fps/` and `play/horror/`.

## From an empty directory

Use a built Aegis CLI on `PATH`. For example, after `npm ci` and `npm run build` in the engine checkout, add **that checkout's** `node_modules/.bin` to `PATH` before changing directories. This selects the local executable; it is not an alias the game needs. From a new directory **outside** the checkout:

```sh
aegis scaffold game first-light --mode platformer
cd first-light
aegis validate first-light.scene.json first-light.presentation.json first-light.input
aegis test
aegis play . --base-path /reviews/live/
```

The last command prints the canonical game URL (by default `http://127.0.0.1:5173/reviews/live/play/first-light/`). It does not launch a browser. `--port 0` asks for an available port. Stop that process before the next command, or use another terminal.

```sh
aegis export . --out ../web/reviews/build
```

Serve `../web` with an ordinary static HTTP server. The catalogue is at `/reviews/build/`; the playable entry is `/reviews/build/play/first-light/`. No rewrites, API or absolute public path are needed. Preserve the directory structure and serve `.js` as JavaScript. Do not open the HTML with `file:`. Move the same output to a different prefix without rebuilding.

An installation of the built `@aegis/cli` and its runtime dependencies works without the source checkout too: the renderer locates the **installed** packages. No Vite aliases, game workspace, global `NODE_PATH`, or edits under `poc/` are required. This mode-based CLI isn't part of the four-package [action-runtime SDK](standalone-consumers.md). The private workspace packages aren't promised to be available on a public registry.

## The game manifest

```json
{
  "id": "first-light",
  "title": "First Light",
  "objective": "Cross the room.",
  "scene": "./levels/start.scene.json",
  "presentation": "./art/game.presentation.json",
  "input": "./play/first-light.input",
  "plugin": "platformer",
  "tests": ["./first-light.gametest.mjs"],
  "rights": "./release/asset-rights.json"
}
```

- Only `scene` is required by the new commands. `id` defaults to the game directory's name; supply a slug of letters, digits, `_` and `-` if that name isn't URL-safe. `title` defaults to the scene name; `blurb` and `objective` are optional display text.
- `scene`, `input`, `presentation` and `rights` are local files **relative to `aegis.json`**, not the invoking shell. Use paths inside the game directory. Missing files, malformed declarations, invalid scenes, script statements and presentation bindings are errors, not reasons to try a different game. Omit optional fields instead of supplying `null` or empty paths.
- `presentation` points to a `presentation/1` JSON document. Each runtime asset's `src` is relative to **that document's directory**; external glTF buffers and images resolve relative to their model. The same checked local closure is used on both hosts.
- `input` is an example DSL script, validated against the selected plugin's declared vocabulary when available. It is downloadable under **Controls** at `./example.input` on both hosts; it does not automatically take control from a player.
- `plugin` keeps its existing meaning. Use a stock name (`platformer`, `iso`, `fps`), `./dist/game.js#gamePlugin` relative to the manifest, or an installed package and export. With no export suffix, a valid default export or a single unambiguous plugin is accepted. Game-local packages take precedence over the CLI installation. Omission requests the scene's stock mode and retains the usual unowned-marker check. Plugin code is trusted executable code, not data. Use built ESM suitable for a browser; a custom plugin and its ordinary JS dependencies are bundled, sharing the renderer's engine modules. Declare runtime media in the presentation, not through ad hoc `fetch` calls or a file loader.
- Existing `plugin`/`tests`-only manifests keep working for existing commands. To use either new command with such a game, add an explicit `scene` instead of relying on a glob or some other game's catalogue.
- `--out` is relative to the invoking shell; its default is `<game>/dist-site`. A successful export replaces that directory. The CLI refuses to replace the game, an arbitrary nonempty directory or its ancestors. `--json` includes the entry, output path and inventory.

## Release preflight: media, not legal clearance

Ordinary exports default to `--release evaluation`. The catalogue and `release.json` identify the build as such. **Evaluation does not imply permission to distribute commercially.** Every build still validates the assets and copies their checked bytes. The scope of the commercial gate is the files shipped by the presentation system; it does not audit code, third-party software licenses, or settle ownership.

1. Export for evaluation. Read `release.json`: it records every runtime file's game, output path, SHA-256, provenance and commercial status. Review the complete list, including an external texture or `.bin` that exists **only** as a glTF dependency. Unreferenced files in the author's directory do not ship.
2. The release owner checks the source grant, models/textures/audio and any embedded media, generation/tool restrictions, permitted uses and required notices. An engine license, tool license, import receipt, visual approval or parent model's review is **not** a commercial grant.
3. Put the decisions in version-controlled `asset-rights/1` JSON and point the game's `rights` field to it. Each entry needs its exact **asset-root-relative path** (remove `assets/<id>/` from the inventory path), SHA-256, `commercial` decision (`cleared` or `restricted`), a named reviewer and a public evidence reference. These last fields are copied into the public report; do not include private contract text. A digest covers embedded bytes; every separate dependency needs its own row.

   ```json
   {
     "aegis": "asset-rights/1",
     "files": [
       {
         "path": "models/runner.glb",
         "sha256": "<replace with the 64 lowercase hex digits from release.json>",
         "commercial": "cleared",
         "reviewer": "<responsible release owner>",
         "evidence": "<review record covering commercial use of this exact media>"
       }
     ]
   }
   ```

4. Run `aegis export . --release commercial` (collection: `npm run build:site -- --release commercial`). Missing reviews are `unreviewed`, a hash mismatch is `changed`, and `restricted` blocks regardless of other files' decisions. Use `"commercialUse": "restricted"` in an asset's `provenance` to preserve a known upstream limitation through import and presentation. This veto wins even over a positive review of the same bytes; no provenance field grants permission. The failure identifies the game, path, provenance and remedy; no previous export is replaced. Editing the output receipt does not grant rights on a later build. Resolve the underlying issue and re-review before claiming clearance.

The [Cable Warden approval](../../games/horror/assets/source/trellis-monster/approval.json) retains research/evaluation-only licensing. Its [import receipt](../../games/horror/assets/imported/responder-trellis/import.json) and [release record](../../games/horror/assets/asset-rights.json) identify the actual `imported/responder-trellis/model/responder.glb` in the collection, not an alternate generated model. The full evaluation build succeeds; a commercial export of the current collection must fail.

## Acceptance for the browser reviewer

The headless [standalone installation test](../../test/standalone-game.test.ts) runs the real CLI in a separate package installation with no access to the source checkout, exercises live input and independently links the relocated static entry. It does **not** claim to prove browser rendering. The separate [browser acceptance](../../test/standalone-game.browser.test.ts) is for a dedicated browser runner:

```sh
npx vitest run test/standalone-game.browser.test.ts
```

Set `AEGIS_GAME_TEST_ROOT` to a writable directory outside the checkout for physically external acceptance (`RUNNER_TEMP` is used on CI). The goals are the same for both hosts: the actual scaffold and its presentation appear under the requested prefix, the simulation advances, and ordinary rightward input visibly moves the player. The example script remains reachable under that prefix. For the relocated static build, require a working `boot.js`, no missing modules or console failures and **no `/api/` requests**. A catalogue, screenshot or green HTTP status alone is not a pass.
