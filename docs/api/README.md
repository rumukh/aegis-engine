# API reference

The **authoritative API contract for every package is the TSDoc on its exported types**, in the
package's `src/`. Each public interface, function and type carries semantics documentation, and
each barrel file (`src/index.ts`) has a `@packageDocumentation` overview. This document is the
index into that surface; read it alongside [`../architecture.md`](../architecture.md).

The contracts are type-only: function bodies are `notImplemented()` stubs (or, where trivial and
non-gameplay, real plumbing). Implementation sessions fill in behaviour **without changing the
exported signatures** — the whole point is that five sessions can build against these in parallel.

## Public surface by package

| Package                  | Barrel                                                                                 | Key exported contracts                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@aegis/core`            | [`packages/core/src/index.ts`](../../packages/core/src/index.ts)                       | `Entity`, `World`, `ComponentType`/`defineComponent`, `QueryDescriptor`/`QueryResult`, `Schedule`/`System`/`Simulation`, `EventBus`, `InputFrame`, `Prng`, `StateHash`, `Validated`, `GameMode`, `math/*`                                                      |
| `@aegis/content`         | [`packages/content/src/index.ts`](../../packages/content/src/index.ts)                 | `SceneFile`/`PrefabFile`/`TilemapFile`, `createSceneBuilder`/`SceneBuilder`, `ComponentRegistry`/`createRegistry`, `parseScene`/`validateScene`/`instantiateScene`, `Diagnostic`/`ContentCode`, visual components `Sprite`/`Model`/`Light`                     |
| `@aegis/harness`         | [`packages/harness/src/index.ts`](../../packages/harness/src/index.ts)                 | `runScene`/`RunOptions`/`SimResult`, `Invariant`/`InvariantError`, `expectSim`/`GameplayAssertions`, `GameTest`/`defineGameTest`/`runGameTest`, `parseInputScript`/`InputScript`, `Recording`/replay, `SemanticFrame`/`AsciiView`/`ViewProvider`, `ModePlugin` |
| `@aegis/mode-platformer` | [`packages/mode-platformer/src/index.ts`](../../packages/mode-platformer/src/index.ts) | `platformerPlugin`, components (`Velocity`, `PlatformerController`, `BodyState`, `TileCollider`, `PlatformerCamera`), `PLATFORMER_SYSTEMS`, `PlatformerViewProvider`                                                                                           |
| `@aegis/mode-iso`        | [`packages/mode-iso/src/index.ts`](../../packages/mode-iso/src/index.ts)               | `isoPlugin`, components (`GridPosition`, `IsoActor`, `MoveOrder`, `Blocking`, `IsoCamera`), `ISO_SYSTEMS`, `IsoViewProvider`                                                                                                                                   |
| `@aegis/mode-fps`        | [`packages/mode-fps/src/index.ts`](../../packages/mode-fps/src/index.ts)               | `fpsPlugin`, components (`CapsuleBody`, `FpsController`, `LookState`, `FpsCamera`, `Hitscan`, `Health`), `FPS_SYSTEMS`, `FpsViewProvider`                                                                                                                      |
| `@aegis/render-three`    | [`packages/render-three/src/index.ts`](../../packages/render-three/src/index.ts)       | `createRenderer`/`RenderAdapter`/`RendererOptions`, `startDevServer`/`DevServer`/`DevServerOptions`                                                                                                                                                            |
| `@aegis/cli`             | [`packages/cli/src/index.ts`](../../packages/cli/src/index.ts)                         | `main`, `COMMANDS`/`Command`/`CommandContext`, `parseArgs`/`ParsedArgs`, `CliIO`, `findCommand`, `topLevelHelp`                                                                                                                                                |

## Generating HTML (optional)

The TSDoc is designed to feed [TypeDoc](https://typedoc.org). It is intentionally **not** wired
into the toolchain by default (it would add a dependency pulled through the corporate proxy and is
not needed for the green build). To generate a static site locally:

```
npm i -D typedoc            # installs via the pinned proxy in .npmrc
npx typedoc --entryPointStrategy packages packages/*
```

Until then, the `src/` TSDoc is the contract of record, browsable directly or via editor hover.
