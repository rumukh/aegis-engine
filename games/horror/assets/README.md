# NULL MERIDIAN visual assets

Original station geometry, articulated pressure-suit responder, original decals and orbital
exterior, with three Azure-generated neutral surface sources. `source/observation-concept.png`
is **human-approved concept art only**, excluded from runtime assets. It is not an engine capture.
The approval, exact prompts, source hashes, model deployment and mixed rights are recorded in
`source/recipes.json` and `provenance.json`. Generated images are not third-party CC0.

The current damaged responder (`e26edcaa...`) and three-site aftermath model (`35279a2e...`)
are human-approved from their actual-game views, alongside the SFX direction and evacuation
ending. Current approval and measured limits are documented in
[`docs/games/horror.md`](../../../docs/games/horror.md). Final release verification is a
separate record, not implied by creative approval. Earlier checkpoint sections and immutable
hash-pinned recipes/provenance describe their production stage; their old pending fields are
historical, not current release status. Do not rewrite those receipts after approval.

The evacuation ending's `sourceSha256` records its cook-time source bytes. Its asset test
accepts the LF and CRLF representations of that same text so Git checkout conversion does
not invalidate the receipt. Other source edits still fail; the recorded fingerprint is not
rewritten, and model, image and audio fingerprints remain byte-exact.

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

## First horror-direction prototype

`generate-horror.mjs --scene <canonical scene> --out <new prototype directory>` is an explicit
opt-in creative prototype. It never overwrites `generated/` or an existing output directory.
The current accepted 36-file runtime must match its inventory before cooking; 35 files are
copied byte-identically and only the responder changes. `struggle.glb` and four original
surface/decal textures are added. The resulting 41-file inventory records exact source hashes,
the world-origin first-cluster placement, an inherited-frame/clip contract and pending approval.
`verify-horror.mjs --candidate <prototype directory> --report <new JSON receipt>` verifies the
production dependency closure, unchanged rig/accepted visor, exact Search/Lunge and lower-body
channels, bind envelope, 84 sole samples, wall projection and the protected slate clearance.

`source/infestation-concept.png` is concept only, not a screenshot or character identity source.
Its complete prompt and rights are in `source/horror-pass.recipe.json`. Runtime growth and
damage maps are original Node-authored geometry/material recipes, not projected concept pixels.
The first thin parallel-ribbon mesh was rejected during asset review for reading as hanging
decoration. The first-gate 1b iteration uses fewer, thicker irregular shell forms rooted in
corrugated masses; artistic approval remains pending actual-game torch/front/side evidence.

The first environment object is `struggle.glb` at world origin, facing the maintenance machinery
west surface x=4.5,z=16. Its inward-buckled cover, flush boot/tool drag marks and small dry
handwipe add no collider or standing obstacle. Only this one aftermath cluster is authorized
before the substantial creative gate. The accepted rings/window/lighting and all eleven controls
are unchanged; new sound is a separate owner's workstream.
The 1c correction puts the shallow bent bars in front of their backing: a front-ray assertion
rejects the opaque-board failure seen in 1b. Existing coolant machinery and the 14mm maximum
projection are preserved; it is a damaged protective cover, not a deep opening cut into the tank.
Prototype source receipts retain both raw SHA256 and CRLF-to-LF-only SHA256 for `.mjs`/`.json`.
The verifier reports every checkout line-ending bridge explicitly; it rejects any other source
change. Images, models, other binary dependencies and runtime-file comparisons remain exact.

### Recorded first-gate repair 2

Five actual game views rejected 1c: pale ribbons read as decorative leaves, wounds were too
subtle, and the regular cage/parallel floor marks lacked a specific struggle. The next bounded
revision repairs only those same two objects. It replaces the targeted chest/shoulder shell
region with a recessed core, restrained irregular injury/contact rim and roots that end under
surviving panels; the attached mineral growth is made of closed volumes, not lamella ribbons.
The clean utility block and strap crossing the damaged area are removed only in the infected
constructor. Accepted visor optics and all lower-body geometry/channels remain unchanged.

The single cover now has a failed upper-right attachment, three unequal broken rods and one
attached frayed textile strip. One interrupted heel/tool rub replaces the repeated floor
stamps. No floating plate scraps, extra aftermath locations, new collision, camera/light changes
or new image/model generation are part of this revision. The existing 14mm projection and
control clearances still apply. Asset-only views remain visibly stylized and are not an approval:
compare the same actual 4m/2.46m/3.40m torch views and maintenance views before the next gate.

## Sculpted insert checkpoint (separate approval)

The parent rejected revision 2's actual-game result and authorized **one** different construction
workflow, not another annular/tube iteration. Existing Blender 3.2.2 authors a continuous
voxel-fused volume with high-poly surface sculpt and targeted pressure-liner thickness. The
three exports are in existing `thorax`, `shoulder-right` and `helmet` local coordinates.
The high/low meshes, packed UVs, maps and `.blend` are retained. This is scripted sculpting and
insert-only decimation, **not hand sculpting, hand retopology or a generated model**.

Run in a new output directory using the existing offline Blender executable:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 3.2\blender.exe' --background --factory-startup --python-exit-code 1 --python games\horror\assets\source\sculpt_infestation.py -- --out <new-sculpt-directory> --size 2048
& 'C:\Program Files\Blender Foundation\Blender 3.2\blender.exe' --background --factory-startup --python-exit-code 1 --python games\horror\assets\source\cook_sculpt_basecolor.py -- --sculpt <sculpt-directory>
node games\horror\assets\assemble-sculpt.mjs --body-runtime <frozen-revision-2-runtime> --sculpt <sculpt-directory> --out <new-assembled-checkpoint>
```

This offline tool's Python is bundled with Blender; the game runtime and assembly remain Node.
No new model download, external image or generation request is used. All original body binary
payload, rig/bind nodes and animation accessors are copied unchanged; only explicitly named
organic/contact primitives in the three allowed nodes are replaced. Accepted visor primitives
are not re-exported. Normal-map tangent attributes from the insert are retained.

The first authoring attempt failed connectivity/UV inspection and remains a rejected technical
artifact. The corrected source verifies one fused colony per bone (plus a separate torn textile
piece on the thorax), uses backbone-oriented seams and checks shared UV area before baking.
The 2K normal and ORM remain lossless; only the new color map is JPEG-cooked from its retained
lossless bake to fit the existing byte cap. No other asset is reduced. Fixed Blender version,
source script and produced hashes are recorded; cross-version/device bake byte-identity is not
promised. Repeating the Node assembly from the retained maps/insert is byte-identical.

The first rendered checkpoint was **asset-only**: production asset loading and cinematic
pipeline, neutral close and an isolated 36cd game-settings torch at 2.458935m. It has no
authoritative world or room lights, so it is not a gameplay proof. Its parent inspection
preceded the separately recorded actual-game review.

### Actual closure and the final ending

The coordinator explicitly approved the sculpt checkpoint for a bounded game-integration review,
not final character/AAA approval. Before handoff, `audit-sculpt-closure.mjs` preflights the
current isolated art presentation and the parent's frozen combined ending/SFX source, substitutes
only the approved assembled responder, and derives the actual referenced material/image union.
Only the now-unreferenced rejected-prototype `colony-shell-basecolor.png` and
`colony-shell-orm.png` are pruned from the staged copy/catalog. The existing colony normal remains
referenced by the single struggle cluster. No accepted file is deleted or quality reduced.

The pre/post appearance-input hash includes the unchanged presentation plus every actual
dependency hash; it is not represented as a new pixel capture. Since the two orphan maps were
already absent from the production dependency closure, deleting those disk/catalog leftovers
saves **zero additional runtime bytes**.

The measured base-art closure remains **49,252,392 bytes**, below the existing 48 MiB guard.
Including the final 1,988,768-byte evacuation model with its 12 shared textures counted once gives
**51,241,160 visual bytes**. The 30 audio files are **1,505,787 bytes**, for **73 files /
52,746,947 bytes** combined. The parent explicitly reallocated the _internal planning budget_
on 2026-09-19 to **50 MiB combined visuals including the user-added ending plus 14 MiB audio**.
This is a coordinator allocation, not a user-specified limit. Neither the existing base-art
48 MiB test nor the engine's hard 64 MiB combined / 32 MiB per-file limits are changed.

Node assembly can reproduce against retained rejected-revision-2 inputs without reinstalling
them into runtime: pass `--body-model <retained responder.glb>` and
`--body-inventory <retained inventory.json>` alongside `--body-runtime <current shared-map directory>`.
The retained original model supplies geometry/animation bytes; the shared accepted dependencies
remain untouched. The `.blend`, raw insert GLB, lossless original bakes, encoded color map and
offline script must remain in source/provenance storage, never in the declared runtime closure.

## User-selected suit-damage checkpoint

The user selected **much more damaged and blood-stained**, not approval of the prior character.
`damage-suit.mjs --body <frozen sculpted responder.glb> --out <new checkpoint>` performs only
the bounded actor pass. It removes front triangles at three selected armor impacts and one
pressure-fabric tear, adds fracture thickness and recessed dark backing, and appends attached
frays and conforming contact-stain surfaces. The sculpt insert, visor, original materials/maps,
rig, animation accessors and unmodified primitive payloads remain exact. There is no new
infestation pipeline, model generation, exposed anatomy, global repaint or room/ending change.

Two responder-specific 512px atlases carry irregular dry/absorbed blood and smaller wet
roughness regions, gravity trails, abrasion and a limited lower-suit transfer. Shared normal
textures are read through preserved original UVs, not changed. In particular, the existing
textile normal is also consumed by the facility/struggle cluster and must not be edited.

`verify-suit-damage.mjs --candidate <checkpoint> --baseline <accepted sculpt directory>
--closure <frozen combined candidate-presentation.json> --out <new audit directory>` checks
the protected data, actual first-hit surfaces through the new openings, exact bounds and the
full production dependency union. The current checkpoint adds **600,167 bytes**: the responder
changes and two maps are added; all 72 other previously declared runtime files remain exact.
The measured union is **75 files / 53,347,114 bytes**: base art **49,852,559**, all visuals with
ending **51,841,327**, audio **1,505,787**. Existing 48/50/14/64 MiB guards are unchanged.

The first internal draft had stain coverage hidden behind the forearm pad and coarse mask-cell
edges. Its source/images are retained; the bounded correction extends contact transfer onto
that pad and uses continuous low-frequency mask variation. No sculpt, visor, lighting or scale
changed. The neutral and isolated torch checkpoint preceded the three matched actual-game
views. The user subsequently approved that exact e26 character revision; its historical
checkpoint receipts remain unchanged.

## Three restrained environment additions

The user explicitly selected restrained aftermath at 3–4 other locations; the coordinator
authorized **exactly three**: arrival, infirmary and archive. The human-approved e26 responder,
its two maps and the existing maintenance cluster are frozen. `generate-aftermath.mjs` produces
one world-origin `aftermath-sites.glb` with three named site nodes and floor-trace children.
It reuses existing map bytes; there are no new images, lights, sounds, scene entities or colliders.

The stories are deliberately different: a scored/parted arrival service cover and interrupted
dirty contact; a frayed aid wrap caught in a bent berth clip with absorbed transfer; and a short
failed brace across recorder equipment rather than a passage. Primary details remain above
0.75m where the arrival/archive canonical views require it. All raised/floor geometry must
remain inside the integrator's explicit envelopes and outside protected control approaches.

```powershell
node games\horror\assets\generate-aftermath.mjs --scene games\horror\levels\null-meridian.scene.json --baseline games\horror\assets\source\aftermath-input\baseline-presentation.json --asset-root games\horror\assets --inventory games\horror\assets\source\aftermath-input\baseline-inventory.json --contract games\horror\assets\source\aftermath-input\placement-contract.json --out <new-output>
node games\horror\assets\verify-aftermath.mjs --candidate <new-output> --baseline games\horror\assets\source\aftermath-input\baseline-presentation.json --asset-root games\horror\assets --contract games\horror\assets\source\aftermath-input\placement-contract.json --out <new-proof>
```

The repository's `source/aftermath-input/` directory retains the exact accepted 75-file authoring
metadata and placement contract. Nine narrowly listed JSON files are exempt from formatting
because they are immutable hash-pinned offline inputs/receipts; tests parse each and verify
independently recorded LF-normalized SHA-256 literals. No executable source or broad asset
directory is excluded. The historical absolute `assetRoot` is retained as receipt data:
always pass `--asset-root games\horror\assets` to relocate the files without relying on the old
machine path. Text-only CRLF/LF bridges are recorded; binary comparisons remain exact.
The verifier checks cooked vertices, floor height, wall
lip and control clearance, then casts from the owner's canonical eye positions against both the
new GLB and the actual existing facility. It requires the new opaque subject to be the first hit,
with the baseline facility as a positive control. Projection alone is not visibility evidence.

All 75 previous runtime files are classified as byte-identical in the proof; only the new GLB
may add bytes. Its strict unique-runtime allowance is **less than 479,089 bytes**, with unchanged
base-art 48 MiB, all-visual 50 MiB, audio 14 MiB and engine 64 MiB limits. The user approved
the three actual-game representative views after the environment-only handoff. That creative
decision is separate from the engineering proof and final integrated verification; it does not
authorize additional sites or changes to the frozen character and existing maintenance cluster.
