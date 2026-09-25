# Import a local model

`aegis import` packages a local uncompressed glTF 2.0 `.glb` or `.gltf` using the
existing production dependency preflight. It is generator-independent and
Node-only: it does not run TRELLIS, Blender, a browser, a game plugin or a world.
Python, CUDA and checkpoints never enter engine installation, CI or player runtime.

```powershell
npx aegis import C:\art\candidate\monster.glb --id responder --out-dir games\horror\assets\imported\candidate-001 --provenance C:\art\candidate\provenance.json --dry-run --json
```

The destination's parent directory must already exist. The destination itself
must be new. Remove `--dry-run` to publish the checked package. An existing file,
directory, symlink or junction is refused, including an empty directory.
There is deliberately no `--force`; import another revision instead.

The required provenance JSON contains exactly three nonempty strings:

```json
{
  "author": "Your team or documented creator",
  "license": "The actual applicable terms; not an inferred model license",
  "source": "The reviewed source recipe or provenance reference"
}
```

Provenance is a declaration, not legal verification. Do not pass a full local
generation log as this document or copy private host paths into a public source
reference. For generated content, retain input rights, model/code/settings and
raw/cooked hashes in the separate authoring recipe. A model's MIT license does
not automatically clear its inputs, dependencies or generated output.

## Package and receipt

The destination contains:

```text
candidate-001/
  model/<original filename and exact checked dependencies>
  asset.presentation.json
  import.json
```

Model/dependency bytes and their relative URIs are unchanged. Placing them below
`model/` reserves metadata names without rewriting glTF. Unrelated files from
the source directory, checkpoints, source projects and generation logs are not
copied. Descriptors and receipts use portable relative references, not absolute
host paths.

Keep a committed package byte-identical too: text checkout conversion or a
formatter can invalidate its recorded JSON/glTF fingerprints without changing
how the model looks. Aegis preserves bytes under `games/*/assets/imported/**`
with Git's `-text` attribute. For another destination/repository, configure the
equivalent scoped attribute before committing. Deliberate content edits require
a fresh import/receipt, not a silently rewritten package.

`import.json` has discriminator `asset-import/1`. It records the stable asset
ID, declared provenance, source-model SHA-256/byte count, descriptor fingerprint,
the exact source/output relative inventory with per-file sizes/hashes, and
total encoded asset bytes. It explicitly requires visual review. CLI output
uses `asset-import-result/1`, with `status: "planned"` or `"imported"`, the
destination host path, and the receipt. Dry-run validates the complete closure
without writing a reservation, directory or receipt.

The command uses `preparePresentation` and `readPreparedPresentationFile`,
stages checked bytes in a unique sibling directory, re-prepares the staged
closure, verifies source freshness, then renames the completed directory into
place. An exclusive sibling reservation serializes Aegis imports of the same
destination. Failures clean only owned staging/reservation files; source assets
and prior packages are not replaced. Do not concurrently edit source files or
the destination parent: the reservation coordinates importers, not arbitrary
filesystem writers. Do not remove another process's live reservation.

The same production policies apply: traversal, remote/escaped dependencies,
unsafe portable names, case collisions, missing files, unsupported decoder
extensions, and 32 MiB/file, 64 MiB/closure or 256-file budget violations are
refused. Internal dependency symlinks are copied as checked bytes; targets
outside the resolved asset root are refused. Draco, Meshopt and KTX2/Basis
decoder dependencies are not automatically installed.

Structured `AEG-IMPORT-0001` through `0004` distinguish unsupported input,
provenance, destination and publication failures. Existing `AEG-RENDER-*`
preflight diagnostics retain their codes and locations. `--json` sends errors
through the normal CLI stderr diagnostic envelope and returns nonzero.

## Review and bind intentionally

Review the **packaged descriptor**, not an unrelated raw copy:

```powershell
npx aegis preview games\horror\assets\imported\candidate-001\asset.presentation.json --model responder --serve --watch --out-dir reviews --json
```

Keep the PNG capture recipes and inspect the actual rendered geometry and
decoded textures. Import preflight is not a complete Khronos validator, a
topology/rigging check, or artistic approval.

To use a reviewed package, copy its asset declaration into the game's existing
manifest and prefix `src` with the package's path relative to that game's
`assetRoot`, for example `imported/candidate-001/model/monster.glb`. Retain the
declared ID/provenance. Bind the intended entity using `visual.kind: "model"`,
`mesh: "responder"`, the existing clip/state bindings, an explicit `pose` where
needed, and `fit: "authored"`. The importer does **not** rewrite game JavaScript,
rescale/rotate geometry, simplify meshes, create colliders or invent animations.

The existing dev and static hosts serve the same prepared dependency closure.
Recompute the **whole game's** budgets after replacement; a passing individual
import does not establish that the combined manifest fits. Do not leave both
old and replacement model declarations active merely to retain rollback files.

## Node API

Use the explicit Node-only subpath, never the browser renderer entry:

```ts
import { resolve } from 'node:path';
import { importModelAsset, readImportProvenance } from '@aegis/render-three/asset-import';

const result = importModelAsset({
  source: resolve('candidate', 'monster.glb'),
  id: 'responder',
  outDir: resolve('assets', 'candidate-001'),
  provenance: readImportProvenance(resolve('candidate', 'provenance.json')),
  dryRun: true,
});
```

The API requires absolute host paths. CLI paths instead resolve against its
working directory. Both call the same implementation and enforce the same
preflight, staging and no-overwrite behavior.
