# Sector Breach original asset kit

All meshes, textures, lettering, animation and sounds in this directory are original
procedural artwork authored for Aegis. No downloaded models, stock textures, sound samples,
generated third-party images, proprietary fonts or external creative services are used. The assets and their
source are released under the repository's MIT license.

Rebuild from the repository root with `node games/fps/assets/generate.mjs`. Only Node's
standard library is required. `generate.mjs` is the editable source of truth; the committed
GLBs and PNGs are delivery artifacts. `generated/manifest.json` records dimensions, counts,
canonical-JSON source-scene fingerprint and SHA-256s (independent of checkout line endings).
The generator uses fixed parameters and a seeded
integer texture-grain sequence, not time or unseeded randomness.

The existing Vitest gate runs `games/fps/test/assets.test.ts`: it regenerates into a
temporary directory with `--out`, compares shipped bytes, checks payload/image/audio
bounds, and independently probes the committed triangles against the level's 105 floor
cells, 72 exposed wall boundaries, collision boxes and coolant surface. It also guards
the upright wall UVs found necessary during the real browser asset preview.

## Art direction

Sector 09 is an orbital transfer station. Pale service panels, dark ribbed deck plates,
copper thermal lines and machined graphite frames establish its industrial construction.
Amber pressure-lock warnings contrast with cyan coolant and a green extraction pad.
Lettering is an original hand-authored bitmap alphabet, rasterized into a shared atlas.

The Kestrel K-09 sentry has distinct plated shoulders, an offset optical slit, exposed
hydraulics, separated articulated legs and a forearm weapon. The Vaultline V-7 is an
original compact coil rifle with a reflex sight, charging bolt, thermal coils, magazine
and pressure-suit arms. Neither references an existing fictional weapon or character.

## Integration contract

| Asset                  | Origin / orientation                                             | Presentation controls                                                                       |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `orbital-facility.glb` | World origin, Y up; built from the unchanged scene grid          | Static environment; replaces legacy floorplan drawing, not collision                        |
| `kestrel-security.glb` | Feet at origin, faces -Z; authored to the existing enemy hit box | `SentinelIdle`, `ReturnFire`, `Shutdown`, terminal `Offline`; `EnemyMuzzle` anchor          |
| `vaultline-rifle.glb`  | Camera-local origin, points -Z                                   | Attach to camera, offset in composition; `Fire` clip and `Muzzle` anchor                    |
| `blast-door.glb`       | Bottom centre of a door cell; 1 x 4 x 1 closed                   | `Open` lifts `DoorLeaf`; driven by authoritative cell state                                 |
| `breach-panel.glb`     | Entity origin; illuminated target faces -X                       | Fits the existing panel hit box; `Unlock` changes the amber indicator to green `LockStatus` |
| `extraction-pad.glb`   | Entity origin on the floor                                       | Non-obstructing markings inside the existing goal trigger                                   |

GLBs embed their PNG images and need no sidecar fetches. Standalone PNGs are also provided
for shared material descriptors. Albedo/signage maps use sRGB; normal maps use linear
sampling. Largest image: 512 x 512. The four environment zones are merged by material:
surface detail is mostly texture work rather than hundreds of independent draw calls.

Audio is 22,050 Hz, mono, 16-bit PCM WAV with explicit headroom and click-free edges:
a station-air loop, coil discharge, pressure-door servo, armor/suit impacts, sentry
shutdown and airlock-ready cue. They are synthesized from fixed polynomial oscillators
and seeded filtered noise. Playback, event dispatch, gain and gesture unlock belong to
the shared audio service.

The presentation layer must own geometry/material/texture disposal and animation mixers.
Clone instances through the shared asset cache; do not duplicate loading or add assets to
world snapshots. Audio, HUD, loading/error states and event binding use the shared
presentation platform, not an asset-specific runtime.

Opening the blast door is a visual transition after the collision cell becomes passable.
Its 0.8-second rise completes before the existing route reaches it. A live player who
reaches it sooner must never encounter an invisible collider or be blocked by rendering.
Visual weapon recoil changes only its model; camera direction, `LookState`, crosshair and
hitscan rays must remain identical. Mesh animation is not collision animation.

## Playable composition

`poc/fps.mjs` owns the typed shared presentation manifest and host-only asset directory.
It binds the robot, control panel and extraction pad at their authored entity origins,
the facility and pressure door in world space, and the rifle in camera-local metres.
The inspected starting rifle pose is `[0.31, -0.31, -0.9]` at scale `0.85`; recoil adds
only `0.035` metres to the visual wrapper, in addition to its short authored fire clip.
The camera and collision meshes are never displaced.

The shared runtime plays `Open`, `Unlock`, `Fire`, `ReturnFire` and `Shutdown` from
existing simulation events. `Offline` is a constant terminal pose derived from the end
of `Shutdown`, so reconstructing a dead actor without its historic event cannot loop the
collapse. Impact feedback is a color-only flash on the target, not a fabricated world
hit position: existing hitscan events do not contain a historic ray origin/direction.
The shared audio service supplies gesture unlock, mute, pause and restart behavior.

The legacy environment and trigger rendering is explicitly replaced, not deleted.
The existing collision-debug toggle still reveals the original level, hit boxes and
hazard volumes. The scene, plugin, 600-tick winning input, 300-tick pit-death route,
200-tick wall-sliding probe and final/trajectory golden literals remain authoritative.
The normal `npm run play` and `npm run build:site` composition paths use the same manifest.
