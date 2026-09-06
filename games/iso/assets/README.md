# Server Vault asset kit

Original procedural art and sound for Aegis's Server Vault showcase. No downloaded models,
stock textures, external fonts, reference-image copies, or third-party audio are used.
All source and generated assets in this directory are MIT licensed; see `LICENSE.txt`.
`provenance.json` records each generated file's size, digest, and geometry budget.

Regenerate from the repository root:

```powershell
node games\iso\assets\source\generate.mjs
```

The source uses only Node built-ins. An optional output-directory argument produces the same
kit elsewhere without touching the shipped files. Raster textures use an original tiny pixel
alphabet and deterministic grain; sound effects are bounded PCM synthesis, not sampled media.
glTF buffers are embedded, with local PNG references for rack faces, console screens, and
partition tops. Keep those relative dependencies beside the models when packaging.

## Art and placement

The operative is a slim, pale-helmeted infiltration suit with a cyan slit visor and asymmetric
shoulder equipment. The sentinel is a broader rust-armored security robot with amber optics,
a reinforced crown, and a heavier torso. Both have named articulated parts and `idle`, `walk`,
`attack`, and `death` clips. Geometry is combined by material within each articulated part,
not emitted as one runtime object per armor plate.

One asset unit is one navigation cell: right-handed coordinates, +Y up, +Z forward, feet at Y=0.
Meshes are appearance only. They must never replace the simulation's navigation/collision data.

| Asset                             | Intended placement                                                               |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `operative.gltf`, `sentinel.gltf` | Actor body anchors, preserving cell picking and health                           |
| `server-rack.gltf`                | Tall rear-perimeter equipment only; never in front of a navigable cell           |
| `service-partition.gltf`          | Instanced low walls on blocked cells; top stays below 0.45 units                 |
| `access-console.gltf`             | Security-switch cell; screen uses `terminal-locked.png` or `terminal-active.png` |
| `vault-door.gltf`                 | Blocking door cell; `leaf-left`/`leaf-right` retract into neighboring wall cells |
| `extraction-pad.gltf`             | Exit cell; low rim and four uplink nodes keep the operative visible              |
| `deck-panel.png`                  | Tileable non-emissive walking surface with seams, fasteners, and service marks   |
| `vault-icons.svg`                 | Four original 64-pixel UI symbols: operative, lock, console, extraction          |

Interior and foreground partitions stay below the existing tactical visibility ceiling.
Tall architecture belongs behind the maze, not on arbitrary walls. The source deliberately
does not bake presentation into the authoritative scene or change the 960-tick winning route.

## Sound

`vault-air.wav` is a quiet equipment loop. The remaining WAVs are short pulse, impact,
alert, access, unseal, route-denied, and extraction cues. All are mono 22,050 Hz signed 16-bit PCM,
with unclipped peaks and tapered envelopes. Playback, user-gesture unlock, mute, event delivery,
voice limits, and disposal belong to the shared presentation audio system.
