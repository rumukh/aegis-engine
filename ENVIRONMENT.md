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

Node and TypeScript only. Do not introduce a toolchain that needs Python or Go, and do not
add native-compilation dependencies (`node-gyp`) — there is no guaranteed build toolchain.

`npm view typescript version` currently reports `7.x` (the native port). Pin TypeScript to
`^5` for predictable behaviour with the rest of the ecosystem unless you have verified 7 works
across the whole toolchain.

## OS

Windows. Paths use backslashes. Scripts in `package.json` must be cross-platform — no `rm -rf`,
no `&&`-dependent POSIX-only shell tricks, no `cp`. Use Node-based tooling (e.g. `rimraf`, or a
small Node script) for filesystem work in scripts. Tests and builds must pass on Windows.
