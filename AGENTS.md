# Build a game in Aegis

## First playable loop (no browser)

Start in a clean directory with the built `aegis` CLI on `PATH`. Working in a checkout?
Run `npm ci` and `npm run build` once at its root, then use `npx --no-install aegis` in
place of `aegis` inside the checkout. See [environment setup](ENVIRONMENT.md).

<!-- quickstart-commands -->

```sh
aegis scaffold game first-game --mode platformer
aegis validate first-game/first-game.scene.json first-game/first-game.input first-game/first-game.presentation.json --game-context --strict
aegis run first-game/first-game.scene.json --input first-game/first-game.input --ticks 120 --json
aegis inspect first-game/first-game.scene.json --input first-game/first-game.input --tick 120 --query "has:Player" --limit 1 --resources none --json
aegis test "first-game/*.gametest.mjs" --json
```

Read **`events`** in the run report first: `player.landed` means contact with the floor actually
happened. A seed and final hash alone do not prove that an input was consumed. The inspect query
returns one player's components, not a level-sized collision grid. Check `matched`, `total`
and `page.returned`; request the full world only if the focused result doesn't answer your question.
The test should find and pass one gameplay spec.

The scaffold writes these files under `first-game/`:

<!-- quickstart-files -->

```text
aegis.json
first-game.gametest.mjs
first-game.input
first-game.presentation.json
first-game.scene.json
```

Edit the level **in the scene** (`resources["platformer.tilemap"]`), not in a separate tilemap file.
The manifest selects the plugin and entry files; the `.input` is a script, not a keyboard mapping.
Use `aegis describe first-game/first-game.scene.json --json` for legal actions/axes, event
payloads, resource schemas and component fields. Missing declarations are not empty vocabularies.

## Inspect a shipped FPS game

From the **repository root** after building; the plugin flag selects the actual game, not the stock mode:

<!-- quickstart-fps -->

```sh
aegis inspect games/fps/levels/sector-breach.scene.json --plugin "@aegis/game-fps#sectorBreachPlugin" --input games/fps/play/sector-breach.input --tick 9 --view frame --json
```

Read the perspective camera, projected entities and visibility counts. This frame answers a
different question from the exact world query above; entities outside the frame still exist.

## Go deeper

- [Numbered authoring reference](GAME-AUTHORING.md): the Ledge Hop scene, plugin and test
  templates; input grammar (§4), headless inspection (§5), assertions and golden pitfalls (§6),
  debugging (§7) and known rough edges (§9). Existing `AGENTS.md §…` citations use these sections.
- [Agent workbench](docs/api/agent-workbench.md): declaration formats, validation scope,
  diagnostic examples and bounded queries. [Game distribution](docs/api/game-distribution.md):
  how to play or export from a game's own manifest.
- [Architecture](docs/architecture.md), [charter](CHARTER.md) and [working agreement](docs/working-agreement.md).
  Respect package ownership and keep simulation deterministic. `npm run verify` is the workspace
  gate; report which checks you actually ran and which remain pending.
