# Coyote Gap: The Amber Traverse

Original art and sound for the existing Coyote Gap playthrough. The expedition engineer,
furnace beetle, industrial rail ferry and signal beacon share a warm brass / cool slate palette.
The distant canyon is an original generated painting; sprites, terrain, machinery, silhouettes
and sound cues are generated from the committed sources. No third-party characters or samples
are included. See `provenance.json` for authorship, license and the painting's creative prompt.

## Reproduction

From the repository root after the normal workspace install:

```powershell
node games\platformer\assets\source\generate.mjs
node games\platformer\assets\source\generate-audio.mjs
```

Both commands also accept `--out <directory>` for isolated regeneration. They use Node and the
repository's existing formatter, not a native image/audio toolchain. Vector, metadata and audio
outputs are deterministic. Regenerating `canyon-vista.jpg` through the recorded image service
prompt is **not** bit-identical; the committed JPEG is the canonical background.

`contact-sheet.html` previews the source sheets. `atlas.json` records intrinsic dimensions,
top-left pixel rectangles and alignment landmarks. Explicit transparent `clear` frames terminate
stomp and impact feedback without inventing an opacity or particle system in the game.

## Presentation wiring

[`poc/platformer.mjs`](../../../poc/platformer.mjs) is the sole renderer/game composition root.
It declares the local file closure, normalized atlas rectangles, cached unlit materials,
state animations, event effects, parallax, audio and shared HUD. None of these are components or
resources in the simulation. The game plugin, scene and input script are not modified.

| Surface          | Contract                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cliff/deck faces | Instanced unit planes derived from the existing collision layer; the top edge remains the actual standing surface. Standalone 128px maps avoid atlas-edge bleeding.      |
| Engineer         | Collider-relative foot alignment uses source pixel `(80, 180)`; the helmet/scarf are cosmetic overhang. State frames follow grounded/velocity/facing facts.              |
| Beetle           | Transform-driven patrol motion selects walking/facing; death feedback ends on a transparent frame while the authoritative dead entity remains untouched.                 |
| Ferry            | Source deck spans pixels 17 through 495 at row 35; its three-unit width and top align to the existing moving collider.                                                   |
| Hazards          | Spike and molten-rock paintings fill their actual trigger bounds, including the lethal height, instead of suggesting that only bottom-row tiles are dangerous.           |
| Beacon           | The base rests on the goal ledge. The existing completion event activates the signal and celebration.                                                                    |
| Effects          | Short feet-attached landing puffs, stomp flash, ferry signal and bounded event bursts use shared tick/event handling; no gameplay camera shake or simulation changes.    |
| Audio            | Original mono 16-bit PCM at 22050 Hz; six short cues and a twelve-second air loop. The shared host owns gesture unlock, mute, pause, restart, decoding and voice limits. |

The opaque cliff faces sit behind the retained collision geometry, so the shared diagnostic
toggle can reveal the underlying mechanical tiles. Decorative objects never become colliders.
The camera-anchored painting continues to cover the view with reduced motion; the wide secondary
layers remain present when their parallax is disabled.

All textures, samplers and materials are borrowed from the shared presentation library. The
adapter owns only sampled motion history and scene instances, clearing history on reset/remount
and removing despawned actors. It neither fetches assets nor disposes the library's resources.
Missing assets remain hard errors. Dev and static export consume the same presentation source
and inventory; authoring sources/contact sheets are not runtime dependencies.

The original 400-tick final hash remains `d813e4e19db7444d`; its trajectory pin remains
`79d373c4785825ca`. B1 covers integration and headless regression checks. Actual dev/static
vista, ferry and victory inspection, plus browser lifecycle/performance acceptance, belong to
the separately coordinated B2 pass; asset sheets alone are not final visual acceptance.
