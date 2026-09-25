# Environment constraints

Operational facts about the machine this project is built on. **Read this before running any
package or build command.** Violating these will waste a whole session.

## Package registry — public npm is BLOCKED *from this machine*

Corporate policy blocks `registry.npmjs.org` here. All npm traffic from this machine must go
through the corporate proxy:

```
https://packagefeedproxy.microsoft.io/npm/
```

This is pinned in the repo root `.npmrc`, which is committed. **Do not remove it and do not
change it to `registry.npmjs.org`.** Normal `npm install` / `npm ci` work fine through it. If a
package appears to hang or 403, it is a proxy issue — do not work around it by switching
registries; report it to the PM.

### The lockfile is the exception, and it is not optional

`package-lock.json` holds canonical `https://registry.npmjs.org/` URLs, **not** proxy URLs.
This is deliberate, and it is enforced by `test/lockfile-registry.test.ts`.

`npm ci` fetches tarballs from the lockfile's own `resolved` URLs; the configured registry only
selects where packument metadata comes from. Feed URLs (`*.pkgs.visualstudio.com`) are reachable
only inside the corporate network, so a lockfile containing them cannot be installed on a
GitHub-hosted runner — CI dies at the install step regardless of what registry the workflow sets.
Canonical URLs work in both places: a runner fetches them literally, and behind the proxy npm's
default `replace-registry-host=npmjs` rewrites exactly that origin to the configured registry.

**`npm install` and `npm update` silently write feed URLs back into the lockfile.** Everything
still works locally, so nothing tells you. After changing dependencies, run:

```
node scripts/canonicalise-lockfile.mjs --write
```

Omitting `--write` reports and exits non-zero, which is the form the gate uses.

## Toolchain

| Tool | Version | Notes |
| --- | --- | --- |
| Node | v24.18.0 | Already installed |
| npm | 11.16.0 | Already installed |
| Python | not installed | Do not depend on it |
| Go | not installed | Do not depend on it |

The **engine build, CI and player runtime** are Node and TypeScript only. Do not introduce
Python/Go or native-compilation dependencies (`node-gyp`) on those paths; there is no
guaranteed external authoring toolchain for an engine consumer.

Optional asset authoring is separate. This workstation's dedicated `Aegis-Trellis`
Ubuntu 22.04 WSL2 distro stores its VHDX under `C:\AI\TRELLIS\wsl`; `C:\AI` is an
existing junction to `D:\AI` and must be preserved. TRELLIS source, Python/CUDA
environment and model caches live inside that distro. Inputs, outputs and logs
remain local interchange files. Do not install Linux NVIDIA drivers, enable WSL1,
reboot Windows, or modify other AI environments as part of engine commands.

The user-level `trellis-3d` skill is optional and is not installed by npm. Original
TRELLIS image-large textured export was exercised locally with Python 3.10,
Torch 2.4.0/cu121 and the 16 GB RTX 4070 Ti SUPER; fresh network-isolated inference
also passed. Exact local evidence is in `C:\AI\TRELLIS\runtime.json`. This is
research/evaluation tooling with restricted export dependencies, not a claim of
whole-toolchain MIT licensing or commercial output clearance.

Raw TRELLIS export requires no Blender. Optional character cooking explicitly
selects Blender **5.2.2 LTS** at
`C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`, or an explicitly
configured executable whose actual version/build must be recorded. The measured
5.2.2 build is `d13f752e3b9c`; isolated bake/skinned-animation/GLB round-trip
compatibility was exercised. Existing historical recipes are not implicitly
migrated. Only reviewed cooked model bytes and portable provenance enter a game
through the Node-only [`aegis import`](docs/api/asset-import.md) workflow.

`npm view typescript version` currently reports `7.x` (the native port). Pin TypeScript to
`^5` for predictable behaviour with the rest of the ecosystem unless you have verified 7 works
across the whole toolchain.

## OS

Windows. Paths use backslashes. Scripts in `package.json` must be cross-platform — no `rm -rf`,
no `&&`-dependent POSIX-only shell tricks, no `cp`. Use Node-based tooling (e.g. `rimraf`, or a
small Node script) for filesystem work in scripts. Tests and builds must pass on Windows.

### Test temporary storage

`scripts/run-tests.mjs` gives each run a unique temporary directory outside the checkout.
On Windows its base is `%LOCALAPPDATA%\Aegis\test-tmp`, rather than a redirected general
`TEMP`/`TMP` location. Other platforms retain their system temporary-directory base.
The selected path is printed. Only test subprocesses receive `TEMP`, `TMP` and `TMPDIR`
overrides; the user's environment is not changed. Cleanup removes only that run's directory,
and a cleanup failure makes the runner fail.

This is a measured storage constraint, not a relaxed browser deadline. Identical fresh Chrome
shutdown controls took 3,445–3,996 ms on this machine's `F:\temp`, versus 344–434 ms on C:.
Under the earlier complete run, browser shutdown repeatedly exceeded the unchanged 10-second
deadline. Moving temporary storage made all 14 Coyote browser cases pass, including navigation
and live input, without changing their assertions or timing limits.

Set `AEGIS_TEST_TMPDIR` to an absolute directory to choose another base. Its resolved path
(including directory aliases) must be outside the checkout so an independently installed
consumer cannot inherit workspace dependencies.
Invalid settings and filesystem errors are reported, not silently bypassed. Standalone tools
run outside the test wrapper continue to use their normal temporary-directory settings.
