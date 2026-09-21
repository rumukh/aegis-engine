# ADR-0012: additive action consumers and local SDK artifacts

Status: accepted for the extension integration.

The existing deterministic ECS and physics-mode PoCs remain supported. Narrative
and turn-based applications need no physics mode, three.js dependency or private
monorepo imports.

## Decision

`@aegis/runtime` depends on core. `@aegis/narrative` depends on core.
`@aegis/browser` depends on core/runtime and hosts asynchronous browser services.
The renderer may import public browser audio utilities; the dependency never
points from browser services to rendering. No existing `GameMode` is repurposed.

Local npm tarballs are the initial supported distribution. Publication is not
authorized: staged manifests remain private. The pack command requires a full
source revision, captures source bytes, builds a fresh frozen staging tree and
pins all selected siblings to one content-addressed prerelease version.
Uncommitted inputs require an explicit flag and are labeled modified, with their
complete source inventory and digest. A Git revision alone is not provenance for
uncommitted work.

A separate temporary project installs every selected artifact together and owns
its own pinned TypeScript/bundler dependencies. It resolves only public exports,
checks declarations without ambient Node types, bundles the entire browser API
without tree-shaking away unsupported paths, and executes the headless surface.
The fixture has no workspace links, source aliases or unpublished dist access.

## Consequences

Source workspaces retain their existing development workflow. Tarball sets are
immutable local build outputs; consumers copy the whole set and lock its exact
files rather than relying on registry wildcards. Rebuilding with different
inputs/tool versions changes the identifier. Tests compare two clean builds'
tarball bytes rather than assuming reproducibility from a deterministic filename.

Static HTTPS and installable offline web are the approved delivery target.
Nested deployment paths must work. A service-worker install is distinct from a
static build, and browser storage is evictable; local backup remains necessary.
No desktop wrapper, game campaign, account, telemetry or remote runtime service
is introduced.
