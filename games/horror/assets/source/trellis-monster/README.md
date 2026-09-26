# Cable Warden character source

This is a separate TRELLIS-derived character recipe, not a revision pretending
the historical procedural responder generator produced this mesh. The user
selected concept B and approved raw unrigged001 for cleanup/rigging on
2026-09-25. The user then approved the final actual-game result: **"Amazing!
Get it in!"** `approval.json` pins that decision to the cooked bytes.

`recipe.json` records the immutable source/output fingerprints, input rights,
local model/code revisions, Blender version/build, material work, rig and
motion contract. `approved-concept.png` has only private PNG metadata removed;
its decoded pixels match the selected image. Restricted Gaussian-export
dependency terms remain research/evaluation-only; no whole-toolchain MIT or
commercial-output clearance is claimed.

The raw GLB, generation receipts, intermediate revisions and editable `.blend`
remain in the local authoring store. They are not installed by npm, rebuilt in
CI or loaded by players. The accepted cooked bytes are the distribution input.

## Offline cooking

From the repository root, with the exact approved raw GLB available locally:

```powershell
.\games\horror\assets\source\trellis-monster\cook.ps1 `
  -RawModel C:\authoring\approved-unrigged.glb `
  -OutputDirectory C:\authoring\new-cook-revision `
  -BlenderExecutable "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
```

The output directory must be new. The script verifies the raw and historical
motion fingerprints before work. Blender 5.2.2 LTS is explicitly required,
with `disable_bone_shape=True` and frame 0 / 60 fps established before import.
It does not open or migrate any historical `.blend`.

The 24-joint rig is specific to this mesh. Surface-connected limb regions
prevent nearby hand and thigh surfaces from accidentally sharing influences.
The source upper-body motions are sampled, and leg IK keeps the existing
1.6 m / 2.2 s gait, 75 mm swing lift and playback rates. Sole vertices remain
rigidly attached to their feet. The entity/root does not translate.

## Verify the actual exported skin

```powershell
node games\horror\assets\source\trellis-monster\verify-character.mjs `
  --asset C:\authoring\new-cook-revision\responder.glb `
  --out C:\authoring\new-verification-directory
```

This uses the production Aegis loader and a real browser, decodes all three
texture maps, checks normalized skin weights and samples every 60 Hz frame of
all four clips. It measures real skinned vertices, foot contact/lift, planted
stride, loop closure, root motion, historical clearance and visible edge
stretch. A no-animation mutation must fail the deformation threshold.
Images and reports remain beside the verification output.
The default software browser path also runs in CI; set `AEGIS_CHARACTER_HARDWARE=1`
for explicit local GPU studio evidence. Neither path runs model inference or Blender.

The first skin passed basic bounds/contact checks but visibly stretched;
it was rejected, and the added strain oracle also rejects it. Do not remove
that oracle or repin gameplay hashes to make a changed character pass.

Import verified cooked output with `aegis import`, using `provenance.json`.
Only the responder source/provenance changes in `poc/horror.mjs`. Its ID,
state conditions, playback rates, warning timing and spatial audio bindings
remain unchanged. Keep `assets/generated/responder.glb`, its textures and
all historical recipes for deliberate rollback; they must not also be
declared in the active presentation.
