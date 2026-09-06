# Agent-first production roadmap

**Goal:** build a new agent-first engine that can eventually support AAA production. Aegis's
current TypeScript runtime and three playable slices are the reference foundation, not evidence
that the engine already has AAA scale or production completeness.

## Architectural commitments

- **Readable authoring, efficient delivery.** Scene graphs, gameplay definitions, asset manifests
  and recipes remain diffable text with stable IDs. Original media and cooked runtime assets may
  be binary. Cooking must retain provenance, versioned metadata and reproducible outputs; an
  opaque GUI project cannot be the only source of truth.
- **Deterministic authority, asynchronous presentation.** Fixed-rate authoritative simulation
  must remain reproducible from explicit inputs. Asset IO, decoding, rendering, view-only effects
  and audio may run asynchronously outside that boundary. Loading completion or display timing
  must not silently choose a gameplay outcome. Rendering reads simulation state, never writes it.
- **Reference behavior before backend replacement.** TypeScript/Node is the current executable
  reference. Storage, transport and hot paths may evolve; full JSON snapshots on every frame are
  not a permanent requirement. Native work needs a measured bottleneck, representative workload,
  reproducible toolchain and equivalent deterministic results. No speculative native stubs.
- **Inspectable and testable throughout.** Every subsystem needs agent-accessible data,
  diagnostics and acceptance workloads. Simulation assertions establish gameplay truth;
  rendered captures and presentation review establish visual/audio quality. Neither proves the
  other, and a missing check is never a pass.

## M1: integrated vertical slice

This is the current milestone. Completion means integrated acceptance, not separate green
branches or a claim of AAA readiness.

| Sequence                              | Work                                                                                                                                                                                                                                   | Integration condition                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Wave 1: foundations**               | Atomic snapshot restore; real prefab hierarchy expansion; shared plugin/resource initialization; rate-correct recordings; output-compatible hashing improvement; declarative shared presentation/assets/audio and dev/static delivery. | Public contracts are coordinated, shipped paths use them, and downstream games can consume working implementations.          |
| **Wave 2: agent tools and showcases** | Capability discovery and bounded inspection; substantial upgrades to the existing Coyote Gap, Server Vault and Sector Breach.                                                                                                          | All three games use the shared infrastructure, remain playable, and keep their meaningful scripted win/lose workloads.       |
| **Integrated acceptance**             | Review and combine the work, then exercise the complete engine and presentation paths.                                                                                                                                                 | The existing full gate, headless routes, browser/static evidence and comparable performance measurements support the result. |

The showcases remain the same games: Coyote Gap's traversal and ferry beats, Server Vault's
patrol/detection/door/combat sequence, and Sector Breach's door shot, coolant jump and firefight.
Improve authored environments, recognizable characters, feedback, objectives, controls and
sound without replacing these workloads with easier demonstrations.

Acceptance includes the existing `npm run verify` gate; exact replay and existing deterministic
oracles; human-playable and scripted browser routes; static deployment under a URL prefix;
actionable asset errors; bounded loading/disposal/restart behavior; accessible mute/unlock and
controls; actual rendered review; and comparable runtime measurements. Browser-heavy runs are
coordinated rather than raced on one machine. Do not disable assertions, weaken budgets, hide
omissions or re-pin goldens without explaining the behavioral change.

## M2: scalable runtime and content

Enter after M1's integrated acceptance. Use the expanded PoCs and representative stress scenes
to define workload-specific CPU, GPU, memory and IO budgets. Build a versioned runtime-host
boundary, compact storage, incremental observation, content cooking and streaming where the
measurements justify them. Prototype native hot paths only against those workloads; require
reproducible builds, diagnostic parity and equivalence with the reference simulation.

## M3: production characters and worlds

Add skeletal animation/blend graphs, richer physics and navigation, streamed worlds, persistent
state migrations, and VFX/audio authoring. Each subsystem must expose schemas, capabilities,
diagnostics and reproducible acceptance to agents from the start. Large-world and character
systems are not achieved merely by adding type declarations or unexercised loaders.

## M4: production operations and platforms

Address large-project asset workflows, incremental packaging, platform-specific integration
and optimization, GPU/crash diagnostics, collaboration and continuous representative performance
coverage. Platform readiness needs evidence on the target platform. Networking requires its own
authority, synchronization and failure model; deterministic replay does not supply one by itself.

AAA capability is the cumulative production outcome of these milestones and sustained workloads,
not a label granted to M1. Maintain the [charter](../CHARTER.md)'s agent-first, headless and
deterministic principles as the implementation changes.
