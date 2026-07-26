# Environment constraints

Operational facts about the machine this project is built on. **Read this before running any
package or build command.** Violating these will waste a whole session.

## Package registry — public npm is BLOCKED

Corporate policy blocks `registry.npmjs.org`. All npm traffic must go through the corporate
proxy:

```
https://packagefeedproxy.microsoft.io/npm/
```

This is pinned in the repo root `.npmrc`, which is committed. **Do not remove it, do not
override it, and do not add a registry line pointing at `registry.npmjs.org`** in any
package-level `.npmrc`, lockfile, or CI config.

Verified working through the proxy: `typescript`, `vitest`, `three`. Normal
`npm install` / `npm ci` work fine. If a package appears to hang or 403, it is a proxy
issue — do not work around it by switching registries; report it to the PM.

Because resolved URLs in `package-lock.json` will point at the proxy host, that is expected
and correct. Commit the lockfile as-is.

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
