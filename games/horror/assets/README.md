# NULL MERIDIAN visual assets

Original station geometry, articulated pressure-suit responder, original decals and orbital
exterior, with three Azure-generated neutral surface sources. `source/observation-concept.png`
is **human-approved concept art only**, excluded from runtime assets. It is not an engine capture.
The approval, exact prompts, source hashes, model deployment and mixed rights are recorded in
`source/recipes.json` and `provenance.json`. Generated images are not third-party CC0.

From the repository root, with the normal locked dependencies and engine build available:

```powershell
node games\horror\assets\generate.mjs
node games\horror\assets\verify.mjs
```

The cooker reads the canonical `games\horror\levels\null-meridian.scene.json`, not a duplicate
tilemap. `--scene <path>` accepts an explicit read-only source during isolated visual production;
`--out <directory>` changes the runtime output directory. The cooker never writes the scene.
It needs only Node and the repository's existing three.js package. Re-cooking from the retained
original PNG sources is deterministic; re-requesting Azure images is not.
`verify-rebuild.mjs --scene <canonical scene> --scratch <new temporary directory>` pins the
exact published scene bytes, independently re-cooks all runtime files and compares every hash.
It refuses an existing scratch directory, cleans only the directory it created, and leaves a
neighboring JSON proof. This proves reproducibility, not artistic correctness.

`generated/inventory.json` is the integration contract: every runtime file and hash, material
recipe, mesh/primitive counts, bounds, exact named entity/portal placements, clip durations and
lighting suggestions. `generated/collision-audit.json` contains the authored walkable tile and
wall coverage. Geometry checks measure wall-vertex intrusion against collision planes, rather
than simply asserting that the generator read the scene. The verification script additionally
uses the production local-asset dependency preflight and samples actual glTF animation channels.
The inventory and provenance also fingerprint every cooking source module and record the
Node/three.js versions. Opaque floor/ceiling hull backers seal the detailed wall rebates; they
are behind the authoritative collision surfaces, not fog or a postprocessing mask.

**Placement:** `facility.glb` and `orbital-exterior.glb` are world-origin assets in meters;
disable legacy level drawing, not collision. All eleven interactables are individualized
wall-mounted/recessed models, named after their stable entity IDs. They have no floor pedestal:
the local origin remains floor level, the front face is local Z=0 and their bodies occupy
Z=-0.31..0. Their canonical scene anchor lies 0.05m outside the existing wall and the facility
kit reserves a visible recess. The atomic, parent-approved anchor contract is asserted before
any assets are written; do not mix old free-floor anchors with these models.
`responder.glb` uses local feet origin, positive Z forward, `fit: "authored"`.
All six doors share `pressure-door.glb`, positive X width;
rotate the three east/west portals 90 degrees as listed in the inventory. Clip `Open` lasts
0.7 seconds and must hold its last pose; gameplay, not the clip, controls collision.
Responder clips are exactly `Idle`, `Stalk`, `Search`, `Lunge`. These are real articulated rigid
node clips without root motion, **not skinned production skeletal animation or mocap**.
The 2.2-second `Stalk` cycle has 0.8m of planted travel per half-cycle, matching the game's
footstep distance. Its reference speed is 1.6/2.2 m/s; playback rate is actual movement speed
divided by that reference. The 48-sample leg IK is checked for heel/toe ground contact and
world-space sliding, not only for changing joint angles. Turning and stop/start phase alignment
remain actual-game integration checks.

**Materials:** base color and emissive content are sRGB; normal and packed ORM images are linear.
ORM channels are red occlusion, green roughness, blue metalness. Ceramic's 2048px base color is
explicitly an upsample of a 1024px Azure source; scalar/normal maps are 1024px. Their derived
microheight and hand-tuned roughness/metalness are artistic approximations, not physical scans.
The shared external PNG dependencies avoid embedding copies in every GLB.
`station-reflection.png` is an original LDR equirectangular lighting field, not HDR.

The budget leaves 16 MiB of the engine's 64 MiB runtime closure for audio, which is owned
separately under `assets/audio/`. The material sampler's GPU memory estimate is a unique-image
lower bound, not measured residency: loaders may create multiple GPU textures for shared images.
The suggested seven practical spots leave one flashlight slot; only the power pool and flashlight
should cast shadows initially. Avoid fog until the actual geometry is readable.

Use the production preview path for asset review, with output outside authored assets:

```powershell
node packages\cli\bin\aegis.mjs preview games\horror\assets\generated\responder.glb --clip Stalk --time 0.55 --out reviews\responder.png
node packages\cli\bin\aegis.mjs preview games\horror\assets\generated\facility.glb --camera 15,1.62,3 --target 15,1.62,12 --out reviews\ingress.png
```

For large assets use `review.mjs --driver <built hardware-capable browser.js> --out <directory>`.
It requests and verifies real hardware graphics, captures actual articulated poses through the
production preview API, records PNG sidecars, and closes only its own browser/profile. The older
CLI preview default forces SwiftShader and should not be mistaken for RTX performance evidence.

Preview captures prove asset loading and sampled geometry only. Final visual quality, readability,
door/gameplay alignment and 1440p60 need the integrated game renderer and its actual performance
measurements. Direct preview provenance is reported as user-supplied unless a presentation
descriptor explicitly declares it; the adjacent PNG recipe is not a substitute for this source
provenance.

## Bounded v10 optical repair

Only `responder.glb` and `orbital-exterior.glb` change at runtime; `ring-density.png` is added.
The other 33 v9 runtime files remain byte-identical. The helmet receives a genuinely curved,
tinted, rougher non-emissive visor, without changing the shared equipment material, rig,
animation samples or character bounds. The rings become one transparent annulus with a small
original radial-density image: muted warm grey, feathered edges and two broad density troughs.
Planet/ring placement, inner/outer radii, orientation, scene anchors, lighting and camera framing
are unchanged. No additional image/model generation is used.
The second candidate uses a smooth global paraboloid with analytical normals; actual-game
comparison rejected the first radial construction's X-shaped highlight despite its lower peak
brightness. The first candidate's immutable receipt remains a rejected comparison, not final art.
For this narrow follow-up, `generate.mjs --scope optics` reuses the published room kit only after
checking its runtime hashes, non-optical cooking sources and source-image hashes. It refuses
scene changes and cooks only the two optical models and ring density image. The matching
`verify-rebuild.mjs --scope optics` repeats those three outputs in scratch and explicitly reports
that the other 33 files were hash-checked, not rebuilt.

`verify-v10.mjs --baseline <frozen v9 asset directory> --report <new JSON receipt>` compares
resolved geometry/material/animation data and all file hashes, proves the narrow runtime delta,
checks physical visor curvature and ring connectivity/density, and writes old/new SHA receipts.
The receipt is immutable (an existing report is refused). Rebuild proof and actual unchanged
1440p game captures remain separate requirements: neither this test nor a studio image approves
the flashlight highlight or transparent ordering in the composite game.
